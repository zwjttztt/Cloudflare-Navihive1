# 记事本对齐 inkstone —— 第三轮全面对比与改进方案（2026-10-10）

基线：NaviHive `d57a1c8`（记事本对齐 inkstone（四）已推送）对照 `harness/inkstone-src`。

本轮只做审查与方案，未改任何功能代码。前两轮已关闭的差距（查找替换、行级 diff、FTS 检索、
rev 乐观并发、starred/pinned 分离、附件、备份、JSON 导入、多选、fuzzy 高亮、别名、锚点嵌入、
命令面板/反链/灯箱/滚动同步的"基本款"）不再重复列出。

---

## A. 确认差距（源码级证据，可直接实施）

### A1. 粘贴链路（P0，差距最大的一块）

对照：inkstone `src/client/editor/paste.ts` vs 本仓库 `src/components/NoteEditor.tsx` + `src/utils/htmlToMarkdown.ts`。

1. **HTML→MD 触发条件过窄（本轮最重要发现）**。
   `NoteEditor.tsx:318` 的条件是 `html && !plain.trim()` —— 而浏览器/微信/文档复制几乎
   总是同时带 `text/html` 和 `text/plain`，所以上一轮交付的"网页内容转 Markdown"在
   最常见的场景下根本不触发。inkstone 的判据是 `!looksLikeMarkdown(text)`（纯文本
   不是 Markdown 语法时才转）且转换结果 `!== text` 才接管。
2. **无 URL 粘贴成链接**：inkstone `paste.ts:43-58`，选区非空 + 粘贴纯 URL →
   `[选区](<URL>)`；我们没有任何处理。
3. **HTML 无协议过滤（安全）**：inkstone `safePastedHref` 只放行
   http/https/mailto/tel（图片仅 http/https），并把目的地包进 `<...>` 且转义空格/尖括号；
   我们 `htmlToMarkdown.ts` 原样输出 `href`/`src`，`javascript:` 可以被粘进正文。
4. **嵌套列表丢失**：`htmlToMarkdown.ts:51-63` 对 `ul/ol` 只做一层 `inline(li)`，
   `li` 里嵌套的 `ul/ol` 走 inline 的 default 分支变成纯文字，层级和序号全丢；
   inkstone `renderList` 递归嵌套并支持 `start`/`value` 属性。
5. **代码块无语言**：inkstone 从 `language-xxx` class 提取语言标注 fence；
   我们输出裸 ``` 。fence 长度也不自适应（内容含 ``` 时会截断，inkstone 按最长反引号串 +1）。
6. **上传占位符语义不完整**：inkstone 用 `<!-- 注释 token -->` 独占标记，成功后整段
   替换为 `![文件名](<url>)`（alt=真实文件名），失败替换为含文件名的 HTML 注释；
   我们 `NoteEditor.tsx:151-165` 只把 token 换成 URL —— 成功后 alt 仍是"上传中…"，
   失败后是 `![上传失败](上传失败)`（渲染成一张破图）。
7. **只处理图片、且只认 `clipboardData.files`**：inkstone 还收
   `clipboard.items` 里 kind=file 的图片兜底（部分应用截图路径），并支持上传任意
   附件文件（isImage 决定 `![]` 还是 `[]`）。我们非图片文件走原生粘贴。
8. **drop 缺 `dragover` preventDefault**：inkstone `paste.ts:87-91` 有；缺了它部分
   浏览器会执行"拖入文件=打开文件"的默认行为。
9. **编辑器销毁防护**：inkstone 上传完成时检查 `view.dom.isConnected`，已分离走
   `replaceDetachedUpload` 兜底；我们对已 destroy 的 view `dispatch` 可能抛错
   （异步上传回来晚于切笔记/关面板时）。

### A2. ⌘K 双触发（P0，源码确认）

`NotesPage.tsx:2007-2018` 的 window keydown 监听**不检查 `e.defaultPrevented`**，
而编辑器里 `link` 绑定的是 `mod+k`（`editorShortcuts.ts:49`）。CodeMirror 的 keymap
命中后 `preventDefault` 但**不阻止冒泡**，事件仍会到 window —— 在编辑器里按
⌘K 会**同时**插入链接语法**和**打开命令面板。inkstone 的 hotkeys 注册表有
`allowInInput` 判定（`lib/hotkeys.ts:59`），`.cm-editor` 算 editable target，
编辑器内的组合键不会被全局热键抢走。

