# NaviHive × inkstone 全项目逐模块对比报告（2026-10-11）

基线：NaviHive 本地 `eb9aa5b`（远端 `006f5dd`，含「连点置顶误报冲突框」修复）对照 `harness/inkstone-src`（全套 client / worker / shared 源码）。

方法：逐目录枚举两侧全部源文件（inkstone 131 个 ts/tsx，本项目 220+ 个），对每类能力做源码级核对——不是按文档或界面印象。此前五轮记事本专项对比（`notes-inkstone-gap-2026-10-06/09/10-r3/r4.md`）已关闭的项只在「已对齐清单」里一行带过，本轮重点补齐前几轮**没覆盖的平台级模块**（同步、会话、维护、备份引擎、导入管线、设置面板全集）。

---

## 一、总览结论

1. **记事本功能面已基本追平**：前四轮报告列出的差距经批次 A/B/C（第五轮）后，G1–G4、G6、G7 全部关闭；本轮逐项复查无一复活。剩余的记事本差距只有 2 类：**图谱交互余项**（r4 G5，一直没排）和若干**边缘行为差异**（见第四节）。
2. **新发现的最大差距在「平台层」而不是「功能层」**：inkstone 是单用户纯笔记应用，围绕多设备/多标签页做了整套基础设施——实时同步（DO WebSocket + 轮询回退 + 多标签 leader 选举）、分享附件的口令会话、过期数据 cron 清理、备份互斥租约。这些此前「维持不做」清单里只挡住了 Realtime DO 本体，**没挡住它的降级替代品**（轮询 + BroadcastChannel），本轮把它们单独拆出来重新评估。
3. **发现 1 个安全行为差异**：口令保护的分享，其**附件不受口令保护**（凭 uuid 直取）。inkstone 用 share-asset-session 把附件访问绑到「口令验证通过后发的短时会话」上。这是本轮最重要的新发现。
4. **1 个可用性硬伤**：HTML/PDF 导出不内联私有图片，导出文件在别的机器打开图全裂（inkstone 有 inlinePrivateImages）。改动小、收益直接。
5. **明确不做的 8 项维持不变**（MCP、TOTP、Realtime DO、i18n、S3 多目标、头像、PWA 更新检查、demo 模式），本轮逐项复核后没有翻案理由，但把「不做」的边界写清楚了——不做的是**形态**，不是其中可以用低成本方式拿到的**效果**。

---

## 二、已对齐清单（逐模块复查记录）

