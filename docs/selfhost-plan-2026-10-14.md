# NaviHive 自托管迁移方案（方案 B：整站搬到 VPS）

日期：2026-10-14
背景：站点部署在 Cloudflare Workers，`myhp.zwjttzt.com` 实测命中欧洲节点（CF-RAY 尾缀 `MAN` / `MAD`），
IPv4 TTFB 0.92–2.22s、主 JS 下载速率仅 53 KB/s。瓶颈在「家宽 → CF 边缘」的跨境段，不在应用代码。
本文评估并给出「整站迁出 Workers / D1、落到 VPS 自托管」的落地路径。

所有结论均已逐个回查代码，行号对应当前 main 分支。

---

## 一、可行性结论：可行，且改造面比想象小得多

逐项核对结果：

| 检查项 | 结果 |
|---|---|
| API 层是否依赖 CF SDK | **否**。运行时依赖（package.json）全是前端：React / MUI / CodeMirror / markdown-it / mermaid / katex / dnd-kit / pinyin-match |
| D1 类型从哪来 | **本地声明的最小接口** `worker/types.ts:158-180`（`D1Database` / `D1PreparedStatement` / `D1Result`），没引 `@cloudflare/workers-types` |
| Worker 用了什么运行时 API | 只有 Web 标准：`Request` / `Response` / `URL` / `crypto` / `fetch` |
| `caches.default` | **无**（全仓库 0 处） |
| `request.cf` | **无** |
| `ctx.waitUntil()` 实际调用 | **无**（只在 `worker/types.ts:154` 的类型声明里躺着，运行时没人调） |
| `db.raw()` | **无**（0 处，适配器可省） |
| 中文分词 | **在 JS 侧做的**（`src/utils/ftsQuery.ts` 的 `segmentCJK`），FTS5 建表只用标准选项 `tokenize = "unicode61 remove_diacritics 2"`（`src/API/methods/internals.ts:107`），**没用 D1 私有分词器** |
| 自托管钩子 | **已经写好了**：`NAVIHIVE_TRUST_XFF`、`NAVIHIVE_COOKIE_SECURE`（`worker/index.ts:61-69`），`worker/loginGuard.ts:41` 注释里明确写了「自托管（没有 CF-Connecting-IP）时，默认不再信任 X-Forwarded-For」 |

**结论**：这是个「按能搬出去的样子设计的 Workers 项目」。工作量主要在**适配与运维**，不在**重写**。

规模参考：`src/API` 共 14,726 行（含 `notes.ts` 1,890 行、`migration.ts` 827 行、`data.ts` 704 行），
`worker/` 下 23 个文件；数据库 23 张实体表 + 1 张 FTS 虚拟表，`SCHEMA_VERSION = 21`。

---

## 二、需要替换的东西（只有 5 项）

| CF 绑定 / 能力 | 现在的用途 | VPS 替身 | 工作量 |
|---|---|---|---|
| `DB` (D1) | 全部业务数据，23 张表 + `notes_fts` | node:sqlite / better-sqlite3 **适配器** | **中**（唯一的核心件） |
| `FILES_KV` (KV) | 笔记图片附件二进制 | 本地目录 `./data/files/<key>` | 小（只有 4 个方法） |
| `assets` | `dist/` 静态资源 + SPA fallback | Nginx | 小 |
| `triggers.crons` 每小时 | 附件删除重试 / WebDAV 备份 / 死链巡检 / 记事本备份 / 过期清理 | node-cron 或 systemd timer | 小 |
| `wrangler secret` | `AUTH_*` / `AUTH_SECRET` / `JWT_SECRET` / `DATA_ENCRYPTION_KEY` | `.env` 或 systemd `EnvironmentFile` | 小 |
| `FILES` (R2) | **未启用**（`wrangler.jsonc` 里整段注释着） | — | 0 |

KV 的实际使用面非常窄，全部集中在 `worker/attachments.ts` 的 4 个调用：
`get(key)`、`get(key, "arrayBuffer")`、`put(key, value)`、`delete(key)`。

---

## 三、核心件：D1 → SQLite 适配器

### 3.1 现成的种子，但**不能**直接上生产

`tests/helpers/realSqliteD1.ts`（59 行）已经把 `node:sqlite` 包成 D1 形状，并且跑通了真实的
`NavigationAPI` 方法。它有 4 个必须修掉的问题：