### A3. 命令面板选笔记可能丢未保存改动（P0）

`NotesPage.tsx:6251-6256` 面板的 `onOpenNote` 直接 `setActiveId(...)`：
- 有 dirty 草稿时，`useEffect`（`:2031`）按 `active?.id` 变化直接覆盖 draft ——
  未保存的编辑被丢弃。反链/双链跳转统一走的 `jumpToNote`（`:3212`）是
  "先保存再切"，面板应同款。
- 窄屏不会 `setMobileDetail(true)`，点了像"没反应"。

### A4. 编辑器快捷键少 8 条（P1）

对照 inkstone `editor/shortcuts.ts`，我们没有绑定的：
`task-done`(mod+shift+enter)、`move-line-up/down`(alt+↑/↓)、`delete-line`(mod+shift+k)、
`indent/outdent`(mod+]/mod+[)、undo/redo 显式绑定（redo mac=mod+shift+z、win=mod+y）。
另外 inkstone 把 `select-next-occurrence`(mod+d) 列进表里供帮助面板显示；我们靠
searchKeymap 自带但 UI 不显示。A2 修完后，`link` 与命令面板的 ⌘K 也应写进一张表。

### A5. 滚动同步只有"编辑器→预览"单向（P1）

`src/utils/syncScroll.ts` 已经有 `sourceLineForPreviewTop` 和
`editorScrollForLine` 参数，但 `syncFromPreview` 没实现、`bind()` 只挂了编辑器的
wheel/pointerdown/keydown/scroll —— 预览侧滚动不会带动源码。inkstone
`sync-scroll.ts:65-81,108-119` 是双向 + 同一套 driver 锁。反向函数都写好了，补
`syncFromPreview` + 预览侧事件绑定即可。

### A6. 图谱（P1/P2）

对照 inkstone `GraphPanel.tsx`（675 行，canvas + 物理）：
- P1：**搜索过滤**（按标题过滤节点）、**未解析链接节点**（写了 `[[不存在]]` 的目标
  以虚节点出现，右键可直接建笔记 —— 我们 `resolveWikiLinks` 已经能拿到未命中目标，
  只是图谱不画）、节点数上限（inkstone 350 截断 + truncated 提示；我们全量画，
  几百节点 SVG 会卡）。
- P2：文件夹/标签过滤、groupBy 着色、缩放/平移/拖拽节点、偏好 localStorage 持久化。
- 力导向布局：**维持确定环布局**（现状注释已论证：无动画抖动、无 rAF 常驻），
  不建议追。

### A7. 灯箱功能（P2）

inkstone `Lightbox.tsx`：Ctrl+滚轮缩放（0.3–6）、± 按钮 + 百分比、双击 2x、
下载原图、加载失败提示、底部 alt 说明条。我们 `NotesPage.tsx:6285-6322`
只有打开/点空白关闭/右上角关闭。适合一个小批次补齐（纯 UI，无后端）。

### A8. 大纲无滚动高亮（P2）

inkstone `Outline.tsx` 监听预览滚动做 scroll-spy，高亮当前所在标题（`aria-current`）；
我们的大纲面板是静态列表 + 点击跳转。做法照抄：`scroll` + rAF + 按
`[data-line]`/slug 位置比较。另外 inkstone 大纲是预览侧 sticky 常驻栏，
我们默认收在按钮里（有 defaultOutline 设置）——维持现状。

### A9. 反链面板（P1/P2）

- P1：inkstone `BacklinksPanel.tsx` 在 `noteId/rev/cursor` 变化时**自动重拉**
  并有失败"重试"按钮；我们只在打开面板时算一次，编辑完要手动重开才能刷新。
- P1：反链摘要 `wikiContextSnippet` 按字符串 `[[${target}` 搜行，与 wiki token
  解析（别名、转义、`![[嵌入]]` 排除）不同构 —— 应改成复用 `extractWikiLinks`
  的 token 位置取上下文行。
- P2：inkstone 反链是编辑器底部常驻区（所有布局可见）；我们桌面可开右栏、
  窄屏只在菜单里。可接受，不改布局，只补"保存后自动刷新"。

### A10. Obsidian 导入（P2）

inkstone `worker/lib/obsidian-import.ts`：md 文件夹结构 → 笔记/文件夹/标签/附件。
我们已有零依赖 `utils/zip.ts`（备份取回已用）+ JSON 导入闭环，做一个
"接受 .zip → 解包 → 逐文件建笔记"的入口成本不高。前端入口放数据页。