| 模块 | inkstone 侧 | 本项目侧 | 状态 |
|---|---|---|---|
| 编辑器补全 | `editor/completion.ts` 三来源 | `utils/noteCompletion.ts`（含第五轮 label/守卫修复） | ✅ |
| 任务勾选回写 | `Preview.tsx:272-288` | `utils/noteTasks.ts`（顶层可点、嵌入只读同款） | ✅ |
| 代码块折叠 | `enhance.ts:91` collapseLines | `markdownToReact.tsx:767` foldCodeLines | ✅ |
| 编辑器设置 | `EditorSettings.tsx` 10 项 | `notesSettings.ts` 覆盖全部并有超出（indentWidth/autosaveMs/previewFont/contentWidth…） | ✅ 超出 |
| 界面密度/阅读位置/打字机/专注 | workspace 系列 | data-notes-density / readingPosition / NoteTypewriter / focusMode | ✅ |
| 渲染容器语法 | renderer.ts `details/tabs` | `markdownNoteBlocks.ts` tabs/fold | ✅ |
| 数学/Mermaid | katex-loader + enhance | markdownMath + Mermaid 沙箱（独立 iframe，安全上更强） | ✅ |
| 反链/大纲/图谱基础 | BacklinksPanel/Outline/GraphPanel | BacklinksPanel/noteOutline/NoteGraphDialog（标题过滤+邻域+350 上限） | ✅（图谱交互见差异） |
| 灯箱 | Lightbox.tsx | 键盘缩放/焦点收口/滚动锁（第五轮） | ✅ |
| 列表性能 | NoteList content-visibility | 第五轮已加 + containIntrinsicSize 放宽 | ✅ |
| 标签颜色/快捷多选 | NoteList/tagColors | TagColorDialog + ⌘/Shift 多选（第五轮） | ✅ |
| 附件管理器+清理未引用 | AttachmentManager + DataSettings | AttachmentManager + `data.ts:423` prune（引用计数按笔记去重） | ✅ |
| FTS 服务端检索 | `worker/db/fts.ts` | FTS5 unicode61 + segmentCJK + 降级 LIKE + 导入后自动重建 | ✅（差异见 4.6） |
| rev 乐观并发 | notes store | 409 + NoteConflictError + 冲突弹框 + 自撞修复（writeQueue，今日 `eb9aa5b`） | ✅ |
| 分享（口令/次数/过期/撤销/列表） | SharePanel + SharedNotes | NoteShareDialog + 分享列表 + PublicNotePage | ✅（附件口令见 4.1） |
| 版本历史行级 diff | VersionsPanel | `utils/noteDiff.ts` + NoteVersionHistoryDialog | ✅ |
| 导出 md/html/pdf | export-note.ts | noteExport + noteHtmlExport（隐藏 iframe 打印，避开 Trusted Types） | ⚠️ 见 4.2 |
| ZIP 导出/导入（含附件） | shared/zip.ts + backup-import | `utils/zip.ts`（零依赖 crc32+deflate）+ NotesPage `importNotesFile`（`![[wiki]]` 与相对路径引用都重写，`NotesPage.tsx:3095-3102`） | ✅ |
| Obsidian 文件夹 ZIP 导入 | `worker/lib/obsidian-import.ts` | 客户端实现：目录→文件夹树、front-matter/正文标签提取、附件回传重写 | ✅（健壮性差异见 4.7） |
| 数据页维护 | DataSettings（清理未引用/清空回收站） | NotesSettingsDialog 数据节 + prune + 回收站 | ⚠️ 缺「重建索引」见 3.5 |
| 记事本备份（频率/保留/runs/取回/删除） | BackupSettings + worker/backup | notesBackup（独立目录/前缀/保留含新一份/WebDAV 取回恢复/最近备份可删） | ✅（多目标不做） |
| 登录设备管理 | AccountSettings（sessions） | AccountDialog 设备列表 + 单踢 + 退出其它设备 | ✅ |
| 网盘预设 | backupPresets | 第五轮已加 | ✅ |

---

## 三、inkstone 已实现、当前项目缺失的功能清单

### P1（建议尽快做）

**3.1 分享附件口令会话（share-asset-session）** — 安全差距，详见 4.1。
**3.2 HTML/PDF 导出内联私有图片** — 可用性硬伤，详见 4.2。

### P2

**3.3 图谱平移/缩放/拖拽 + 分组着色 + 偏好持久化**（r4 G5 余项，一直未排）
inkstone `GraphPanel.tsx`：pointer 拖拽画布与节点、pinch 缩放、`groupBy: none|folder|tag` 按 `organizer-colors` 给节点着色、全部偏好 localStorage 持久化。我们只有标题过滤/邻域模式/350 上限/未解析目标入口。**不需要引入力导向**，平移缩放和分组着色是独立子集，可单独做。

**3.4 多标签页轻量同步（Realtime DO 的降级替代）**
inkstone `SyncEngine`（`lib/sync.ts`）在 WS 不可用时自动降级为**轮询**（默认间隔可配 5–120s，`SyncSettings.tsx:102`），并用 **BroadcastChannel + leader 选举**保证同源多标签只有一个标签页发请求、变更通过 BroadcastChannel 秒传给其它标签。我们没有其中任何一层：同开两个标签页互不知道对方改了什么（要手动刷新）。**成本收益最好的切入点是 BroadcastChannel 这一层**——同源标签页零服务器成本，做「有别的标签页改过 → 顶栏提示一键刷新」即可把最疼的场景关掉；跨设备轮询拉取（cursor 增量）可以作为第二步，D1 上按 `updated_at` 游标拉，不需要 DO。

