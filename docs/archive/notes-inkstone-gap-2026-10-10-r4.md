# 记事本对齐 inkstone —— 第四轮全面对比与计划（2026-10-10）

基线：NaviHive 本地 `9744c5c`（第三轮三批次已推送 GitHub `707d5b8`）对照 `harness/inkstone-src`。

第三轮已关闭的差距（粘贴链路、⌘K、快捷键、双向滚动、反链 token 上下文、图谱搜索/虚节点/上限、灯箱增强、大纲 scroll-spy、Markdown ZIP 导入）不再重复列出。本轮逐文件复查后，**剩余差距已经不多**，逐项列证据与计划。

## 本轮确认已对齐、无需再动的（复查记录）

- `:::tabs` / `:::fold` 容器语法（markdownNoteBlocks.ts）——inkstone renderer.ts 的 `details|tabs` 我们有同款。
- 界面密度（data-notes-density，comfortable/compact）、阅读位置（readingPosition.ts）、打字机 / 专注模式（NoteTypewriter.ts / focusMode）、front-matter、别名 / 标题锚点 / 嵌入。
- 笔记行拖到文件夹移动（NotesPage.tsx `draggable` 4353）、多选批量条、设置项清单（editorFont/fontSize/lineNumbers/showToolbar/spellcheck/scrollSync/focusMode/liveRender/typewriter/rememberPosition/math/mermaid/foldCode，覆盖 inkstone EditorSettings 全部并有超出）。
- 备份闭环（上传/取回/删除）、附件、FTS、rev 并发、分享（口令/次数/过期）。

## 一、确认差距（源码级证据）

### G1. 编辑器自动补全（P1，本轮最大新发现）

inkstone `src/client/editor/completion.ts` 有三类补全，我们一个都没有（`tagSuggest.ts` 只服务导航站卡片，与编辑器无关）：

1. `[[` 双链补全：按笔记标题 fuzzy 匹配，选中插入 `标题]]`；无命中时给「新建笔记」项（`boost: -20`）。
2. `#` 标签补全：行内/括号后的 `#词` fuzzy 匹配标签（带使用次数 detail 与 boost），**刻意排除标题行**（`line.from` 处 `#{1,6}\s` 不触发）。
3. ` ``` ` 代码块语言补全：30 种常用语言。

实现走 `@codemirror/autocomplete` 官方包（inkstone 同款），`validFor` 限定触发字符。我们目前没有这个依赖（有 `@codemirror/search`）。

### G2. 预览任务复选框只读（P1，交互闭环缺口）

inkstone `Preview.tsx:272-288`：点击预览里的任务复选框 → 找到 `data-task-line` 对应源码行 → 反写 `[ ]`/`[x]` → 走保存（失败回滚 UI）。我们的 `markdownToReact.tsx:862` 渲染的是 `readOnly` 复选框，点不动。任务是「想到就写」高频场景，这条直接影响日常使用。

### G3. 标签颜色（P2）

`note_tag` 表**已有 `color` 列**（internals.ts:28），但 UI 既不展示也不编辑。inkstone 笔记列表行内 `#标签` 按标签色着色（NoteList.tsx:72 `tagColors`），标签管理里可选色。差在「最后一公里」：标签管理弹窗加取色 + 列表/正文标签着色。

### G4. 列表快捷多选（P2）

inkstone NoteList.tsx：普通模式下 `⌘/Ctrl+点击` 切换选中、`Shift+点击` 范围选（onRangeSelect）。我们只有「显式开多选 → 勾选框」这一条路（2026-10-09 批量条）。快捷路径是锦上添花。

### G5. 图谱 P2 余项（P2，此前明确另排）

平移/缩放/拖拽节点、文件夹/标签过滤、groupBy 着色、偏好 localStorage 持久化。力导向维持不做（确定性环布局论证过：无 rAF 常驻、无抖动）。

### G6. 灯箱无障碍余项（P2）

键盘 `+`/`−` 缩放、打开时焦点进入/关闭归还、背景滚动锁。功能面（Ctrl+滚轮、±、双击 2x、下载、失败态、alt 条）本轮已齐。

### G7. 长列表渲染性能（P2）

inkstone 行级 `content-visibility: auto` + `contain-intrinsic-size`（NoteList.tsx:497）。我们全量渲染 DOM（有 renderLimit 类分页的没有；几百条时滚动可能掉帧）。

### 维持不做（多轮结论不变）

MCP/AI、TOTP、Realtime DO、i18n、S3 多目标、备份多目标、力导向图谱、PWA/更新检查、头像、导出 JSON 含附件（zip 导出已覆盖该需求）。

### 顺手清理（不单独成批）

- `syncScroll.ts` 的 `editorScrollForLine` 注释仍写「1 基」，实际 0 基（第三轮遗留）。
- `NoteEditor.tsx` 若干旧注释（「只图片」「只判 run」等）与现状不符。
- `editorShortcuts.ts` 的 `run` 字段注释与「动作注入」架构不一致。

## 二、实施计划

**批次 A（P1：编辑器补全 + 任务勾选回写）**
1. 加 `@codemirror/autocomplete` 依赖，移植 completion.ts 三来源：
   - `[[` → 笔记标题（fuzzy + 「新建笔记」项，apply 写 `标题]]`）；
   - `#` → 标签（含 count boost，排除标题行）；
   - ` ``` ` → 语言列表。
   数据源走现有 notes/tags 状态；注意与既有 keymap 无冲突（autocomplete 自管 Tab/Esc）。
2. 预览任务勾选回写：渲染时给复选框挂 `data-task-line`（源码行号已有 data-line 基建），点击 → 改对应行 `[ ]`/`[x]` → 复用 `updateNote` 保存链路（乐观更新 + rev 冲突弹框照旧），失败回滚 UI；嵌入块（note-embed）里的复选框维持只读。
3. 验收：补全三来源 dom 用例、勾选回写用例（含失败回滚）、tsc/lint/全量/build/smoke；真机探针补一条「预览点勾选 → 正文变化」。

**批次 B（P2 体验三件）**
1. 标签颜色：标签管理弹窗加调色（预设色板即可，不用完整 picker），列表行 `#标签` 与正文标签着色；`note_tag.color` 已有列，无 schema 变更。
2. 列表快捷多选：⌘/Ctrl 点击切换选中（进入多选态）、Shift 点击范围选。
3. 灯箱：`+`/`−` 键缩放、打开焦点收口 + 关闭归还、`overflow:hidden` 滚动锁。

**批次 C（性能与清理，可并入 B 验证）**
1. 笔记列表行 `content-visibility: auto` + 行高占位。
2. 三处注释口径清理（见上）。

**工作量口径**：批次 A 约半天（含依赖引入与测试）；批次 B 约半天；批次 C 约 1 小时。批次 A 独立先行，B/C 可合并一交付。
