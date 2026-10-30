# NaviHive API 端点清单

这份文档回答：**服务端到底暴露了哪些 `/api` 端点、每个端点要什么鉴权、由哪个文件认领**。
列表逐条来自 `worker/routes/*.ts` 与 `server/entry.ts` 的分发代码，没有推测项。
代码改动后需要同步更新的章节：加/删端点 → 对应分组表；改错误形状或鉴权规则 → §1；改自托管专属端点（网页端升级 / 慢查询）→ §11。

---

## 1. 通用约定

| 项 | 事实 | 出处 |
| --- | --- | --- |
| 前缀 | 所有业务端点都在 `/api/` 下；路由内部拿到的 `path` 是**去掉 `/api/` 之后**的部分 | `worker/index.ts:241` |
| 鉴权 | 令牌在 **httpOnly cookie**（`navihive_session` 是 JS 可读的布尔标记，不是令牌）；也兼容 `Authorization: Bearer` | `worker/routes/middleware.ts:37-51` |
| 鉴权开关 | `AUTH_ENABLED !== "true"` 时整站公开，`enforceAuth` 直接放行 | `middleware.ts:33` |
| CSRF | 走 cookie 的**非 GET/HEAD** 请求必须同源，否则 403 | `middleware.ts:126` |
| 错误形状 | `{ error: { code, message, details? } }`；客户端同时兼容旧的 `{ error: "字符串" }` | `worker/lib/apiError.ts`、`shared/apiErrorCodes.ts` |
| 请求 ID | 响应头 `x-request-id`（`shared/requestId.ts`），日志/审计/前端上报共用 | `worker/index.ts:367-373` |
| 幂等 | 写请求可带 `Idempotency-Key`；`data` 组在 `handleDataRoutes` 统一包一层 | `worker/routes/data.ts:351-358` |
| 请求体上限 | 默认 256 KB；`/api/import`、`/api/webdav/upload` 10 MB；`/api/notes/attachments` 按 `ATTACHMENT_MAX_BYTES`（25 MB）；`report-error` / `csp-report` 8 KB | `worker/index.ts:202-219` |
| 写限速 | 各写分支过 `writeGate`（按账号 + IP 分桶），超限 429 + `Retry-After` | `worker/loginGuard.ts` 的 `enforceWriteGuard` |

鉴权一列的取值：**公开** = 不需要登录；**登录** = 需有效会话；**owner** = 还需 `role === "owner"`。

---

## 2. 公开路由（鉴权之前）

