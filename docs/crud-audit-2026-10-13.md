# CRUD 全面审查 + 性能瓶颈分析（2026-10-13）

范围：站点 / 分组 / 笔记（含文件夹、标签、版本、附件、分享）/ 配置 / 回收站 / 备份导入导出的
增删改查全链路 —— 路由层（`worker/routes/`）、实现层（`src/API/methods/`）、前端表单与提交
（`src/hooks/`、`src/components/`）。每条结论都给了文件:行号证据；只列**静态审查能确认**的问题，
「可能」级别的猜测不进清单。

---

## 0. 总体评价：底子是好的

先说做对了的（这些不必重做，是后面建议的对照物）：

- **账号隔离统一走 scopeSql**：列表/单查/改/删都带 `user_id`，JOIN 也限表名；`note_note_tag`
  这张没有 user_id 的表靠 JOIN notes 判归属（`notes.ts:1551` 注释里就是当年的越权教训）。
- **写路径有闸门**：writeGate 限速、Idempotency-Key 幂等重放、乐观并发（rev + 409 冲突带现场）。
- **删除全是软删除**：先进 recycle_bin 再删真身，返回 recycleId 支持精确撤销；笔记还带墓碑、
  吊销分享、删标签关联、删 FTS 索引——副作用收口完整。
- **输入校验在 POST 侧相当严**：`validateSite` 做 trim/截断/URL 规范化/危险协议清洗，
  附件上传嗅探文件头不信 Content-Type，configs 有属主门控与 auth.* 黑名单。
- **前端**：创建/编辑都做 URL 规范化（挡 `javascript:`）、乐观更新 + 失败回滚 + 撤销、
  离线队列 + 占位 id、防连点。首屏请求两轮优化后 15 个。

所以下面清单里的缺陷，几乎全是「**不对称**」：同一件事 POST 路径做了、PUT/单条路径漏了。
修法也因此简单——把已有的工具复用到缺的那条路上即可。

---

## 1. 缺陷清单（按优先级）

### P0-1 单条编辑可以把卡片挪进别人的分组（越权）

- **问题**：`PUT /api/sites/{id}` 的路由层只校验 url/icon 的 URL 格式与 username/password 类型
  （`worker/routes/data.ts:795-832`），`group_id` 原样透传；实现层 `updateSiteRow` 直接
  `group_id = ?` 写库（`src/API/methods/data.ts:300-303`），没有任何「目标分组是我的」校验。
  `POST /api/sites` 同理——`validateSite` 只验 `Number.isSafeInteger`（`worker/validate.ts:79-83`）。
- **证据（为什么说是漏修）**：批量排序那条路**已经修过同一个洞**——`updateSiteOrder` 专门加了
  `filterOwnedGroupIds`，注释写明「以前只给 sites 加了 user_id 条件，group_id 却任意填 ——
  拖拽时能把卡片塞进别人的分组」（`data.ts:481-492`）。单条 PUT / POST 没有同步修。
- **影响范围**：多账号部署。普通账号可把自己的卡片写进他人分组：数据从自己视图里消失
  （分组不可见 → 找不回），并污染他人分组内容。单账号部署（uid=NULL）不受影响。
- **建议**：把 `filterOwnedGroupIds` 抽成共享方法，在 `updateSiteRow` / `insertSite` 内
  （或路由层）校验 `group_id`；不属主返回 400「目标分组不存在」。改动面小，三处调用同一工具。

### P0-2 编辑站点/分组不做截断与清洗，脏数据会进 bootstrap（正确性 + 性能）

- **问题**：POST 有 `validateSite`（name≤100、description≤500、notes≤1000、password≤500、
  icon 走 `sanitizeIconUrl`）；`PUT /api/sites/{id}` 只有 URL 格式和类型检查
  （`worker/routes/data.ts:806-829`），**没有 trim、没有长度上限、icon 不做危险协议清洗**。
  `PUT /api/groups/{id}` 同样只查「name 非空串」（`data.ts:282-295`），POST 的
  `name.trim().slice(0,100)`（`validate.ts:34`）没有对应物。
- **具体后果**：
  1. `name` 可以改成**空串**——前端编辑路径也不拦（`useSiteActions.handleSiteUpdate`
     只做 URL 规范化，`useSiteActions.ts:123-133`），与新增对话框「名称和URL不能为空」不对称；
  2. name/description/notes 无上限 → 可写入 MB 级内容，而 bootstrap 是**全量回传**
     （`queryBootstrap` SELECT 所有列，`data.ts:66-83`），一条脏记录把首屏拖垮；
  3. `icon: "javascript:alert(1)"` 能过 `new URL()` 检查直接入库（POST 侧会被
     `sanitizeIconUrl` 清掉）。`<img src>` 下虽不可执行，但三条入库路径只洗了两条，
     属于防御深度缺口。
- **建议**：把 `validateSite` / `validateGroup` 改造成支持「PATCH 语义」（只校验传入字段），
  PUT 路由对 `data` 跑一遍后把 `sanitizedData` 交给实现层；前端编辑保存前补 `name.trim()` 非空检查。

