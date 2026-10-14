# 方案 B 落地手册：整站自托管

把 NaviHive 从 Cloudflare Workers + D1 + KV 搬到一台 VPS 上用 Node 跑。
**业务代码一行没改** —— `worker/` 与 `src/API/` 原本就只依赖 Web 标准 API，
本方案只是把平台替我们做的四件事（D1、KV、静态资源、定时任务）在 `server/` 里重新长出来。

原理与取舍见 `docs/selfhost-plan-2026-10-14.md`；这份手册只讲**怎么落地**。

---

## 一、这次落地改了什么

| 文件 | 作用 |
|---|---|
| `server/sqlite-d1.ts` | `node:sqlite` → D1 形状适配器（真事务 batch、RETURNING 行、外键开启） |
| `server/file-kv.ts` | 本地目录 → `KVNamespaceLike`（笔记图片附件，带路径穿越防护） |
| `server/entry.ts` | Node 入口：HTTP 桥接 + 静态资源（含 `_headers` 规则与 SPA fallback）+ 定时任务 |
| `server/static.ts` | 静态资源与 `_headers` 解析（从 entry.ts 抽出，单测覆盖） |
| `script/build-server.mjs` | esbuild 把入口打成自包含单文件 `dist-server/entry.mjs` |
| `script/selfhost-smoke.mjs` | 26 项端到端冒烟（登录/改密/CRUD/静态头/SPA/附件/cron/404） |
| `tests/server*.test.ts` | 35 条单测：事务原子性、RETURNING 行、外键、文件 KV、`_headers` 解析 |
| `deploy/nginx/sites-available/navihive-selfhost.conf` | 自托管版 Nginx 配置 |
| `Dockerfile` / `.dockerignore` / `docker-compose.yml` / `.env.example` | 容器化部署件（第四节 B） |
| `tests/dockerDeploy.test.ts` | Docker 部署件漂移守卫（17 条） |
| `tsconfig.server.json` | 服务端目录的独立类型检查配置 |

新增脚本：`npm run build:server`、`npm run start:selfhost`、`npm run smoke:selfhost`。
Workers 部署路径（`npm run deploy`）完全不受影响，两条路可以并行跑一段时间。

---

## 二、快速开始（本机 5 分钟）

```bash
npm ci
npm run build          # 产出 dist/client（含 _headers）
npm run build:server   # 产出 dist-server/entry.mjs

# 起服务（密钥随便给一个，仅本地验证用）
AUTH_SECRET=$(openssl rand -hex 32) npm run start:selfhost
# → 监听 http://127.0.0.1:8787

# 另开一个终端跑冒烟（26 项）
npm run smoke:selfhost http://127.0.0.1:8787
```

首次启动会自动建库建表（`NavigationAPI.migrate()` 补到当前 `SCHEMA_VERSION`），
并用 `AUTH_USERNAME` / `AUTH_PASSWORD` 种下第一个账号（默认 `root` / 见下方环境变量表）。
冒烟会覆盖：登录 → 改密 → 重登 → 建分组/站点 → PUT 站点 → 静态响应头 → SPA fallback
→ 附件上传读回 → 结构化 404。

> 想用 Docker？直接跳到**第四节 B**（`docker compose up -d --build` 一把起）。

> ⚠️ `node:sqlite` 在 Node 22.5+ 才可用，且启动会打一条 ExperimentalWarning
> （`start:selfhost` 已带 `--disable-warning` 静音）。生产建议 **Node 24 LTS**。

---

## 三、环境变量全表

配置全部走环境变量（systemd `EnvironmentFile` 或 `.env`），没有配置文件、没有命令行参数。

### 服务本身

| 变量 | 默认 | 说明 |
|---|---|---|
| `NAVIHIVE_PORT` | `8787` | 监听端口 |
| `NAVIHIVE_HOST` | `127.0.0.1` | 监听地址。**前面挡 Nginx 就别改**；直接暴露公网才改 `0.0.0.0`（不建议） |
| `NAVIHIVE_DB` | `./data/navihive.db` | SQLite 库文件路径（目录会自动建） |
| `NAVIHIVE_FILES` | `./data/files` | 附件根目录 |
| `NAVIHIVE_STATIC_DIR` | `./dist/client` | 构建产物目录 |
| `NAVIHIVE_TRUST_XFF` | `1` | 是否信任 `X-Forwarded-For`（限速分桶用）。**挡 Nginx 时保持 1**；端口直接暴露公网必须设 `0`，否则改个请求头就能换限速桶、绕开爆破防护 |
| `NAVIHIVE_CRON` | `1` | 进程内每小时跑一次定时任务。多副本部署必须设 `0`（否则每个副本各跑一遍），改用 `POST /__cron` |
| `NAVIHIVE_CRON_TOKEN` | 空 | `POST /__cron` 的 bearer token。**不配 = 该端点 404** |