处理文件：`worker/routes/public.ts`。这一组必须排在鉴权中间件之前 —— `<img>`、CSP 上报带不上令牌，登录/注册/找回则是「还没登录才要用」。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/init` | 初始化探测 / 容器探活 | 公开 | 恒回 `{ ok, initialized: true, maintenance }`，不暴露是否首次初始化；按 IP 限速 |
| POST | `/api/login` | 登录 | 公开 | 令牌只写 cookie，响应体不含 token；失败按 IP 递增锁定 |
| POST | `/api/auth/register` | 注册（唯一门槛是邀请码） | 公开 | 未启用鉴权时直接 400；成功即签发 cookie |
| POST | `/api/auth/recover` | 用恢复私钥签名的令牌重置密码 | 公开 | 按 IP 熔断 |
| GET | `/api/auth/recovery-status` | 是否已配置恢复公钥 | 公开 | 带令牌时按「当前账号」回答，只回布尔 |
| GET | `/api/icon` | 第三方图标同源代理 | 公开 | 前端可缓存成 blob |
| GET | `/api/icons` | 批量图标代理 | 公开 | 首屏十几个 `<img>` 塌缩成一次请求 |
| POST | `/api/csp-report` | CSP 违规上报 | 公开 | 只进日志，不落库 |
| POST | `/api/report-error` | 客户端错误上报 | 公开 | 崩溃在登录页外也要能报 |
| GET | `/api/group-shares/{token}` | 公开分组分享页 | 公开 | 口令保护的返回 `{ status: "need-password" }`（HTTP 200） |
| POST | `/api/group-shares/{token}` | 带口令访问分组分享 | 公开 | 口令错才计一次失败 |
| GET | `/api/note-shares/{token}` | 公开笔记分享页 | 公开 | 无口令直接回笔记；受口令回 401 + `needPassword: true` |
| POST | `/api/note-shares/{token}` | 带口令访问笔记分享 | 公开 | 口令正确后另发附件会话 cookie（30 分钟） |
| GET | `/api/note-shares/attachments/{id}` | 分享页里的图片 | 公开 | 只查该附件所属笔记的有效分享，且必须匹配 `?share=` 或会话 |

> 顺序坑：`note-shares/attachments/{id}` 必须排在 `note-shares/` 前缀分支**之前**，否则会被当成 token 去查分享（`public.ts:86-88`）。

---

## 3. 账号与会话

处理文件：`worker/routes/account.ts`。九条写路由都过 `writeGate`。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| POST | `/api/logout` | 退出登录 | 登录 | 把当前 jti 拉黑 + 清 cookie |
| GET | `/api/auth/me` | 当前身份（id / username / role） | 登录 | 未启用鉴权时返回 `{ id: 0, username: "guest", role: "owner" }` |
| POST | `/api/auth/invite` | 生成邀请码（30 分钟有效） | owner | 非 owner 403 |
| GET | `/api/users` | 账号列表（含沉睡治理状态） | owner | — |
| POST | `/api/users/sweep` | 手动触发沉睡账号扫描 | owner | 必须排在 `users/` 前缀分支前 |
| GET | `/api/sessions` | 当前账号的登录设备列表 | 登录 | SQL 里带 `user_id` 条件 |
| DELETE | `/api/sessions/{jti}` | 吊销某台设备 | 登录 | 只对自己账号的会话有效 |
| POST | `/api/sessions/revoke-others` | 退出其它设备 | 登录 | `currentJti` 为空时等于全部吊销 |
| POST | `/api/users/{id}/status` | 改账号状态（`active` / `disabled`） | owner | 路径必须匹配 `^users/(\d+)/status$` |
| DELETE | `/api/account` | 注销账号（删名下全部数据） | 登录 | 必须再验一次当前密码 |
| PUT | `/api/auth/credentials` | 改当前账号的账号名 / 密码 | 登录 | 成功 200 / 失败 403 |
| PUT | `/api/auth/recovery-key` | 保存 / 更换恢复公钥 | 登录 | 必须校验当前密码 |

---

## 4. 运维：审计、统计、回收站

处理文件：`worker/routes/ops.ts`。回收站五条写路由过 `writeGate`（永久删除不可逆，且批量版一条能带几百个 id）。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/audit` | 审计流水 | owner | `limit` 1–200、`offset`、`actor` |
| GET | `/api/stats` | 运维统计看板聚合 | owner | 内容计数 / 30 天活跃 / 分享浏览 Top / 链接健康 |
| GET | `/api/client-errors` | 前端错误上报聚合 | owner | `limit` 1–500 |
| GET | `/api/recycle` | 回收站列表 | 登录 | `?kind=nav\|note` 分家 |
| POST | `/api/recycle/restore` | 还原一条 | 登录 | body `{ id }` |
| POST | `/api/recycle/purge` | 永久删除一条 | 登录 | body `{ id }` |
| POST | `/api/recycle/restore-batch` | 批量还原 | 登录 | body `{ ids }`，带回还原出的卡片 |
| POST | `/api/recycle/purge-batch` | 批量永久删除 | 登录 | body `{ ids }` |
| DELETE | `/api/recycle` | 清空回收站 | 登录 | `?kind=nav\|note` 同样分家 |

---

## 5. 导航数据：bootstrap / 分组 / 站点

