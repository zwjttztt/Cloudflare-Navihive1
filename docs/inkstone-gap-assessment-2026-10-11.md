# NaviHive × Inkstone 四维差距评估（功能 / 架构 / 性能 / 代码质量）

基线：NaviHive 本地 `9ac51dd`（远端含 `723db4d` inkstone P1–P3 补齐批次、`2d1155c` 浏览次数防刷 + 报告订正、`9ac51dd` 触屏 Pointer Events）。对照 `harness/inkstone-src`（131 个 ts/tsx）。

本评估不再按「模块逐条」复述（`docs/inkstone-full-compare-2026-10-11.md` 已做），改为按用户要求的四个维度做结构化判断，并给出客观的整体差距结论。所有「已交付」结论均已源码级核对，非按记忆或文档推断。

---

## 一、功能特性差距

### 1.1 记事本功能面：已实质追平

前四轮专项对比 + 第五轮批次 A/B/C 关闭的差距（补全、任务回写、代码折叠、编辑器设置、密度/打字机/专注、数学/Mermaid、反链/大纲、**图谱**、灯箱、列表 content-visibility、标签颜色/快捷多选、附件管理器、FTS5、rev 乐观并发、分享全功能、版本行级 diff、ZIP 导入导出、Obsidian 导入、数据维护、备份、登录设备管理、网盘预设）经本轮复查**无一复活**。

本轮在 `723db4d` 又把原先挂着的三项记事本平台件补齐：
- **口令分享附件保护**（3.1）：`worker/shareAssetSession.ts` 实现 share-asset-session，附件路由 `public.ts` 校验短时会话，关闭了「凭 uuid 直取受口令保护分享的图」这一安全级缺口。
- **HTML/PDF 导出内联私有图片**（3.2）：`noteHtmlExport.ts:48-66` 在导出前 `fetch` 附件（same-origin 凭据）→ `FileReader.readAsDataURL` → 重写 `token.src` 为 dataURL，离开登录态图不再裂。
- **图谱平移/缩放/拖拽 + 分组着色 + 偏好持久化**（3.5 原文 3.3）：`NoteGraphDialog.tsx:82-358` 有完整 `camera{x,y,zoom}`、`onWheel` 缩放、`pointer` 拖拽平移、pinch 双指缩放、`groupBy: none|folder|tag` 按文件夹/标签颜色着色、偏好 localStorage 持久化。力导向我们刻意不用（确定性布局更易读、零布局抖动），这是有意的差异而非缺失。

**结论：记事本功能面与 inkstone 对齐度 ≈ 100%，无用户可感知的功能缺项。**

### 1.2 平台层剩余真实差距（均为 P3 低频小件）

以下项目经核实**当前仍未做**：

| 项 | inkstone 做法 | 本项目现状 | 量级 | 改进方向 |
|---|---|---|---|---|
| 备份互斥租约（原 3.7） | `lib/lease.ts` TTL 租约保证备份不重入 | cron 与手动备份理论可并发写同一 WebDAV 目录 | 1h | app_meta 上加 TTL 租约 + renew/release，零成本 |
| 欢迎笔记（原 3.8） | `shared/welcome-notes.ts` 首次进入给示例笔记 | 新用户面对空白编辑器 | 0.5h | 首登检测无笔记则注入 1 篇语法教学 |
| 服务端上传读图片尺寸（原 3.9，部分） | `worker/lib/image.ts` 上传时读 png/jpeg/gif/webp 尺寸存库 | 已实现「挂载时拉元数据预种渲染种子」(`#272` ④)，但 AVIF 不解析尺寸、上传时未存 | 2h | 上传路径补尺寸探测，覆盖换设备首开 |
| 附件删除重试队列（原 4.5） | `FILES_KV pending` + cron `drainAttachmentCleanup` 分批删 | `DELETE` 同步删，失败即报错留用户重试 | 2h | 失败入队 + cron 兜底 |
| Obsidian 导入回退查找（原 4.7） | 三级回退：同目录→仓库根→文件名全局 | 只有两级（相对路径→全路径），同名异目录附件漏 | 1h | `resolveAsset` 加文件名全局兜底 |

### 1.3 跨设备实时同步（维持不做的边界）

inkstone 用 Realtime DO（WebSocket + 轮询回退 + 多标签 leader 选举）。我们**没做 DO 本体**（免费版 cron 上限 + 成本），但已交付其两个降级替代：
- `BroadcastChannel` 同源多标签秒传（`useNotes.ts` / `notesSync.ts`）——多标签互改可见；
- cursor 增量轮询 `GET notes/changes` + `changedNoteIds`（`#272` ①同步深化）——跨设备分钟级感知，当前打开的笔记由 rev 守卫兜底不覆盖草稿。

