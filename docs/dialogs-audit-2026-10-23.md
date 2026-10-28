# 全站弹窗排查与整改计划（2026-10-23）

> 本轮**只出报告与计划，不改代码**。落盘位置沿用上一轮审计的习惯（`docs/`），
> 未提交、未推送，等你点头再动手。
>
> 上一轮报告：`docs/dialogs-audit-2026-10-16.md`（19 个弹窗 × 4 档视口实测）。

---

## 一、本次的口径与方法

| 手段 | 覆盖 | 说明 |
| --- | --- | --- |
| 源码扫描 | **32 个文件 / 37 处 `<Dialog>`** | 逐个抓 `<Dialog>` 起始标签（花括号配平，避免被 `onClose={() => …}` 里的 `>` 截断），统计 `maxWidth` / `fullWidth` / `fullScreen` / `scroll` / `slotProps.paper` / 是否使用公共外壳 |
| 外壳与 token 对照 | 3 处外壳定义 | `dialogShell.ts`、`SiteSettingsModal.settingsPaper()`、`NotesSettingsDialog` 内联 paper，逐条比对圆角/材质/边框/阴影/内边距 |
| 响应式规则溯源 | `index.css` + 构建产物 | 找到包裹「小屏底部面板」的媒体查询，并在**构建后的 CSS** 里确认规则确实存在 |
| **线上实测**（今天） | 375×800，真 Chrome + CDP | 打开线上 `<your-host>`，量 `.MuiDialog-paper` 的 `getComputedStyle`：`margin` / `maxHeight` / 容器 `alignItems` / 圆角 / 毛玻璃 / 操作区 sticky 与内边距 |
| 历史实测数据 | 19 个弹窗 × 1440/1024/768/375 | 直接引用 `Claw/harness/out/audit-{1440,375}.json`（2026-10-16 采集），**只用于说明尺寸分布**，凡涉及外观的结论一律以今天的实测或源码为准 |

**明确区分**：文中标「实测」的是今天/上一轮真浏览器量到的数；标「推断」的是读代码得出的结论。
浏览器缩放一节是等价换算，不是逐档截图（换算依据写在那一节里）。

---

## 二、参考样式：从你给的截图反解出的基线

截图那个弹窗标题是「网站设置」，内容分「基本信息 / 外观 / 背景与毛玻璃」，底部「取消 / 保存设置」，
标题下有一行说明「带「即时生效」的开关改完立刻生效；其余为草稿，需点「保存设置」。」

**它其实是 `SettingsDialog`（顶栏齿轮 → 全站设置），不是卡片上的那个 `SiteSettingsModal`。**
两者源码对照可以确认：`SettingsDialog.tsx:217` 就是那行说明，`:791` 就是「保存设置」按钮，
节标题「基本信息/外观/背景与毛玻璃/图标与缩略图/搜索/离线与缓存/数据同步/维护/数据保留/高级」全在它里面；
而 `SiteSettingsModal.tsx` 里**根本没有**这几个节标题。

据此把参考样式拆成 12 条基线（后续所有整改都以它为准）：