处理文件：`worker/routes/data.ts`（`dispatchDataRoutes`，1207 行）。写分支统一过 `writeGate`。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/bootstrap` | 首屏一次取分组 + 站点 + 配置 | 登录 | 弱 ETag，命中 `If-None-Match` 回 304；`?full=1` 附带 `me` 与 `recovery` |
| GET | `/api/groups/{id}/share` | 查分组分享配置 | 登录 | 必须排在 `groups/` 前缀分支之前 |
| PUT | `/api/groups/{id}/share` | 更新分组分享有效期 / 口令 | 登录 | `days` ∈ `1 / 7 / 30 / null` |
| POST | `/api/groups/{id}/share` | 创建分组分享（轮换令牌） | 登录 | — |
| DELETE | `/api/groups/{id}/share` | 撤销分组分享 | 登录 | — |
| GET | `/api/groups` | 分组列表 | 登录 | 按账号隔离（`scopeSql`） |
| GET | `/api/groups/{id}` | 单个分组 | 登录 | — |
| POST | `/api/groups` | 新建分组 | 登录 | — |
| PUT | `/api/groups/{id}` | 改分组 | 登录 | — |
| DELETE | `/api/groups/{id}` | 删分组（软删除进回收站） | 登录 | 结果含 `recycleId` |
| PUT | `/api/group-orders` | 批量更新分组排序 | 登录 | body 为数组，逐项校验 `id` + `order_num` |
| GET | `/api/sites/changes` | 站点增量变更（含删除墓碑） | 登录 | 必须排在 `sites/` 前缀分支之前 |
| GET | `/api/sites` | 站点列表（含绑定的笔记） | 登录 | — |
| GET | `/api/sites/{id}` | 单个站点 | 登录 | — |
| POST | `/api/sites` | 新建站点 | 登录 | 密码字段加密落库 |
| PUT | `/api/sites/{id}` | 改站点 | 登录 | — |
| DELETE | `/api/sites/{id}` | 删站点（软删除） | 登录 | — |
| POST | `/api/sites/batch-delete` | 批量删除站点 | 登录 | 一次最多 500 个；审计并入同一批次 |
| PUT | `/api/site-orders` | 批量更新排序 + 跨组移动 | 登录 | 返回「成了哪几个、没成哪几个」 |

---

## 6. 记事本：笔记 / 文件夹 / 标签 / 附件 / 分享 / 版本

处理文件：`worker/routes/data.ts`。**顺序敏感**：`notes/shares`、`notes/folders`、`notes/tags`、`notes/attachments` 都必须排在 `notes/{id}` 前缀分支之前，否则 `parseInt("folders")` 得到 `NaN` 直接 400。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/notes` | 笔记列表 | 登录 | `?fields=list` 只回摘要；`limit` / `offset` 可选，不带 = 全量 |
| GET | `/api/notes/count` | 笔记总数 | 登录 | — |
| POST | `/api/notes` | 新建笔记 | 登录 | 只收 `title / content / pinned / site_id / folder_id` 白名单 |
| GET | `/api/notes/{id}` | 单篇笔记 | 登录 | — |
| PUT | `/api/notes/{id}` | 改笔记 | 登录 | 支持 `rev` 乐观并发、`archived`、`folder_id` |
| DELETE | `/api/notes/{id}` | 删笔记 | 登录 | 写墓碑供跨设备同步 |
| PUT | `/api/note-orders` | 批量更新笔记排序 | 登录 | 兼容顶层数组与 `{ orders }` 两种形状 |
| GET | `/api/notes/changes` | 跨设备变更轮询 | 登录 | `since` 游标；`fp` 指纹相同则回 `{ unchanged: true }`；`no-store` |
| GET | `/api/notes/stats` | 双链 / 版本历史全站计数 | 登录 | 只读 |
| POST | `/api/notes/search` | 服务端全文检索 | 登录 | 有 FTS5 走索引 + bm25，否则退 `LIKE`；空查询直接回空 |
| POST | `/api/notes/reindex` | 重建 FTS 索引 | 登录 | 按 `rowid` 定位；不支持 FTS 时 503 |
| POST | `/api/notes/import` | 导入记事本导出的 JSON | 登录 | 按 `uuid` 合并，文件较新才覆盖 |
| GET | `/api/notes/shares` | 分享列表 | 登录 | 必须排在数字正则分支之前 |
| GET | `/api/notes/{id}/share` | 查单篇分享配置 | 登录 | — |
| PUT | `/api/notes/{id}/share` | 更新有效期，保留 token | 登录 | `password` 不传 = 保持 |
| POST | `/api/notes/{id}/share` | 创建分享 | 登录 | 轮换 token |
| DELETE | `/api/notes/{id}/share` | 撤销分享 | 登录 | — |
| GET | `/api/notes/folders` | 文件夹列表 | 登录 | — |
| POST | `/api/notes/folders` | 新建文件夹 | 登录 | `name / parent_id / icon / color` 白名单 |
| PUT | `/api/notes/folders/{id}` | 改文件夹 | 登录 | — |
| DELETE | `/api/notes/folders/{id}` | 删文件夹 | 登录 | — |
| GET | `/api/notes/tags` | 标签列表 | 登录 | — |
| POST | `/api/notes/tags` | 新建标签 | 登录 | — |
| PUT | `/api/notes/tags/{id}` | 改标签 | 登录 | — |
| DELETE | `/api/notes/tags/{id}` | 删标签 | 登录 | — |
| GET | `/api/notes/tag-links` | 笔记↔标签关联 | 登录 | — |
| PUT | `/api/notes/{id}/tags` | 设置某篇笔记的标签集合 | 登录 | body `{ tagIds }` |
| GET | `/api/notes/{id}/revisions` | 版本历史列表 | 登录 | 必须排在 `notes/{id}` GET 之前 |
| GET | `/api/notes/{id}/revisions/{revId}` | 单个版本内容 | 登录 | — |
| POST | `/api/notes/{id}/revisions/{revId}` | 恢复到该版本 | 登录 | — |
| POST | `/api/notes/attachments` | 上传附件（raw body） | 登录 | 不是 multipart、不是 base64；服务端嗅探文件头定类型 |
| GET | `/api/notes/attachments/list` | 附件元数据列表 | 登录 | **剥掉** `object_key` |
| GET | `/api/notes/attachments/{id}` | 取附件字节 | 登录 | `private, no-store`；`Content-Disposition` 带文件名 |
| PATCH | `/api/notes/attachments/{id}` | 重命名附件 | 登录 | — |
| PUT | `/api/notes/attachments/{id}/content` | 编辑纯文本附件 | 登录 | 内容也要过嗅探 |
| DELETE | `/api/notes/attachments/{id}` | 删附件 | 登录 | 先删 D1 记录再删对象 |
| POST | `/api/notes/attachments/prune` | 清理未引用附件 | 登录 | 返回 `removed` / `freedBytes` |

