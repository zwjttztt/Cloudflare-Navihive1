# 记事本 vs inkstone：源码级全面差距清单（第三轮）

- 日期：2026-10-09（本地 `257bdf3`）
- 对照物：inkstone 源码（`C:\Users\95370\AppData\Local\Temp\inkstone`，52.8k 行 TS/TSX）
- 被查物：NaviHive（`src/` + `worker/`，68.4k 行）
- 方法：**逐文件读两侧源码**对照（不是像 2026-10-06 那轮那样只靠线上界面清点）。
  下表每条都带 `文件:行` 出处，可复核。

> 前两轮的产物：`docs/notes-inkstone-gap-2026-10-06.md`（界面清点）、`docs/notes-inkstone-plan.md`。
> 那一轮列的「缺反向链接 / 版本历史 / 大纲 / 导出 / 高亮 / Mermaid / 图片 / 脚注 / 内容块」**本轮已全部补齐**，不再重复。

---

## 一、已经对齐的部分（基线，不用再动）

| 模块 | inkstone | NaviHive | 证据 |
| --- | --- | --- | --- |
| 三栏 + 三档断点 | desktop/tablet/mobile | 同（`usePanelBreakpoint` 1180/768） | NotesPage.tsx:1521-1545 |
| 状态栏六项 | 字数·字符·约N分钟·文件夹·标签(≤4)·创建于 | **完全一致** | NotesPage.tsx:4594-4650 |
| 保存指示位置 | 头部 SaveIndicator | 头部 | NotesPage.tsx:1266-1293 |
| 格式工具栏 | 7 组菜单 + 6 个直按 | 同（另有块/代码语言/表格扩展） | NotesPage.tsx:6448-7105 |
| Markdown 渲染 | callout/tabs/details/脚注/front-matter/Mermaid/数学/嵌入/块ID/隐藏注释/代码折叠/任务列表/高亮 | 同 | utils/markdownToReact.tsx |
| 大纲 / 反链 / 版本 / 导出 md·html·pdf / 只读分享(含口令+浏览数) | ✅ | ✅ | NotesPage.tsx:4132-4260 |
| 附件管理器 | 4 档筛选 + 引用计数 + 50 分页 + 清理 | 照抄 | components/AttachmentManager.tsx |
| 数据页 | 8 格概览 + 附件字节 + 管理/导出/导入/维护 | 9 格（多一个「分享」） | NotesSettingsDialog.tsx:859-1008 |
| 备份页 | 频率 7 档 + 保留 6 档 + 立即备份 + 测试 + 最近 12 条 | **逐项一致** | NotesSettingsDialog.tsx:1198-1261 |
| 分屏（在侧边打开）+ 分屏时右上角收进「更多」 | ✅ | ✅（本轮刚做） | NotesPage.tsx 条件渲染 |
| 阅读位置记忆 / 滚动同步 / 密度 / 字号 / 正文宽度 / 自动保存延迟 / 打字机 | ✅ | ✅ | — |
| 文件夹拖放移动笔记 + 父子拖放 | ✅ | ✅ | NotesPage.tsx:651-705, 3197 |

---

## 二、一级差距：整块功能缺失

### G1 版本历史只有下拉菜单，没有预览、没有行级 diff

- inkstone：`features/workspace/VersionsPanel.tsx` — 880px Modal，**左列版本列表**（「最新」/相对时间 + 全时间 + 体积），**右栏与当前正文做行级 diff**（`computeLineDiff` 180-263：前缀后缀剥离 + LCS，`MAX_LCS_CELLS=600000` 超阈值降级为「整段删+整段加」，渲染上限 4000 行，中间插「N 行未改动已隐藏」），顶栏显示 `+N / -N`，底部「恢复此版本」并提示*当前内容会先存为新版本*。
- NaviHive：`NotesPage.tsx:5584-5623` —— 一个 `Menu`，列出 `时间 / 标题 · 字数`，**点了直接恢复**。
- 影响：恢复前看不到改了什么；误点一下正文就被覆盖（虽有快照兜底，但用户没有预览与反悔的余地）。
- 工作量：纯前端 + 纯函数单测，后端不用动。

### G2 没有服务端全文检索