**坑 1：`batch()` 没有事务。**
测试替身写的是 `Promise.all(stmts.map(s => s.run()))` —— 而真 D1 的 `batch()` 是
**一次往返 + 一个事务**，全成功或全回滚。仓库里有 **29 处 `db.batch()` 调用**，其中
「删站点 + 写回收站 + 写墓碑 + 写审计」这类组合必须原子，否则会出现数据半删。
生产适配器必须显式 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`。

**坑 2：`exec()` 返回值。**
D1 的 `exec()` 返回 `{ count, duration }`。`migration.ts` 有 10 处 `await this.db.exec(sql)`，
目前只当 void 用，但适配器应补齐返回形状，免得以后踩空。

**坑 3：node:sqlite 仍是实验特性。**
Node 22 下会打 `ExperimentalWarning: SQLite is an experimental feature`。
要求 Node ≥ 22.5。**生产建议直接用 better-sqlite3**（npm 原生模块、成熟、自带事务 API），
把 `node:sqlite` 留在测试里 —— 两边接口形状一致，切换只改一个文件。

**坑 4：并发与锁。**
Workers 是多 isolate 并行，VPS 是单进程同步写。必须开 WAL，否则并发写直接 `SQLITE_BUSY`。

### 3.2 实测结论（已在本机 Node 22.22 上验证）

```
SQLite 版本      3.51.2
FTS5             已编译进来；tokenize = "unicode61 remove_diacritics 2" 建表成功，
                 '中 文 测 试 hello' MATCH '中' 命中 ✅
all() 无 RETURNING 的写语句   返回 []，**不抛错**（不会撞 "This statement does not return data"）
INSERT ... RETURNING          正常返回行 ✅
UPDATE ... RETURNING          正常返回行 ✅ —— 上次刚改的「RETURNING 判冲突」逻辑不用动
run() UPDATE meta             { lastInsertRowid, changes } ✅
BEGIN / ROLLBACK              事务正常 ✅
```

两条实操提醒：
- `stmt.all()` 返回的是 **null-prototype 对象**。`Object.keys` / 展开 / `JSON.stringify` 都正常，
  但 `row.hasOwnProperty(...)` 会炸（全仓库目前没这么用）。
- `node:sqlite` **不接受 `ArrayBuffer` 绑定**（要转 `Uint8Array`）。附件字节走 KV 不落 D1，
  但适配时建议 `bind()` 里统一做一次转换兜底。

### 3.3 可直接用的实现

```ts
// server/sqlite-d1.ts
import { DatabaseSync } from "node:sqlite";

export function makeSqliteD1(file: string) {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");   // 并发读写：读不阻塞写
    db.exec("PRAGMA busy_timeout = 5000");  // 写锁等待 5s 而不是立刻 SQLITE_BUSY
    db.exec("PRAGMA synchronous = NORMAL"); // WAL 下的推荐档：性能与安全平衡
    db.exec("PRAGMA foreign_keys = ON");    // ⚠️ 与 D1 行为对齐：sites 有 FK 到 groups

    const wrap = (stmt: any) => {
        let bound: any[] = [];
        const p = {
            bind(...args: unknown[]) {
                // node:sqlite 不吃 ArrayBuffer，统一转 Uint8Array
                bound = args.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
                return p;
            },
            all<T>() {
                return Promise.resolve({ results: stmt.all(...bound) as T[], success: true as const });
            },
            first<T>() {
                return Promise.resolve((stmt.get(...bound) ?? null) as T | null);
            },
            run() {
                const r = stmt.run(...bound);
                return Promise.resolve({
                    success: true as const,
                    meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
                });
            },
        };
        return p;
    };

    return {
        prepare: (sql: string) => wrap(db.prepare(sql)),
        exec: async (sql: string) => {
            db.exec(sql);
            return { count: 0, duration: 0 };
        },
        // ⚠️ 真 D1 的 batch 是**一个事务**：要么全成，要么全滚。
        // 测试替身用 Promise.all 是错的，生产必须显式包事务。
        // node:sqlite 全同步，所以这里不会和别的请求交错。
        batch: async (stmts: any[]) => {
            db.exec("BEGIN IMMEDIATE");
            try {
                const out = [];
                for (const s of stmts) out.push(await s.run());
                db.exec("COMMIT");
                return out;
            } catch (e) {
                db.exec("ROLLBACK");
                throw e;
            }
        },
    };
}
```

⚠️ `batch()` 里如果以后有 `SELECT`，D1 的 `batch` 也支持读语句并返回 `results`；
上面的实现只调了 `run()`，需要读时改成按语句类型分派。当前 29 处调用全是写，暂不处理。

---

## 四、文件 KV（附件存储）

```ts
// server/file-kv.ts
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";