### 密钥与业务开关（按需）

| 变量 | 说明 |
|---|---|
| `AUTH_ENABLED` | `true`（默认）/ 其他值 = 关鉴权，仅内网调试用 |
| `AUTH_SECRET` | **`AUTH_ENABLED=true` 时必配**。令牌签名 + 数据加密。从 D1 迁数据时必须和线上完全一致，否则已加密的凭据解不开 |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | 只在**首次建库**时当种子；库已存在则忽略（以 `configs` 表为准） |
| `DATA_ENCRYPTION_KEY` | 站点凭据加密密钥。迁库时必须与线上一致 |
| `JWT_SECRET` / `JWT_SECRET_OLD` | 令牌签名密钥（轮换时旧的放 `JWT_SECRET_OLD`） |
| `AUTH_RECOVERY_PUBLIC_KEY` | 恢复流程用 |
| `NAVIHIVE_COOKIE_SECURE` | 逃生舱：反代不传 `X-Forwarded-Proto` 又只能 http 访问时设 `0`，否则令牌 cookie 存不上、登录必掉线 |
| `NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR` | 会话校验出错时是否放行。默认 fail-closed，别随便开 |

启动时会打两条告警自查：`AUTH_ENABLED=true` 但没配 `AUTH_SECRET`（登录必然失败）、
`AUTH_ENABLED` 不是 `true`（站点无需登录即可读写）。

---

## 四、VPS 部署

两种接法二选一：**A. systemd**（Node 直接跑，最小依赖）或 **B. Docker**（容器，升级回滚更干净）。
数据都在 `data/`（库 + 附件）里，两种接法共用一套备份与迁移步骤。

### A. systemd

```bash
# 1) 代码落到 /srv/navihive，构建一次
sudo mkdir -p /srv/navihive && cd /srv/navihive
# （把仓库 clone / rsync 过来）
npm ci && npm run build && npm run build:server

# 2) 密钥文件：权限收紧，只有服务账号能读
sudo install -d -m 700 /etc/navihive
sudo tee /etc/navihive/env >/dev/null <<'EOF'
AUTH_ENABLED=true
AUTH_SECRET=换成 64 位十六进制
DATA_ENCRYPTION_KEY=与线上一致
JWT_SECRET=与线上一致
NAVIHIVE_TRUST_XFF=1
NAVIHIVE_CRON=1
EOF
sudo chmod 600 /etc/navihive/env
```

`/etc/systemd/system/navihive.service`：

```ini
[Unit]
Description=NaviHive self-hosted
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/navihive
EnvironmentFile=/etc/navihive/env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist-server/entry.mjs
Restart=always
RestartSec=3
# 自托管最大的新增责任是备份，别让进程被 OOM 悄悄杀干净
MemoryMax=512M
# 最小权限：只读代码目录 + 读写数据目录
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/navihive/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now navihive
sudo systemctl status navihive
```

探活用 `/api/init`（公开路由，无需登录，回 `{"ok":true,"initialized":true}`）：

```bash
curl -fsS http://127.0.0.1:8787/api/init
```

> 升级就是 `git pull && npm run build && npm run build:server && sudo systemctl restart navihive`。
> 库的迁移在启动时自动做，不用手工跑 SQL。

### B. Docker

仓库根四个文件：`Dockerfile`（多阶段，运行镜像只带 `dist/client` + `dist-server/entry.mjs`，
没有 node_modules 也没有源码）、`.dockerignore`、`docker-compose.yml`、`.env.example`。

