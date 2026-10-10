# 记事本 vs inkstone：第二轮源码级差距清单（2026-10-10）

- 对照物：inkstone 源码（`harness/inkstone-src/`，当前快照）
- 被查物：NaviHive（`src/` + `worker/`，本地 `f127cb3` / 远端 `9e311ae`）
- 方法：逐文件读 inkstone 表面层（工具栏 / 命令面板 / 设置分区 / 反链面板 / 编辑器粘贴与快捷键 / Markdown 块），再 grep NaviHive 当前实现确认是否已具备。
- 与 [2026-10-09 报告](./notes-inkstone-gap-2026-10-09.md) 的关系：**那一轮列的 G1–G15 中，批次 1–4（ff2ad22）+ 本轮三项修正已关闭绝大多数**；本文只列**仍存在的真缺口**与**新增发现**，不重复已对齐项。

---

## 一、已对齐基线（本轮不必再动）

以下在 2026-10-09 之后已落地，复查确认仍在：

| 模块 | 证据 |
| --- | --- |
| 三栏 + 三档断点、状态栏六项、格式工具栏 7 组 + 块/代码/表格 | NotesPage.tsx 工具栏 / useEditorTools.ts |
| Markdown 全语法（callout / tabs / details / 脚注 / front-matter 渲染 / Mermaid / 数学 / 嵌入 / 任务列表 / 高亮 / 隐藏注释） | utils/markdownToReact.tsx |
| 大纲 / 反链（下拉）/ 版本历史（Modal + 行级 diff）/ 导出 md·html·pdf·zip（含附件） | NotesPage.tsx / NoteVersionHistoryDialog / zip |
| 双链 `[[标题]]`、笔记嵌入 `![[标题]]`、块引用 `![[标题#^块ID]]`、块 ID 插入 | utils/noteWikiLink.ts / utils/noteBlocks.ts / useEditorTools.ts:559-569 |
| 附件管理器、备份页（频率/保留/立即备份/测试/运行记录）、从 WebDAV 恢复 | AttachmentManager / NotesSettingsDialog / worker/routes/backup.ts |
| 图片灯箱、本地模糊搜索高亮、FTS5 服务端检索、`rev` 乐观并发、收藏/置顶分离、双链图谱、多选批量条、行菜单复制三项 | 各模块（批次 1–4） |
| 阅读位置记忆 / 滚动同步 / 密度 / 字号 / 正文宽度 / 自动保存 / 打字机 | 设置项 |

---

## 二、仍存在的真缺口（按优先级）

### P0 —— 高价值、中低风险，建议先做的三件

#### N1 记事本命令面板（旧 G11，仍缺）
- inkstone：`CommandPalette.tsx` —— 一个面板同时搜 **命令**（新建/收藏/归档/分享/删除/布局切换/主题/导出 zip/回收站/收藏夹）、**笔记**（本地 fuzzy + 远端 `/search` 全文命中带 snippet）、**标签**、**文件夹**，空查询给「最近打开」+ 快捷命令，`>前缀` 只搜命令，无结果可「用当前输入建笔记」。
- NaviHive：`CommandPalette.tsx` 是**导航站专用**（`useAppCommands`）；记事本里 ⌘K 只是「聚焦搜索框」（NotesPage.tsx:1978 / :3429）。记事本内没有命令入口、不能搜标签/文件夹、不能一键建笔记。
- 价值：长库里跳笔记/执行操作最快的入口，目前记事本里缺失。
- 工作量：中。纯前端；复用现有 `fuzzy.ts` / FTS5 `/search`，新一个 `NotesCommandPalette` 组件 + ⌘K 在记事本上下文改派发。可单测（项生成/分组/远端命中合并）。

#### N2 编辑器内查找 / 替换（inkstone 有，NaviHive 没有）
- inkstone：`editor/shortcuts.ts:38` `find: mod+f → openSearchPanel`（`@codemirror/search`）+ `mod+d → selectNextOccurrence`。编辑器内原生查找面板，支持替换。
- NaviHive：编辑器（CodeMirror）**未接入 `@codemirror/search`**，⌘F 走浏览器整页查找（markdownToReact.tsx:519 注释也承认这点）。长笔记里定位/改词很别扭。
- 价值：高频编辑操作，体验差距明显。
- 工作量：低–中。CodeMirror 自带 search 扩展，挂上 keymap + 一个轻量面板 UI 即可（样式对齐现有工具栏/弹层）。纯前端。

#### N3 粘贴 / 拖拽图片直接进编辑器正文（inkstone 有，NaviHive 没有）
- inkstone：`editor/paste.ts` —— 粘贴或拖入图片文件 → 先插入「上传中…」占位符 → 上传完成替换成 `![](url)`；还把**富文本 HTML 粘贴转成 Markdown**（标题/列表/表格/引用/链接/图片，含 URL 安全过滤）。
- NaviHive：编辑器**没有 paste/drop 图片处理**（`src` 里只有工具栏「上传图片」按钮：NotesPage.tsx:6932 `uploading` + `canInsertOk`）。要从别处拷图，得先存文件 → 点按钮 → 选文件，链路断在「粘贴」这一步。
- 价值：截图即贴是笔记类 App 最高频动作之一。
- 工作量：中。需要把现有附件上传管线接到编辑器内部（占位符 → 上传 → 回写正文），并复用 `NoteImage` 模块级缓存；HTML→MD 转换是附赠项、可后做。

### P1 —— 值得做，但收益/成本比次之