附件配额（`worker/attachments.ts`）：单文件 25 MB、单用户总量 1 GB、每小时 100 次；同一用户上传用 lease 串行化，拿不到锁 409。

---

## 7. 保险库（方案 B，端到端加密）

处理文件：`worker/routes/vault.ts`。服务端**只搬密文**，不做任何加解密。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/vault/keys` | 读 KDF 参数 + 两份包裹好的 DEK | 登录 | — |
| PUT / POST | `/api/vault/keys` | 建库 / 改主密码（upsert） | 登录 | 六个字段缺一即 400 |
| GET | `/api/vault/entries` | 条目列表 | 登录 | — |
| POST | `/api/vault/entries` | 新建 / 更新条目 | 登录 | 必须有 `ciphertext` + `iv`；带 `id` 即更新 |
| DELETE | `/api/vault/entries/{id}` | 删条目 | 登录 | `id` 必须是正整数 |

---

## 8. 配置

处理文件：`worker/routes/config.ts`。所有写方法（POST/PUT/PATCH/DELETE）先过更严格的 `enforceConfigGuard`。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/configs` | 读全部配置 | 登录 | 按账号作用域合并 |
| POST | `/api/configs/batch` | 批量写配置 | 登录 + （写全站键需 owner） | 非 user-scoped 键需 `canManageSharedConfigs`；`auth.*` 一律拒绝 |
| GET | `/api/configs/{key}` | 读单个配置 | 登录 | `auth.*` 不可读 |
| PUT | `/api/configs/{key}` | 写单个配置 | 登录 + （同上） | `auth.*` 必须走 `/api/auth/credentials` |
| DELETE | `/api/configs/{key}` | 删单个配置 | 登录 + （同上） | `auth.*` 不可删 |

---

## 9. 备份 / 导入导出 / WebDAV