```bash
# 1) 代码落到 /opt/navihive，按需改 .env
cd /opt/navihive
cp .env.example .env
$EDITOR .env            # AUTH_SECRET 必填；从 D1 迁了数据还要填 DATA_ENCRYPTION_KEY / JWT_SECRET

# 2) 构建并起服务（首次构建要编译整个前端，小机器上几分钟）
docker compose up -d --build
docker compose logs -f navihive        # 看到「NaviHive 自托管服务已启动」+ 两条自检告警（没有才算对）

# 3) 验证
curl -fsS http://127.0.0.1:8787/api/init     # → {"ok":true,"initialized":true,...}
docker inspect --format='{{.State.Health.Status}}' navihive   # → healthy（探活打的就是 /api/init）
```

几个和 systemd 接法不同、值得记住的点：

- **数据在命名卷 `navihive-data` 里**（容器内 `/app/data`），`docker compose down` 不丢，
  重建容器也不丢。换机器迁移 = 把这个卷拷走。想用绑定挂载（`./data:/app/data`）也行，
  但宿主机目录要先 `chown 1000:1000`——容器里是 `node` 用户，不是 root。
- **compose 强制要求 `AUTH_SECRET`**（`${AUTH_SECRET:?…}` 语法）：没设就直接启动失败，
  不会给你一个「起来了但登不进去」的服务。`.env` 已在 `.gitignore` 和 `.dockerignore` 里。
- **端口只绑宿主机回环**（`127.0.0.1:8787`），TLS 仍然交给前面的 Nginx/Caddy。
  确认过风险才能改成 `8787:8787`，且那时必须 `NAVIHIVE_TRUST_XFF=0`。
- **小内存机器构建要 swap**：`tsc -b` 全量编译在 512MB 内存的机器上会 OOM
  （Node 按物理内存把堆上限收到 ~257MB，exit 134）。Dockerfile 已设
  `NODE_OPTIONS=--max-old-space-size=3072` 兜住，但**至少再给 2G swap**：
  ```bash
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```
  （这只是上限不是预分配，大内存机器上毫无影响。）
- **备份命令和 systemd 版不同**——容器里没有 `sqlite3` CLI，见第七节。
- 升级：`git pull && docker compose up -d --build`，迁移照旧在启动时自动做。

> **已实测（2026-10-14）**：Debian 13 / 1 核 / 464MB 内存 / Docker 29.9.0 的 VPS 上
> 真构建真跑过——镜像构建 8 分 26 秒成功（356MB），端到端验证 29 项全过：
> 登录 → 首登强制改密 → 重新登录 → bootstrap → 建分组 → 读回 → CSP 三头
> （`trusted-types navihive-sw` / XFO / XCTO）→ SPA fallback → 未知路由 404 →
> `POST /__cron` 无 token 404 → healthcheck healthy → 容器以 node(1000) 运行 →
> 重启后数据还在 → **删掉容器重建后数据还在**（升级路径）→ 旧种子密码已失效。
> compose 也实测了：不配 `AUTH_SECRET` 直接拒绝启动、`.env` 正确贯通、端口只绑回环。

---

## 五、Nginx

用 `deploy/nginx/sites-available/navihive-selfhost.conf`（与方案 A 的反代配置同目录，
区别只是上游从 `*.workers.dev` 变成本机 Node）。要点：

- **静态资源也走 Node**，不配 `root`。这样 CSP 等安全头仍然只有 `dist/client/_headers`
  一个事实来源 —— Nginx 认不了 `_headers`，抄一份进 nginx 配置必然漂移，而 CSP 少一条
  （比如 `trusted-types navihive-sw`）表现为 Service Worker 注册静默失败，没有任何报错。
  单用户站点的静态吞吐 Node 绰绰有余；gzip 由 Nginx 这一层补。
- `proxy_set_header X-Forwarded-Proto $scheme` **必须有**：cookie 的 `Secure` 属性靠它判断。
- `client_max_body_size 30m`：附件单文件上限 25MB，小了会在 Nginx 这层先挂。
- `/api/webdav/` 超时放到 600s：备份上传封顶 10 分钟。

首次上线证书还不存在时，`nginx -t` 会失败 —— 先只留 80 端口的 acme 块，
`certbot certonly --webroot` 签完证书再启用 443。

---

## 六、定时任务

`worker/cron.ts` 的 `runScheduledTasks` 每小时一轮：附件删除重试 → 导航页每周备份
→ 死链巡检 → 记事本备份调度。两种接法二选一：