#### N4 反链改成右侧常驻面板 + 服务端上下文（旧 G14，仍部分缺）
- inkstone：`BacklinksPanel.tsx` 是工作区**右栏常驻**面板，调 `api.notes.backlinks` 拿「谁链了我」+ 每段**上下文摘要** + 数量角标；加载失败有重试。
- NaviHive：反链在**下拉菜单**里（NotesPage 旧逻辑），且**客户端算**、无上下文摘要。功能在，但「常驻 + 上下文」的可见性差一档。
- 价值：双链是核心卖点，反链可见性直接影响使用频率。
- 工作量：中。UI 把下拉改右栏面板；上下文摘要若要服务端算需加 `backlinks` 端点（或继续客户端算、只补上下文截取）。建议先 UI 面板化、上下文客户端截取，端点留作可选。

#### N5 富文本 HTML → Markdown 粘贴（N3 的附赠，可单列）
- 见 N3。单独做价值中等（从网页/微信拷内容最常用），但依赖同一套 paste 钩子，建议和 N3 同批。

#### N6 Wiki 链接别名 `[[目标|显示名]]`
- inkstone：`shared/markdown-utils.ts` 解析 `[[target|alias]]`，渲染用 alias 当显示。
- NaviHive：`noteWikiLink.ts:29` 明确**不支持别名**（「没有别名语法」）。
- 价值：低–中。让同一篇笔记在不同位置显示不同文字，写文档体感更好。
- 工作量：低。解析 + 渲染各加一处；纯前端 + 单测。

### P2 —— 可选 / 低成本润色

| # | 项 | inkstone | NaviHive | 工作量 |
| --- | --- | --- | --- | --- |
| N7 | 块引用支持 `#标题` 锚点（不止 `^块ID`） | `renderer.ts:748` 解析 heading/blockId | 仅 `^块ID` | 低 |
| N8 | Front-matter 插入 / 编辑入口 | `EditorToolbar` 有「front matter」项 | 仅渲染、无插入命令 | 低 |
| N9 | 图谱增强（depth / global-local 两种范围、按关系过滤） | `GraphPanel.tsx` | 已有基础图谱，无 depth | 中 |
| N10 | 备份服务商预设（**本轮已主动删除**） | inkstone 有 `backupPresets.ts` | 我们刚删 `WEBDAV_PRESETS` | — 见「明确不做」 |

---

## 三、明确不做（本轮新增 + 沿用）

沿用「宁缺勿假」：做不到位的宁可不放按钮。

| 不做 | 理由 |
| --- | --- |
| MCP server / AI 搜索 | 与「个人导航站 + 记事本」定位无关，引入密钥管理与授权页 |
| TOTP 两步验证 + 恢复码 | 个人自用；已有 JWT + 登录守卫 + 恢复密钥 |
| Realtime 同步（DO sync-hub） | 要 DO 绑定 + 部署配置；个人单库无多端实时需求 |
| S3 备份目标 / 多备份目标管理 | WebDAV 已覆盖；单目标够用 |
| i18n 中英双语 | 单中文使用者，改造成本极高收益为零 |
| 模板 / 日记 / 笔记别名属性 / 写作目标 | **本轮核查确认 inkstone 也没有这些**——不是差距，不跟风 |
| 备份服务商预设（N10） | 地址只在导航页「数据备份」里填，记事本备份页重复给是噪音；本轮已删，不恢复 |
| 「重建索引」假开关 | 没有服务端索引就不放假开关（既有原则） |

---

## 四、后续批次方案（建议落地顺序）

排序原则：**先补编辑/导航的高频洞（纯前端、可单测），再动面板形态与服务端。** 全部纯前端零迁移，除非标注。

### 批次 A（P0，建议紧接着做）
- **N2 编辑器内查找/替换**：接 `@codemirror/search`，`mod+f` 开面板、`mod+d` 选下一个；面板 UI 套现有弹层样式。最低风险、最高频。
- **N1 记事本命令面板**：新 `NotesCommandPalette`；⌘K 在记事本上下文改派发；命令 + 笔记(local fuzzy + 远端 `/search` 命中) + 标签 + 文件夹 + 空查询最近 + `>` 仅命令 + 无结果建笔记。
- **N3 + N5 粘贴/拖拽图片进正文 + HTML→MD**：编辑器 paste/drop 钩子 → 占位符 → 复用附件上传 → 回写 `![](url)`；HTML 分支转 MD。

> A 三件合起来补的是「**在笔记里找得到（⌘F）、跳得快（命令面板）、贴得进（图片/HTML）**」三个最实际的日常洞，且全部不动后端与写路径。

### 批次 B（P1）
- **N4 反链右侧常驻面板**：下拉 → 右栏面板，带上下文截取 + 数量角标；服务端 `backlinks` 端点按需补（也可先客户端算）。
- **N6 Wiki 别名 `[[目标|显示]]`**：解析 + 渲染 + 单测。

### 批次 C（P2，看心情）
- **N7 块引用 `#标题` 锚点** · **N8 front-matter 插入** · **N9 图谱 depth/范围增强**。

---

## 五、验收与风险

- 全纯前端、零 `SCHEMA_VERSION` 改动（N1/N2/N3/N4/N6 都不碰表结构；N4 服务端端点可选）。
- 单测钉死：命令面板项生成与远端命中合并、查找面板开关、paste 占位符→回写、HTML→MD 转换、wiki 别名解析/渲染。
- 真机探针只验布局（编辑器内查找面板不挡滚动条、命令面板在 125% 缩放下不溢出视口）。
- 推送即交付（不动 `wrangler deploy`、不验证 CF 部署）；502 走 `harness/api_push2.py`。