- inkstone：`worker/routes/search.ts`(637) + `worker/db/fts.ts`(229) —— FTS5 虚表，`/search` 返回 `SearchHit{note, snippet, score}`，`mode: 'fts' | 'like'` 双模式降级，另有 `/search/reindex` 回填。
- NaviHive：`NotesPage.tsx:2036-2045` `searchHits` —— 客户端 `title/content/tag.includes(kw)`，**只在已加载的 notes 上跑**，无高亮、无相关度、无命中片段。
- 影响：卸载/未加载的笔记搜不到；搜到也看不到上下文；长文里定位不到位置。
- 折中选项：先搬 inkstone `client/lib/fuzzy.ts`(112) 做本地模糊匹配 + `<mark>` 高亮（零后端改动），FTS5 留到后面。

### G3 没有双链图谱

- inkstone：`features/graph/GraphPanel.tsx`(675) + `/search/graph`（`GraphNode/GraphEdge`，global/local 两种模式 + depth）。
- NaviHive：反链是 `NotesPage.tsx:5627` 的下拉菜单，纯前端算（注释写明「不查库」），没有图谱。
- 说明：个人库规模下反链菜单够用，图谱是「好看 > 好用」的那一类；不做也能自洽。

### G4 备份只有「上传」，没有「从网盘取回」

- inkstone **也没有**从 WebDAV 恢复 —— 它的恢复入口是 `DataSettings.tsx:163-181` 的「选择备份文件夹」（本地选目录 → `restoreMarkdownBackupFolder` → `transfer.import`）。
- NaviHive 零件齐全：`webdavList` + 既有解密链 → 喂给 `notes/import`（uuid 合并、较新者胜）。#224 已论证可行。
- 影响：备份目前是**单向的**——能存不能取。这是备份功能最大的现实缺口。

### G5 导出 JSON 不含附件

- inkstone：`api.transfer.save('zip')`，`shared/zip.ts`(424) 自实现 crc32 + `createZip`/`readZip`（**零第三方依赖**，store/deflate 手写），zip 含笔记/文件夹/标签/附件，UI 文案「用于完整恢复」。
- NaviHive：数据页文案明写「不含图片附件」（`NotesSettingsDialog.tsx:938`）。
- 影响：一旦删站或迁移，正文里的图片永久丢失。
- 备注：之前把它归为「需新依赖」而搁置；看完 inkstone 的 zip.ts 可以确认**不需要新依赖**，值得重开评估。

---

## 三、二级差距：有，但形态/粒度不同

| # | 项 | inkstone | NaviHive |
| --- | --- | --- | --- |
| G6 | 备份目标 | 多目标（`backup_targets` 表，启用/禁用/测试/删除，上限 `LIMITS.backupTargetsMax`）+ **S3 兼容**（`backup/s3.ts` 467 行，aws4 签名 + multipart）+ 服务商预设引导（`backupPresets.ts` 192 行，InfiniCLOUD 等一键填字段） | 单 WebDAV，无 S3，无预设 |
| G7 | 备份内容 | `snapshot.ts`(633) 打包 + `scheduler.ts` 增量 changeLog + 到期裁剪 | 每次全量 JSON（`worker/notesBackup.ts`） |
| G8 | 并发控制 | `PatchNoteBody.rev` + `ConflictPayload` 409 冲突 | 无 rev，最后写入获胜；多端同时编辑会**静默覆盖** |
| G9 | 收藏 / 置顶 | `isPinned`（排序）+ `isStarred`（收藏视图）两个独立开关 | 只有一个 `pinned`：`view === "starred"` 判的也是 `n.pinned`（NotesPage.tsx:2057）——两个语义共用一个字段 |
| G10 | 列表多选 | shift 范围选 / ctrl 加选 + `BulkBar`（批量收藏·移动·归档·删除） | 只能单条操作 |
| G11 | 命令面板 | 命令 + 笔记 + 标签 + 文件夹 + 远端命中，`>` 前缀只搜命令 | `CommandPalette.tsx` 只服务导航站；记事本里 ⌘K 是聚焦搜索框 |
| G12 | 图片灯箱 | `Preview.tsx:351` → `ui.lightbox` → `Lightbox.tsx` | 预览里的图片点了没反应 |
| G13 | 设置分区 | 9 个（appearance/editor/backup/sync/mcp/account/data/shares/about） | 5 个（NotesSettingsDialog.tsx:52）——sync/mcp/about 属另一层面，account 在导航站层 |
| G14 | 反链形态 | 右侧常驻 `BacklinksPanel` | 下拉菜单 |
| G15 | 行菜单项 | 复制标题 / 复制ID / 复制直链 / 创建副本 / 移到文件夹 / 导出×3 | 有 open-side/pin/folder/archive/duplicate/export×3，缺三项「复制」 |

---

## 四、明确不做（及理由）

沿用「宁缺勿假」原则——做不到位的宁可不放按钮。