### P1-3 `note-orders` PUT 不校验元素形状 → 恶意载荷 500

`worker/routes/data.ts:689-704` 只验顶层是数组；元素缺 `id`/`order_num` 时 `undefined` 直接进
`bind`，D1 抛错 → 500。对照 `group-orders` / `site-orders` 都有逐项校验（`:879-921`）。
补一组与它们相同的循环校验即可（10 行）。

### P1-4 `importNotesData` 提交批不切片，大导入会整批失败

`src/API/methods/notes.ts:693` 把全部 commit 语句一次性 `db.batch(...)`；FTS 重建批（`:716`）同理。
而同文件 `updateNoteOrder` 特意按 250 条分批、`updateSiteOrder` 按 100 条分批，注释都写明
「D1 单次 batch 的语句条数有上限」。导入几百条笔记（INSERT + 标签关联 + FTS 先删后插两条/条）
很容易撞上限 → **整个事务回滚**，用户面对「导入失败」但文件完全合法。
建议：按 250 条切批提交；批间失败可保留「部分成功 + stats 里如实计数」（与 site-orders 的
updated/failed 同思路），或至少在 stats 里暴露失败原因。

### P2-5 GET 单条不存在时回 200 + null，与笔记的 404 不一致

`GET /api/sites/{id}`、`GET /api/groups/{id}`：实现返回 null 后路由直接
`Response.json(null)`（`data.ts:773-780`、`:252-258`）；对照 `GET /api/notes/{id}` 抛
`ApiError.notFound`（`:667-669`）。前端目前主要走 bootstrap 单模型所以没踩到，但这是给
未来调用方埋的形状陷阱（200 就当有数据）。统一为 404。

### P2-6 `GET /api/sites?groupId=abc` → NaN 进 bind

`data.ts:770-772`：`parseInt("abc")` 得 NaN，`groupId !== undefined` 仍成立 →
`WHERE group_id = ?` 绑 NaN，行为未定义（D1 报错或当 NULL）。加 `Number.isSafeInteger` 判断，
非法值当「未传」或 400。

### P2-7 乐观并发检测依赖 `meta.changes`，缺失时静默退化为覆盖

`notes.ts:910`：`Number((result.meta as {changes?})?.changes ?? 1) === 0` —— meta 拿不到
changes 时默认 1（当「改到了」），并发守卫静默失效。改成 UPDATE … RETURNING 后按
「RETURNING 是否有行」判定（与 P1-8 一起改，一处改动两得）。

### P2-8 审计留痕覆盖不一致（数据域有缺口）

审计基建本身覆盖很广：登录/注册/登出、账号管理、恢复密钥、备份恢复、回收站还原/清空、
cron 失败都有留痕（`account.ts`、`backup.ts`、`ops.ts`、`public.ts`、`recovery.ts`、`transfer.ts`）。
但**数据域只有 `site.delete` / `site.batchDelete` 两条**（`worker/routes/data.ts:843`、`:864`）：
分组删除、笔记删除、站点/分组的新增与编辑、分享创建/撤销、配置改动都不写。
审计对话框按 action 检索时，「删了什么」只有卡片这一半，笔记/分组的删除不在案。
建议：给数据域补「删除类」事件（group.delete / note.delete），与回收站条目对得上；
新增/编辑类频率高，可只记失败或维持现状（避免 audit_log 膨胀，清理已有索引兜底）。

### P3-9 前端编辑卡片不拦空名称

`useSiteActions.handleSiteUpdate`（`useSiteActions.ts:123-133`）只做 URL 规范化；
配合 P0-2 一起修（前端非空检查 + 后端拒绝空名）。

---

## 2. 性能瓶颈与优化方案

D1 的账是**往返次数 × 单次延迟**（同 region 内每往返约 1~10ms，跨区更高），
和首屏那个「请求数比字节贵」是同一个道理。下面按往返数排。

### P1-A 删除一条笔记 = 8 次串行往返（最大头）

`deleteNote`（`notes.ts:941-1006`）的执行序列，每步都 await 上一步：

1. SELECT 笔记行
2. SELECT 标签关联（JOIN notes）
3. INSERT 回收站（pushToRecycle）
4. DELETE 标签关联
5. DELETE 分享（revokeNoteShare）
6. DELETE 笔记行
7. dropNoteFts（内部又是 DELETE+INSERT 的一个 batch）
8. INSERT 删除墓碑

**优化**：① 步骤 1/2 互不依赖，改 `Promise.all` 并行；② 步骤 3~8 合并成**一个
`db.batch`**——D1 batch 既是一次往返又是事务，顺带消掉「删行成功但墓碑/索引写失败」的
中间态（现在墓碑失败只打日志）。预计 8 次 → 3 次，删除延迟约降 60%。

### P1-B 保存一条笔记 = 4~5 次串行往返

`updateNote`（`notes.ts:821-938`）：SELECT before（留快照）→ UPDATE → SELECT after
（回读 updated_at）→ syncNoteFts batch → pushRevision INSERT。