| # | 基线 | 出处 |
| --- | --- | --- |
| R1 | 纸面：圆角走卡片同一档（22px）、1px 描边、`blur(14px) saturate(1.4)` 毛玻璃、`--surface-modal` 底 | `settingsPaper()` / 实测 `radius 22px, backdrop blur(14px) saturate(1.4)` |
| R2 | 标题：`px 24 / pt 16 / pb 8`，标题 20px/600 | `SiteSettingsModal` 标题区 + `SettingsDialog` 标题区 |
| R3 | 标题下允许一行 13.5px 说明，讲清「哪些即时生效、哪些要点保存」 | `SettingsDialog:217` |
| R4 | 分组：左侧 3×14 主色竖条 + 组标题（`Section`），组间用 `Divider` 分隔 | `dialogSection.tsx` + `SettingsDialog` |
| R5 | 正文：`px 24`，与标题左边界对齐（同一竖直基准线） | 两处注释都点名了这条 |
| R6 | 底部操作区：右对齐、`取消`（outlined/ink）在左、主操作（contained）在右 | 参考样式 |
| R7 | 破坏性操作单独放左侧、`color="error"`（参考样式里 `删除` 在操作区最左） | `SiteSettingsModal:983` |
| R8 | 右上角有 `×`，且 `aria-label` 是中文「关闭」 | 参考样式 |
| R9 | 一个弹窗只干一件事；标题就是它的名字 | 参考样式 |
| R10 | 内容长时可滚，操作区 sticky 常驻 | MUI v9 默认 + 实测 `position: sticky` |
| R11 | 小屏走底部面板（贴底、全宽、顶部圆角、92dvh） | `index.css` 意图（**实测未生效**，见 G2） |
| R12 | 动效/无动效、亮暗两态都由 token 决定，不写死颜色 | 参考样式 |

---

## 三、系统级问题（先看这 6 条，它们决定了后面 80% 的返工）

### G1 · 两个弹窗都叫「网站设置」，作用域却完全不同 —— **P1**

- **现象**：顶栏齿轮打开的是**全站**设置（外观、图标 API、搜索、离线缓存、数据同步、维护、数据保留、高级），
  标题写「网站设置」；卡片齿轮打开的是**单个网站**的设置（名称、URL、图标、账号密码、备注），
  标题也写「网站设置」。两个弹窗名字一模一样，内容毫无重叠。
- **位置**：`SettingsDialog.tsx:195`（`<DialogTitle>网站设置`）与 `SiteSettingsModal.tsx:467`（`网站设置`）。
- **影响**：你这次给参考样式时都把它当成「网站设置」了 —— 说明这个误导对熟悉项目的你同样成立。
  真实使用中：想改某个站的账号密码，会先点顶栏齿轮；想改全站背景，会先点卡片齿轮。
- **建议**：全站那个改叫「**设置**」或「**全站设置**」（顶栏齿轮的 `aria-label` 同步改），
  卡片那个保留「网站设置」。同时给全站设置的标题下补一句范围说明（R3）：
  「这里的改动影响整个站；单个网站的名称/账号请点卡片右上角齿轮」。

### G2 · 小屏「底部面板」那套 CSS **整体没生效** —— **P1（实测）**

- **现象**：`index.css:1201-1222` 写明「设置/编辑类弹窗在小屏走底部面板」，声明了
  `align-items: flex-end`、`margin: 0`、`width: 100%`、`max-height: 92dvh`、操作区 sticky。
- **实测（375×800，线上）**：卡片设置纸面 `301×736`，`top/left/bottomGap = 32/32/32`（居中卡片），
  容器 `alignItems = center`，纸面 `max-height = calc(100% - 64px)`（MUI 默认值）。
  → **贴底、全宽、92dvh 一条都没生效**，只有操作区 sticky 生效（而那是 MUI v9 自带的，不是我们这条规则）。
- **根因（推断，可信度高）**：这些选择器与 MUI 运行时用 emotion 生成的 `.MuiDialog-container` / `.MuiDialog-paper`
  **特异性相同（0,1,0）**，而 emotion 的样式在运行时注入、排在 `<link>` 之后，同权重后者胜。
  构建产物里确实还有这段规则（已核对 `dist/client/assets/index-*.css`），是**被级联覆盖**，不是没打包。
- **影响**：① 手机上少了「拇指够得到」的底部面板；② 375 宽下两侧各浪费 32px（纸面只剩 301，内容被压窄 17%）；
  ③ `dvh` 那套「软键盘弹出时弹窗跟着收」的设计也没生效，键盘可能压住底部按钮。