**A. 进程内（默认，`NAVIHIVE_CRON=1`）** —— 零配置，对齐 UTC 整点。单实例部署用它。

**B. 外部触发（多副本 / 想把定时任务和 Web 进程解耦时）** —— 服务设 `NAVIHIVE_CRON=0`，
再配 token，然后用 systemd timer 或 crontab 打：

```bash
curl -fsS -X POST -H "Authorization: Bearer $NAVIHIVE_CRON_TOKEN" http://127.0.0.1:8787/__cron
```

没配 token 时该端点恒 404（冒烟里有这条断言），不会成为一个无鉴权的触发口。

---

## 七、备份（这次迁移最大的新增责任）

D1 托管版自带时间点恢复，搬到 VPS 后**全没了**，必须自己补。

```bash
# ⚠️ 不能直接 cp：WAL 模式下会拿到不一致的快照。VACUUM INTO 目标文件必须不存在
mkdir -p /backup
sqlite3 /srv/navihive/data/navihive.db "VACUUM INTO '/backup/navihive-$(date +%F).db'"

# 附件单独备（KV 搬过来的二进制全在这儿）
rsync -a /srv/navihive/data/files/ /backup/files-$(date +%F)/

# 异地（示例用 rclone，换成任何你有的对象存储 / 另一台机器都行）
rclone copy /backup remote:navihive-backup/
```

Docker 接法容器里没有 `sqlite3` CLI，用 `node:sqlite` 跑同一条 SQL（效果一样，都是快照）：

```bash
# 库：在容器内 VACUUM INTO，再拷出来、删掉容器里的中间文件（目标必须不存在，下次还要用）
docker compose exec navihive node --input-type=module -e \
  "import { DatabaseSync } from 'node:sqlite'; new DatabaseSync('/app/data/navihive.db').exec(\"VACUUM INTO '/app/data/backup.db'\")"
docker compose cp navihive:/app/data/backup.db ./navihive-$(date +%F).db
docker compose exec navihive rm /app/data/backup.db

# 附件：tar 流式导出
docker compose exec navihive tar czf - -C /app/data files > files-$(date +%F).tgz
```

建议：每天一次全量、保留 30 天；**先验一遍能恢复**（`sqlite3 备份文件 "PRAGMA integrity_check;"`）
再信任它。数据库文件含密码哈希与加密凭据，备份要按敏感数据对待（加密存放、传输用 TLS）。

---

## 八、从 D1 迁数据

```bash
# 1) 全量导出（标准 SQLite 方言）
npx wrangler d1 export navigation-db --remote --output d1-dump.sql

# 2) 灌进本地库（服务先停掉，避免迁移逻辑和灌库打架）
sudo systemctl stop navihive
mkdir -p /srv/navihive/data
sqlite3 /srv/navihive/data/navihive.db < d1-dump.sql

# 3) 删掉 FTS 虚拟表，让 migrate() 按当前分词规则重建
sqlite3 /srv/navihive/data/navihive.db "DROP TABLE IF EXISTS notes_fts;"

# 4) 起服务，migrate() 自动补到当前 SCHEMA_VERSION，FTS 数据由同步逻辑回灌
sudo systemctl start navihive
```

四个注意点：

- **FTS 表不要从 dump 带过去**（第 3 步别省）：D1 导出的定义与本地 SQLite 可能有细微差异，
  删掉让代码重建最稳。
- **附件（KV）要单独搬**，最容易漏。先查有没有数据：
  ```bash
  npx wrangler kv key list --binding=FILES_KV
  ```
  有 key 就逐个 `wrangler kv key get --binding=FILES_KV "<key>" > data/files/<key>` 落盘
  （key 形如 `attach/<userId>/<uuid>`，子目录要一起建）。一个 key 都没有就直接跳过。
- **导出文件含敏感数据**（`users` 的密码哈希、`configs` 里加密过的凭据）：加密存放，用完即删。
- **`AUTH_SECRET` / `DATA_ENCRYPTION_KEY` / `JWT_SECRET` 必须与线上完全一致**，
  否则老令牌全部失效、已加密的站点凭据解不开。迁完先用自己的账号登一次验证。

---

## 九、灰度切流与回滚

