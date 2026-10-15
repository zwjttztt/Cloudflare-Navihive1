# 自托管（方案 B）全模块走查与修复清单

日期：2026-10-16 · 范围：`zwjttztt/Cloudflare-Navihive1`，自托管部署形态（Docker + Node + SQLite + 本地文件 KV，前挡 nginx）
方法：先把 `dist-server` 跑起来（全新库），逐模块打真实 HTTP 接口，把非预期状态码挑出来定位；再回到代码找根因、改、补守卫、**反向验证守卫真的会红**。

走查脚本留在 `Claw/selfhost-walkthrough.mjs`（仓库外，一次性排查工具）：起服务 → 登录 → 83 项检查，覆盖用户与权限、系统配置、导入导出、回收站、日志监控、定时任务、分享公开页、附件、静态资源、批量与排序、笔记检索、多账号。

走查结果：**修复前 8 项非预期 → 修复后 83 项全绿**。

---

## 一、修复清单

### P0-1 · 撤销分组分享会把整个分组删进回收站（阻断性 · 数据破坏 · 两端共有）

| 项 | 内容 |
| --- | --- |
| 现象 | 分组分享弹窗里点「撤销分享」，该分组**连同里面所有卡片**一起消失（进回收站）。同时「查分享配置」返回的是分组对象，「更新有效期/口令」改不动。 |
| 影响 | 任何人只要在界面上点一下撤销，就丢一整个分组的数据。可恢复（回收站），但用户当时只看到「分组没了」。 |
| 根因 | `worker/routes/data.ts` 的分支顺序：`path.startsWith("groups/")` 的三条（GET / PUT / DELETE）排在更具体的 `/^groups\/\d+\/share$/` **之前**。前缀分支取 id 用 `parseInt(path.split("/")[1])`，`"7/share"` 被 `parseInt` 读成 `7` 且**不报 NaN** —— 于是 DELETE 静默落到「删分组」上。同类坑在 `notes/` 那边处理对了（`/^notes\/\d+\/share$/` 排在前缀分支之前），`groups/` 这一侧漏了。 |
| 改动 | `worker/routes/data.ts`：把 `/^groups\/\d+\/share$/` 整块移到 `groups/` 前缀分支之前，并把「必须排在前缀分支之前」的理由写进注释（含 `parseInt` 不报 NaN 这一点）。 |
| 验证 | `tests/dataRoutes.test.ts` 新增 6 条（撤销走 revoke 分支且 `log.deleted` 为空、查配置返回 token、PUT 走 update 分支、POST 走 create、有效期白名单、删分组本身不被抢）。反向验证：把分支挪回原处，3 条用例立刻变红。`script/selfhost-smoke.mjs` 补端到端一条（撤销后分组还在）。 |

> ⚠️ 这条在 Worker 路由层，**Cloudflare 端与自托管端同样受影响**，不是自托管独有。

### P1-2 · 缺失的静态资源回 200 + text/html（功能性 · 仅自托管）

| 项 | 内容 |
| --- | --- |
| 现象 | 请求一个不存在的 `/assets/xxx.js`，拿到的是 200 和一整页 index.html。 |
| 影响 | 浏览器按缓存里的旧 index.html 去请求**早已被新版本删掉**的 chunk 时，会因 MIME 检查拒绝执行：`Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of text/html`。表现为**发版后随机白屏**，刷新也不一定救得回来（Service Worker 可能已把这份 HTML 当脚本缓存下来）。 |
| 根因 | `server/static.ts` 的 SPA fallback 实现成「任何没命中文件的路径都回 index.html」，并把这当成 `wrangler.jsonc` 的 `not_found_handling = "single-page-application"` 的等价物。实际 CF 文档的语义是「为**导航请求**（带 `Sec-Fetch-Mode: navigate`）回 index.html」，子资源请求照样 404。 |
| 改动 | `server/static.ts` 新增 `looksLikeAsset()`：未命中且路径最后一节带扩展名 → 404（仍套一遍 `_headers` 规则）。不带扩展名的路径照旧回退（分享短链 `/sg/<64 位 hex>` 靠这个，且它们常被 curl / 抓预览的机器人打开，未必带 `Sec-Fetch-Mode`）。 |
| 验证 | `tests/serverStatic.test.ts` 新增 3 条（缺失资源 404 且不带 HTML、HEAD 同样 404、不带扩展名的路径照旧回退）。反向验证：把判断短路掉，2 条变红。`script/selfhost-smoke.mjs` 补两条。 |

### P1-3 · 直连时所有人共用一个限速桶、审计日志 IP 全是 unknown（功能性 · 仅自托管）