export function makeFileKv(root: string) {
    const base = resolve(root);
    // 路径穿越防护：key 虽由代码生成，仍然守一道
    const safe = (key: string) => {
        const p = resolve(join(base, key));
        if (p !== base && !p.startsWith(base + "/")) throw new Error("非法的 KV key");
        return p;
    };
    return {
        async get(key: string, type?: "arrayBuffer") {
            try {
                const buf = await readFile(safe(key));
                if (type === "arrayBuffer") {
                    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                }
                return buf.toString("utf8");
            } catch {
                return null;
            }
        },
        async put(key: string, value: ArrayBuffer | ArrayBufferView | string) {
            const p = safe(key);
            await mkdir(dirname(p), { recursive: true });
            await writeFile(p, typeof value === "string" ? value : Buffer.from(value as any));
        },
        async delete(key: string) {
            await rm(safe(key), { force: true });
        },
    };
}
```

签名与 `worker/types.ts:57-64` 的 `KVNamespaceLike` 完全对得上，`attachments.ts` 一行都不用改。

---

## 五、Node 入口桥接

`worker/index.ts` 导出的是 `{ fetch(request, env), scheduled(controller, env) }`，
Node 侧只要造一个 `env` 再把 `fetch` 接到 `http` 上即可，**业务路由一行不动**。

```ts
// server/entry.ts（用 tsx 直接跑，或 esbuild 打包成 mjs）
import { createServer } from "node:http";
import { Readable } from "node:stream";
import handler from "../worker/index";
import { makeSqliteD1 } from "./sqlite-d1";
import { makeFileKv } from "./file-kv";

const env = {
    DB: makeSqliteD1(process.env.NAVIHIVE_DB ?? "./data/navihive.db"),
    FILES_KV: makeFileKv(process.env.NAVIHIVE_FILES ?? "./data/files"),
    AUTH_ENABLED: process.env.AUTH_ENABLED ?? "true",
    // ⚠️ VPS 上必须开：见下面第 3 条坑
    NAVIHIVE_TRUST_XFF: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "",
    ...(process.env.AUTH_USERNAME ? { AUTH_USERNAME: process.env.AUTH_USERNAME } : {}),
    ...(process.env.AUTH_PASSWORD ? { AUTH_PASSWORD: process.env.AUTH_PASSWORD } : {}),
};

createServer((req, res) => {
    // 用反代给的 scheme 拼 URL，否则 requestIsSecure 会误判成 http
    const proto = (req.headers["x-forwarded-proto"] as string) || "http";
    const url = new URL(req.url ?? "/", `${proto}://${req.headers.host ?? "localhost"}`);

    // ⚠️ Node 的 IncomingHttpHeaders 里重复头是 string[]，直接塞给 Headers 会炸，先摊平
    const h = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
        method: req.method,
        headers: h,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        duplex: "half",
    } as RequestInit);

    handler
        .fetch(request, env as any, { waitUntil() {}, passThroughOnException() {} })
        .then((response) => {
            const headers = Object.fromEntries(response.headers);
            // ⚠️ 多条 Set-Cookie 必须展开成数组，Object.fromEntries 会把它们粘成一条
            const cookies = response.headers.getSetCookie();
            if (cookies.length) headers["set-cookie"] = cookies;
            res.writeHead(response.status, headers);
            if (!response.body) return res.end();
            Readable.fromWeb(response.body as any).pipe(res);
        })
        .catch((e) => {
            console.error(e);
            res.writeHead(500).end();
        });
}).listen(8787);
```

三个必踩的坑（都在上面代码里处理了）：

1. **`duplex: "half"`** —— Node 的 `Request` 带 body 时必须显式声明半双工，否则抛 `TypeError`。
2. **`set-cookie` 多值** —— 登录会同时下发 `navihive_token` + `navihive_session` 两条。
   `Object.fromEntries(response.headers)` 会把它们用 `, ` 粘成一条，浏览器只认第一条 →
   **表现为「登录接口 200，但下一个请求 401，页面弹回登录页」**。必须用 `getSetCookie()` 展开。
3. **`NAVIHIVE_TRUST_XFF=1` + Nginx 传 `X-Forwarded-Proto`** —— `requestIsSecure()`
   （`worker/httpUtils.ts:73`）在没有 `CF-Visitor` 时只认 `X-Forwarded-Proto`，且要 `trustProxy` 为真。
   不配置的话 cookie 拿不到 `Secure` 属性（功能能用，但令牌会被降级）；
   反过来如果你在 http 下调试，就把 `NAVIHIVE_COOKIE_SECURE=0` 打开逃生舱。

---

## 六、数据迁移步骤

```bash
# 1) 从 D1 全量导出（标准 SQLite 方言）
npx wrangler d1 export navigation-db --remote --output d1-dump.sql