- **修法（两种，建议 B）**：
  - A. 提高特异性：`html body .MuiDialog-container { … }` 之类，能在不改组件的前提下救活。
  - B.（推荐）把这三条搬进组件层：在 `dialogShell.ts` 出一个 `useDialogResponsive()` 或
    `dialogPaperSx` 里直接写 `sx` 断点（emotion 写入，与 MUI 同源、顺序可控），
    从根上不再依赖「谁先打包」。同时全局 CSS 那段删掉，避免两处同时存在。
- **验收**：375×800 下任一弹窗 `paper.top + paper.h == 视口高`（贴底）、`paper.w == 视口宽`、
  `containerAlign == flex-end`、`maxHeight == 92dvh`。

### G3 · 三套外壳并存，圆角/材质/内边距各写一份 —— **P1**

| 外壳 | 用在 | 圆角 | 模糊 | 边框 | 阴影 | 内边距 |
| --- | --- | --- | --- | --- | --- | --- |
| 全局 `.MuiDialog-paper`（`index.css:608`） | 所有弹窗的**底** | `--radius-lg` | 无 | `--border-subtle` | `--shadow-3` | — |
| `dialogPaperSx`（`dialogShell.ts:8`） | 10 个弹窗 | `--radius-lg` | `--blur-md` | `--border-subtle` | `--shadow-3` | `p: 0.5` |
| `settingsPaper()`（`SiteSettingsModal:92`） | 参考样式 | `--card-radius` | `--glass-blur` | `--glass-panel-border` | `--glass-shadow-hover` | — |

- 好消息：token 之间**目前是互相别名**的（`--radius-lg: var(--card-radius)`、`--glass-blur: var(--blur-md)`、
  `--glass-shadow-hover: var(--shadow-3)`），所以肉眼差距不大。
- 坏消息：**这恰恰是最容易持续漂移的形态** —— 三处写「同一个值」，只要有人改一个别名就裂开；
  而且现在已经有真实差异了：边框 token 不同（`--border-subtle` vs `--border-glass`）、
  `dialogPaperSx` 多 4px 内边距。这正是 `dialogShell.ts` 头注释里说「已经收成一份」想避免的情况。
- **建议**：以参考样式（`settingsPaper` 的 token 组合）为唯一真源，`dialogPaperSx` 改为引用它；
  全局 `.MuiDialog-paper` 只保留「兜底不塌」（比如 `max-height` 兜底），不再写外观；
  顺手删掉 `--radius-lg` 这类纯别名（或反过来把别名指向权威 token，只留一层）。

### G4 · 参考样式的「分组语言」只有 2 个弹窗在用 —— **P2**

- `Section`（主色竖条 + 组标题）只出现在 4 个文件：`SettingsDialog`、`AiAssistantDialog`、
  `SiteNotesSection`、`VersionUpgradeSection`。也就是说 **32 个弹窗里只有 2 个「长的像参考样式」**。
- 其余要么纯平铺表单（`SiteSettingsModal` 只有「登录凭据」一个小标题），
  要么自制标题（`RecycleBinDialog` 标题里塞图标 + 计数，`TagManagerDialog` 自制头）。
- **影响**：同一个产品里「设置」长两种样子；用户跨弹窗移动时没有稳定的视觉锚点。
- **建议**：分两类处理，不搞一刀切：
  - **表单向**（≥5 个字段的）：统一上 `Section` 分组，参考样式是模板。
  - **列表向**（回收站、版本历史、审计、标签管理）：统一「标题 + 计数 chip + 搜索/筛选 + 列表 + 底部操作」，
    列表项行高与左内边距对齐。

### G5 · 关闭按钮与无障碍文案不统一 —— **P2**

- **没有 `×` 的弹窗 8 个**（Palette 类按 Esc 关闭，不算问题，已单列）：
  `AuditDialog`、`DeleteAccountDialog`、`EditGroupDialog`、`FolderAppearanceDialog`、
  `NoteShareDialog`、`NotesShortcutsDialog`、`RecycleBinDialog`、`TagColorDialog`。
  其中内容长的（审计日志、回收站、分享）必须滚到底才看见「取消」——手机上这一滚往往就是找不到出口。
