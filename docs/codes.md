# 内部代号索引

> 说明：本文索引代码中以「字母 + 数字/连字符」形式出现的**内部代号**（如 `B4`、`A2`、`Q-3`）。
> 这些代号的含义最初只写在注释里、需跨文件还原；且**同一串字符在不同上下文可能指代不同功能**（见文末「重名冲突」）。
> 本文按其在代码注释中的实际用法逐条标注，含义无法从代码/注释确定的一律标「含义待确认」，不作臆测。
> 仅作为审计报告**章节号**出现的同名编号（如 `audit-report` 的 A1…A5 / V1…V3）不在此内，但单列提示以防混淆。

## 代号明细

### B1 — 全站设置摊平（设置中心取消二级 Tab）
含义：2026-10-31 的信息架构改动——把「全站设置」原来的多张 Tab 摊平成左栏若干条目（外观与搜索 / 数据与维护 / 数据安全），不再有二级 Tab，是 A+B 方案的一部分。
出现：
- `src/components/ConfigPanelBody.tsx:119`
- `src/components/NavigationCenterDialog.tsx:59`
- `src/components/NavigationCenterDialog.tsx:240`
- `src/components/navigationCenter/model.ts:129`
- `src/components/navigationCenter/panels/DataSafetyPanel.tsx:13`
- `tests/settingsDialog.dom.test.tsx:359`
- `tests/settingsDialog.dom.test.tsx:371`
- `script/ci-smoke.mjs:867`

### B3 — 笔记模板（新建笔记先弹模板选择）
含义：2026-10-22 起，新建笔记先弹「空白 / 日报 / 会议 / 读书」模板选择菜单，选「空白」才真正建。
出现：
- `src/utils/noteTemplates.ts:2`
- `src/components/notes/NoteTemplateMenu.tsx:2`
- `src/components/notes/NotesListPane.tsx:351`
- `src/components/notes/notesPageCtx.ts:173`
- `src/components/notes/NotesNavPanel.tsx:228`
- `src/components/notes/NotesPageShell.tsx:790`
- `src/components/notes/sidebarSection.tsx:284`
- `tests/notes.dom.test.tsx:2024, 2040, 3359, 3363`
- `tests/noteTemplates.test.ts:2`
- `tests/noteTemplatePicker.dom.test.tsx:2`

### B4 — 出现两种不同含义（重名）
- **B4-a 标签层级 / 分组标签**（2026-10-22）：标签用 `/` 表达层级（如 工作/项目A），选父级即含全部子级；多选中项之间为「且」，每个选中项内部为「或」。
  - `src/utils/tagTree.ts:2`
  - `src/components/TagBar.tsx:89`
  - `src/hooks/useSiteSearch.ts:197`
  - `tests/tagTree.test.ts:2`
- **B4-b 设置中心左栏滚动比预算**（发版门禁）：一屏能看全的目录，打开设置中心后左栏不应需要滚动；B1 把条目加进左栏后这条预算更敏感，进 `ci-smoke` 真浏览器门禁。
  - `script/ci-smoke.mjs:865`
  - `script/ci-smoke.mjs:921`

### A1 — NavigationCenterDialog 九面板 props 拆分
含义：2026-11-01 重构——原先 `NavigationCenterDialog` 的九个面板 props 是一大坨内联对象/闭包直接摊在 `return` 里，抽出成 `NavCenterDialogBundle` 等并收进懒加载 bundle。
出现：
- `src/components/NavCenterDialogBundle.tsx:4`
- `tests/navigationCenterLazyGuard.test.ts:168`

### A2 — 卡片密度档位（舒适 / 紧凑 / 超紧凑）
含义：质量评估项，卡片密度三档切换（2026-10-21 加第三档「超紧凑」），与现有圆角/字号档位并列，存于 `uiPrefsStore`。
出现：
- `src/context/uiPrefsStore.ts:33`
- `tests/densityMetrics.test.ts:2`
- 另 `src/components/SiteSettingsModal.tsx:132` 引用 `docs/dialogs-audit-2026-10-23.md A2`（该文档中 A2 = 卡片设置对话框 `SiteSettingsModal` 审计项，属文档章节号，非代码内部代号）。

### A3 — 会话 cookie 名字收敛到 shared
含义：把 `navihive_session` 这个会话 cookie 名收敛到 `shared/sessionCookie.ts` 唯一定义点，避免前端（`transport.ts`）与服务端（`httpUtils.ts`）各写一份导致静默 401（登录 200 但下一请求因 cookie 名对不上而 401）。
出现：
- `shared/sessionCookie.ts:4`

### Q-3 — `noUncheckedIndexedAccess` 分批开启 + 棘轮守卫
含义：逐步为 `src`/`shared` 开启 TS `noUncheckedIndexedAccess`（下标访问可能 `undefined`）的严格类型检查，配「只增不减」的棘轮守卫，逐文件「毕业」、豁免清单收敛到 0。
出现：
- `tsconfig.shared.json:2`（先行层，仅 shared/）
- `tsconfig.strict-idx.json:2`（严格层，整份 src）
- `script/strict-idx-guard.mjs:1`（棘轮守卫脚本）
- `tests/q3StrictIsolation.test.ts:2`（静态守卫用例）