# 2) 灌进本地库
mkdir -p data && sqlite3 data/navihive.db < d1-dump.sql

# 3) 删掉 FTS 虚拟表，让 migrate() 按当前分词规则重建（见下）
sqlite3 data/navihive.db "DROP TABLE IF EXISTS notes_fts;"

# 4) 起服务，NavigationAPI.migrate() 会自动补到 SCHEMA_VERSION=21
```

四个注意点：

- **FTS 表不要从 dump 带过去。** D1 导出的 `notes_fts` 定义与本地 SQLite 可能有细微差异；
  直接删掉，启动时 `migrate()` 会重建，数据由 `notes.ts` 的同步逻辑回灌。这一步别省。
- **导出文件含敏感数据**：`users` 表的密码哈希、`configs` 里加密过的凭据。
  导出后加密存放，用完即删。
- **附件（KV）要单独搬**，最容易漏。先查有没有数据：
  ```bash
  npx wrangler kv key list --binding=FILES_KV
  ```
  有 key 就逐个 `wrangler kv key get --binding=FILES_KV "<key>" > data/files/<key>` 落盘。
  一个 key 都没有的话，这步直接跳过（说明你从没上传过笔记图片）。
- **迁移后 `AUTH_USERNAME` / `AUTH_PASSWORD` 可以不配**。密码以 D1 `configs` 表为准
  （`wrangler.jsonc` 头部注释写得很清楚：vars 只在首次部署时当种子）。只留 `AUTH_SECRET`
  用于令牌签名与数据加密即可 —— ⚠️ 这个值必须和线上**完全一致**，否则已加密的数据解不开。

---

## 七、定时任务

`worker/cron.ts:552` 的 `runScheduledTasks(env, undefined, cron)` 每小时跑一次，内部任务：
附件删除重试 → 导航页每周备份（代码内判 UTC 周一 02 点窗口）→ 死链巡检 → 记事本备份调度。

两种接法，二选一：

```ts
// A. 进程内（node-cron）—— 简单，但多实例会重复执行
import cron from "node-cron";
cron.schedule("0 * * * *", () => {
    runScheduledTasks(env, undefined, "0 * * * *").catch(console.error);
});
```

```bash
# B. 独立进程 + systemd timer —— 推荐：和 Web 进程解耦，天然不会重复跑
curl -fsS -X POST http://127.0.0.1:8787/__cron
```

⚠️ 如果用 PM2 cluster 或多副本，**定时任务会每个实例各跑一遍**（重复备份、重复巡检）。
要么单实例，要么用方案 B 独立进程，要么加文件锁。

`runScheduledTasks` 里的 `withDeadline` 是给 Workers 的 CPU/时间限制兜底的，VPS 上无害，保留即可。

---

## 八、Nginx 配置

```nginx
server {
    listen 443 ssl http2;
    server_name myhp.zwjttzt.com;

    ssl_certificate     /etc/letsencrypt/live/myhp.zwjttzt.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/myhp.zwjttzt.com/privkey.pem;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    # 有 Brotli 模块就换 brotli，JS 还能再小 15~20%

    root /srv/navihive/dist;

    # 带 hash 的构建产物：一年强缓存（Vite 已生成 contenthash）
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # API 走 Node
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # ⚠️ 必须：决定 cookie 的 Secure
        proxy_buffering off;                          # 导出/流式接口别缓冲
        proxy_read_timeout 300s;                      # 导入 / WebDAV 上传可能很久
        client_max_body_size 30m;                     # 附件单文件 25MB（ATTACHMENT_MAX_BYTES）
    }

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

