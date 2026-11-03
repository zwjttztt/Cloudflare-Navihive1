# 性能现状分析：增删改查与数据加载（2026-10-13）

> 定位：这不是第一份性能报告 —— 今天已经落地**两轮首屏优化**（94→15 请求）和**一轮 CRUD
> 往返合并**（deleteNote 8→3、updateNote 5→3 等）。本文只回答两个问题：
> ① 各层面**还剩什么**没优化；② 每一项的**触发阈值**是什么（现在值不值得做）。
> 已交付的不再展开，逐层列出做对了什么作为基线，避免重复建议。

---

## 0. 基线：已经做掉的（不要再提）

| 层面 | 已交付 | 位置 |
|---|---|---|
| 首屏请求 | 94 → **15**：bootstrap 合并 me/recovery（`?full=1`）、ChunkBoundary `when=` 按需挂载、假 lazy 清零 | 两轮性能批次 |
| 请求字节 | ETag 304、CSP connect-src 去 data:、img src 空 → undefined | 同上 |
| CRUD 往返 | deleteNote **8→3**、updateNote **5→3**（RETURNING）、deleteSite/Group **3→2**、批量删除 200/批、审计入批 | `e761e03` |
| 索引 | user_id 系列、notes 四条、定时清理时间列、`idx_sites_user_group`（v19） | `internals.ts` |
| 数据库写入 | 排序/导入全走 batch、幂等键表、令牌黑名单单行化 | 存量 |
| 前端渲染 | SiteCard/GroupCard memo、displayedGroups 全链 useMemo、**content-visibility**（GroupCard/NotesPage）、notes 组级懒挂载（lazyGroup）、搜索截断（renderedCount + 展开） | 存量 |
| 数据加载 | 搜索纯本地过滤（零请求）、笔记跨设备轮询带 leader 选举 + 心跳让位 + 可配间隔（最低 30s）、墓碑增量、FTS + LIKE 熔断降级 | 存量 |

> **✅ 2026-10-13 深夜：P1/P2/P3 六项已全部落地**（提交见 CHANGELOG 当日「修复」条目）。
> **并更正三处本文写错的结论**（都是照抄旧分析、未回查代码所致）：
> ① `sites.password` **早就加密落库**（insertSite/updateSiteRow 用 encryptSecret），
>   剩下的是升级前明文行 → 已加一次性回填迁移（schema 20）；
> ② 站点侧**真懒挂载早已有**（GroupCard 的 IntersectionObserver + 分页递增），本文
>   误把 content-visibility 当成全部；
> ③ 因此「P1 加密」与「P2 懒挂载」两条不是新增项。教训：**性能结论也要回查代码，
>   不能沿用更早的分析文档。**

**结论先行：当前量级（几十~几百卡片、几十笔记）没有现实瓶颈。** 剩下的都是
「量级阈值触发型」优化 —— 下面每一条都标了什么时候该做。

---

## 1. 数据库查询层（剩 2 项）

### P2 · 回收站「打开即清」无上限

`listRecycleBin` 每次列出前先 `purgeExpiredRecycle`（一条按时间的 DELETE），然后**全量**
SELECT + 逐行 `JSON.parse` 取名字（`recycle.ts:78-135`）。条目少时无感；回收站积到几百条
（长期不清理 + 大量删除）时每次打开都多付一次扫描。

**建议**：SELECT 加 `LIMIT 200`（列表本来就是「最近的删除」语义，前端无分页需求）；
`data` 的解析只取 `name/title` 两个字段，JSON.parse 无法避免（数据是整行 JSON），LIMIT 即可。
审计日志那侧已经有分页范式（`getAuditLog` limit/offset），照抄。

### P3 · LIKE 回退搜索全表扫

FTS 建不成的库上每次搜索 `title/content LIKE %..%`（`notes.ts:1764`）。已有实例级熔断
（炸一次就关 FTS 开关），且只影响少数老库。**建议**：在数据页给「搜索已降级」一条显式提示
（唯一缺的是用户可见性），查询本身不动。

---

## 2. 接口设计层（剩 2 项，都是阀门型）

### P1 · 笔记列表全量正文（唯一量级敏感的数据通道）