- **`aria-label` 是英文的 2 处**：`SettingsDialog.tsx:198`（`aria-label='close'`）、`AccountDialog`（同样 `close`）。
  其余弹窗都是「关闭」/「关闭 XX」。读屏用户在这两个弹窗里会听到英文，站内按「关闭」找按钮的用例也点不到它们。
- **建议**：`×` 提升为外壳能力（`dialogTitleSx` 已经在为它预留 `pr: 5`，但多数弹窗没放按钮）；
  文案统一「关闭」，并在 `tests/` 里加一条静态守卫：弹窗文件里不许出现 `aria-label='close'`。

### G6 · 破坏性操作的位置有两套约定 —— **P2**

- `SiteSettingsModal:983`：删除在**左下**，取消/保存在右。
- `ConfirmDialog:206-242`：取消在左、**危险确认在右**（且没有把 danger 移到左侧）。
- 两者都「说得过去」，但同一个产品里同一类动作在相反的位置，误触成本不一样（右手拇指区在右）。
- **建议**：定一条 —— **危险动作永远在操作区最左**（离「确认」最远），`ConfirmDialog` 增加可选
  `dangerAlign: "start" | "end"` 并默认 `start`，迁移期先只改 `ConfirmDialog`，其余跟着它走。

---

## 四、逐弹窗问题清单

优先级：**P1** = 功能/可达性受损；**P2** = 体验或一致性明显受损；**P3** = 打磨项。
「实测」= 今天或 10-16 轮真浏览器量到；「推断」= 读代码得出。

### A. 设置类（长表单，最该向参考样式靠）

#### A1　全站设置 `SettingsDialog`（顶栏齿轮）—— 参考样式本尊

| 优先级 | 问题 | 位置 | 依据 |
| --- | --- | --- | --- |
| P1 | 名字叫「网站设置」，实际是全站设置（见 G1） | `SettingsDialog.tsx:195` | 源码 |
| P2 | 10 个 `Section` 一长条（实测 1440 下纸面 736 高、内容超长需滚），没有分组导航；参考样式之外的弹窗里它是最长的一个 | 全文 `Stack spacing=2 divider` | 实测 + 源码 |
| P2 | 关闭按钮只有图标、无中文 `aria-label`（`close`） | `:198` | 源码 |
| P3 | 纸面自设 `m: {xs:2, sm:auto}`，导致小屏比其它弹窗**宽 32px**（实测 333 vs 301） | `:186-193` | 实测（10-16 数据）+ 源码 |

**建议**：① 改名 + 标题下补范围说明；② 10 个节加左侧锚点 chips（或按「外观/数据/高级」三分折叠，
默认展开常用组）；③ 修 `aria-label`；④ 小屏边距交给统一外壳，删掉自己的 `m`。

#### A2　卡片设置 `SiteSettingsModal`（卡片齿轮）