1. 先按第四节起好服务，用 `npm run smoke:selfhost` 过一遍，再手工点一遍关键路径
   （登录、改卡片、传一张笔记图片、跑一次 WebDAV 备份）。
2. DNS 把 `myhp.zwjttzt.com` 的 TTL 提前调到 60s，然后改指 VPS。
3. **Cloudflare 那套留着别删**，观察至少一周（备份有没有真跑起来、附件能不能读、限速有没有误伤）。
4. 回滚 = DNS 改回 Cloudflare，一分钟量级。数据方向是「D1 → VPS」单向的，
   回滚前如果在 VPS 上写过数据，需要再导回来（所以建议观察期内 VPS 侧只读先用）。

---

## 十、排障

| 现象 | 先看哪 |
|---|---|
| 登录 200 但立刻掉线 | ① Nginx 有没有传 `X-Forwarded-Proto`；② 真只 http 访问就设 `NAVIHIVE_COOKIE_SECURE=0`；③ 多条 Set-Cookie 有没有被中间层黏成一条（`curl -i` 数一下） |
| 静态页没有 CSP / SW 注册失败 | `dist/client/_headers` 没构建出来或路径不对（启动时有告警）；`NAVIHIVE_STATIC_DIR` 指错 |
| 写操作 403 | 同源判据是 `Sec-Fetch-Site`；确认访问用的就是站点自己的域名，没有混用 workers.dev |
| 附件 413 | Nginx `client_max_body_size` 小于 25MB |
| `SQLITE_BUSY` | 有别的进程在写（备份脚本 / 手工 sqlite3）。适配器已开 WAL + 5s 等待；备份请用 `VACUUM INTO` 而不是长事务 |
| 定时任务没跑 | `NAVIHIVE_CRON=1`？多副本是不是每个都跑了？外部触发就看 `NAVIHIVE_CRON_TOKEN` 配了没 |
| 改完代码不生效 | `npm run build && npm run build:server` 之后**重启服务**；`dist-server/` 是构建产物，不会热更新 |
| **Docker：构建 OOM（exit 134 / `Aborted (core dumped)`）** | 小内存机器上 Node 按物理内存把堆上限收到 ~257MB，`tsc -b` 直接爆。Dockerfile 已设 `NODE_OPTIONS=--max-old-space-size=3072`，**但至少要给 2G swap**（`fallocate -l 2G /swapfile && mkswap && swapon`） |
| **Docker：compose 显示 Up 但宿主连不上** | 上一次 `up` 因端口冲突失败后会留一个半成品容器（PortBindings 有、实际映射没建立）。`docker compose down && docker compose up -d` 重建即可 |
| **Docker：compose 拒绝启动并提示 AUTH_SECRET** | 设计如此（`${AUTH_SECRET:?…}`）：宁可直接失败，也不给一个「起来了但登不进去」的服务。去 `.env` 配上 |
| **Docker：绑定挂载（`./data`）写不进** | 容器里是 `node` 用户（uid 1000）不是 root。宿主机目录 `chown 1000:1000`，或改用命名卷 |
| **Docker：首登后任何写操作 403** | 种子账号首登强制改密是既定行为，不是故障。`PUT /api/auth/credentials` 改完再写 |

---

## 十一、安全须知

- **不要把 8787 直接暴露公网**。默认只听 `127.0.0.1` 是故意的；真要不挡 Nginx，
  必须 `NAVIHIVE_TRUST_XFF=0`（否则改 `X-Forwarded-For` 就能换限速桶）。
  Docker 接法同理：compose 的端口映射默认只绑 `127.0.0.1`，改直连前先想清楚这条。
- `AUTH_ENABLED` 不是 `true` 时全站无需登录即可读写，只适合内网调试。
- 密钥文件（`/etc/navihive/env` 或 Docker 的 `.env`）权限 600，别进 git
  （`.gitignore` 已忽略 `.env`，`.dockerignore` 同样排除——进镜像等于把密钥烙进层里）。
- 服务按最小权限跑：systemd 段已给 `ProtectSystem=strict` + `ReadWritePaths`；
  Docker 镜像以 `node` 用户运行，只挂 `/app/data`，它只需要读代码目录、写 `data/`。
- 数据库文件含密码哈希与加密凭据，备份按敏感数据对待（加密存放、传输用 TLS）。