`client_max_body_size` 必须 ≥ 26MB，否则附件上传会在 Nginx 这层先挂
（`worker/attachments.ts:35` 的 `ATTACHMENT_MAX_BYTES = 25MB`，而 Worker 侧的
`readBoundedBytes` 给它单独开了额度）。

---

## 九、运维：备份是这次迁移最大的新增责任

D1 托管版自带 point-in-time 恢复，搬到 VPS 后**这些全没了**，必须自己补：

```bash
# ⚠️ 不能直接 cp：WAL 模式下会拿到不一致的快照。
# 用 VACUUM INTO（目标文件必须不存在）
sqlite3 data/navihive.db "VACUUM INTO '/backup/navihive-$(date +%F).db'"
rclone copy /backup remote:navihive-backup/     # 异地
```

- 频率：每天一次全量 + 保留 30 天。
- 进程守护：systemd `Restart=always` + `RestartSec=3`；配个 `/api/health` 之类的探活。
- 建议**保留 Cloudflare 那套跑一段时间**做灾备，确认 VPS 侧稳定后再下线。

---

## 十、分阶段落地与工作量

| 阶段 | 内容 | 预估 |
|---|---|---|
| 1 | `server/` 目录：SQLite 适配器 + 文件 KV + Node 入口，本地 `tsx` 跑通登录与 CRUD | 半天 |
| 2 | D1 导出灌入 + 附件迁移 + 跑现有回归脚本（`e2e` / `e2e:share` / `e2e:webdav` / `e2e:cron`） | 半天 |
| 3 | Nginx + TLS + 定时任务 + 备份 + systemd | 半天 |
| 4 | 灰度：先把自己的 DNS 指过去观察一周，再切正式 | 1 周（等待时间） |

**纯编码约 1.5 天**。阶段 2 的回归脚本是现成的（`package.json` 里 `e2e` / `e2e:share` /
`e2e:webdav` / `e2e:cron` 四个），它们打的是 HTTP 接口，搬到 VPS 后可以直接复用 —— 这是这个
项目做自托管的又一个便宜之处。

---

## 十一、风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| VPS 单点 | 机器挂 = 站点全挂，Workers 时代没有这个问题 | 快照 + 监控告警 + 保留 CF 侧灾备 |
| SQLite 在本地盘 | 云盘故障 / 误删 = 数据丢失 | **必须**异地备份（第九节）；选带快照的云盘 |
| 失去 CF 的边缘缓存 / WAF / 免费额度 | 静态资源不再有全球边缘 | 靠 Nginx 本地缓存弥补；单用户场景影响很小 |
| 失去 D1 的 point-in-time 恢复 | 误操作无法回滚到 5 分钟前 | 备份频率补；写操作前先手动导出 |
| `batch()` 事务语义不一致 | 适配错了会出现「数据半删」 | 阶段 2 重点回归删除/回收站/墓碑相关用例 |
| KV 附件漏迁 | 笔记里的图片全部 404 | 迁移前先 `wrangler kv key list` 确认有无数据 |
| 多实例重复跑定时任务 | 重复备份、重复巡检 | 单实例或独立 cron 进程（第七节） |

---

## 十二、待确认

1. **VPS 地区**：域名有 ICP 备案 → 放国内（TTFB 20–50ms，最快）；没有 → 中国香港 / 东京 / 新加坡
   （30–60ms，仍然远好于现在绕欧洲的 1–2s）。
2. **要不要直接在仓库里建 `server/` 目录**：本文的代码可以直接落盘，配合 `npm run` 脚本加一条
   `start:selfhost` 即可，不影响现有 Workers 部署路径。
3. **有没有笔记附件**：决定第六步第 3 条的迁移工作量。
4. **Node 版本**：建议 24 LTS；用 `node:sqlite` 需 ≥ 22.5，用 `better-sqlite3` 则无此限制。