**3.5 手动「重建搜索索引」入口**
inkstone DataSettings 有维护按钮（搜索结果不对时自救）。我们 FTS 建表探针失败会降级 LIKE，导入后会自动重建，但**没有手动重建入口**——万一索引与数据漂移（例如未来加迁移回填正文），用户没有任何自救手段。一个 `POST /api/notes/reindex` + 一个按钮即可。

### P3（低频/锦上添花）

**3.6 过期运维数据 cron 清理**：inkstone `lib/maintenance.ts` 每次清理 expired sessions / share-asset-sessions / login challenges / login attempts（LIMIT 500 分批）。我们 `user_sessions` 过期行只靠登录时校验、不删除，长期积累（低频但只增不减）。
**3.7 备份互斥租约**：inkstone `lib/lease.ts`（app_meta 上的 TTL 租约 + renew/release）保证备份任务不重入。我们 cron 与手动备份理论可并发（同一 WebDAV 目录两份同时写），风险低但零成本可加。
**3.8 欢迎笔记**：inkstone `shared/welcome-notes.ts` 首次进入给示例笔记教学语法。我们新用户面对空白编辑器。可选。
**3.9 服务端图片自然尺寸**：inkstone `worker/lib/image.ts` 上传时读 png/jpeg/gif/webp 尺寸存附件元数据；我们靠客户端 imageCache(LRU 64) 记自然尺寸。两种方式效果近似，服务端版对「换设备首开」更稳。

### 明确不做（本轮复核维持，共 8 项）

MCP server（`worker/mcp/*` 9 文件：AI 检索/OAuth/API keys/读写）——我们有自己的 AI 助手走另一条路；TOTP 两步验证（`totp.ts`/`totp-service.ts`/`TotpSettings.tsx` 553 行）；Realtime DO 本体（`realtime/sync-hub.ts`）；i18n（`shared/locales/*`，产品只面向中文）；S3/多目标备份（`backup/s3.ts` + engine 多 target）；用户头像（`avatars/*` + AvatarPicker）；PWA 更新检查（`update-check.ts`/UpdateDialog/store/update；我们已有 usePwaInstall 安装引导）；demo 演示模式（`client/demo/*` 三文件，浏览器内模拟后端）。

---

## 四、实现方式或行为不同的功能点（差异细节）

**4.1 口令分享的附件访问（安全，最重要）**
我们：`GET /api/note-shares/attachments/<id>`（`public.ts:65`）→ `getPublicAttachment`（`notes.ts:983`）校验「附件属于一条**未过期、作者 active** 的分享」，**但不校验口令**。口令保护的分享，正文里每张图的 URL 就是访问凭证——截图外流、浏览器历史、Referer 泄漏都会把图片暴露出去（uuid 不可猜是对的，但 uuid 在拿到过一次公开页的任何载体里都是明文）。
inkstone：口令验证通过后 `createShareAssetSession`（`share-asset-session.ts`）发短时会话 token，附件请求必须带 token，且 token 与 slug+passwordHash 绑定、随分享过期。
建议：公开页通过口令后种一个 `share_asset` cookie（或 URL 签名），附件路由校验之；已有 `note_share.password` 列，无需 schema 变更。

**4.2 HTML/PDF 导出图片**
inkstone `export-note.ts:71` `inlinePrivateImages`：导出前把 `/api/files/` 图片 fetch 成 dataURL 内联进 HTML，PDF 走同一管线。
我们：`noteHtmlExport.ts` 只带 `img{max-width}` 样式，图片 URL 是带鉴权的 `/api/notes/attachments/<id>`——导出的文件**离开登录态就全裂**，打印 PDF 同理。
建议：复用同一条链路（fetch → blob → dataURL，走鉴权 cookie），只改导出函数，半天内完成。

**4.3 同步架构（无 vs 有）**
inkstone：WS(DO) + 轮询 + BroadcastChannel + leader 选举 + outbox ack（`sync.ts` 300+ 行）。
我们：单页应用直连 D1，无任何跨标签/跨设备通知；多端冲突靠 rev 守卫兜底（保存时才发现）。
建议见 3.4，分两层做。