| 项 | 内容 |
| --- | --- |
| 现象 | 不挡反代、直接把端口暴露出去时，审计日志与会话列表里的来源 IP 一律 `unknown`。 |
| 影响 | 两处：① 事后排查无线索；② 登录爆破限速按 IP 分桶，`unknown` = **全场共用一个桶** —— 一个人连错 5 次，所有人在接下来几分钟内都登不上。 |
| 根因 | `worker/httpUtils.ts clientIp()` 与 `worker/loginGuard.ts clientBucket()` 只认 `CF-Connecting-IP` / `X-Forwarded-For` 两个头；Node 侧没人把 socket 对端地址补进去。 |
| 改动 | `server/entry.ts`：缺 `X-Forwarded-For` 时用 `req.socket.remoteAddress` 补上（`::ffff:1.2.3.4` 归一化成点分十进制）。已有的 XFF 不覆盖 —— 反代链更长时由最外层那条说话。worker 代码一行未改。 |
| 验证 | 走查里审计条目 IP 从 `unknown` 变成 `127.0.0.1`。`tests/serverNet.test.ts` 5 条覆盖 IP 归一化与回环判定。 |

### P1-4 · 笔记全文检索只有冷启动后第一个请求用得上 FTS5（功能性 · 两端共有）

| 项 | 内容 |
| --- | --- |
| 现象 | 搜索响应里的 `mode` 字段是 `"like"` 而不是 `"fts"`（走查第 67 项抓到）。 |
| 影响 | 结果还在（所以没人报 bug），但**没有 bm25 相关度排序**（标题命中不再排在正文命中之前），笔记多了还会退化成 LIKE 全表扫。控制台一声不响，唯一线索是响应里的 `mode`。 |
| 根因 | `notesFtsReady` 原先是 `NavigationAPI` 的**实例**字段，只在 `migrateNotesFtsTable()` 里置真；而 `migrate()` 的 promise 是**模块级**缓存的（每个 isolate 只真跑一次），NavigationAPI 是**每个请求 new 一个**。于是第一个请求之后，所有实例的 `notesFtsReady` 都是初始值 `false`。 |
| 改动 | 真值移到模块级 `migrationState.ftsReady`（`src/API/methods/internals.ts`），`navigationApi.ts` 改成只读 getter；`resetMigrationCacheForTests()` 一并清它（否则上一个用例的结果会串到下一个）。 |
| 验证 | `tests/noteFtsRealSql.test.ts` 新增「第二个请求（新 new 出来的 api 实例）也知道 FTS 可用」。反向验证：换回实例字段，3 条变红。走查里 `mode` 已回到 `"fts"`。 |

### P2-5 · 随仓库发布的 nginx 配置：请求头指令只写在 `location /` 里（体验性 · 部署件）

| 项 | 内容 |
| --- | --- |
| 现象 | `/api/login`、`/api/webdav/`、`/assets/` 三个 location 拿不到 `X-Forwarded-For` / `X-Forwarded-Proto`。 |
| 影响 | ① 登录接口拿不到 XFF → 应用层的失败限速仍是全场一个桶（nginx 那层 `limit_req` 按 `$binary_remote_addr` 是好的，但它是硬限、挡不住这一条）；② 这三个 location 的响应 cookie 少了 `Secure`。 |
| 根因 | nginx 的继承规则是「当前级别一条 `proxy_set_header` 都没有，才继承上级」。写在 `location /` 里的那几行只对 `location /` 生效，平级 location 不会继承兄弟块。 |
| 改动 | `deploy/nginx/sites-available/navihive-selfhost.conf`：四行 `proxy_set_header` 与 `proxy_http_version 1.1` 提到 `server` 级；`location /` 只留本块特有的 `proxy_buffering off`（不能一起提上去 —— `/assets/` 开着 `proxy_cache`，缓冲必须留着）。 |
| 验证 | 配置已提交；生产机（131.186.58.86）上的 `/home/web/conf.d/home.zwjttzt.com.conf` 按同一条规则核对后同步修正。 |

### P2-6 · 启动自检缺两条「跑错了但不报错」的提醒（体验性 · 仅自托管）

| 项 | 内容 |
| --- | --- |
| 现象 | ① `NAVIHIVE_CRON=0` 且没配 `NAVIHIVE_CRON_TOKEN` → 定时任务既不在进程内跑、也没有外部触发口，等于全关，启动日志却只淡淡打印「定时任务 关闭」；② 监听 `0.0.0.0` 却开着 XFF 信任 → 客户端随手加个头就能换限速桶。 |
| 改动 | `server/entry.ts` 启动时按条件打醒目警告；回环判定抽成 `server/net.ts#isPublicHost`（`server/entry.ts` 一被 import 就会起服务，抽出来才能单测）。 |
| 验证 | `tests/serverNet.test.ts` 覆盖回环/通配判定。 |