### A11. 快捷键帮助面板（P2）

inkstone `ShortcutsPanel.tsx` 把全局 + 编辑器快捷键列成一张表（数据就是
EDITOR_SHORTCUTS/hotkeys 表，零额外维护）。我们两张表都在，缺一个展示面板。
A4 做完后顺手加，入口放命令面板（inkstone 同款 `cmd-shortcuts`）。

---

## B. 第二轮新增代码自身的待修项（本轮复查发现）

1. **命令面板选中项越界**：`NotesCommandPalette.tsx` 只在 keyword 变化时
   `setActive(0)`；远端命中到货 rows 变化后 active 可能越界（Enter 落空）。
   inkstone 有两个 effect：query 重置 + `items.length` 变化时 clamp。
2. **无 `scrollIntoView`**：14 行上限内问题不大，键盘走到可见区外时选中行不可见。
3. **无输入法 composing 守卫**：inkstone `onKeyDown` 首行判 `isComposing`；
   中文输入法选词按 Enter 会误触发"执行选中项"。
4. **旧远端结果未即时清**：查询变化到新请求返回之间，`remoteHits` 仍是上一词的
   命中，瞬间会显示旧摘要。
5. **本地笔记命中的 detail 与查询无关**：我们显示 `snippetOf(全文)`，inkstone 显示
   `excerpt`（也是摘要）；差距不大，但可改为"关键词命中行"摘要（FTS hit.snippet
   已有能力，本地路径复用）。
6. **侧栏上传归属**：`uploadImageForEditor` 绑主栏 `activeId`，侧栏编辑器传图会挂到
   主栏笔记（源码注释已自知）。要在侧栏场景传对 noteId。
7. **未配存储时的粘贴行为待验证**：NotesPage 始终传 `uploadImageForEditor`，
   `handleUpload` 在没配存储时的实际表现（报错提示？）需要一条用例钉死，
   保证"没配存储=原生粘贴图片"的承诺成立。

---

## C. 实施顺序（建议三个批次，每批独立验证、独立提交）

**批次 1（P0：粘贴 + 冲突 + 丢改动，全部集中在 NoteEditor/NotesPage/htmlToMarkdown）**
- A1.1 触发条件改 `looksLikeMarkdown` 判据 + 转换结果比对
- A1.3 safePastedHref 协议白名单 + 目的地转义
- A1.6 占位符整段替换（HTML 注释 token、alt=文件名、失败为注释）
- A2 window 监听加 `defaultPrevented` 判定（一行修复 + 用例）
- A3 面板 onOpenNote 走 jumpToNote
- 验收：dom 单测（htmlToMarkdown 8 条扩到 ~15 条、editorPaste 扩 URL/安全/占位符用例、
  notes.dom 补 ⌘K 冲突与面板跳转用例）+ 真机探针（run-probe.sh 塞 DataTransfer）。

**批次 2（P1：快捷键 + 同步 + 反链）**
- A4 补 8 条快捷键（含 undo/redo；注意与 searchKeymap 的 mod+d 共存）
- A5 syncFromPreview + 预览侧事件绑定（复用已写的反向插值函数）
- A9 反链保存后自动刷新 + 摘要改 token 口径 + 重试按钮
- A1 其余小项：嵌套列表递归、代码语言提取、fence 自适应、多文件/非图片、
  dragover、销毁防护
- B1–B4 面板四小修（clamp/scrollIntoView/composing/旧结果清理）

**批次 3（P2：体验增强）**
- A6 图谱：搜索过滤 + 未解析节点 + 数量上限（缩放/分组按需再排）
- A7 灯箱缩放/下载/失败态
- A8 大纲 scroll-spy
- A10 Obsidian zip 导入（数据页入口）
- A11 快捷键帮助面板 + B7 存储未配验证

**明确不做（维持前两轮结论）**：MCP/AI、TOTP、Realtime、i18n、S3 多目标、
备份服务商预设（N10）、力导向图谱、PWA/更新检查、头像。

## D. 验证纪律

- 每批全量 `node script/unit-tests.mjs` + `npx tsc -b --force` + lint + build + smoke。
- 粘贴/滚动同步/⌘K 属交互链路，批次 1、2 各做一次真机探针
  （`bash harness/run-probe.sh`，复现滚动条类问题带 `SHOW_SCROLLBARS=1`）。
- CHANGELOG 每批一段；新增列一律升 SCHEMA_VERSION（本轮方案无 schema 改动）。