| 优先级 | 问题 | 位置 | 依据 |
| --- | --- | --- | --- |
| P1 | 与 A1 同名（G1）；且**没有分组骨架**，一列表单里只有「登录凭据」一个小标题，与参考样式的节感差得最远 | `:890` | 源码 |
| P2 | 操作区 `space-between` + 三个按钮，375 下换行成两排（10-16 实测操作区 116px；本轮 xs 已把删除收进标题，需复测确认是否仍换行） | `:983` | 实测（10-16） |
| P2 | 三个并存的弹窗（主设置 / 备注放大 / 删除确认）共用一个 `settingsPaper`，其中备注窗额外加了 `minHeight: min(560px, calc(100vh - 104px))` —— `100vh` 在移动端不跟软键盘变 | `:133` | 源码 |
| P3 | 标题区塞了星标 Chip + ×（(+xs 还有删除），信息密度偏高 | `:452-480` | 源码 |

**建议**：① 上 `Section` 分组（「基本信息 / 图标 / 登录凭据 / 备注」），照参考样式；② 备注窗 `100vh → 100dvh`；
③ 小屏操作区只留「取消 / 保存」，删除已经在标题区了，把 `space-between` 去掉。

#### A3　记事本设置 `NotesSettingsDialog`（2359 行）

| 优先级 | 问题 | 位置 | 依据 |
| --- | --- | --- | --- |
| P1 | **完全不用公共外壳**：`paper: { height: 560, maxHeight: "86vh", borderRadius: 3 }` —— 固定像素高 + `vh`（不是 `dvh`）+ 圆角写死数字，且没有毛玻璃与 `--surface-modal` 底 → 与全站所有弹窗材质不同 | `:652` | 源码 |
| P2 | 自定义头（无 `DialogTitle`）+ 左列导航，是多弹窗里结构最特殊的一个；`maxWidth='md'` 但 375 下双列表单会被压到 301px | `:646-660` | 源码 + 实测（10-16） |
| P2 | 固定 `height: 560` 在 150% 缩放下等于占满半屏以上，且不随 `dvh` 收 | `:652` | 推断（见第五节换算） |
| P3 | 2359 行单文件，节边界难维护 | 全文 | 源码 |

**建议**：① 纸面换成统一外壳 + `height: { xs: "86dvh", sm: 560 }`；② 保留左列导航（这是好设计，
参考样式是纵向的，但设置项多时左列更快），只统一材质与内边距；③ 顶部补一行「哪些即时生效」的说明（R3）。

#### A4　AI 设置（`AiAssistantDialog` 的配置页 / MoreMenu 入口）

| 优先级 | 问题 | 位置 | 依据 |
| --- | --- | --- | --- |
| P3 | `maxWidth='xs'`（444px）里放「开关 / 模型服务 / 凭据 / 测试连接」四组，是全场最窄的弹窗；参考样式同类内容用 `md` | `AiAssistantDialog` | 源码 + 10-16 建议未采纳 |
| P3 | 用了 `Section`（与参考样式一致），但宽度太窄导致每组内部两列挤成一行 | 同上 | 推断 |

**建议**：`xs → sm`；把「凭据」与「测试连接」合成一组（同一个心智模型：连得上吗）。

### B. 内容浏览类（列表/预览）

#### B1　统计 `StatsHubDialog`
- P3：`maxWidth='sm'` + 两个 Tab（访问统计 / 运营看板），107 行里把图表都外包出去了 → 结构没问题。
  唯一问题：Tab 下没有说明当前时间范围，切 Tab 时上下文会丢。建议 Tab 右侧常驻一行「近 7 天」。

#### B2　审计日志 `AuditDialog`
- **P2**：没有 `×`，且列表可能很长 —— 手机上要滚到底才能「关闭」。
- P3：与回收站/版本历史三者的列表行样式各写一份（行高、时间列宽、hover 反馈不同）→ 建议抽一个 `DialogListRow`。

#### B3　回收站 `RecycleBinDialog`
- **P2**：没有 `×`；标题里塞了图标 + 右侧计数（`ml:"auto"`）—— 这是**好的信息设计**，但和别的弹窗标题不一致，建议把「计数 chip」升级为外壳通用位（`dialogTitleSx` 右侧），全局统一。
- P3：空态文案与统计面板的空态用词不统一（「空空如也」vs「暂无数据」）。

#### B4　版本历史 `NoteVersionHistoryDialog`
- P3：`maxWidth='md'` 里只有一列列表，600px（`sm`）就够（10-16 提过，未改）；`minHeight: 320`（px）在缩放/小屏下多余。
- P2：没有 `×`。

#### B5　关系图 `NoteGraphDialog`
- P3：`minHeight`/画布尺寸未跟 `dvh` 走；`maxWidth='md'` 但在 375 下画布只有 301 宽，节点文字会重叠。
  建议 xs 下改全屏（`fullScreen`）——这也是全场唯一确实**需要**整屏的弹窗。

#### B6　附件预览 `AttachmentPreviewDialog` / 附件管理 `AttachmentManager`（抽屉）
- P3：预览弹窗用 `md`，图片预览合理；但「二进制附件」走的是同一外壳，底部按钮文案是「下载」还是「关闭」取决于 mime，缺少说明。
- P3：`AttachmentManager` 是 **Drawer** 不是 Dialog —— 材质与弹窗同一套，但圆角是「单侧」的，视觉上像另一类组件。

### C. 输入与确认类

| 弹窗 | 优先级 | 问题 | 位置/依据 |
| --- | --- | --- | --- |
| `AddSiteDialog` | P3 | 有 `×`（唯一几个有的之一）；`maxWidth='sm'` 合理。问题：AI 补全按钮挤在输入框内（`endAdornment`），375 下与「名称」文字抢空间 | 源码 |
| `EditGroupDialog` | P2 | 无 `×`；操作区没有统一 `dialogActionsSx`（padding 与其它不一致） | 源码扫描 |
| `NamePromptDialog` | P3 | 无问题（用外壳 + 有 X 的兄弟实现一致），可作「最小弹窗」模板 | — |
| `TagColorDialog` | P2 | 无 `×`；色板容器宽度写死在窄屏会换行 | 源码 |
| `DeleteAccountDialog` | P2 | 无 `×`（有取消，可接受）；但**危险确认在右**（同 G6） | 源码 |
| `ConfirmDialog` | P2 | 破坏性按钮位置与 A2 相反（G6） | `:206` |
| `FolderAppearanceDialog` | P2 | 无 `×`；`maxWidth='xs'` 里塞了三组（图标/颜色/圆角） | 源码 |

### D. 特殊形态

| 弹窗 | 优先级 | 问题 |
| --- | --- | --- |
| `CommandPalette` / `NotesCommandPalette` | P3 | 自定义外观是对的（palette 不该长成表单）。二者彼此不一致：一个是 `maxHeight 380`、一个 `420`；一个圆角走 token、一个写死。建议共用一份 `palettePaperSx` |
| `BulkActionBar` | P3 | 内部那个「批量打标签」Dialog 手抄了一遍 paper 样式（`borderRadius: var(--card-radius)` + 自己的玻璃声明），是 G3 的典型复制点 |
| `BookmarkImportDialog` / `ImportPreviewDialog` | P3 | 都用外壳 + `×`，结构最规范；`maxHeight 320`（px）在缩放时偏高 |
| `GroupShareDialog` | P3 | 有 `×`；`maxWidth='sm'`；无问题 |
| `TagManagerDialog` | P3 | 自制头 + 三个 `Dialog`（主窗 / 删除确认 / 重命名），其中两个 `xs` 套在主窗里 —— 三层弹窗在手机上容易迷路，建议重命名改成内联编辑 |
| `AiSuggestDialog` | P3 | `maxHeight 320`（px）；建议改 `min(320px, 45dvh)` |
| `NotesShortcutsDialog` | P2 | 34 行、无 `×`、无操作区 —— 手机上只能靠 Esc/遮罩关（iOS 没有 Esc） |
| `SiteNoteDialog` / `NoteSiteDialog` | — | 本轮新写的两个，已经按外壳 + 参考样式做，可作为**新弹窗模板**（有 `×`、有说明行、有边界文案） |

---

## 五、响应式 / 设备 / 缩放专项

### 5.1 断点现状（源码扫描 + 实测）

| 断点 | 生效内容 | 风险 |
| --- | --- | --- |
| ≤ 599.95px | 意图：底部面板 + 92dvh + 操作区 sticky | **整段未生效**（G2），实际是居中卡片 32px 边距 |
| ≤ 359.98px | `MuiDialogContent` 左右内边距收到 12px | 只在「底部面板」生效时才有意义，目前等于没用 |
| 全部宽度 | 操作区 sticky | MUI v9 默认自带，不需要我们声明 |

### 5.2 浏览器缩放（等价换算，不是逐档实测）

浏览器缩放不改变 CSS 像素语义，只**缩小布局视口**。所以「1280 窗口 @150%」≡「853 CSS px」，与「窗口缩到 853」等价。
按这个换算，关键阈值被压到的情况是：

| 场景 | 等效 CSS 宽 | 跨过 600 断点？ | 观察 |
| --- | --- | --- | --- |
| 1920 @150% | 1280 | 否 | 无影响 |
| 1440 @125% | 1152 | 否 | 无影响 |
| 1440 @150% | 960 | 否 | `md`(900) 以上，最大弹窗 900 仍放得下 |
| 1366 @150% | 911 | 否 | 900 宽的弹窗只剩 11px 余量 → 贴着边 |
| 1280 @200% | 640 | 否（但很接近） | 600 宽弹窗 + 32 边距 = 664 > 640 → **会溢出/被 clamp** |
| 1366 @200% | 683 | 否 | 600 + 64 = 664 ≤ 683，勉强 |
| 任何屏 @300% | ≤ 480 | **是** | 进入小屏分支 → 但 G2 让它只是「变窄的居中卡片」 |

**结论**：① 缩放下真正危险的是「900/600 宽 + 固定 32px 边距」在 ~640 CSS px 时的挤压（1280@200%）；
② `NotesSettingsDialog` 的 `height: 560` 与四处 `maxHeight: 320/380/420`（px）在缩放下体积翻倍，
   会和视口抢空间；③ `100vh`（`SiteSettingsModal:133`）与 `86vh`（`NotesSettingsDialog:652`）在
   移动端软键盘弹出时不收 —— 这正是项目自己在别处用 `dvh` 解决过的问题。

### 5.3 设备类型

| 设备 | 现状 | 结论 |
| --- | --- | --- |
| 桌面（≥900） | 全部居中、尺寸稳定 | 好 |
| 平板（768） | 与桌面同构，`:1024` 档实测无溢出 | 好 |
| 手机竖屏（375） | 意图底部面板但未生效 → 居中卡片 301 宽，边缘 32px 白边 | **要修（G2）** |
| 手机横屏（667×375） | 高度只有 375 → 92dvh 意图 345，但 MUI 默认 `calc(100% - 64px)` = 311；长表单必然滚 | 修 G2 后复测 |
| 触屏笔记本 | 桌面布局 + 触屏点击；`--touch-min` 已把点击区放大 | 好 |
| 软键盘弹出 | `dvh` 未生效 + `100vh` 写死 → 底部按钮有被顶出屏幕的风险 | **要修** |

---

## 六、整改计划（4 批，按「改一处收一片」排序）

### 第 1 批：外壳收口（P1，收益最大，风险最低）

| 动作 | 文件 | 范围 |
| --- | --- | --- |
| 1-1 让「小屏底部面板」真正生效：把 `align-items/margin/width/max-height` 搬进 `dialogPaperSx` 的 `sx` 断点，删除 `index.css:1201-1222` 那段 | `dialogShell.ts`、`index.css` | 约 30 行，**全局生效** |
| 1-2 以参考样式为唯一真源：`dialogPaperSx` 的 token 组合对齐 `settingsPaper`（`--glass-panel-border` 等），`SiteSettingsModal` 改为直接引用 | `dialogShell.ts`、`SiteSettingsModal.tsx` | 约 40 行 |
| 1-3 `x` 关闭按钮提升为外壳能力：`DialogShell` 增加 `onClose` → 自动渲染右上角 `×` + `aria-label="关闭"` | `dialogShell.ts`（新组件） | 约 20 行，需逐个弹窗接 |
| 1-4 修 2 处英文 `aria-label` | `SettingsDialog.tsx:198`、`AccountDialog` | 2 行 |
| 1-5 加静态守卫：弹窗文件不许出现 `aria-label='close'`；`<Dialog>` 必须带 `slotProps.paper`（用外壳） | `tests/` 新增 1 个用例 | 约 40 行 |

**验收**：375×800 实测 `paper 贴底 + 全宽 + maxHeight=92dvh`；桌面 1440 视觉无变化（截图对比）；
单测 / lint / build / 预算 / 冒烟全绿。

### 第 2 批：命名与信息架构（P1，改动小但影响认知）

| 动作 | 文件 | 范围 |
| --- | --- | --- |
| 2-1 全站设置改名「设置」/「全站设置」，标题下补范围说明 | `SettingsDialog.tsx` + 入口 `aria-label` | 约 10 行 |
| 2-2 `SiteSettingsModal` 上 `Section` 分组（基本信息 / 图标 / 登录凭据 / 备注），按参考样式排 | `SiteSettingsModal.tsx` | 约 60 行，只动 JSX 结构 |
| 2-3 统一破坏性按钮位置：`ConfirmDialog` 危险按钮移到操作区最左 | `ConfirmDialog.tsx` + 调用点 | 约 20 行，**要跑一遍确认类用例** |
| 2-4 列表类弹窗（回收站/审计/版本历史）抽 `DialogListRow`，统一行高与时间列 | 新增组件 + 3 个弹窗 | 约 120 行 |

### 第 3 批：单点修复（P2）

`NotesSettingsDialog` 纸面换成外壳 + `height: {xs:"86dvh", sm:560}`；8 个无 `×` 的弹窗接第 1 批的关闭能力；
`NoteVersionHistoryDialog` `md→sm`；`AiAssistantDialog` `xs→sm`；`SiteSettingsModal` 的 `100vh→100dvh`；
4 处 px `maxHeight` → `min(Npx, 45dvh)`。

### 第 4 批：打磨（P3）

`CommandPalette`/`NotesCommandPalette` 共用 paper；`BulkActionBar` 里的手抄 paper 换外壳；
`NoteGraphDialog` xs 下 `fullScreen`；空态文案统一；`TagManagerDialog` 重命名改内联。

### 建议的验证方式（延续上一轮的工具链）

1. 用 `Claw/harness/` 里的 CDP 驱动，按 1440 / 1024 / 768 / 375 / 375×667（横屏）五档，
   对**全部 32 个弹窗**跑一遍：纸面尺寸、`top+bottomGap`、`maxHeight`、内容 `scrollHeight`、操作区是否一行、是否溢出。
   上一轮只覆盖 19 个，本轮新增的 13 个（含两个绑定弹窗、统计、标签管理、文件夹外观等）需要补进脚本。
2. 缩放档：1440@125% / 1440@150% / 1280@200%，只看「是否溢出 + 操作区是否还在一屏内」。
3. 每批改完跑：`tsc -b --force` / `lint` / 单测 / `build` / `check:budget` / `smoke` / `audit:a11y` / `audit:contrast`。

---

## 七、优先级汇总

| 级别 | 条目 | 数量 |
| --- | --- | --- |
| **P1** | G1 同名两弹窗、G2 小屏面板失效、G3 三套外壳、A2 卡片设置无分组骨架、A3 记事本设置不用外壳 | 5 |
| **P2** | G4 分组语言只 2 处在用、G5 无 × / 英文 aria、G6 危险按钮两套位置、B2/B3/B4 无 ×、C 类 6 处、A1 长滚动与边距、NotesShortcuts 无出口 | 13 |
| **P3** | 其余打磨项（宽度/高度与内容不匹配、palette 尺寸不一、空态文案、内联编辑等） | 12 |

**建议先做第 1 批**：它不改任何业务逻辑、只动外壳，却一次性解决 G2 + G3 + G5 三条系统级问题，
并且给后面三批提供唯一的标准件。