### V1 — 触屏行操作兜底
含义：2026-10-25 修复——笔记列表行尾操作（改名/置顶/删除）原只靠 `:hover`/`:focus-visible` 出现，触屏上整体消失；补 `@media (hover:none)` 兜底入口。
出现：
- `src/components/notes/NotesListPane.tsx:731`

### V3 — 出现两种不同含义（重名）
- **V3-a 空态说明文字对比度**（2026-10-25）：`EmptyArt` 空态说明文字原为 `text.disabled`（亮色 ≈2.85:1，不达 AA），改为 `text.secondary`（≥4.6:1）。
  - `src/components/EmptyArt.tsx:170`
- **V3-b 附件抽屉上传入口**（2026-11-02）：附件抽屉补「拖拽 / 选择上传」入口（后端 `uploadAttachment` 早已就绪，前端此前未接线）。
  - `tests/attachmentUpload.dom.test.tsx:3`

### V2 — 仅见于审计报告，代码中未作为内部代号使用
`audit-report-2026-11-01.md` 的 V2 = 「设置中心 B1/B4 未做」（B1 全站设置 3 Tab 摊左栏、B4 首屏滚动比预算）；`docs/archive/quality-review-2026-10-25.md` 的 V2 = 列表 loading 态缺失。二者均为**文档章节号**，**代码中无 V2 内部代号**，含义见对应文档。

## 方案代号（中文「方案 X」形式，亦属内部代号）

### 方案 A — 「收纳增强」（密码健康方向）
纯前端、无 schema / 迁移 / 服务端改动：密码健康分析、密码生成器、账号「密码健康」面板；设计上可被将来的「方案 B（保险库）」复用判据。
出现：
- `src/components/PasswordHealthDialog.tsx:2, 12`
- `src/utils/passwordGenerator.ts:2, 4, 9`
- `src/utils/passwordHealth.ts:2, 8`
- `src/App.tsx:509`、`src/components/AccountDialog.tsx:120, 246, 842`

### 方案 B — 端到端加密保险库（vault）
PBKDF2→AES-GCM 信封加密、服务端只存密文。覆盖 `vault` 域的传输层、服务端方法、迁移（schema 26）、弹窗与加密层。
出现：
- `src/App.tsx:2214`、`src/API/types.ts:882`、`src/API/mock.ts:361`
- `src/API/clientMethods/vault.ts:2`、`src/API/methods/vault.ts:2`、`src/API/methods/migration.ts:87, 538`、`src/API/methods/internals.ts:89`
- `src/components/VaultDialog.tsx:2`、`src/utils/vaultCrypto.ts:2`

### A+B 方案 — 设置中心信息架构重组（2026-10-31 用户确认）
把「外观与搜索 / 数据与维护」合并进左栏、「备份与恢复 + 回收站」合成「数据安全」面板、「高级」拆散迁入。B1 摊平即其结果之一。
出现：
- `src/components/ConfigPanelBody.tsx:119, 616, 707`
- `src/components/NavigationCenterDialog.tsx:55, 59`
- `src/components/navigationCenter/model.ts:11, 102`
- `src/components/navigationCenter/panels/DataSafetyPanel.tsx:2, 20`
- `src/components/RetentionPolicySection.tsx:6`
- `tests/navigationCenter.dom.test.tsx:217, 376, 408, 434`、`tests/navigationCenterLazyGuard.test.ts:100`

### P1-4 方案 B — 操作色规范（蓝 = 操作，红棕 = 记号）
笔记 / 设置等交互件的可点态用 `--accent-op`（蓝）、记号（如笔记强调色）用 `--notes-accent`（红棕）的分色口径。
出现：
- `src/index.css:266, 276, 633`
- `src/components/notes/NotesListPane.tsx:323`、`NotesAppearanceTab.tsx:40`、`NotesEditorPane.tsx:241, 316, 610`、`NotesSidePane.tsx:309`、`NotesSharesTab.tsx:158`、`paneChrome.tsx:235`、`settingsShared.tsx:87`、`sidebarSection.tsx:100`

## 重名冲突提示（ARCH-8 的核心问题）
同一串字符在不同上下文含义不同，切忌望文生义：
- **B1**：代码 = 设置中心摊平；但 `dialogs-audit` 文档中 B1 = 统计 `StatsHubDialog`、`quality-review` 中 B1 = 浏览器扩展。
- **B4**：代码有「标签层级」与「左栏滚动比预算」两义；`dialogs-audit` 中 B4 = 版本历史 `NoteVersionHistoryDialog`；`audit-report` V2 中 B4 = 首屏滚动比预算。
- **A1**：代码 = NavigationCenterDialog 拆分；`audit-report` A1 = `App.tsx` 巨型组件；`improvement-review` A1 = 首屏预算只盯了真实首屏。
- **A2**：代码 = 卡片密度档位；`audit-report` A2 = 类型纪律；`dialogs-audit` A2 = 卡片设置对话框。
- **V3**：代码有「空态对比度」与「附件上传入口」两义；`audit-report` V3 = 附件抽屉无拖拽。
- **Q-3**：仅出现在代码/配置（TS 严格检查），含义唯一，未作为审计章节号。
- **V2**：仅作审计章节号，代码中无对应内部代号（含义见上文）。

---

> 收集范围：`src/`、`shared/`、`script/`、`tests/`、`tsconfig.*.json` 中的代号注释，交叉核对 `.workbuddy/artifacts/audit-report-2026-11-01.md` 与各 `docs/*-audit-*.md`。本文**不改任何源码**，纯索引。