| 不做 | 规模 | 理由 |
| --- | --- | --- |
| MCP server / AI 搜索 | `mcp/*` 3300+ 行 + OAuth + API key + 授权页 | 与「个人导航站 + 记事本」定位无关，要引入 AI 依赖与密钥管理 |
| TOTP 两步验证 + 恢复码 | `lib/totp.ts` + `totp-service.ts` 865 行 | 个人自用；已有 JWT + 登录守卫 + 恢复密钥 |
| Realtime 同步（Durable Object sync-hub） | `realtime/sync-hub.ts` + `routes/sync.ts` | 多端协同场景；要 DO 绑定，免费额度与部署配置都要动 |
| i18n 中英双语 | `shared/locales/*` 1333×2 行 + 全量文案改造 | 单一中文使用者，改造成本极高、收益为零 |
| S3 备份目标 | 467 行签名 + 分片上传 | 除非真有 S3；WebDAV 已覆盖 |
| 多备份目标管理 | 目标表 CRUD + 每目标独立状态 | 单目标够用；真要第二个目标，加「第二个 WebDAV」比整套目标管理划算 |
| Obsidian 导入 | `lib/obsidian-import.ts` 122 行 | 除非真有 Obsidian 库 |
| 「重建索引」开关 | — | 没有服务端索引就不放假开关（此前已定的原则） |

---

## 五、下一步方案（按批次）

排序原则：**先补完已有功能的洞，再谈新增能力；先纯前端零迁移，再动后端与写路径。**

### 批次 1 —— 纯前端、可单测、不动后端与写路径（推荐先做）

| 项 | 内容 | 风险 |
| --- | --- | --- |
| G1 | 版本历史改成 Modal：左列版本 + 右侧行级 diff（搬 `computeLineDiff`，含 LCS 上限/降级/渲染上限）+ 底部恢复并提示「当前内容先存为新版本」 | 低。纯函数可单测（前缀后缀剥离、超阈值降级、4000 行截断） |
| G12 | 图片灯箱：预览区图片点击 → 全屏层，Esc / 点空白关 | 低 |
| G2a | 本地模糊搜索 + `<mark>` 高亮（搬 `lib/fuzzy.ts` + `splitByRanges`） | 低。纯函数单测 |

> 这三项合起来补的是「**恢复前能看清改了什么**」「**图片点得开**」「**搜得到、看得见命中位置**」三个最实际的洞。

### 批次 2 —— 备份闭环（建议紧接着做）

| 项 | 内容 | 风险 |
| --- | --- | --- |
| G4 | 从 WebDAV 恢复：列出网盘上的备份 → 选一份 → 下载解密 → 喂 `notes/import`，复用现有 uuid 合并语义 | 中。要加两个端点（list / download-restore）；复用已有解密链与出站限速闸门 |
| G5 | 导出 zip 含附件：搬 `shared/zip.ts`（零依赖），导出侧打包笔记+附件，导入侧解 zip | 中。只动导出/导入两条边路，不动写路径 |

> 做完这两项，备份从「单向存档」变成「存得进去也取得回来，且图片不丢」。

### 批次 3 —— 检索增强

| 项 | 内容 | 风险 |
| --- | --- | --- |
| G2b | D1 FTS5 虚表 + `/api/search` + `/search/reindex`，带 snippet/score，fts/like 降级 | 中高。要建表、迁移（**记得 `SCHEMA_VERSION` +1**，#216 的坑）、回填、增量维护 |

### 批次 4 —— 数据一致性（风险最高，单独评估）

| 项 | 内容 | 风险 |
| --- | --- | --- |
| G8 | `rev` 乐观并发 + 409 `ConflictPayload` + 客户端冲突提示 | 高。触及所有写路径，改错就是丢数据 |
| G9 | `isStarred` 与 `isPinned` 分离 | 中。加列 + 迁移 + UI 两处开关 + 老数据回填语义 |

### 可选（收益/成本比一般，看心情）

G3 双链图谱 · G10 列表多选批量条 · G6 备份服务商预设（只做 WebDAV 那几个）· G15 三项「复制」

---

## 六、本轮遗留（与上面无关但要记账）

1. 本地 `257bdf3` 与远端 `4c9e88a` 分叉（push 被代理拦），代理恢复后需 `fetch + rebase` 对齐。
2. `e2e:cron` 在本机跑不起来（workerd 在这台 Windows 上 access violation），20/20 只能靠 CI(ubuntu) 复跑确认。
3. `SiteSettingsModal`「关掉大窗」用例偶发时序失败、复跑即过，继续观察。