---

## 二、走查覆盖与结论（未发现问题的模块）

| 模块 | 走查项 | 结论 |
| --- | --- | --- |
| 用户与权限 | init / 登录 / 强制改密 / 重登 / `auth/me` / 会话列表 / 用户列表 / 邀请码 / 空体 DELETE / 退出登录 / 令牌拉黑 / 重新登录 | 全通过。两条 Set-Cookie 展开正确（登录 200 后下一个请求不 401）。 |
| 系统配置 | 单键读写 / 批量写（含空串）/ 空体 DELETE | 全通过。批量接口收空串、单键拒空值的契约符合预期。 |
| 数据导入导出 | 导出 / **重复导入幂等**（分组不翻倍）/ 笔记 | 全通过（`stats` 里新增 0、匹配 1）。详见 CHANGELOG 2026-10-16（一）。 |
| 回收站 | 删分组 → 回收站有条目 → 列表少一条 → 还原 → 分组与卡片都回来 | 全通过。 |
| 日志与监控 | 回收站 / 审计日志 / 统计 / 客户端错误上报 | 全通过。修复 P1-3 后审计带真实来源 IP。 |
| 任务与服务 | `/__cron` 无 token / 错 token / 带 token、WebDAV test / list | 全通过。cron 的 4 个子任务（死链巡检 / 记事本备份 / 沉睡扫描 / 过期清理）都跑完且各带耗时上限。 |
| 分享与公开页 | 创建 / 公开读 / 查配置 / 撤销 / 撤销后失效 | 修复 P0-1 后全通过。 |
| 附件（KV → 本地目录） | 上传 / 读回字节一致 / 删除（空体）/ 列表 / prune / **1MB 大图** | 全通过。 |
| 静态资源 | index.html + CSP + X-Frame-Options / assets 强缓存 / sw.js / SPA 回退 / **缺失资源 404** | 修复 P1-2 后全通过。 |
| 批量与排序 | 分组排序 / 增量变更轮询 / bootstrap | 全通过。 |
| 笔记检索 | reindex / 中文 / 英文 / 空结果 | 修复 P1-4 后 `mode` 为 `fts`。 |
| 多账号 | owner 生成邀请码 → 匿名注册普通账号 → 出现在用户列表 → 吊销其他会话 | 全通过。 |

**额外确认**：`node:sqlite`（SQLite 3.51.2）具备 FTS5 / JSON1 / CTE / UPSERT / RETURNING / 窗口函数；`segmentCJK` 是应用层 JS 分词函数、不是 SQLite 分词器，标准 `unicode61` 足够承载它 —— 自托管端笔记检索无平台障碍。

---

## 三、验证方式（全绿）

```
npx tsc -b --force        通过
npm run lint              19 warnings / 0 errors（都是既有的 react-refresh、exhaustive-deps）
node script/unit-tests.mjs  2716 tests / 2716 pass / 0 fail（2701 → 2716）
npm run check:brand       品牌信息三处一致
npm run build             ✓ built in 5.65s
npm run smoke             全部通过
node script/selfhost-smoke.mjs  通过 33 项，失败 0 项（新增 4 项回归钉）
Claw/selfhost-walkthrough.mjs   共 83 项，非预期 0 项
npm run audit:a11y        0 项不合格
npm run audit:contrast    亮/暗两态 0 处不合格
```

新增守卫的**反向验证**（改回旧写法确认会红）逐条做过：

| 守卫 | 反向操作 | 结果 |
| --- | --- | --- |
| `tests/dataRoutes.test.ts` 分享路由顺序 | 把分享分支挪回 `groups/` 前缀分支之后 | 3 条 not ok |
| `tests/serverStatic.test.ts` 缺失资源 404 | 短路 `looksLikeAsset` 判断 | 2 条 not ok |
| `tests/noteFtsRealSql.test.ts` 第二个实例的 FTS | `notesFtsReady` 换回实例字段 | 3 条 not ok |

---

## 四、未修与观察（刻意保留）

- **静态资源不发 ETag / 不认 If-None-Match**：自托管下每次都回全量，CF 的 assets 会自带校验头。影响面很小（assets 是 immutable 强缓存，只有 60 秒 TTL 的 index.html 会重复回），改动收益低于风险，先记着。
- **静态资源不支持 Range 请求**：只影响断点续传，业务里没有大文件直下。
- **docker 构建时无 `.git`** → 版本号徽标兜底成毫秒构建号（VPS 显示构建号、CF 显示 commit 哈希），已知且符合预期。
- 走查脚本 `Claw/selfhost-walkthrough.mjs` 放在仓库外（一次性排查工具，不进版本库）；可复跑，起全新库、跑完自动清理。