**4.4 备份引擎**
inkstone：`worker/backup/` 10 个文件——engine/scheduler/retention/concurrency/lease/snapshot/validation/archive，支持 webdav+s3 多目标、并发租约、分批清理。
我们：`worker/notesBackup.ts` + webdav 四件套，单目标、无租约、保留策略在写回 runs 时一并清。功能等价（单目标下），缺的是 3.6/3.7 两个运维件。**多目标维持不做。**

**4.5 附件删除路径**
inkstone：删附件先记账（FILES_KV pending），cron `drainAttachmentCleanup` 分批删对象（单次 ≤200）。
我们：`DELETE /api/notes/attachments/<id>` 同步删对象。差异在「删除失败的重试兜底」：我们失败就报错留给用户重试，inkstone 有队列兜底。低频，P3。

**4.6 FTS 索引维护**
inkstone：写后进 FTS 队列（`notify.ts` scheduledFtsDrains 延迟批量 drain），加手动重建按钮。
我们：写入路径 `await` 同步建索引（Workers 免费版 `void promise` 会被掐，记忆里钉过），无手动重建。**同步写换可靠性，合理**；缺的只是 3.5 的手动入口。

**4.7 Obsidian 导入健壮性**
inkstone worker 端：扩展名白名单（png/jpeg/gif/webp/avif/svg/pdf）、`.obsidian` 等隐藏目录过滤、按「笔记同目录 → 仓库根 → 文件名索引」三级回退。
我们客户端版：隐藏目录/`__MACOSX`/路径穿越都过滤了（`NotesPage.tsx:3046,3065`），`![[x]]` 与 `![](x)` 都重写；差异是回退查找只有两级（相对路径 → 全路径），没有按文件名的全局回退——Obsidian 里「同名附件放别的文件夹」的场景会漏。小改 `resolveAsset` 即可。

**4.8 附件元数据**
inkstone 服务端读尺寸存库；我们客户端 imageCache。行为差异见 3.9。

**4.9 图片附件 MIME 白名单**
我们 SVG 故意不收（`data.ts:37` 注释：SVG 可携带脚本）——**这条我们比 inkstone 更严，是有意的安全取舍**，写进报告免得未来被当「缺失」翻出来。

---

## 五、建议路线（按优先级）

| 批次 | 内容 | 理由 | 量级 |
|---|---|---|---|
| 1（P1 安全） | 3.1 口令分享附件会话 | 唯一的安全级差距；口令分享的意义 Depends 它 | 半天 |
| 2（P1 可用性） | 3.2 导出内联图片 | 导出闭环的最后一公里，改动集中在 noteHtmlExport | 半天 |
| 3（P2 体验） | 3.3 图谱平移缩放+分组着色+持久化 | r4 挂账至今的最后一项记事本差距 | 半天 |
| 4（P2 架构） | 3.4 BroadcastChannel 多标签提示（可选：cursor 轮询） | 多标签是最常见的「多端」形态 | 提示版半天 / 轮询版一天 |
| 5（P3 运维） | 3.5 重建索引按钮 → 3.6 cron 清理过期会话 → 3.7 备份租约 → 4.7 回退查找 | 都是零风险小件，可攒一批 | 各 1–2 小时 |
| 择机 | 3.8 欢迎笔记、3.9 服务端图片尺寸 | 锦上添花 | — |

---

## 附：反向差异（NaviHive 有而 inkstone 没有，解释定位差异）

本项目是「导航站 + 记事本」双模产品，以下整块是 inkstone 没有的：站点/分组卡片体系（拖拽排序、文件夹父子、书签导入、链接健康巡检、图标代理与 IndexedDB 缓存、拼音搜索）、AI 助手（AI 建卡/配额）、审计日志、访客统计、全局回收站（卡片+分组+笔记三合一）、自定义 CSS/背景体系、离线队列与断网横幅、恢复密钥/邀请码/多账号体系（inkstone 是单用户）。inkstone 的多数「平台件」是为它的单用户纯笔记定位服务的；评估其任何一项时都要先过一遍「在 NaviHive 的多账号 + 导航站语境下是否还成立」——这也是本报告把 8 项「不做」维持原判的依据。