**这是有意的架构取舍，不算功能缺失**；若未来要多端亚秒级协同才需上 DO。

### 1.4 明确不做（复核维持，共 8 项）

MCP server、TOTP、Realtime DO 本体、i18n、S3/多目标备份、用户头像、PWA 更新检查、demo 模式。逐项复核无翻案理由——本项目是「导航站 + 记事本」双模多账号产品，inkstone 多数平台件为其单用户纯笔记定位服务，在 NaviHive 语境下不成立或已有替代。

---

## 二、架构设计差距

### 2.1 同步架构：形态不同，取舍合理

- inkstone：`SyncEngine`（WS/DO + 轮询 + BroadcastChannel + leader 选举 + outbox ack），约 300+ 行，需 DO 运行时。
- 本项目：SPA 直连 D1，跨标签用 BroadcastChannel、跨设备用 cursor 轮询；冲突靠 `rev` 乐观并发（409 + 冲突弹框 + 自撞修复 writeQueue）兜底。

**差距性质**：不是缺陷，是「免费版 Workers + 多账号」约束下的务实替代。代价是跨设备非实时（分钟级），但避免了 DO 的复杂度与成本。架构分层（Provider/Store 分离、偏好按 uid 分桶、API 新增字段同步 methods/routes/client/mock）反而比 inkstone 更规整。

### 2.2 备份引擎：功能等价，缺运维件

- inkstone：`worker/backup/` 10 文件——engine/scheduler/retention/concurrency/lease/snapshot/validation/archive，多目标（webdav+s3）、并发租约、分批清理。
- 本项目：`worker/notesBackup.ts` + webdav 四件套，单目标、无租约、保留策略随写回 runs 一并清。**单目标下功能等价**；唯一真实差距是 2.2 表的「备份互斥租约」（P3）。多目标维持不做。

### 2.3 导出/渲染隔离：本项目更强

- Mermaid 渲染走**独立 iframe 沙箱**，比 inkstone 的 `enhance.ts` 内联注入隔离更彻底（防恶意图表脚本逃逸）。
- 严格 Trusted Types，禁用 HTML sink；SVG 附件**故意不收**（防脚本注入），比 inkstone 更严（已写入既有报告 4.9，避免未来被当缺失）。
- 导出走隐藏 iframe 打印，避开 Trusted Types 限制。

**这些是有意的安全加固，反向优于 inkstone。**

### 2.4 分层与可测性

- Provider/Store 分离、偏好按 uid 分桶、SQL 拼 `scopeSql` 必走 `scopeParams`——多账号隔离在架构层强制。
- 真 SQLite 测试基建（`tests/helpers/realSqliteD1.ts` 包 `node:sqlite` 成 D1 形状）能钉死列缺失/语法错/ambiguous/bind 不匹配，比 inkstone 纯 mock 更接近生产。

**结论：架构设计无缺陷级差距，安全护栏与多账号隔离反而更稳；剩余仅为备份租约一个 P3 件。**

---

## 三、性能表现差距

### 3.1 首屏与包体

- 首屏 304KB gzip，预算内余量 **5%+**（`docs/perf-audit-2026-10-11.md`）。
- 最大可改进项 mermaid 的 elk(438KB gz)/cytoscape(133KB gz) 布局引擎已**懒加载**，场景窄、动作在上游，不动。
- 运行期热点（列表渲染、搜索、图片缓存）全部已有治理与用例把守。

### 3.2 列表与渲染

- 笔记列表 `content-visibility` + `containIntrinsicSize` 放宽，与 inkstone `NoteList` 对齐。
- 图片渲染：服务端尺寸预种（`#272` ④）+ 客户端 `imageCache(LRU 64)` + width/height 属性，长文首开不塌缩不跳动。

### 3.3 检索

- FTS5 `unicode61` + 两侧统一 `segmentCJK`，中文两字词 `MATCH` 正确返回（避开 trigram ≥3 字符陷阱）；建表探针失败降级 LIKE。
- **写入路径 `await` 同步建索引**（Workers 免费版 `void promise` 会被掐，记忆里钉过）——牺牲一点写延迟换可靠性，比 inkstone 的异步 drain 队列更稳但略慢。已补手动重建入口（`routes/data.ts` + `NotesSettingsDialog.tsx`）。

### 3.4 图谱

- 确定性布局（非力导向）零布局抖动、首屏无计算峰值；camera 变换用 CSS transform，平移缩放 60fps 无压力。