`GET /api/notes` 默认回**全量正文**；`?fields=list` 摘要阀门（substr 200 字符）已实现但
**刻意未开** —— 几十条笔记时开了反而每次点开多一次往返（`data.ts:449-456` 注释写明）。

**建议（有明确触发条件再动）**：笔记数 > ~200 或列表体积 > ~1MB 时，前端改传
`fields=list`，点开笔记再 `GET /api/notes/{id}` 拉全文。两边代码都已就位，只差前端
开关 + 一个本地阈值判断。**现在不做是对的**；这条写下来是为了在「笔记变多」时有人记得它。

### P3 · 站点/分组的跨设备同步靠整页刷新

卡片侧没有 notesChanges 那样的增量轮询（笔记有墓碑 + changes，站点没有）。单设备使用
无感；多设备同时编辑时另一台要手动刷新。**建议**：复用 note_tombstone 模式加
site_tombstone + `sites/changes`——但这是功能一致性需求而非性能需求，量级敏感度低，排在
笔记侧验证过的模式之后。

---

## 3. 前端渲染层（剩 2 项，都是阈值型）

### P2 · 卡片懒挂载（已更正：早就有了）

GroupCard 除了 CSS `content-visibility: auto`，**已经有** IntersectionObserver 分组懒挂载
+ 分页递增（`visibleCount + PAGE_SIZE`，见 GroupCard 注释）。本文初稿只查到
content-visibility 就误判为缺失。卡片到千级时若仍不够（fiber 树本身成为成本），
再考虑更细粒度；目前无需动作。

### P3 · App.tsx 的派生密度

App.tsx 2076 行里 useMemo/useCallback 只有 13 处 —— 但热点派生（displayedGroups、
favoritesGroup、flatResults）都在 useSiteSearch 里且已 memo 化，App 剩下的多是事件回调。
**建议**：与「App.tsx 补测试」同一工程处理（拆域时顺带补 memo），不值得单独立项。

---

## 4. 代码实现层（剩 1 项 + 1 个已知取舍）

### P1 · sites.password（已更正 + 已落地）

写入路径早就加密；真正剩下的是**升级前落库、之后没再编辑过**的明文行。
已加迁移 `encryptLegacySitePasswords`（schema 20）：先探密钥再动笔（encryptSecret
拿不到密钥会返回**空串**，照写就是把凭据清空 —— 比留明文更糟），失败只记日志。

### 已知取舍（不修）

- `decryptSitePasswords` 每行一次解密 —— 已 Promise.all 并行，微秒级，不动。
- `updateNoteOrder` 拖拽一次几百条 UPDATE 走 batch（250/批）—— 已是最优形态。
- `importNotesData` 的 FTS 重建逐条「先删后插」—— 已 250/批切片，失败不回滚导入。

---

## 5. 优先级总表

| 优先级 | 事项 | 触发条件 | 改动面 |
|---|---|---|---|
| **P0（不做分析）** | **恢复线上部署** —— secret 已丢，今天所有性能/越权修复都没到生产 | 立即（用户操作） | — |
| P1 | ~~`sites.password` 列加密~~ → **历史明文回填** | ✅ 已落地（schema 20） | 小 |
| P1 | 笔记列表切 `?fields=list` | ✅ 已落地（阀门 + 打开补全文 + 保存安全闸） | 小 |
| P2 | 回收站列表 LIMIT 200 | ✅ 已落地 | 极小 |
| P2 | ~~站点侧真懒挂载~~ | ❌ 无需动作（早已有） | — |
| P3 | FTS 降级的用户可见提示 | ✅ 已落地（搜索框下方一行） | 极小 |
| P3 | sites 增量同步（tombstone 模式） | ✅ 已落地（site_tombstone schema 21 + /api/sites/changes + 前端轮询） | 中 |
| P3 | App.tsx 拆域 + memo 补齐 | 部分落地（navRailGroups memo）；整块拆域留给 App.tsx 补测试那批 | 大 |

---

## 6. 复核方式

```bash
npm run build        # 产物后看 bundleBudget（首屏预算看总字节）
bash harness/run-probe.sh <probe>   # 真机布局/请求数探针（stub 缺接口=假红）
npm run coverage     # 触及率导航（非行覆盖率）
```
探针判据与阈值记录在 `Claw/harness/`（首屏全页 button≥25、STUB_NOTES=120 等）。