**优化**：
1. UPDATE 加 `RETURNING ${NOTE_FIELDS}`（与 `updateSiteRow` 同款，`data.ts:347-357`），
   省掉回读那一次；RETURNING 空结果同时就是「0 行命中」的可靠信号——**顺带修 P2-7**；
2. pushRevision 的 INSERT 并进 syncNoteFts 那个 batch（快照语义是「改动前的内容」，
   before 已经在内存里，晚一拍写不影响正确性）。

预计 5 次 → 3 次。笔记自动保存 5 秒一拍，这是使用频率最高的写路径，收益最大。

### P2-C 删除分组/站点 3 次串行 → 2 次

`deleteGroup` / `deleteSite`（`data.ts:178-200`、`:430-445`）：SELECT → pushToRecycle →
DELETE。SELECT（分组场景还有第二个 sites SELECT，可与主查询并行）之后，
把 INSERT 回收站 + DELETE 真身合成一个 batch。

### P2-D 批量删除的回收站写入是 N 条并发 INSERT

`deleteSites`（`data.ts:373-424`）：每个站点单独 `pushToRecycle`（并发，但 20 张卡 = 20 条
并发写）。合成一条多值 INSERT（或一个 batch）→ 1 次往返；事务性也更好——现在「写了一半
回收站挂了」会出现部分进站部分硬删的混合态（代码用 recycleId 过滤兜住了正确性，但代价是
20 次往返里的部分失败静默变「没删」）。

### P2-E writeAudit 的串行附加往返

删除站点后 `await api.writeAudit(...)`（`data.ts:843`、`:864`）又是一次独立往返。
把它并进同一个 batch（P2-C/D 改造时顺手做）。

### P3-F SQL / 索引

- **索引面基本达标**：`INDEX_STATEMENTS`（`internals.ts:281-313`）把 scopeSql 的 user_id
  过滤、排序路径、定时清理的时间删都盖住了；`note_revision(note_id)`、attachments(user_id)
  这些当年吃过全表扫亏的也都补了。没有发现新的缺失索引。
- 小项：`sites` 可加 `(user_id, group_id)` 复合索引——`getSites(groupId)` 现在走 group_id
  索引后回表过滤 user_id；量级小（几百行内）时收益为零，记录备查。
- **LIKE 回退搜索是全表扫**：FTS 建不成的库上每次搜索 `LIKE %..%`（`notes.ts:1764-1780`），
  已有实例级熔断（查询炸一次就关 FTS 开关）。可接受；建议在数据页给「降级中」一个显式提示。
- **回收站打开即触发过期清理**（`recycle.ts:82-83`）：每次列出都先跑一遍 DELETE。
  条目多时打开变慢；可加 LIMIT 或把 purge 频率降低（cron 之外最多每小时一次）。

### P3-G 前端请求模式：无新增问题

首屏 15 请求、`?full=1` 合并 me/recovery、批量排序/删除合并、乐观更新、离线队列、
幂等键、30s 超时 + 慢端点豁免、bootstrap ETag 304——两轮性能批次的成果都在位。
**计划内债务**一项：笔记列表 `?fields=list` 摘要阀门已实现但默认关闭
（`data.ts:449-456` 注释写明几十条笔记时开了反而多一次往返）——维持现状，
笔记涨到几百条时打开即可。

---

## 3. 优先级路线图

| 优先级 | 事项 | 类型 | 改动面 |
|---|---|---|---|
| P0 | A1 单条 PUT/POST sites 的 group_id 属主校验（复用 filterOwnedGroupIds） | 越权 | 小 |
| P0 | A2 PUT sites/groups 走校验清洗（PATCH 化的 validateSite/validateGroup） | 正确性+性能 | 小 |
| P1 | P1-A deleteNote 合并 batch（8→3 往返） | 性能 | 中 |
| P1 | P1-B updateNote 用 RETURNING + 合并快照批（5→3 往返，顺带修 P2-7） | 性能+正确性 | 中 |
| P1 | P1-4 importNotesData 分批提交 | 正确性 | 小 |
| P1 | P1-3 note-orders 元素校验 | 健壮性 | 极小 |
| P2 | P2-5/6 单查 404、groupId NaN | 一致性 | 极小 |
| P2 | P2-C/D/E 删除路径 batch 化 + 审计并入 | 性能 | 中 |
| P2 | P2-8 删除类审计补齐 | 合规 | 小 |
| P3 | P3-F/G 复合索引、回收站清理节流、FTS 降级提示、前端空名校验 | 打磨 | 小 |

验证方式：A1/A2 用真 SQLite 基建（`tests/helpers/realSqliteD1.ts`）写跨账号用例；
P1-A/B 用现有 notes 路由测试对照往返行为；反向验证老规矩——改回旧写法看用例红不红。

## 4. 复现

```bash
npm run coverage        # 覆盖率导航（后端 CRUD 路径已全部被用例触及）
npm test -- dataRoutes  # 分组/站点 CRUD 用例
npm test -- noteSql     # 笔记 SQL 用例
```