**结论：性能在预算内、无瓶颈；FTS 同步写是有意的可靠性取舍；整体与 inkstone 同档。**

---

## 四、代码质量差距

### 4.1 类型与检查

- `tsc -b --force` 严格模式通过（**注意**：`npx tsc --noEmit` 在此仓库是假绿——tsconfig 是 `files:[]`+仅 references，秒退 0 错，必须用 `tsc -b --force`）。
- lint 0 error（8 条既有 warning 与近期改动无关），单测全量 **2388（2387 通过 / 1 跳过 / 0 失败）**。

### 4.2 测试质量与「假绿体检」

- `#85/#86/#87` 全库扫描三类反模式并加固：iconCache「没借过就还」改真断言、usePrefSync 失败路径断言真上传、`SiteSettingsModal` 固定 350ms 睡眠改轮询（消 CI 慢机假红）。
- 真机探针（`harness/run-probe.sh` 同次 bash 起 stub+CDP Chrome）覆盖布局/滚动条回路；`SHOW_SCROLLBARS=1` 复现滚动条↔宽度↔图片高回路。
- 源码注释陷阱已规避（`/*` 会被静态守卫当块注释吃掉——已留自愈守卫）。

### 4.3 架构瘦身

- `App.tsx` 2046→1972（渐显/锚点/分组色/失效巡检抽到 `hooks/useNavSceneEffects.ts`）；`SiteCard` 1024→975（`copyText` 去重、头像配色抽 `utils/siteAvatar.ts`）；`GroupCard` 914→892（挂载调度抽 `utils/mountQueue.ts`）。可独立测试、可复用。

### 4.4 SQL 与数据安全

- 多步写入同 D1 `batch`；回收站存完整字段/tagIds；JWT cookie/吊销；aesKey 缓存 PBKDF2；外部 `safeFetch`。
- 附件 500 真因（漏绑 uid）已修；AI 向量跨账号误删（缺 scope）已修（`d9836e5`）；SELECT 别名必须 camelCase（SQLite 0/1 断言用 `!!x.hasPassword`）等坑已钉死。

**结论：代码质量达标且多处优于 inkstone（安全护栏、真库测试、假绿加固）；无技术债级差距。**

---

## 五、整体差距程度：客观评估

| 维度 | 对齐度 | 剩余真实差距 | 安全级缺口 |
|---|---|---|---|
| 功能特性（记事本） | ≈ 100% | 无 | 无 |
| 功能特性（平台运维） | ≈ 90% | 5 个 P3 小件（备份租约/欢迎笔记/服务端尺寸/删除队列/Obsidian 回退） | 无 |
| 架构设计 | ≈ 95% | 备份租约 1 件；DO 本体维持不做（降级替代已给） | 无（反向更严） |
| 性能表现 | ≈ 95% | 无瓶颈；FTS 同步写是有意取舍 | 无 |
| 代码质量 | ≈ 100%（超） | 无 | 无（护栏更强） |

**总评**：

1. **记事本功能面已完全追平**，用户可感知的差异为零；图谱交互（最后的记事本挂账项）已在 `723db4d` 关闭。
2. **唯一「功能缺项」是平台运维层的 5 个 P3 低频小件**，单项成本 0.5–2h，无一个是安全级或体验硬伤，可择机攒一批做。
3. **跨设备实时同步与多目标备份是「有意不做」**，已用 BroadcastChannel + cursor 轮询 + 单目标备份覆盖绝大多数场景；8 项不做清单维持原判。
4. **架构与代码质量无缺陷级差距**，多账号隔离、安全护栏（Trusted Types / SVG 不收 / Mermaid 沙箱 / 口令附件会话）、真库测试反而优于 inkstone 的单用户纯笔记假设。
5. **无安全级缺口**：原唯一安全项（口令分享附件暴露，`4.1`）已在 `723db4d` 关闭；AI 向量跨账号误删已在 `d9836e5` 关闭。

**整体差距程度：功能 ~97% 对齐、平台运维仅余低成本小件、架构/性能/代码质量达标或超、无安全级缺口。** 继续投入的边际收益已很低，优先级应让位于产品新方向（如导航站 AI、审计可视化）而非继续贴齐 inkstone。

---

## 附：建议收尾清单（均为 P3，可选）

1. 备份互斥租约（防 cron/手动并发）
2. 欢迎笔记（首登注入教学）
3. 上传路径补图片尺寸探测（AVIF 也解析）
4. 附件删除失败入队 + cron 兜底
5. Obsidian 导入 `resolveAsset` 加文件名全局回退

> 8 项不做（MCP/TOTP/Realtime DO/i18n/S3 多目标/头像/PWA 更新/demo）维持。