处理文件：`worker/routes/backup.ts`。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/export` | 导出整站数据（含解密后的站点密码） | 登录 | 最贵的接口，按账号 + IP 限速并指数退避 |
| POST | `/api/import` | 导入备份 | 登录 | 体≤10 MB、条数另有限制；失败整批回滚 |
| POST | `/api/webdav/test` | 测试 WebDAV 连接 | 登录 | — |
| POST | `/api/webdav/upload` | 上传导航页备份 | 登录 | 体≤10 MB |
| POST | `/api/webdav/list` | 列远程备份 | 登录 | — |
| POST | `/api/webdav/download` | 下载远程备份 | 登录 | — |
| POST | `/api/webdav/delete` | 删除远程备份 | 登录 | — |
| POST | `/api/webdav/notes/test` | 测试记事本 WebDAV | 登录 | — |
| POST | `/api/webdav/notes/upload` | 上传笔记备份 | 登录 | — |
| POST | `/api/webdav/notes/list` | 列笔记备份 | 登录 | — |
| POST | `/api/webdav/notes/download` | 下载笔记备份 | 登录 | — |
| POST | `/api/webdav/notes/delete` | 删除笔记备份 | 登录 | — |

---

## 10. AI（补全 / 标签建议 / 语义搜索）

处理文件：`worker/routes/ai.ts`。整个 `ai` 分支自带按账号 + 作用域的内存限速（`text` / `embed` / `search` 三个桶）。

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/api/ai/status` | AI 是否可用、模型名、已嵌入数 | 登录 | 前端据此决定按钮是否置灰 |
| POST | `/api/ai/test` | 用请求体里这份未保存的配置真跑一次 | 登录 | 必须排在「配置不全就 400」的闸门之前；文本与嵌入各测一次 |
| POST | `/api/ai/site-meta` | 加站时补全名称 / 描述 / 分组 / 标签 | 登录 | 只接受 `http(s)` 网址 |
| POST | `/api/ai/suggest-tags` | 给存量站点批量建议标签 / 分组 | 登录 | 有 `MAX_SUGGEST_SITES` 上限 |
| POST | `/api/ai/embed` | 把站点文本整批换成向量 | 登录 | 按 `EMBED_BATCH_MAX` 分批，失败停在该批 |
| POST | `/api/ai/search` | 语义搜索 | 登录 | 余弦相似度在 Worker 内存里算；结果受 `SEARCH_MAX_RESULTS` / `SEARCH_MIN_SCORE` 约束 |

---

## 11. 自托管专属（`server/entry.ts` 直接注册，Worker 里没有）

| 方法 | 路径 | 用途 | 鉴权 | 备注 |
| --- | --- | --- | --- | --- |
| POST | `/api/system/upgrade` | 触发网页端升级 | owner | 内部先自调 `/api/auth/me` 判角色；每次判定都落审计；**先响应再动手**（1.5 s 后） |
| GET | `/api/system/upgrade` | 查升级进度 | owner | 读 `/spool/state.json` 的 `phase` |
| GET | `/api/system/slow-queries` | 慢查询清单 | owner | 数据来自 `server/slowQuery.ts` |
| — | `POST /__cron` | 外部定时器触发定时任务 | `NAVIHIVE_CRON_TOKEN` | **不在 `/api/` 下**；配了 token 但不匹配回 401，完全没配 token 则回 404（等于关闭该入口） |

`server/entry.ts` 的静态资源分支（`GET/HEAD` 且非 `/api/`）不是 API，走 `server/static.ts` 的 SPA 回退，不在此表。

---

## 12. 未在本仓库中定义的

- **健康检查专用端点**：没有 `/api/health` 或 `/health`。容器探活与外部探测都用 `GET /api/init`（`Dockerfile` 的 `HEALTHCHECK` 就是这么写的）。
- **OpenAPI / Swagger 规范文件**：仓库里没有找到，本清单是逐条读分发代码整理的。
- **`/api` 本身**（不带尾斜杠）：既不是 `/api/...` 也不命中静态资源路由，两条链路都回 404。
- **版本号端点**：前端版本号是构建期烘进产物的常量（`__NAVIHIVE_APP_VERSION__`），不是接口。

---

## 13. 端点总数

`/api` 端点共 **122 条**（`vault/keys` 的 `PUT|POST` 合并记为一条），另有 1 条非 `/api` 的 `POST /__cron`。
按分组：公开 14、账号 12、运维 9、导航数据 19、记事本 37、保险库 5、配置 5、备份 12、AI 6、自托管专属 3。
