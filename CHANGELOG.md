# 更新日志

个人导航站 NaviHive 的变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
按日期倒序；因为项目还没有打版本 tag，这里以「天」为单位归档。

分类沿用提交前缀：`安全` / `新增` / `修复` / `重构` / `性能` / `工程`。
只看「这次上线会有什么不一样」的话，读每段的**要点**即可。

> **历史归档**：本文件只保留 **2026-11 及以后**的记录。更早的按时间段归档在
> [`docs/archive/changelog-2026-10a.md`](docs/archive/changelog-2026-10a.md)（2026-10-21 ~ 10-31）、
> [`…10b`](docs/archive/changelog-2026-10b.md)（10-11 ~ 10-20）、
> [`…10c`](docs/archive/changelog-2026-10c.md)（10-01 ~ 10-10）、
> [`…09`](docs/archive/changelog-2026-09.md)（09-24 ~ 09-30）；完整索引见 [`docs/README.md`](docs/README.md)。

## 2026-11-08 · v36.1.0

### 修复
- 修复卡片悬停抖动的缺陷：原 `:hover` 的位移直接作用在被悬停的 `.nav-card-in` 自身，导致光标随卡片上移而离开命中区 → 取消 hover → 回落 → 再次 hover，形成高频抖动死循环。现把抬升位移改到内层静止命中区的子元素 `.nav-card-lift` 上，外层保持几何静止，抖动循环被打断（新增 `tests/cardHoverLift.test.ts` 守住该写法不被回退）。
- 修复笔记编辑后保存太慢、切走导航站时内容丢失的缺陷：自动保存防抖由 5 秒收紧到 2.5 秒；卸载（关闭记事本 / 切走）时改为强制落库并自带最多 3 次重试，仅在全部失败时才提示用户可能未保存；新增「在飞 / 已成功」双守卫避免重复 flush 与无效写入。

## 2026-11-08 · v36.0.1

### 修复
- 修复站点排序取消编辑后卡片顺序不回滚的缺陷：进入排序模式时记录完整分组快照，取消时整体恢复到进入前的顺序，多次拖拽后取消也不再残留中途状态（之前需刷新页面才恢复）。
- 移动端（触屏）卡片只保留「设置」与「笔记」两个按钮，隐藏收藏（星标）与右下角快捷操作（复制账号 / 复制密码），避免卡片控件过挤、误触。
- 同步更新冒烟测试的移动端浮层断言，并新增两条取消排序回滚的回归测试。

## 2026-11-08 · v36.0.0

### 修复
- 链接健康检测区分明确 404/410 与未知网络、限流、方法限制及服务端错误，避免误判失效。
- 图标代理失败时为显式 HTTP(S) 图标保留安全的原始地址回退，同时维持 SSRF、CSP 与 SVG 下载保护。
- 修复多轮跨分组拖拽的布局反馈风险，拖动期间保持结构稳定并在结束时一次性落位。

### 性能
- 将用户主动触发的批量链接检测拆为按需加载模块，保持三态检测、通知和隐私契约。

## 2026-11-08 · 修复：按 VPS 今日错误日志逐条收口（恢复锁误报 / 拖拽崩溃 / 审计时间差 8 小时 / QQ 中段白块 / 恢复 403）（35.0.0）

> 用户把今天（北京时间 11-08）VPS 操作日志里所有报错一次性摊开要求逐条修掉。审计日志只留下 `source/path/message`、没有堆栈，所以先从 `docker logs` 里取到完整 sanitized 堆栈再定位，不靠猜。
>
> - **恢复锁误报「上一次恢复还没结束」（P0，Cloudflare Workers + D1）**：`claimIdempotency` 用 `meta.rows_written === 1` 判「锁是不是我抢到的」，而 D1 的 `rows_written` 是**含索引写入**的物理行数，插一条锁记录也可能 >1 —— 于是自己抢到了却被判成没抢到，紧接着重读锁又读到**自己刚写的那条**，一路报「上一次恢复还没结束」，并且 `finally` 里因为 `lockAcquired` 仍是 false 而**不会释放**，两分钟内谁来都恢复不了。改为按 `meta.changes`（逻辑变更行数：1 = 抢到、0 = 别人占着）判定，`rows_written` 只作为没有 `changes` 的旧适配器兜底，且不再从「>1」推断归属。同时把恢复锁切到三态 `claimIdempotencyDetailed`：「别人在跑」和「锁不可用」不再混成同一个 `false` —— 前者回「上一次恢复还没结束」，后者回「无法确认恢复锁是否可用…本次未做任何改动」，不再让用户对着一句假话干等两分钟。
> - **恢复的版本闸门挪到抢锁之前**：归一化（含 `checkBackupVersion`）全程是纯计算、一次库都不碰。原先排在抢锁之后，导致「备份版本比当前版本新」这种一眼就该拒绝的输入先去抢锁，抢不到还回报成「上一次恢复还没结束」——报错要报真原因。
> - **卡片拖拽一拖就报错（P0）**：两条独立成因。其一是 `App.tsx` 的 `POINTER_SENSOR_OPTS` 同时给了 `distance: 5` 和 `delay: 0`，dnd-kit 的 `PointerSensor` 在「位移没超过 distance」时会拐进 delay 分支并调用 `hasExceededDistance(delta, tolerance)`，而这条路径上 `tolerance` 是 `undefined` → `Cannot use 'in' operator to search for 'x' in undefined`（日志里 4 条，堆栈都落在 vendor 的 `handleMove`）。去掉多余的 `delay: 0`，只留 `distance: 5`。其二是跨分组拖动时 `dragover` 每帧都重建 `groups` 数组（同组也算一次移动），把 dnd-kit 的 `useDerivedTransform` effect 顶成自激循环 → React #185（Maximum update depth exceeded，日志里 4 条）。现在 `dragover` 只做**跨组移动**（`crossGroupOnly`，同组直接原样返回，不产生新引用），并在拖起时记一份分组快照：`dragover` 期间基于快照重算、`dragend`/`dragcancel` 收尾时按快照回滚，取消拖动不再残留半路状态。
> - **审计日志时间差 8 小时**：`audit_log.created_at` 是 SQLite `CURRENT_TIMESTAMP` 写下的**无时区 UTC 文本**，前端当成本地时间 `toLocaleString` 就成了 `02:38`（真实北京时间 `10:38`）。新增 `fmtAuditDateTime`：识别「无时区」形态先补 `Z` 按 UTC 解析，再固定按 `Asia/Shanghai` 格式化；`AuditDialog` 两处（明细行、客户端错误分组）改用它。别的字段仍走 `fmtDateTime`，不牵连全站时间显示。
> - **QQ 浏览器滚到中段抖动 + 白块挡住卡片**：分组面板的 `content-visibility: auto` 配着 420px 猜测占位，在 QQ 的合成器上滚到视口中段时会反复进出「跳过绘制」判定，表现为不断抖动并糊出白块。QQ 安全档（`html.nav-qqbrowser`）下对浏览态面板（`data-sort-mode="None"`）强制 `content-visibility: visible` + `contain-intrinsic-size: none`；React 侧的一次性懒挂载照旧，排序态的 transform 与测量不受影响，其他浏览器一行不变。
> - **记事本备份页多出一个「）」**：`NotesBackupTab.tsx` 里一行孤立的 `)` 被当成文本节点渲染出来了，删掉。
> - **本地文件恢复 403（VPS 侧）**：nginx 的 ModSecurity/OWASP CRS 949110 把大体积加密 POST 当注入拦掉。已在 `/api/import`、`/api/notes/import`、`/api/webdav/` 三处 location 加 `modsecurity off;`（VPS 上已完成并 reload）；应用侧把 worker 的 10MB 额度正则补上 `notes/import`，之前它只认 `import` 与 `webdav/upload`。
> - **本次不动**：Chrome 上「笔记编辑打开仍无行号」按用户决定不修；拖拽快照回滚理论上可能覆盖同一时刻的 bootstrap 刷新（无现场证据），留作观察项。
>
> 新增守卫（均对旧写法做过反向验证）：`restoreAtomicity` 新增 11 条锁用例（`changes-only/indexed` 两种元数据形态、`changes=0` 不释放真实持有者、索引计数下过期锁可重抢、无法确认时不误报并发且不删未知持有者、缺 Detailed 能力拒绝无锁导入、D1 报错不退回无锁导入、异常后 `finally` 释放）；`idempotency` 补 `claimed by meta.changes` 与三态分离；`sortController.dom` 直接调真实 `PointerSensor.prototype.handleMove`（5px 内不抛、6px 启动、`{distance:5,delay:0}` 必抛）+ 80 次交替 `over` 不重建数组；`whiteBlock.dom` 加 QQ 面板静态守卫；`formatUtilities` 钉无时区串→北京时间；`streamLimits`/`workerRequestRebuild` 钉笔记恢复的 10MB 额度。
>
> 本地门禁全绿：`tsc -b`(0 error) / lint(0 error，23 条 react-refresh 基线 warning) / 全量单测(4225 通过，0 失败，1 跳过) / build / `check:budget`(37/37) / `audit:a11y`(0 项不合格) / `audit:contrast`(亮暗各 0 处) / `check:strict-idx`(366/62/62) / `check:brand` / smoke(全部通过)。

## 2026-11-07 · 修复：普通模式在 QQ 浏览器持续闪烁 / 弹窗白块（极光重绘风暴 + QQ 自动安全档）（34.1.1）

> 34.1.0 上线后用户复测：**Chrome 一切正常，但 QQ 浏览器**仍持续闪烁（卡片悬停闪、顶栏与滚动条逐帧闪）并伴随设置 / 弹窗超界白块，开启「清爽模式」后全部消失。这一批定位到真正的根因并修复；34.1.0 那一轮的头部滞回 / 零位移 / sensor 引用 / 设置纸面去模糊**都没碰极光**，所以对你无效。
>
> - **真正的根因（P0）**：全屏柔光背景层 `.nav-aurora` 是一块 `position:fixed; inset:-12%` 铺满视口（还外扩 12%）的装饰层，带 `filter: blur(48px)` 与 `animation: navAurora 26s ease-in-out infinite`——等于**永不停歇地全屏重绘 + 模糊重算**。它身后每帧都在变，于是所有带 `backdrop-filter` 的元素（弹窗纸面、卡片、顶栏、搜索框等约 20 处）**每帧都得重新采样背景**。Chrome 的现代合成器扛得住，QQ 浏览器的合成器扛不住，表现为逐帧重排的闪烁与 backdrop-filter 合成失败时糊出的超界白块。清爽模式靠 `.nav-aurora{display:none}` 掐掉驱动源、再 `backdrop-filter:none` 停采样，所以一下全好——这正说明极光才是驱动源。
> - **主干修复**：`BackgroundLayers.tsx` 删掉极光的 `filter:"blur(48px)"`；`index.css` 删掉 `@keyframes navAurora` 与 `.nav-aurora` 的 `animation`。极光退化为**静止柔光**（径向渐变本就柔和，三处尺寸略放大以补偿扩散损失），卡片 / 顶栏 / 弹窗的毛玻璃照旧，但背后是静止背景，不再每帧重采样 → 重绘风暴停止。这是清爽模式对你生效的那一刀，只是这次只动极光、保留观感。
> - **QQ 浏览器安全档（自动，仅 QQ 生效）**：检测到 QQ 系 UA（`QQBrowser` / `MQQBrowser`）时，由 `useDocumentEffects.ts` 一次性嗅探给根节点挂 `nav-qqbrowser`，`index.css` 在该类下 `display:none` 关掉极光、并把所有元素的 `backdrop-filter` 降级为 `none`（复用 `nav-no-glass` 的成熟写法，surface 仍是半透明静态面板）。QQ 用户失去的只是「磨砂感」而非可用性；Chrome 用户不会挂这个类，毛玻璃观感完全不变。
> - **未动**：任何 `backdrop-filter` 用法、清爽模式 `.nav-lite`、34.1.0 的全部改动、死代码清理。
>
> 本地门禁全绿：`tsc -b`(0 error) / lint(0 error，23 条 react-refresh 基线 warning) / 全量单测(4195 通过，0 失败，1 跳) / build / `check:budget`(37/37) / `audit:a11y`(0 项不合格) / `audit:contrast`(亮暗各 0 处) / `check:strict-idx`(366/62/62) / smoke(全部通过)。

## 2026-11-07 · 修复：导航站持续闪烁（滚动滞回 / 头部零位移 / 渲染引用稳定）+ 设置中心切换面板白框（34.1.0）

> 34.0.0 上线后用户复测：笔记页白块已消失，但**停留在导航站首页**仍有持续闪烁 —— 鼠标移上卡片不停闪、顶部进度条与右侧滚动条逐帧闪；点设置左栏面板时右缘冒出一圈白色圆角浮框。这一批逐项收口。
>
> - **首页持续闪烁（P0）**：根因是 `useViewportUi.ts` 的 `setHeaderCompact(y > 阈值 && y > lastY + 2)` —— 这是**滚动差分判定**，临界点上头部一收紧、文档高度变化又让 `scrollY` 反向跳一帧，下一页判定翻回 `false`，形成逐帧 true/false 翻面（顶栏 / 进度条 / 滚动条跟着逐帧重排）。改用**双阈值滞回**（`HEADER_COMPACT_ON = 160` / `HEADER_COMPACT_OFF = 130`，中间带保持上一次状态），判定抽成可导出纯函数 `resolveHeaderCompact(prev, y)`，由 8 条拐点断言直接驱动。同时**把位移源头去掉**：`SiteListHeader` 的 `gap/mb/pt` 三处原随 `headerCompact` 一同收缩（合计约 21px 文档高度差 → 整页平移 → 滚动条 thumb 重算），现拍平为常量，**头部盒高恒定**，紧凑态只保留标题字号变化（字号只改字形、行盒由 line-height 撑，不改盒高）。滞回因此不再需要「宽于 21px 位移」，但**不取消、也不退化成单点阈值** —— `scrollY` 在惯性滚动、`overscroll` 边界回弹、移动端地址栏伸缩下本来就会在临界点来回抖几像素，中间带正是为这种抖动留的。
> - **死代码清理（同一根因的收尾）**：间距拍平后 `.nav-header-compact` 这个类和它的 `className` 挂载彻底失效（只剩一条 `transition: padding / background`，两个属性都不再变），一并删除并留说明注释；同步移除 `script/visual-regression.mjs` 采样清单里的该选择器，以及 27 个视觉基线里对应的空数组 key（逐文件按各自真实行尾精确删行，零数据损失 —— 它从来没采到过元素）。
> - **整列表重渲染的独立成因**：`App.tsx` / `GroupCard.tsx` 的 dnd-kit `sensor options` 写成内联对象字面量，每次渲染新建引用 → `sensors` 每次变 → 下游 memo 组件的 props 浅比较永远失败（看起来「数据没动」却全量重渲染）。两处 options 提为模块级常量；**两份数值刻意不同**（App 触摸 100ms / 容差 3px，卡片 250ms / 5px —— 卡片更小更易误触，策略更保守），不为「去重」硬合成一份。
> - **设置中心切换面板白框**：`SettingsWorkspaceDialog` 的 Paper 走全站共用的 `dialogPaperTokens`（`backdrop-filter: blur(...) saturate(1.4)` + 半透明底 + 22px 圆角）。设置中心是唯一「左栏常驻 + 右栏整块切换」的弹窗，换面板会让右栏子树整体重绘、浏览器被迫为纸面**重新采样背景**；采样那一帧里半透明底与圆角抗锯齿带把底下浅色页面漏出来，就是那道白框。修法只针对这一个纸面：`backdropFilter: "none"` + 底色换 `theme.palette.background.paper`（亮 `#fff` / 暗 `#121212`，均不透明、跟随主题），`dialogShell.ts` 的全站真源**一个字未动** —— 其余 31 个弹窗的玻璃材质不受影响。
> - **F4/F5 刻意未做**：`content-visibility: auto` + 420px 估算占位、以及卡片 hover `translateY(-6px)`，这两处是「放大器」，只在主链被触发时放大问题；F1/F2 修好后事件链已断，放大器没有机会被触发。它们分别有长列表滚动性能与交互观感的实际代价，故留作后续观测项，不在本轮无证据地先把代价赔进去。
>
> 新增守卫（均做**反向变异自证**，改回旧写法必须变红）：`scrollHysteresis`（8 条：六个拐点 + 滞回带内连续微抖不翻转 + 越线后可再次收紧）、`headerLayoutStability`（5 条：间距不得跟随 headerCompact / 必须拍平在常态档 / 字号三元保留 / 死 transition 已删 / 死类不得回挂）、`sensorRefStability`（4 条：options 必须是模块级常量且不得内联字面量）、`settingsPaperOpaque`（静态 3 条 + 运行时 1 条 —— 读 emotion 注入 `<head>` 的规则文本自己算级联赢家，**不读** jsdom 的 `getComputedStyle`，那对 `var()` 返回空串会写出假绿）。
>
> 本地门禁全绿：`tsc -b`(0 error) / lint(0 error，23 条 react-refresh 基线 warning) / 全量单测(4195 通过，0 失败，1 跳) / build / `check:budget`(37/37，首屏 index 258.22 KB，与基线 258.23 KB 持平) / `check:strict-idx`(366/62/62) / `audit:a11y`(0 项不合格) / `audit:contrast`(亮暗各 0 处，含设置中心暗色态) / smoke(全部通过)。`audit:visual` 实测 5/27 一致：**主站 home 场景（`desktop-home-light/dark`）完全一致**，印证 F1/F2 对静止页的几何与颜色零影响；其余 22 条差异全部来自任务 A 的笔记停绘与本次设置中心不透明底，属基线过期，观察期内未跑 `--update`。

## 2026-11-07 · 修复：一整批实测交互与渲染缺陷（保险库自动填充 / WebDAV 删除要点几次 / 胶囊误撤 / 首页抖动卡片消失白块）（34.0.0）

> 一批用户实测报障，覆盖提交 `75d2873`、`c5b1e4f` 与本次一并推送。逐项给根因与修法（都不改表象、只修根因）：
>
> - **保险库/搜索框被浏览器自动填充登录账号密码**：根因是 `VaultDialog.tsx` 六个主密码框用 `type='password'` + `current-password`/`new-password`，Chromium 把整页当登录表单做「用户名+密码」配对，把保存的账号灌进搜索框、密码灌进主密码框（`autoComplete=off`/`new-password` 实测都挡不住）。全部改走 `utils/secretInput.ts` 既有方案（`type=text` + `-webkit-text-security:disc` 遮蔽、Firefox 回退 `type=password`），六个 name 互不重复且不含 password/username 语义，`SECRET_IGNORE_ATTRS` 严格挂 `slotProps.htmlInput`（原生 input，挂顶层会被摊到外层 div 白做）；设置左栏「搜索设置」框补同款防填，顶栏搜索框加固（`readOnly` 解锁三路径一行未动）。
> - **WebDAV 恢复列表「删除要点好几次」**：主因是 DELETE 成功后 `finally` 的静默校准整表 `setRemoteFiles(listed)`，部分 WebDAV/PROPFIND 缓存仍返回旧目录 → 文件复活，用户只能再点。改法：`pendingDeletedRef` 同步状态机（点击即屏蔽、校准按名过滤陈旧结果、确认服务端不再列出才解除）+ 删除按钮从 `ListItemButton` 内嵌改为 `ListItem + secondaryAction` 兄弟结构并补 `onMouseDown/onPointerDown/onClick` 三层 `stopPropagation`（原来只挡 click，第一次点击被外层选中吞掉）。QA 独立探针又抓到一个未测竞态（删除在途 + 用户点「查看远端备份」会把屏蔽清空 → 文件复活），按 P1 补 `inFlightDeleteRef`（在途名字不被非 silent 刷新清掉）+ `listEpochRef`（删除失败放回后丢弃过期列目录响应），并显式钉死「两步语义」：第 1 次主动刷新仍屏蔽陈旧 PROPFIND、第 2 次以服务端真相为准（避免「删了又冒出来」与「永久屏蔽同名新备份」两个极端）。
> - **笔记「包成胶囊」改选/空选区误撤已有胶囊**：根因是 `useEditorTools.ts` 的 `insertAtCursor` ① 撤销分支只校验「同一对定界符 + 上次片段还在旧偏移」，**完全不读当前选区**；`lastInsertRef` 是实例级隐藏状态，改选/复制/失焦都不清 → 包完 A 再改选 B 或空选区点击被误判成「对 A 连点的第二下」，主动撤掉 A 的定界符。修法：给 ① 判据补 `start === last.selStart && end === last.selEnd` 选区闸门（惰性判据，不引入 effect/选区订阅/新 state，设计内「刚包完立刻再点第二下仍可撤」保留），并让胶囊专属入口对空选区 no-op（不改通用工具的空选区占位符行为）。这是**通用 toggle 缺陷**，同一处同时修好粗体/双链等 11 个行内工具的同类问题。
> - **首页多次抖动 / 卡片时隐时现 / 白色矩形块（P0，笔记界面也受影响）**：唯一上游是 `useSites.applyRemoteData` 每次无条件全量替换 `groups`、`fetchData` 无请求序号/去重/取消 → 挂载期 ≥4 条自动刷新源交错落地，晚到的旧快照覆盖新快照（计数 9↔10 跳、整树重渲染）。修法：`fetchData` 加 `requestSeqRef`（只接受最新响应，旧响应不落地/不写缓存/不回调 extras/不碰 error）+ `inflightRef`（并发复用同一 Promise）+ `mergeGroupsPreservingRefs`（O(n) 按值浅比较，内容不变原样返回 prev，让 `GroupCard` memo 真正生效）。下游放大器逐条收口：`GroupCard` 占位高度去掉条数依赖（固定估值 + IO effect 去条数依赖 + 首次切换跳过 Collapse 过渡 + hover 只补间 box-shadow/border-color 并去掉 scale）、卡片入场动画只在首次挂载播（`navCardIn` 挪到 `.nav-card-first-in`，刷新不再重播 backwards 透明帧）、卡片 key/SortableContext items 统一 `site.id`；笔记界面白块用三刀：`notesOpen` 时给 `html` 加 `data-notes-open` 让背景 `.nav-root` 停绘（`visibility:hidden`，保留布局/滚动/IO 状态，不用 display:none）+ 背景分组 `content-visibility:visible`（关掉 420px 方形空白）+ 卡片动画 `none`，并补 `[data-notes-root]`/加载骨架豁免；`App.tsx` 拆共享 `ChunkBoundary`（`EditGroupDialog`/`AddSiteDialog` 各挂各的 when，消除关一个留另一个 320ms Paper 残影）、`NotesLoadingFallback` 提成模块级稳定常量（避免 z2000 纯白层重挂）。
> - **首屏预算（index chunk）随 P0 修复上调**：上述修复在 6 个首屏文件净增约 2.56 KB 必需逻辑（去重状态机 / 结构共享合并 / 停绘 effect / 渲染层就地修法），逐项核过无可改 lazy 的赘肉。index `BUDGET_KB` 270 → 272、`BASELINE_KB` 255.67 → 258.23（实测 258.23 KB，余量 5.34%），按仓库既定「P0 必需首屏成本」例外连同理由与实测字节记录在案，不靠放宽过门禁。
>
> 本地门禁全绿：build / `check:budget`(37/37) / 全量单测(4174 通过，0 失败，1 跳) / `tsc -b`(0 error) / lint(0 error，23 条 react-refresh 基线 warning) / `check:strict-idx`(366/62/62) / `audit:a11y`(0 项不合格) / `audit:contrast`(亮暗各 0 处) / smoke(全部通过)。

## 2026-11-07 · 性能/修复/工程：独立审计第三批 · 增量 A（P2-8 快照节流 + P2-15 批量删补偿 + P2-14 离线孤儿 + P2-10 CI 供应链）（33.1.0）

> 第三批（结构性）先落**风险低、收益直接**的四项；最险的 P1-5（App.tsx 拆 7 个 controller hook）单独放增量 B 后续。要点：
>
> - **P2-8 版本快照节流（容量）**：`note_revision` 每笔记保留份数 `REVISION_KEEP_PER_NOTE` 60 → **20**（D1 容量硬上限下的主杠杆）；新增纯函数 `shouldSkipRevision` + 常量 `REVISION_MIN_INTERVAL_MS = 5min`，**只挂在显式 `pushRevision` 入口**（拦重复的手动「存版本」点击，正文不变不丢历史）。`src/API/methods/notes/notesNote.ts` 的 `updateNote`「每次编辑存改动前快照」路径**不**走时间节流——全量单测抓到：若在这里节流，用户在 5 分钟内的连续编辑会丢掉中间版本、破坏「版本历史可恢复」契约（测试 `noteFolderTagRealSql` 锁定的「改两次 = 2 份」直接红）。`docs/architecture.md` 新增 §4.4 容量估算公式（库体积 ≈ Σ正文×1.15 + Σ正文×0.8×平均快照份数 + 附件元数据，含 60→20 与 5min 节流的说明，标注经验估值待校准）。
> - **P2-15 批量删除跨 batch 补偿**：`data.ts` `deleteSites` 阶段②逐批 `try/catch`——多批时单批失败返回 `{ items, failed, partial: true }`（已提交批次保留、未提交并入 failed），不再「中途失败只回 500 把已删的也判失败」；单 batch（`planned.length===1`）仍保持原子 500。`SiteBatchDeleteResult` 新增 `partial?: boolean` 字段（语义对齐 `NoteImportStats.partial`）。前端据此在提示条上给「撤销」并标注部分成功。
> - **P2-14 离线队列孤儿**：重放时若某 mutation 依赖的占位 id 仍未被解析（上游还没回），不再无限重试/直接失败留下孤儿数据；新增 `findUnresolvedTempIds`（深搜去重、排除已解析占位）与 `UnresolvedTempIdError`，命中则在 `translateTempIds` 之前把 `op.blockedBy` 指向第一个未解析 id、`saveQueueMerged()` 保留 pending、跳过本轮，等上游重放后再推进。
> - **P2-10 CI 供应链**：`docker-publish.yml` 的 `merge` job 加 `id-token: write`，并接三段 fail-soft 流水线——`anchore/sbom-action` 产 SBOM（ CycloneDX）、`sigstore/cosign-installer` + keyless `cosign sign` 对 latest / 版本 / sha 三 tag 签名、`aquasecurity/trivy-action` 镜像扫描（`continue-on-error` 仅告警，不卡发布）。
>
> 本地门禁全绿：build / `check:budget`(37/37) / 全量单测(4132 通过，0 失败，1 跳) / lint(0 error) / `check:strict-idx`(366/62/62) / `audit:contrast` / `audit:a11y` / smoke。

## 2026-11-07 · 修复：用户名枚举挡板输入改走 gitleaks 值级白名单（33.0.2）

> 33.0.1 之后 CI 的 gitleaks 门禁把 `DUMMY_HASH_PASSWORD`（用户名枚举计时挡板的假哈希输入）误判为 `generic-api-key`（变量名含 PASSWORD + 高熵串）。它本来就不是凭据 —— 把值改成含 `dummy` 的低熵串（`navihive-dummy-hash-input`），走 `.gitleaks.toml` 自己的值级白名单（dummy/fake/mock…），不再依赖侥幸。挡板行为不变（固定串 → 固定假哈希 → 烧一次满迭代 PBKDF2）。

## 2026-11-07 · 修复：补 selfUpgrade 的触及覆盖（33.0.1）

> 33.0.0 把 Docker 自升级拆到 `server/upgrade/selfUpgrade.ts` 后，CI 覆盖率第 1 层（server/ 文件触及率 100%）红了 —— 该文件没有任何用例引入过。把其中两段**只在线上炸过**的错误文案抽成纯函数并补真测试（`missingComposeInfoError`：/compose 标签污染 vs 非 compose 部署给不同处方；`imageUnchangedError`：「版本号先到、镜像后到」空档提示），`upgradeCompose.test.ts` 引入后触及率回到 100%（本地复跑 coverage 第 1 层 12/12 全绿）。

## 2026-11-07 · 安全/重构：独立审计第二批（P2-2 兼容契约 + 拆自升级 + 日志三件事 + 切批 + 口令策略 + compose 硬化）（33.0.0）

> 审计第二批 5 项全部落地，外加被暂缓的 P2-2。要点：
>
> - **P2-2 兼容契约（保住 Firefox 111–120 / ESR115）**：基线维持 `firefox >= 111`，改为给 `:has()` 补兼容路径 —— 卡片键盘焦点环、卡片操作条、分组工具条三处，`:has()` 全部单独成规则并包进 `@supports selector(:has(*))`，块外留 `:focus-within` 兜底（老浏览器唯一代价：鼠标点一下浮层也会亮）；`--accent-wash` 补静态降级值（不支持 `color-mix()` 的 FF111–112 用默认强调色的 10% 染色）。新增 `tests/cssBaselineGuard.test.ts` 把契约钉进 CI：裸写 `:has()` 即红（反向变异验证过守卫真的会咬人）。顺手删了三处无人引用的死规则（`nav-fade-up` / `nav-drop-hint` / `navAurora` 残留），偿还了本批吃掉的首屏预算。
> - **拆 `server/entry.ts` 的 Docker 自升级**（约 1,100 行 → `server/upgrade/{dockerApi,spool,compose,selfUpgrade}.ts`，entry 只留路由编排与审计落库，行为逐字等价）：纯函数（compose 坐标解析、helper 命令拼装）第一次有了真执行覆盖（`tests/upgradeCompose.test.ts`）。
> - **日志三件事（P1-4）**：① `logger` 发射口把 `Error` 序列化成 `{name,message,stack,cause}` 的普通对象（不再混进宿主 inspect 格式，`jq` 可查）；② Node 侧 `AsyncLocalStorage` 注入 rid，80+ 处 `warn/error` 自动带上请求 ID，不用改任何调用点；③ 新增 `shared/metrics.ts` 四计数（请求 / 5xx / 429 / 慢请求 >1s）+ `/api/ops/metrics`（仅 owner），worker 侧出口只对 5xx/慢请求逐条记日志（CF 形态逐行计量）。
> - **切批与配额租约（P2-3/P2-4）**：`notesTag.ts` / `recycle.ts` 的 `IN (...)` 与 `VALUES (?,?)` 批写改走 `chunkByParamBudget`（D1 单语句 100 参数上限，本机 SQLite 32766 测不出来）；附件配额租约 key 改按用户（以前全局一把锁，A 传图 B 直接 409），并把租约提升到路由层包住「校验 + 写对象 + 写 D1」全程（以前判完就放，并发下 1GB 配额能写出 1.1GB）。
> - **口令策略（P2-6/P2-7）**：注册 / 改密 / `auth/credentials` 三处并入 `validatePasswordStrength`（≥12 位 + 拒绝同字符重复），不再「注册能设 6 位、改密却要 12 位」；登录时用户名不存在也对固定假哈希跑一次满迭代 PBKDF2（堵用户名枚举的计时侧信道）。前端注册框提示同步改「至少 12 位」。
> - **compose 硬化 + TRUST_XFF 告警（P2-9/P1-2）**：`docker-compose.yml` 补 `cpus:1.0` / `pids_limit:128` / `read_only:true`（可写面只剩数据卷、/spool、/tmp） / `cap_drop:ALL` / `no-new-privileges`；入口检测到「请求带 XFF 但 TRUST_XFF=0」时每进程强告警一次；`clientBucket` 增加共享桶第三态（`login:global`，socket 对端为回环且无受信头）—— 该桶下登录宽限提到 20 次、锁定期不硬拒改软节流（每请求最多多等 10s）：自托管没开 TRUST_XFF 时，一个人连错 12 次把全站登录锁 30 分钟的 DoS 从此不成立。
>
> 本地门禁全绿：build / `check:budget`(37/37) / 单测+DOM(4117 通过，1 跳) / lint(0 error) / `check:strict-idx`(366/62/62) / `audit:contrast` / `audit:a11y` / smoke。

## 2026-11-07 · 修复：独立审计第一批（文档失真 / 崩溃页暗色 / SW 预缓存收紧）（32.5.0）

> 一轮**不采信既有结论**的全维度独立审计之后，先落地「改动小、收益直接」的第一批。除错误兜底页配色外不改产品行为：
> - **README 4 处失真纠正**：去掉已删除的「待办聚合视图」（`NotesPageShell` 2026-10-19 已移除）；「ZIP + manifest」改为实际（只打包 `notes.json` + `attachments/*`，无 manifest）；「Cursor 增量同步」改为实际（命中变更后整表重拉，非增量合并）；外观去掉「按账号保存」（`useThemeController` 读裸键 `theme`，实为浏览器级）。
> - **`docs/codes.md` 补 API 错误码表**：此前只有内部代号索引、**零** API 错误码；补 `shared/apiErrorCodes.ts` 的 15 个码（状态码与语义对标 `worker/lib/apiError.ts` 的工厂，`quota_exceeded` 如实标注为预留、无对应状态）。
> - **`docs/contributing.md`** 修正不存在的 `npm run dev:server` → `npm run start:selfhost`（真实联调第 2 步原本就断在这）。
> - **`ErrorBoundary` 崩溃兜底页暗色化**：原 18 处硬编码亮色 → 全走 token；崩溃常发生在 React 挂载前（此时 `<html>` 只有 `data-boot-theme`、尚无 `.dark` 类），故在渲染时自判明暗并给外层 div 挂 `.dark`，即使主题类未挂也走暗色。样式从内联 `style` 搬到 `index.css` 的 `.eb-*`（内联 style 在 index chunk 里约 1.3 KB，搬迁后 index chunk 缩小、首屏预算反而更宽松）。
> - **SW 预缓存核心清单收紧**（`vite.config.ts`）：只把首屏 `index-*.css` 算进 core，KaTeX 等可懒加载 CSS 走 lazy 分支（首访少预缓存一份约占全部 CSS 54% 的样式；precache 测试只校验 `.js` 双向对齐，不卡 CSS）。
>
> ⚠️ 审计报告原列的「browserslist 改 `firefox >= 121`」**本批未做**：实测它不是「一行止血」——`tests/safariApiGuard.test.ts` 与 `docs/architecture.md` 都把 `firefox >= 111` 钉成基线并联动越界 API 风险表，改基线等于放弃 FF111–120 / ESR115 支持、且需重分类整张表。正确解是给 `:has()` 补 `:focus-within` 兜底、`color-mix()` 补 `@supports`（保留 ESR115 可读），留作独立改动。
>
> 本地可跑门禁全绿：build / `check:budget`(37/37) / 单测+DOM(4086 通过，1 跳) / lint(0 error) / `check:strict-idx`(366/62/62) / `audit:contrast`(亮暗 0 不合格) / `audit:a11y`(0 不合格)。

## 2026-11-07 · 修复：对比度审计补 camelCase 别名 + 编辑器 IME 合成期守卫 + 迁移 updated_at 运行层断言（32.4.2）

> 32.4.1 发布后的三处小修，全部是「防回归 / 补覆盖漏洞」，产品行为无变化：
> - 对比度审计 `watched` 关键帧属性集合原只写 kebab-case（`background-color`/`border-top-color`…），但真 Chrome 的 `getKeyframes()` 返回 **camelCase**（`backgroundColor`/`borderTopColor`），对 CSSAnimation 关键帧分支匹配不上 —— 潜在缺口（32.4.1 那次事故走 `transitionProperty` 分支未受影响，但缺口还在）。本轮给 `watched` 并列补 camelCase 别名堵死。
> - `NoteEditorLivePreview` 的 90ms `refreshEffect` 在中文/日文输入期间（`view.composing`）未防护，防抖刷新会触发整块重渲染、吞输入。补 `if (this.view.composing) return;`。
> - `copyBlockRemoved` 静态禁令只有静态一层，真 SQLite 里没有「迁移前后被清洗笔记 `updated_at` 相等」的运行层断言（变异测试证明是覆盖漏洞）。补一条真实 SQLite 运行层断言钉死。
>
> 顺带把 32.4.1 那轮漏写的「34ms 竞态 + 修因不放宽预算」注释口径补进 `contrast-audit.mjs`。
>
> ⚠️ 首屏 gzip 余量已薄到 ~16 B（285.6982 / 285.7143 KB）：本轮实测先量后改，**mui-core 已无安全可缩余量**（React/emotion/MUI 全单实例、桶导入已正常 tree-shake、156 图标全深导入且进首屏的 51 个都必需、`@mui/system`/`@mui/utils` 单实例），强行收只会触发风险或把已懒加载的 66+ chunk 拖回首屏（伤 FCP）。故**不偿还首屏预算**，依赖现有 `check:budget` 卡回归。

### 改了什么

- **对比度等待判据 `watched` 补 camelCase 别名**（`script/contrast-audit.mjs`）：保留原有 kebab 项，并列加 `backgroundColor`/`borderColor`/`borderTopColor`/`borderRightColor`/`borderBottomColor`/`borderLeftColor`；不动 `transitionProperty` 分支、`watched.has(p)` 逻辑、静态守卫（`tests/contrastScanner.test.ts` 仍 12/12）。
- **编辑器 IME 合成期守卫**（`src/components/NoteEditorLivePreview.ts`）：`livePreview()` 的 `update()` 在 `clearTimeout` 之后、`setTimeout` 排程 90ms 刷新之前加 `if (this.view.composing) return;`，合成中输入期间不排程刷新。
- **迁移 `updated_at` 运行层断言**（`tests/copyCalloutMigrationRealSql.test.ts`）：新增断言「真实 SQLite 迁移前后被清洗笔记的 `updated_at` 必须相等」，钉死 `copyBlockRemoved` 静态禁令的实际效果（变异测试证明静态层会被写回语句形状先红、执行不到 `updated_at` 分支）。
- **注释口径补齐**：`script/contrast-audit.mjs` 补 34ms 竞态说明与「修因不放宽 `ATTACHMENTS_CONTRAST_BUDGET=0`」声明。

### 验收

本地 9/9 门禁全绿：typecheck / lint（0 error）/ 全量单测 4087 用例 4086 通过 / build / check:budget（首屏 gzip 285.6982 KB，余 16.4 B）/ smoke / audit:a11y（0 项）/ audit:contrast（18 面 0 处）/ check:strict-idx（无新文件未判空）。

## 2026-11-07 · 修复：对比度审计补等颜色过渡，避免量到补间帧（32.4.1）

> 紧接 32.4.0 的次日修复。**产品代码零改动**：改的是审计脚本自己的采样判据 ——
> 它漏等了按钮文字色的 CSS 过渡，把补间中间帧当成终值量，于是 CI 报出一条本来
> 不该存在的对比度不合格。另一半是把上一版留下的 dash 周期注释口径写准
> （QA 逐度采样实测：`28.67 18.7` 是 2 段，不是手算的 3 段）。
>
> 32.4.1 首次推送时 CI 在「对比度审计」失败，**从未发布成功**：没有 tag、没有镜像、
> 没有部署。本轮有实质代码改动后由修复提交沿用该版本号（沿用 32.1.0 的先例），
> **不回退到 32.4.0** —— 那会覆盖已发布的 `v32.4.0` 镜像 tag；也不再 bump、
> 不跑 `script/bump-version.mjs`（会把版本顶到 32.4.2 / 32.5.0）。这是一次有意的例外。

### 改了什么

- **只改审计等待判据，产品代码零改动**：`script/contrast-audit.mjs` 的
  `waitAnimationsSettled()` 旧写法对 `CSSTransition` 判
  `transitionProperty === 'opacity'`，`color` / `background-color` / 边框色过渡
  一条都不等；现在**有限时长的过渡一律等**（`iterations === Infinity` 的装饰性
  无限动画仍排除），关键帧分支除 opacity 外也认颜色属性。改一处覆盖全部调用点，
  没有逐个打补丁。另外要求**连续两次**查到「没有在跑的动画」才返回，
  关掉「过渡晚一帧才起步」的竞态。
- **修因，不放宽门禁**：`ATTACHMENTS_CONTRAST_BUDGET = 0` 不动、4.5 的 AA 线不动、
  `src/index.css` 与 `src/components/AttachmentManager.tsx` 的配色不动、
  `script/auditEnv.mjs` 的测量数学与 `groupAlpha` 不动。
- **防回归守卫**：`tests/contrastScanner.test.ts` 新增一条（剥注释后）静态断言，
  钉住等待逻辑不能退化成「只认 opacity」；`tests/scriptSyntax.test.ts` 的用例数
  保持 35（本轮没新增 `script/*.mjs`）。
- **两处注释口径修正，产物零变更**：`index.html` 的 `.bs-spinner .bs-spinner-arc`
  与 `tests/spinnerUnified.test.ts` 补上 QA 的三臂实测（`28.67 86` → 1 段、
  `28.67 18.7` → 实测 2 段、`10 18.7` → 4 段）与「`ceil(周长/周期)` 只会多数、
  段数只能实测」的方法论；CSS 注释在构建时被剥掉，构建产物字节不变。

### 证据

- CI 失败样本：`4.46 / 需 4.5  13px  rgba(25, 117, 208, 0.973) on rgb(255,255,255)
  「清理」`（亮色·附件抽屉·无命中）。QA 在真 Chrome 逐帧抓到与日志逐字段一致的
  **t=64ms** 那一帧：`[data-attachment-action="prune"]` 的 computed color。
  终态 `rgb(25, 118, 210)` = **4.60**（达标）。
- 过渡来源 `src/index.css:1259-1262` 的 `.MuiButtonBase-root`：
  `color var(--dur-base) ease`，`--dur-base: 220ms`。逐帧：
  `14ms rgba(24,112,199,0.875)/4.02` → `31ms 0.918/4.23` → `48ms 0.95/4.35`
  → **`64ms 0.973/4.46`** → `113ms rgb(25,118,210)/4.60`。
- alpha 是 `s.color` **自身**带的（`script/auditEnv.mjs:866` 的 `fgA` 混白），
  祖先 opacity 乘积全程 = 1，`groupAlpha`（`:813`）没参与 —— 不是整组淡化误算。
- 受控实验：注入一条纯 `color` 600ms 过渡且没有 opacity 动画在跑，43 帧里
  `waitCount` 取值集合 = `{0}`，等待函数完全无感。

### 为什么本地绿、CI 红

**本地 `audit:contrast` 串行 10 次全绿不是「没问题」**：`DIV.MuiBackdrop-root` 的
opacity 淡入比 color 过渡晚停几十毫秒，恰好把等待撑过了危险窗口，是约 **34ms 的竞态**；
CI 上先后顺序一反转就扫到中间帧。无命中态是唯一「`b.click()` → 轮询
`[data-att-state="none-match"]`（150ms）→ `waitAnimationsSettled()` → `SCAN`」的路径，
缺 `scanHover` 那种 320ms 兜底；其余 17 面都经过 `openAttachmentsAndWait()`（200ms 轮询）
顺带把过渡跑完。所以验收标准是「0.973 帧不再被扫到」，不是「重跑一次 CI 变绿」。

## 2026-11-06 · 修复：把「两个转圈」统一成同一个环，全站只剩一份规格（32.4.0）

> 同一天的第四更，紧接 32.3.0。上一版把启动占位换成了 40px 圆环，但 React 侧那三处整页加载态
> 用的还是 MUI 的 `<CircularProgress>` —— 那是 SVG 弧线，**转的同时弧长还在伸缩**，
> 和启动占位那个静态 border 环完全是两种观感。两屏一前一后出现，用户看到的是「同一个等待被换了个动画」。
> 原话：**「两个转圈不一样统一一下」**。
>
> ⚠️ 这一版上线途中被 CI 的 `audit:perf` 拦下过一次，根因不是视觉而是**度量**：
> 第一版把环画成 CSS `border`，而 Chrome **不把纯 border 算作内容绘制** —— 于是 FCP 的锚点
> 没了，回访 FCP 从 148ms 跳到 504ms（超预算 4ms），冷启动 FCP 从 1904ms 跳到 3084ms。
> 最终改成**内联 `<svg>`**（SVG 算内容），FCP 锚点回到 JS 到达之前。详见下面「为什么是 SVG 不是 border」。

### 改了什么

- **全站只剩一处转圈规格**：`index.html` 文档头的 `.bs-spinner`
  （`40px` 外径 / `stroke-width: 3.5` / 轨道 `stroke-opacity: 0.22` / `0.9s linear infinite`）。
  关键在于它**故意不带作用域** —— 原来写的是 `#boot-skeleton .bs-spinner`，那样只有启动占位用得上，
  React 侧就必然得再写一份。现在启动占位的 `<svg class="bs-spinner">` 与 React 侧的
  `<svg class="bs-spinner" data-mode=…>` 是**同一个类名、同一份标记**，
  「两边数值漂开」在结构上不可能发生 —— 不再靠「两份规格 + 一条深层比对守卫」那种只能事后发现漂移的做法。
  两个 `<circle>`（`r=18.25`）+ 一个 `<g transform="rotate(-135 20 20)">`：`18.25×2 + 3.5 = 40`
  保证外径正好 40，转 -135° 让那 90° 的亮弧居中在 12 点钟、与旧 `border-top-color` 位置一致
  （减少动效时是静态帧，位置不同看得出来）。
- **新增 `src/components/Spinner.tsx`**：只干两件事 —— 给 `role='progressbar'` 让读屏知道在等，
  用 `data-mode={theme.palette.mode}` 告诉 CSS「当前是亮档还是暗档」。**它自己不带任何样式**
  （尺寸/颜色/边框/动画全在 `index.html` 那一条规则里），也没有 `aria-label`
  （调用方外层已有 `role=status` + 名字，两个可访问名会被读屏连念两遍）。
- **三处整页加载态换成 `<Spinner />`**：
  - `LoginScreen.tsx` 的 `isAuthChecking` 检查态（原 `size={60} thickness={4}`）
  - 同文件里登录页 lazy chunk 的 `Suspense` 兜底（原同样 60px）
  - `App.tsx` 的站点列表 loading（原默认 40px `CircularProgress`）

  前两处从 60px 收到 40px 是**有意的**：它要和启动占位接得上，两屏之间不能有大小跳变。
  已确认真 Chrome 里精确居中（容器中心 702、环中心 702），没有因尺寸变化塌陷。
- **`src/index.css` 与 HEAD 零 diff**：第一版曾把规格放进 CSS 包的 `.nh-spinner`，
  等于给同一件事写了第二份定义。现在整段删除 —— 规格只留在 `index.html`，
  因为那才是「HTML 一到就有东西可画」的位置（首帧不许等 JS，也不许等 CSS 包）。
  删掉那段还顺带把上一版多花的 0.15 KB gzip 全额还了回去。

### 颜色为什么不跟 `primary.main`（虽然那是最省事的写法）

`primary` 会被用户在「外观 → 强调色」里挑的颜色覆盖（`useThemeController.ts` 的 `primary:{main:accent}`），
而那个选择存在 `configs` 表里、**不在 localStorage** —— `index.html` 那枚环根本读不到。
一旦组件跟着 `primary` 走，用户换个主色，两边**又会不一样**，正是这次要治的病。
所以两档色值写死在 CSS 里：亮档 `#1976d2`（`var(--bs-brand, …)` 的兜底值）、
暗档 `#90caf9`（组件打 `data-mode="dark"` 现场覆盖）。启动占位在 `#boot-skeleton` 里继承那边的
`--bs-brand`，本来就不需要 `data-mode` 这条路。

### 真 Chrome 量化：逐项同值，不是「看起来一样」

用 `script/auditEnv.mjs` 的静态产物 + 只读 API 桩 + CDP。
⚠️ **`offsetWidth/offsetHeight` 在 `SVGElement` 上不存在**（Chrome 返回 `undefined`，这个属性只属于 `HTMLElement`）。
所以尺寸用两把尺子：`getComputedStyle(svg).width/height` + **`prefers-reduced-motion` 停转后的外接框**
（转着的时候 `getBoundingClientRect()` 量到的是旋转后的外接框，正方形转 θ = `40×(|cosθ|+|sinθ|)`，
实测会跳到 46.316 / 42.264，随采样相位变 —— 不是尺寸变了）。

| 属性 | 占位(亮) | React(亮) | 占位(暗) | React(暗) |
|---|---|---|---|---|
| `computed width×height` | `40px×40px`（停转外接框 40×40） | 同值 | 同值 | 同值 |
| `stroke`（亮那 90° 弧） | `rgb(25, 118, 210)` | 同值 | `rgb(144, 202, 249)` | 同值 |
| `stroke-opacity`（轨道） | `0.22` | 同值 | 同值 | 同值 |
| `stroke-width` / `stroke-dasharray` | `3.5px` / `28.67px, 86px` | 同值 | 同值 | 同值 |
| `r` / 弧偏移 | `18.25` / `rotate(-135 20 20)` | 同值 | 同值 | 同值 |
| `animation` | `bs-spin 0.9s linear infinite` | 同值 | 同值 | 同值 |
| 底色 | `rgb(255, 255, 255)` | — | `rgb(18, 18, 18)` | — |

**负向对照（决定这张表还算不算数）**：把构建产物里的选择器改回 `#boot-skeleton .bs-spinner`，
同一段探针再量 —— 占位环仍是 `40×40`（它本来就该有），但注入到 `#boot-skeleton` 之外的环
双双塌成 **`0×0`**（拿不到 `width/height`、`stroke-width` 回落 `1px`、`animation-name` 变 `none`）。
测量有区分力，上面那张表不是自我安慰。

登录检查态另外拿到了**端到端像素证据**：容器盒 `682..722`、容器中心 `702`、环中心 `702`，精确居中。

### ⭐ 为什么是 SVG 不是 border：一条只有引擎才告诉你的规则

第一版把环画成 CSS `border`（`border: 3.5px solid color-mix(…)` + `border-top-color`），
视觉上和 SVG 一模一样，但 CI 的 `audit:perf` 当场截住了：

| 版本 | 回访 FCP | 回访 LCP | 冷启动 FCP |
|---|---|---|---|
| 32.2.0 | 144 ms | 472 ms | 1876 ms |
| 32.3.0 | 148 ms | 520 ms | 1904 ms |
| 第一版（border） | **504 ms ✖**（预算 500） | 504 ms | **3084 ms** |
| **这一版（SVG）** | **120 ms**（本地实测） | 740 ms | **688 ms**（本地实测） |

**FCP 变差而 LCP 几乎不动**，这个组合的含义是「更早那次绘制不再被算作内容」。
两个受控实验（**都禁用脚本**，保证 React 永不挂载，页面上只剩启动占位）：

1. 直接跑真实构建产物：`performance.getEntriesByType("paint")` **只有 `first-paint`（44ms），
   没有 `first-contentful-paint`**。满屏底色和 border 环都画出来了，但都不算内容。
2. 三个 `data:` URL 页面做 A/B：**CSS border 环 → 只有 `first-paint`；内联 `<svg><circle>` →
   `first-paint` + `first-contentful-paint`；纯文本 → 两者都有**（对照组，证明测量环境没坏）。

结论：**Chrome 不把纯 CSS `border` 当成内容绘制，内联 SVG 算。**
32.3.0 的 FCP 锚点其实是 `LoginScreen` 那枚 MUI `CircularProgress`（它渲染的就是内联 `<svg>`）——
这一轮换成 border 环，锚点就消失了，FCP 只能干等真文本出现，于是与 LCP 重合。
**用户实际看到东西的时刻一点没变**，但冷启动回访两个 FCP 余量同时被吃掉。

顺带排掉两个错误假设（都用实验证伪了，记在这里免得下次再猜）：
- 不是底色：把 `--bs-bg` 从 `#ffffff` 改回 `#f7f8fa` 做相对 A/B，**820ms vs 840ms，没有区别**。
  底色对齐 MUI `background.default`（`#ffffff` / `#121212`，避免 React 接管那一帧跳浅一档）的改动因此保留。
- 不是载荷：冷启动传输 334 KB / 回访 4 KB，两版逐字节相同。

处理方式选的是**修因、不放宽门禁**：回访 FCP 预算仍是 500ms（按 `max(实测×1.7, 实测+300)` 定出来的），
没有为了变绿而放水。

> 附带收益：改成 SVG 之后 `stroke-width: 3.5` 在用户单位里就是 3.5，**不会再被 subpixel 取整成 3px**
> （旧 border 版本用 DevTools 量到的是 3px，得在注释里专门解释一句才不至于被当成漂移），
> 而且任意 DSF 下都抗锯齿渲染。

### 测试：先证明守卫抓得住，再说全绿

新增 `tests/spinnerUnified.test.ts`（8 条）、`tests/spinnerMode.dom.test.tsx`（2 条），
`tests/bootPlaceholder.test.ts` 与 `tests/appLoadingState.dom.test.tsx` 跟着改口径。
**变异测试跑了 16 条（M1~M16）+ 7 条补洞验证（V1~V7）+ 4 条 SVG 改造后的复验**，
其中四条一开始是**全绿的** —— 也就是「看起来守住了其实没有」，一并补掉：

| 洞 | 哪种回归会漏过去 | 补法 |
|---|---|---|
| **M13** | 往 `index.html` 尾部再写一条 `.bs-spinner{width:60px}`。层叠「后写的赢」，两枚环都变 60px，而「定义恰好一条」那条只数带 `width:40px` 的 | 改成**按规则头计数**（当时）；SVG 化之后选择器变多，再改为**数声明**：`stroke-width` / `stroke-opacity` / 作用于 `.bs-spinner` 的 `width` / `animation` 各恰好 1 次 |
| **M15** | 把登录检查态那枚 `<Spinner />` 整个删掉（整屏变成空白）—— 原来只断言「至少一处」 | **钉死处数**：LoginScreen 2 / App 1 |
| **M16** | 把 `data-boot-theme="light"` 档的 `--bs-brand` 改成任意色。旧断言只查「集合里出现过 `#1976d2`」，默认档给了就绿 —— 而占位已变黑环、React 侧还是蓝环，「两个转圈不一样」原样复活 | 四个档位（默认 / 存过亮色 / 系统深色 / 存过深色）**逐档与 React 侧的两个值对齐** |
| **V1~V5** | `Spinner.tsx` 里加回内联样式：`color:` / `backgroundColor:` / `borderTopColor:` / `borderRadius:` / `width:` —— 旧黑名单只有裸子串 `["width:","border:"]`，JSX 对象字面量是大驼峰，**全都漏网** | 换成按**属性名位置**匹配的前缀正则（`(?<![-\w])['"]?(color\|background\w*\|border\w*\|width\|…)\s*['"]?\s*:`），先剥注释再扫 |
| **V6** | 调用点给 `<Spinner />` 传 `sx={{ width: 60 }}` —— 处数正则确实会判红，但文案是「少了一处转圈」，会把人误导到错方向 | 补一条独立断言，文案点明「整页级转圈不许按屏定制尺寸/颜色」 |
| **S1** | `bootStyleBlock()` 原来只取**第一段** `<style>`。另起一段 `<style>.bs-spinner{width:60px}</style>` 是**会生效**的（层叠后写赢，两枚环当场变 60px），而八条断言全绿放过 | 改成**拼接全部 `<style>` 块**；无效变异（写在 `</style>` 之后的纯文本）仍然正确地保持绿 |

`V7` 是**反向验证**：往 `Spinner.tsx` 注释里塞 `color:` / `borderTopColor:` / `sx={{ width: 60 }}` 字样，
必须仍然全绿 —— 用来证明「剥注释」真的生效、黑名单不误伤说明性文字。实测 0 红。
另外单独验了正则本身的命中口径：该命中的 10 条全命中、不该命中的 11 条全不命中
（`prefers-color-scheme`、`--bs-brand: #1976d2`、`className?: string;`、`border 环` 这类都不撞）。

> 一处**测不到**的地方如实标注：`App.tsx` 列表 loading 那枚环拿不到端到端像素证据。
> 原因是 `useAccountSession` 与 `useSites.fetchData` 用的是同一个 `api.bootstrap()`，
> 扣住它只会停在 `isAuthChecking`（登录页那一屏），「已认证 + 站点还在飞」这个中间态在桩服务下不存在。
> 硬造就是假登录态，没做。它靠「同一组件的真机 40×40 + 注入测量」做几何代理，
> 加 jsdom 的 `appLoadingState.dom.test.tsx` 兜行为。

### 首屏预算

| | HEAD (32.3.0) | 这一版 (32.4.0) |
|---|---|---|
| 真实首屏 gzip | 285.56 KB | **285.69 KB** |
| 余量（预算 300 KB，5% 线 285.714 KB） | 5.05% | **5.009%** |
| `index.css` 产物 | `24.90 / 6.00`（文件名 `index-CoLXDYiS.css`） | **同文件名同哈希**（与 HEAD 零 diff） |

⚠️ **余量已经很脆**，而且这条线自己在抖：连跑 5 次 `npm run build`，入口 chunk 每次哈希都不同
（`DqEBsuBi → YoKSSq4S → B-hOk-IF → C4kG4Arx → 7o1H-26u`，gzip 在 285.6885~285.7051 之间），
余量 5.003%~5.009%。`mui-core` 与 `index-*.css` 五次 md5 完全一致，所以抖的是入口 ——
字节级 diff 定位到 `__vite__mapDeps` 里内联了某个懒块的**文件名**，而那个懒块
（`NavigationCenterDialog`）自身每次构建哈希不同。**这是既有账、与本次无关，但它意味着
再往首屏加任何一个字节都可能直接踩线。**

> 顺带查清两笔旧账：
> 1. 删掉 `App.tsx` / `LoginScreen.tsx` 的 `CircularProgress` 静态 import **不会**让那坨代码
>    离开首屏包。`mui-core` 三次构建同哈希，`MuiCircularProgress` 仍在里面 ——
>    因为 `vite.config.ts` 的 `scanFirstScreenMui()` 按「首屏闭包」归桶，而 `LoginForm.tsx`
>    还有三处行内 `size={24}` 的按钮 loading。要退得单独动闭包口径。
> 2. 上面那条哈希抖动同样得动 `vite.config.ts`。两件事本轮都没做 —— 它们跟「统一转圈」无关，
>    硬塞进来只会把回归面糊成一片。

## 2026-11-06 · 修复：弱网启动不再先闪一屏假卡片骨架，全程只留一个转圈（32.3.0）

> 同一天的第三更。用户弱网打开站点，先看到一整屏**假卡片**（`index.html` 里那段纯 CSS
> 启动骨架画的）、再跳成转圈、再跳成真卡片 —— 三次形态跳变，每次都像「已经快好了」其实没到。
> 原话：**「网络不好时打开网站先显示这个界面再显示转圈，不要显示这个界面」**。

### 改了什么

- **`index.html` 的启动占位**：从「顶栏 + 两组各 5 张卡片占位 + 扫光动画」换成**居中 40px 圆环**
  （`.bs-spinner`，`border-top-color` 上色 + `0.9s linear infinite` 旋转）。
  一次性删掉 `.bs-bar / .bs-dot / .bs-search / .bs-title / .bs-grid / .bs-card / .bs-shimmer`
  与 `bs-sweep` 关键帧，`--bs-surface` / `--bs-line` 两个只被骨架用到的变量一起删。
  保留的部分一个没少：底色 `--bs-bg`（避免白屏是它存在的唯一理由）、
  `prefers-color-scheme` + `html[data-boot-theme]` 两套主题覆盖、`prefers-reduced-motion` 停转。
- **`src/App.tsx` 的列表加载态**：`<ChunkBoundary><SiteListSkeleton /></ChunkBoundary>`
  → `<Box role='status' aria-label='正在加载站点'><CircularProgress /></Box>`。
  `error → loading → 列表` 的优先级没动（error 仍排最前，理由写在原地）。
- **删掉 `src/components/SiteListSkeleton.tsx`** 及其 `lazy()` 声明、`dialogChunks.siteSkeleton`
  预取条目、`tests/lazyPrefetch` 里的 key —— 它已经没人渲染了，留着就是死代码。
- 两侧尺寸/节奏对齐（40px / 0.9s 线性 = MUI `CircularProgress` 默认值），
  所以「HTML 圆环 → React 圆环」接续处看不出换了执行者。

### ⚠️ 一个 id 的坑：名字还叫 `boot-skeleton`，但它已经不是骨架

`public/boot-guard.js` 的 `SKELETON_ID = "boot-skeleton"` 靠这个 id 判「React 到底挂没挂载」
（15 秒后还能 `getElementById` 到它 = 主模块没执行 → 清 Cache Storage + 注销 SW + 刷新一次），
`src/main.tsx:145` 的 `requestAnimationFrame` 也按同一个 id 删节点。**改名会同时打断这两条自救链路**，
所以 id 原样保留，只在注释里写清「别按字面理解」。`tests/bootPlaceholder.test.ts` 第 1 条钉着
这层三方一致（HTML 的 id ↔ boot-guard 的常量 ↔ main.tsx 的 getElementById）。

### 真 Chrome 弱网实测（不是单测，也不是推算）

用 `script/auditEnv.mjs` 的静态产物 + 只读 API 桩 + CDP，`Fetch.enable` 精确按住
`*assets/index-*.js` 与 `*api/bootstrap*`（**必须先 `Network.setBypassServiceWorker(true)` +
`setCacheDisabled(true)`**，否则第二次导航命中内存缓存 / SW，请求根本拦不到 —— 第一版探针就是这么假失败的）。

| 采样 | 假卡片节点数 | `#boot-skeleton` | `.bs-spinner` | 底色 |
|---|---|---|---|---|
| 566ms | **0** | 在 | 40×40 | `rgb(247,248,250)` |
| 1567ms | **0** | 在 | 40×40 | 同上 |
| 3077ms | **0** | 在 | 40×40 | 同上 |

暗色（`Emulation.setEmulatedMedia`）底色 `rgb(18,22,28)`、环 `#90caf9`；
`prefers-reduced-motion: reduce` 下 `animationName = none`（静止圆环）。
`document.elementFromPoint(视口中心)` 命中的是 `.bs-spinner` —— 转圈在最上层，没有别的东西挡着。

**注水后的真实形态链**（每 ~100ms 采样）：`40px 静态环 → 60px MUI 环（登录页 checking 态）→ 内容`，
全程假卡片恒 0，也没有出现「既无转圈又无内容」的帧（占位在 `#root` 内，`createRoot` 首次提交
清空容器与插入 LoginScreen 是同一次提交）。

> 顺带纠正一个容易看错的地方：冷启动时**列表的 loading 分支其实永远看不到** ——
> `App.tsx` 的 `isAuthChecking` 门控会先渲染登录页的 checking 转圈，bootstrap 回来后才轮到列表区。
> 它只在「重试 / 刷新 / 缓存已垫底后的静默刷新」出现，新 dom 用例正是走「错误面板 → 重试」这条真实可达路径。

### 顺手修掉的一处像素缺陷

旧骨架的 `padding: 20px 20px 40px`（给卡片网格留底部空隙）在换成 flex 居中后把圆环顶高了
`(40−20)/2 = 10px`。真 Chrome 实测 `dy = −10.00`，改成 `padding: 20px` 后 `dy = 0.00`。
（横向那个 `dx = −5` 是假象：`position:fixed;inset:0` 的参照盒宽 1404 而非 1414，
隐藏滚动条留了 10px 槽，以真实包含块为准横向正好 0。）

### 测试：先证明它抓得住，再说全绿

- 新增 `tests/bootPlaceholder.test.ts`（4 条，静态读 `index.html`）：钉 id + `aria-hidden` +
  `main.tsx` 的 `getElementById`；钉 `.bs-card/.bs-bar/.bs-title/.bs-shimmer/…` **不许回潮**；
  钉 `.bs-spinner` + `bs-spin` + 40px + `0.9s linear infinite` + flex 居中 + `--bs-bg` 底色；
  钉主题与减动效四条覆盖。
- 新增 `tests/appLoadingState.dom.test.tsx`（1 条，**真渲染 App**）：bootstrap 先 500 → 错误面板 →
  点重试让 bootstrap 挂住 → 断言 `[role=status][aria-label=正在加载站点]` 在、`.MuiSkeleton-root` 为 **0**、
  里面真的是 `[role=progressbar]` → 放行 → 断言转圈退场且分组与站点都渲染出来。
- QA 5 处变异：M1 塞回假卡片 → 红 2 条；M2 改 id → `bootPlaceholder` 3/4 红；
  M3 整段回退成 `SiteListSkeleton` → 红（在 `pollUntil` 超时）；**M3b** 保留 `role=status` 但里面画骨架
  → 精确红在骨架那条（`12 !== 0`，12 = 2 组 ×（1 标题 + 5 卡片）），证明那条断言是活的；
  M4 删 `aria-label` / M5 删 `role` → 各红 1 条。
- **挖出一个真缺口（已知、暂不修）**：`tests/bootGuard.test.ts` **抓不到** `index.html` 的 id 改名 ——
  它用 `vm` 把 `boot-guard.js` 跑在假 DOM 上，`getElementById` 只在 `id === "boot-skeleton"` 时返回对象，
  依赖的是**脚本里的常量**而不是 HTML。目前由 `bootPlaceholder.test.ts` 顶着，两边一致有守卫。

### 门禁

`typecheck` 0 error / `eslint` **0 error（26 存量 warning，无新增）** /
全量单测 **4075 tests / 4074 pass / 0 fail / 1 skipped**（skip 是 Windows 软链 `EPERM` 的老问题）/
`build` ✓ / **首屏 gzip 285.56 KB（预算 300，余量 5.06%）** / 首屏 raw 866.68 KB（预算 920）/
index chunk raw 256.65 KB（预算 270）/ smoke ✓ /
`audit:a11y` 0 项不合格（新增的 `role=status` 既没被算成未命名元素，也不在可点判据里）/
`audit:contrast` 亮暗各 0 处 / `check:strict-idx` 366 处 62 文件、豁免 62（两个新测试在 `tests/` 下，
不在严格层范围，守卫范围没变）/ `check:brand` 三处一致。

**首屏反而小了 0.08 KB**：`CircularProgress` 本来就在首屏的 `mui-core` 块里
（产物里 `MuiCircularProgress` 在 index 块 0 次、mui-core 块 7 次，而 mui-core 是 `index.html`
里 `modulepreload` 的首屏块），所以新增 import 不把 MUI 拉进 index、也不新增请求；
同时删掉骨架组件的 lazy 声明与预取条目又省了一点，净下来是负的。

`audit:visual` 本轮**没跑**（观察期、CI 上也是 `continue-on-error`），**未**执行 `--update`：
启动占位从骨架换成圆环、加载态从骨架换成转圈，像素差异是预期的。

### 已知可接受（如实记）

1. **40px → 60px 的尺寸跳变**：`LoginScreen.tsx:87` 的 checking 态是 `CircularProgress size={60}`，
   弱网下会停留在 60px 数秒。要彻底不跳就得改那一处，本次没动（登录页的 60px 是既有设计）。
2. **底色微跳**：占位 `#f7f8fa` → React 亮色 `background.default` = `#ffffff`（7/255 的差，肉眼几乎看不出）；
   暗色 `#12161c` vs `#121212` 同理。
3. **首屏 gzip 距 5% 余量线只剩 0.15 KB**：这是门禁设计意图，下次任何首屏新增都会红 ——
   **别去抬预算**，走「合并两个 ErrorBoundary / 拆 clientMethods」那两条旧账。
4. `boot-guard.js` 的 15 秒自救**没有**在真浏览器里跑过（要挂 15s+ 且要可控的 chunk 404）：
   本次只换了占位内容、id 未变，机制不依赖内容，单测覆盖 6 条分支。

## 2026-11-06 · 修复：复制胶囊的入口从下拉里提出来、直接摆在工具栏上（32.2.0）

> 同一天的第二更，只改**入口位置**，语法与渲染一个字没动。上一版（32.1.0）为了省宽度，
> 把「复制胶囊」收进了两个下拉菜单；用户看完直接说「给这个按键做个图标直接放在工具栏，
> 不要放下拉菜单」。于是 32.1.0 里那句「**没有**做成第一排常驻按钮（第一排宽度在 320px
> 档是硬约束）」被推翻 —— 代价在下面「代价」一节写清了，不粉饰。

### 改了什么

- **删两处下拉入口**：窄屏「插入」`+` 菜单里的 `insertItem("clip-chip", …)`、桌面
  「笔记工具」菜单里 `data-insert-op='clip-chip'` 的 `MenuItem`，两处一起删。
- **加一颗常驻图标按钮**：`aria-label='复制胶囊'` / `data-tool='clip-chip'` /
  `ContentCopyIcon`，**无条件渲染**（窄屏也直接可见，不用点开任何菜单）；写法与「链接」
  那颗逐字同构 —— `size='small'` + `sx={toolBtnSx}` + `onMouseDown={e => e.preventDefault()}`。
- 位置落在「笔记工具」右边（等于把菜单项就地提升成兄弟按钮）；窄屏落在「插入」`+` 之后。
- **入口只有这一处**。测试钉了「工具栏上正好 1 颗」+「两个菜单里都没有」——
  同名两个按钮干同一件事会被读屏念两遍（2026-10 在「块」按钮上踩过）。

### 那个 `onMouseDown` 为什么不能省

点按钮会让编辑器失焦、选区塌掉，`insertAtCursor` 就拿不到要包的那段文字 —— 功能直接废。
工具栏其余二十几颗按钮都写了这行，新按钮照抄。

⚠️ jsdom 的 `.click()` **不派发 mousedown**，所以「把这一行删掉」的变异在单测里是**全绿**的
（QA 实测：37/37 绿）。已补一条用例显式
`dispatchEvent(new MouseEvent('mousedown', {cancelable:true}))` 再断言 `defaultPrevented === true`。
**「选区真的还在」那一半 jsdom 测不出来**，只能靠真机；风险低（写法与其余按钮逐字相同），
如实记在这里。

### 代价：手机上工具栏从 1 行变 2 行

真 Chrome + CDP 实测（静态产物 + 只读 API 桩，390 / 320 / 1440 三档）：

| 视口 | 改造后 | 改造前（同一页面把新按钮 `display:none` 的 A/B 对照） |
|---|---|---|
| 390 | 79px、**2 行** | 41px、1 行 |
| 320 | 79px、2 行 | 79px、2 行（**改造前就是 2 行，非本次引入**） |
| 1440 | 36px、1 行、23 颗 | 36px、1 行 |

- 判定：验收口径是「≤2 行」，**这次仍在口径内通过**；但 390 档多占 38px 编辑区是实打实的代价。
- **算术一开始算错了**：注释按 28px/颗推，结论是「390 仍 1 行、余量 43px」。实测才发现
  `<600px` 时 `MQ_BELOW_600` 把每颗 `IconButton` 抬到 **36×36**
  （`src/hooks/useThemeController.ts:198-204`），真实第一行 **398px > 390** 才换的行。
  注释已按实测重写（含 36px 口径与三档结论），以后别照 28px 记账。
- **这条宽度预算已经用满**：窄屏再加任何一颗按钮就会折 3 行。真要继续加，先把低频入口
  并进下拉 —— **不要**退回 `overflowX:auto`（那会把竖向滚动条一起逼出来，2026-10-07 踩过）。
- 另一条备选（本轮**没做**）：只在宽屏摆工具栏、窄屏仍收进下拉。用户要的就是
  「不要放下拉菜单」，所以没这么办；那是产品决定，不是实现细节。

### 测试与门禁

QA 独立验收（不是复跑工程师的活儿）：

- **变异测试 6 处，挖出 2 条真实覆盖漏洞**：① 删掉 `onMouseDown` → 37 条全绿；
  ② 只守住桌面菜单，往窄屏「插入」菜单再塞一份 → 也全绿（窄屏那份 `insertItem` 挂的是
  `data-tool` 而不是 `data-insert-op`，又 portal 到 body、不在 toolbar 节点内，三条断言全碰不到）。
  两条都已补用例，补完重做变异精确变红。
- 其余 4 处变异（改 `aria-label` / 整颗挪回菜单 / 桌面菜单再补一份 / 删 `data-tool`）都有保护。
- `typecheck` 0 error / `eslint` **0 error（26 条存量 warning）** / 全量单测
  **4071 tests / 4070 pass / 0 fail / 1 skipped** / `build` ✓ /
  **首屏 gzip 285.63 KB（预算 300，余量 5.03%）** / index chunk raw 256.8 KB（预算 270）/
  smoke ✓ / `audit:a11y` **0 项不合格**（未命名按钮 0、<24px 目标 0；新按钮在 390/320 实测
  36×36、1440 下 28×28）/ `audit:contrast` 亮暗各 0 处 /
  `check:strict-idx` **366 处 62 文件、豁免 62（上限 63）不退化** / `check:brand` 三处一致。
- `audit:visual` 本轮**没跑**（观察期、基线在开发机录的、CI 上也是 `continue-on-error`）：
  工具栏多一颗按钮的像素差异属于预期，没有 `--update`。
- `script/ui-probe.mjs` 本身**跑不起来**（卡在「备份面板内容」超时，停在脚本 399 行；
  该脚本最后一次改动是 2026-10-31，与本次无关）。几何数据改用一次性等价探针
  （同一套 `auditEnv.mjs` + CDP）量，探针**没有**进仓库。
- 文档在 390 档有 56px 竖向溢出、320 档 144px —— A/B 对照显示改造前后**数字完全相同**，
  是存量问题，与本次无关。

## 2026-11-06 · 新增：笔记「行内复制胶囊」——选中一段文字，点一下就能复制（32.1.0）

> **和昨天的 32.0.0 是什么关系**：32.0.0 刚把 `> [!COPY]` **块级**复制块连同语法、
> 存量标记一起删干净。这次是**形态完全不同的新东西**：行内、零占地、只包一段短文本，
> 没有块结构、没有片段自动识别、没有整块复制按钮。不是「换个名字装回来」——
> `tests/copyBlockRemoved.test.ts` 那个全仓静态守卫**一个字没改**，仍然 5/5 绿，
> 也专门做过灵敏度验证（往 `src/` 塞 `md-copy-frag` / `COPY` 会立刻红）。
> 新代码全程绕开守卫盯的那几个标识符（`ClipChipNode` / `clip_chip` / `md-clip-*` /
> `onInsertCopyChip`），所以「旧复制块被顺手贴回来」依然会被拦住。

### 用户要的是什么

> 我需要的是一个按键，行内内容选择点击按键后实现图中胶囊效果可以直接点击复制

配图是一枚混排在正文里的**虚线圆角胶囊**：等宽字、浅紫底、`⧉` 尾标，点一下复制、
变成翠绿打勾，图注特意写了「混排在正文中醒目且**不破坏行高**」。链路是
**选中行内文字 → 点工具栏按钮 → 包成语法 → 预览/阅读/分享页渲染成胶囊 → 点胶囊直接复制**。
（选型时确认过不是「一次性按钮动作」，是要**持久化在笔记里**的形态。）

### 改了什么

- **语法 `{{clip:内容}}`**。定界符是逐条 grep 过 `src/` 与 `docs/` 之后挑的：
  `` `行内代码` `` / `==高亮==` / `$…$` `\(…\)` `$$…$$` / `#标签` / `[[双链]]`
  `![[嵌入]]` `![[块引用]]` / `%%隐藏注释%%` / `> [!NOTE|TIP|…|FOLD]` / `:::tabs` / `---`
  全都已占用，而 `{{` 在 `src/` 里只出现在 JSX 对象字面量（`sx={{…}}`），笔记语法里一处没有。
  规则排在 markdown-it `escape` 之后：不跨行、第一处 `}}` 闭合、内容全空白不认、被 `\` 转义不认、
  未闭合不吞后面的正文。**内容按纯文本渲染**（不支持嵌套），这样「看到的」和「复制出去的」
  严格一致 —— 支持嵌套反而会造出「看到粗体、复制出星号」的错觉。

- **工具栏**：`markdownToolbar` → `NotesEditorPane` / `NotesSidePane` → `notesPageCtx` →
  `useEditorTools` 加一条 `onInsertCopyChip`。**复用既有 `insertAtCursor(before, after, placeholder)`**，
  于是「二次点击摘掉格式」「`lastInsertRef` 撤销记忆」「没选区时落占位符」全部自动继承，
  和加粗 / `==高亮==` / 行内公式走同一条路，没有另发明机制。桌面进「笔记工具」下拉，
  窄屏进「插入」下拉；**没有**做成第一排常驻按钮（第一排宽度在 320px 档是硬约束）。

- **渲染**：`src/utils/ClipChipNode.tsx` 单独成文件（塞进 `markdownToReact.tsx` 会新增一条
  `react-refresh/only-export-components` 警告）。`role=button` + `tabIndex=0` +
  `aria-label="复制：<内容>"`，Enter / Space 都触发；尾部 `⧉`/`✓` 带 `aria-hidden` 与
  `user-select: none`，不会被读屏念、也不会混进 Ctrl+A 的选区。
  点击走现成的 `utils/clipboard.ts`（含非安全上下文 `execCommand` 回落），成功进 1.2 秒
  已复制态再复原，失败**不伪造成功态**也不排定时器；连点先清旧定时器，卸载时清理。
  三处共享同一份渲染：编辑器实时预览 / 阅读态 / **公开分享页**，所以刻意不接 `onNotify`
  之类页面上下文，分享页点一下不会抛错。

- **不破坏行高**：`display: inline` + `lineHeight: inherit`。这是 31.0.0 踩过的坑 ——
  那次用 `inline-block`，胶囊自带盒高把整段行距顶开、版面被用户当场退回。
  真 Chrome 用等文本夹具量过：1.5 / 1.6 / 1.7 / 2.0 四档行高下，含胶囊与不含胶囊的段落
  **高度差都是 0.00 px**（1.7 档都是 108.75 px）；把同一夹具改成 `inline-block` 立刻变高，
  证明这套测量确实抓得住顶开行高。

### 配色：两处**刻意不照抄**截图

截图给的已复制态前景 `#059669` on `#ecfdf5` 实测只有 **3.58:1**，边框 `#a5b4fc`
贴纸面只有 **1.96:1** —— 按小字号 4.5:1 / UI 边界 3:1 都**真不达标**。
数学用的是项目唯一那份 `script/auditEnv.mjs` 的 `CONTRAST_CORE`，亮暗两态都算过：

| 态 | 前景 / 底 | 实测 | 判 |
|---|---|---|---|
| 亮·静止 | `#4f46e5` / `#eef2ff` | **5.62:1** | ✅ 截图原值 |
| 亮·已复制 | `#047857` / `#ecfdf5` | **5.21:1** | ✅ 压深一档 |
| 暗·静止 | `#c7d2fe` / `#312e81` | **7.66:1** | ✅ |
| 暗·已复制 | `#a7f3d0` / `#064e3b` | **7.58:1** | ✅ |

边框也从 `#a5b4fc` 换成 `#6366f1`（亮）/ `#818cf8`（暗）：胶囊底与纸面几乎同色
（亮 1.12:1、暗 1.44:1），边界全靠这条虚线撑着，淡到看不见就等于胶囊消失。
四处边框按 3:1 判也全过（4.47 / 3.77 / 5.50 / 8.54）。

⚠️ **但 `audit:contrast` 与 `audit:a11y` 的「0 处不合格」对这套配色不构成证据**。
审计的种子笔记正文里**一个 `{{clip:` 都没有**，脚本也从不往编辑器里插文字，
所以页面上根本没有胶囊可扫 —— 与 31.0.0 那次是同一个「假绿」结构。
这次改用单测直接钉 `aria-label`，配色则读 `src/index.css` 的实际 token 用上面那份数学手算。
**没有往种子里加胶囊**：同一份种子同时喂 `audit:visual`，加进去会造出一大片新基线漂移
（观察期里那 10 处已知漂移还没查完，跑 `--update` 会把它们一起烧进基线）。

### 纯文本降级（三条出口，本轮还修了一处判据不一致）

胶囊在「用户要把正文抄走」的三条路径上都只留内容、不带定界符：分享页「复制为 Markdown」、
笔记导出（`.md` 与导出 HTML 共用的 `buildNoteMarkdown`）、阅读态 Ctrl+A（靠 `user-select:none`
的字形 + 纯文本节点天然只带内容）。粘贴回编辑器时 `htmlToMarkdown` 主动丢掉尾部字形节点。

QA 用变异挖出一处真实的数据变形：`\{{clip:甲}}` 在预览里被 `escape` 吃掉反斜杠、
显示字面量 `{{clip:甲}}`，而降级正则直接跑在原文上会摘掉定界符留下 `\甲`。
本轮**按反斜杠奇偶模拟 escape** 对齐了两条链路：奇数枚时去掉转义反斜杠、整段原样保留；
偶数枚时反斜杠是字面量、胶囊照常降级。范围只限「胶囊开标记被转义」这一种情形，
没有把降级函数重写成半个 Markdown 解析器。

### 测试：先补覆盖缺口，再说全绿

新增 `tests/markdownClipChip.test.ts`（26 条）+ `tests/markdownClipChip.dom.test.tsx`（10 条）。
QA 独立复现后做了 **12 处变异**，挖出 3 条**测试没钉住**的缺口（源码写对了）：
① 把 `state.pos = end + 2` 改成不吃掉 `}}`，76 条全绿 → 补「文本恰为 `前后`、只 1 个 token」；
② 分享页去掉降级，90 条 0 红 → 补「复制入参不含 `{{clip`」；
③ 导出去掉降级，工程师两份测试一条没红 → 补 `buildNoteMarkdown` 降级断言。
这三条固化后重做变异，全部精确红在新断言上（M3/E1 各顺带红 2 条，如实记）。
QA 另有 **44 条独立探针**（表格 / 标题 / 列表 / 引用 / 围栏 / 缩进代码 / 相邻胶囊 /
未闭合 / 转义 / CRLF / 真 Chrome 选区 / 可访问名 / 点击副作用 250ms 后正文不变 /
连点 / 卸载定时器 / 复制失败）全部通过；探针是一次性验证工具，放在仓库外，
**没有**混进本次提交。

### 门禁

`typecheck` 0 error / `eslint` **0 error（26 存量 warning，未新增）** /
单测 **4067 tests / 4066 pass / 0 fail / 1 skipped**（唯一 skip 是 `uptimeCheck` 的
Windows 软链 `EPERM`，CI 上会跑）/ `build` ✓ / **budget 37/37** / smoke 46 PASS。
首屏 gzip **285.52 → 285.62 KB（+0.10 KB）**，预算 920 / 300 **未抬**，
JS 首屏 0 增长（语法与组件落在懒加载的 markdown chunk），增量几乎全在 `index.css` 那 6 个 token。

⚠️ **本地门禁清单漏了一道 CI 独有的 `check:strict-idx`（Q-3 严格下标守卫）**。
它在 `noUncheckedIndexedAccess` 下扫全量 `src/`，要求**新文件默认干净**。
首次推送后 CI 的「静态检查」job 就是它拦下的：`clipChipsToPlainText` 的围栏
状态机里有 3 处 `fenceMatch[1]` 未判空（TS2532 ×2 / TS2322），`docker-publish`
被 gate 连带拦下（build / merge 全 skipped，**没有产生坏镜像**）。已改成判过空的
局部变量 + `charAt(0)`，围栏闭合语义用 21 组输入与旧实现逐字节比对过（0 处不一致）；
修完严格层报错 **366 处 / 62 个文件**、豁免清单仍 **62 条**、新文件 0 报错。
**这道守卫已补进本地全量门禁清单** —— 以后不许再只跑那 8 项就宣称全绿。

### 这次**没有**解决什么（别当成已经治好了）

- **不支持嵌套**：`=={{clip:x}}==`、`` `{{clip:x}}` ``、`[[{{clip:x}}]]`、`${{clip:x}}$`
  里的都不生效（那些规则各自吞掉整段，行内链不二次扫描）。方向钉住了「别人不被误伤」，
  但胶囊在这些位置不生效。
- **没有在产品页面里亲眼看到过一枚胶囊**：种子笔记没有胶囊，整页审计 / smoke 都不会渲染它；
  只在真 Chrome 夹具里核过 `computed style` 与选区。真机观感、工具栏下拉的实际排列与溢出
  仍需人眼看一眼。
- **复制失败静默复原**：`RenderContext` 里没有 `onNotify` 通道，为保分享页不报错选了不提示。
- **源码区 CodeMirror 仍是 `{{clip:…}}` 原文**，只有预览/阅读/分享渲染成胶囊；
  要源码里也看到胶囊得给 CM 加 decoration，本轮没做。
- **导出 `.md` 走降级 → 导回来不再是胶囊**（需求是「输出内容本身」，代价是不能 round-trip）。
  备份/还原走数据库原始正文，不受影响。
- 转义对齐只覆盖了胶囊开标记一种；`\{ {{clip:甲}}` 这类组合的预览字面与纯文本输出仍有
  **既有差异**（`{ 甲` vs `\{ 甲`），按「别借机重构」没修。
- `e2e:cron` 本机 workerd 起不来（Windows access violation），只能 CI 验。
- 昨天的尾巴仍在：视觉基线 10 处漂移（观察期到 2026-12-31，**别跑 `--update`**）、
  dom 测试里 33 处 `assert.equal(DOM元素, null)` 同型写法（OOM 隐患）、首屏 gzip 余量贴线。

### 部署

纯前端改动，**没有数据库迁移、没有 `SCHEMA_VERSION` 变化、没有 `docker-compose.yml` /
`deploy/upgrader/` 变更**，常规 pull + recreate navihive 即可；升级前的库备份不是本次必需项。

## 2026-11-05 · 重构 + 修复：复制块整体下线并清洗存量数据 + 编辑器中文输入不再吃拼音（32.0.0）

> **关于这个 major**：`script/bump-version.mjs` 按 `git diff --cached` 判的（24 文件 / 3131 行，
> 文件数和行数**同时**超过 minor 线 20 / 1200）。和 31.0.0 那次「纯行数口径、对外零行为变化」
> 不同，**这次是真的有不兼容变化**：`> [!COPY]` 语法从解析器里删掉了，旧笔记里的标记由一次
> 库迁移洗掉，`SCHEMA_VERSION` 从 29 升到 30。混版本跑会看到不同语义，major 名副其实。
>
> 行数构成：`src/` 11 文件 1039 行（459 增 / 580 删）、`tests/` 12 文件 2081 行、
> `script/auditEnv.d.mts` 删除 11 行。其中新增测试 941 行（4 个文件）、删除测试 807 行
> （3 个文件）—— 复制块的**全部**专属测试被整体替换，不是「跑绿了留着」。

### 用户要的是什么

31.0.0 刚把复制块改成「块内每个反引号片段各自可复制」的方案三，用户看完的反馈是：

> 笔记中跟复制按键有关的内容全删干净

不是再改一版，是**删掉**。此前同一个功能已经改过两轮（常驻胶囊 → 行内虚线段），
第三轮仍然不满意，结论就是「这个功能不要了」。同时另有一个真 Bug 在等：**中文输入法
打拼音会把拼音吃掉**（输入 `nihao` 结果正文里是半截 `ni`，甚至整段被替换）。

两条线的边界我在动手前跟用户确认过，不是自己猜的：

1. **只清复制块（`> [!COPY]`）的残留**。笔记里还有一堆**同名但是老功能**的复制入口 ——
   复制标题、复制直链（`NotesOverlayLayer` 里的 `copy-title` / `copy-link`，`7bab981`
   起就有）、分享面板的「复制分享链接」、公开笔记页的「复制为 Markdown」、站点卡片的复制 ——
   **全部保留**。「全删干净」如果按字面执行，会把这些一起带走。
2. **迁移只删标记行，正文其余一字不动**。不做「把 `> [!COPY]` 块降级成普通引用」这种
   聪明的改写 —— 那会动用户的缩进和空行，属于替用户重写笔记。

### 改了什么

**一、移除复制块（前端）**

- 工具栏「插入 → 复制块」菜单项、`ContentCopyIcon` 引用、`onInsertCopyBlock` 整条回调链
  （`markdownToolbar` → `NotesEditorPane` → `NotesSidePanel` → `notesPageCtx` → `useEditorTools`）
  连根删掉，不留 `@deprecated` 空壳。
- 渲染层的片段级复制单元、整块复制按钮、悬停气泡、`md-copy-*` 样式全部删除
  （`index.css` **净删 204 行**，`markdownToReact.tsx` 净删 237 行）。
- `buildCopyBlockSource()` 从 `noteBlocks.ts` 删掉。
- **`"COPY"` 从 `CALLOUT_TYPES` 联合类型里移除**，同时删 `CALLOUT_STYLE.COPY`。
  这两处**必须同改**：只删 `CALLOUT_STYLE.COPY` → `Record<CalloutType, …>` 少一个键，tsc 报错；
  只删枚举 → 对象字面量多出一个未知属性，tsc 也报错。两边一起改，`tsc` 才会干净。
- 删掉之后旧笔记里的 `> [!COPY]` 会怎样？`parseCalloutType` 对未知类型**返回 `null`**
  （`markdownCallout.ts:56-63`），`takeMarker` 于是 `return null`，标记作为普通文字留在正文，
  那块退化成一条普通 `blockquote`。**这是接受的降级形态**：内容一个字不丢，只是不再特殊渲染。
  两条测试显式钉住了这个代价（`text.includes("[!COPY]") === true`），防止有人以为它「干净消失」了。
- 移除枚举后我在 `CALLOUT_TYPES` 上方留了守卫注释：**不要加回 `"COPY"`**，
  等于把已下线功能死灰复燃；真要加，得连迁移一起反向设计。

**二、清洗存量数据（库迁移）**

新迁移步骤 `notes-copy-callout-marker`（`MIGRATION_STEPS` 第 21 条，排在 `indexes` 之后）：

- `SCHEMA_VERSION` 29 → 30，`STEPS_AT_V30 = 21` / `INDEXES_AT_V30 = 26` 两个锚点同步跟，
  `SCHEMA_DELTA` 必须为 0。**升号不是仪式**：已部署库里 `configs.schema.version` 存的是 `"29"`，
  不升号 `migrateIfNeeded` 直接 return，脏数据一条都洗不掉。
- 判据是纯函数 `stripCopyCalloutMarkers(content: string): string`（逐行、可单测、可复用）。
  它认两种形态：
  - **整行只有标记**（`> [!COPY]` 独占一行）→ 整行丢掉；
  - **前缀形态**（`> [!COPY] 正文`）→ 只摘标记，留下 `> 正文`。
    第二种 spec 里没写，是实现时发现的必要分支 —— 早期版本允许同行写正文，
    只处理第一种会把 `[!COPY]` 字样留在行首。
- 快路径：`if (!/\[!copy\]/i.test(content)) return content;` —— 绝大多数笔记不含标记，
  一次正则就返回，不进逐行循环。
- **围栏保护**：以 ``` / ~~~ 开头的行翻转状态，围栏内的"标记行"不动。
  因为代码块里的 `[!COPY]` 是**示例文本**，删掉就是在改代码示例。
- `notes` 写回是 `UPDATE notes SET content = ?, rev = rev + 1 WHERE id = ?`：
  **`rev+1` 必须要有** —— 别的设备手里那份带 `[!COPY]` 的缓存靠 rev 判新旧，
  不 +1 它永远不会失效，用户会一直看到脏正文，还会用旧 rev 把脏数据写回来。
  **`updated_at` 一字未动** —— 它决定笔记列表的排序，动它等于替用户重排笔记，纯副作用零收益。
- **下游两张表必须跟着改**，否则搜索和回收站会各留一处脏数据：
  - `notes_fts.body` 存的是 `segmentCJK()` 分词后的文本（汉字两侧带空格）+ `FTS_CONTENT_LIMIT`
    截断。直接塞原文会让中文两字词搜索**静默失效** —— 不报错，就是搜不到。
    所以走 `DELETE` + `INSERT OR REPLACE`，用同一套分词重新算 title 和 body。
  - `recycle_bin` 里 `kind='note'` 的 `data` 是删除那刻的 `SELECT * FROM notes` 整行快照
    （`JSON.stringify({ note, tagIds })`）。不洗这份快照，用户一点「还原」脏正文就回来了。
    `JSON.parse` 失败或形状不对就 warn 跳过，不碰。
- 选行用 `WHERE content LIKE '%[!COPY]%'` 只是**预筛**（SQLite 的 LIKE 对 ASCII 大小写不敏感，
  `[!copy]` 也能选中），真正删不删由纯函数逐行判。宁可多选、不可漏选。
- 逐行 `try/catch` 隔离：一条笔记写失败只跳过它自己（正文保持原样，至少不丢数据），
  不让整步挂掉 —— 整步挂掉会被记成「迁移未完成」，于是每次冷启动都重试、
  每次都在同一行上再失败一遍。

**三、修中文输入吃拼音（`NoteEditor.tsx`）**

根因不是 CodeMirror 本身，是**宿主组件把它按「受控 textarea」用**：

- 老的 `useEffect([value])` 每次都派发 `{from: 0, to: doc.length, insert: value}` ——
  **整篇替换**。CM6 遇到全文档替换会把 contentDOM 整棵重建，正在进行的 composition
  随之被取消，拼音就「固化」成半截。
- 它和一个 `CHANGE_COALESCE_MS = 150` 的合并上抛窗口叠成竞态：IME 每敲一个字母都改 doc，
  上抛被合并；合并后的 `onChange` 回流到父级再作为 `value` 回来，正好压在 composition 中间。
- 修法（不是加 `if (composing) return` 那么简单，那样会丢掉组合结束后的必要同步）：
  - `syncFromProp(force)` **只比不写** —— 先算清「prop 的正文」和「doc 的正文」是否真的不同，
    相同就什么都不做（回声抑制）。
  - `applyDocDiff()` 走**前后缀局部 diff**，只替换真正变化的中间段，不再全文档 replace。
  - `valueRef` 保证定时器 / 事件回调读到的是最新值，不是闭包里的旧值。
  - `pendingSyncRef` 是**布尔 flag 而不是 value 快照** —— 组合期间只记「有人想同步」，
    真要同步时现取最新值。
  - `lastEmittedRef` 记录自己刚上抛的文本，让 `syncFromProp` 认得出「这是我自己发的回声」。
  - `compositionstart` 起**四轮看门狗**（`COMPOSITION_WATCHDOG_MS = 1200`）：
    Android / Safari 会漏 `compositionend`（CM 自己在 `dist/index.js:5378` 也只做了 20ms 兜底），
    漏事件时靠超时兜底，且必须等满四轮才允许 `force` 覆写。
  - `compositionend` 后的补同步**延后 170ms**：不能立刻比，CM 的 `observer.flush()` 是微任务、
    Chrome 还会在 `compositionend` 之后再塞几次 input，立刻比会看到半成品。

### 四个如实披露的取舍

1. **纯函数比 spec 多出两种形态**（前缀形态、围栏识别）。spec 只说了「删标记行」，
   实现时发现「同行带正文」和「代码块里当示例」两种情况必须区分，否则要么留脏字、要么改坏示例。
   多出来的分支都有独立测试，不是顺手加的。
2. **`updated_at` 一动不动**。这条写进了注释也写进了测试（禁止
   `/UPDATE\s+notes\s+SET[^"'`]*updated_at/i`），因为它是**最容易被"顺手"改坏的一列** ——
   迁移完发现笔记列表顺序变了，用户会以为是另一个 Bug。
3. **逐行失败隔离的代价是「可能洗不干净」**。坏行被跳过、而整步仍算完成，那条笔记会一直留着
   `[!COPY]` 字样。相比「整站每次启动都报迁移失败」，这个代价更小；洗不掉的原因已经在上面的
   warn 日志里点名了。**这不是"已修复"，是"已知残留"**。
4. **围栏未闭合时会漏洗**。围栏保护是朴素实现：任何以 ``` / ~~~ 开头的行翻转状态。
   围栏没闭合 → 后面的标记全被当成代码示例漏掉。但方向是安全的（漏洗只是残留可见，
   误删会吃掉正文），而且**围栏之前的标记照常删**（"半篇生效"），重复跑仍幂等。

### 测试换了语义，不是「跑绿了就算」

- **删** `tests/copyBlockFragments.dom.test.tsx`（522 行）、`copyBlockTokens.test.ts`（195 行）、
  `helpers/cssRules.ts`（90 行）—— 它们测的是已经不存在的功能，留着只会变成
  「为了让老测试过而保留死代码」的引力。
- **新增** `copyBlockRemoved.test.ts`（208 行 / 5 条）：全仓 `COPY` 字样扫描，
  唯一白名单是 `API/methods/migration.ts`；反转原「`CALLOUT_TYPES` 含 COPY」断言为 `false`；
  钉住 `MIGRATION_STEPS` 必须含 `notes-copy-callout-marker`、id 不许重复、
  纯函数签名、写回语句形状、禁止 `updated_at`。**扫描前先剥注释** ——
  否则守卫会自己红（注释里全是 `COPY`）。白名单做过反向验证：行注释不红、
  代码行 `const qaCopyProbe = "COPY";` 红 2 条、块注释不红 → **无掩蔽**。
- **新增** `copyBlockRemoved.dom.test.tsx`（113 行 / 1 条）：渲染 `[!COPY]` 后
  `[data-callout="COPY"]` 必须是 `null`、任何 `[data-callout]` 都没有、
  **`blockquote` 必须还在**（退回引用，不是整块消失）；复制控件五连 null
  （`[role="button"]` / `.md-copy-frag` / `.md-copy-host` / `[data-copy-op]` / `button`）。
- **新增** `copyCalloutMigrationRealSql.test.ts`（247 行 / 12 条）：7 条纯函数 + 5 条
  **真 SQLite**（按 `tests/helper/realSqliteD1.ts` 的方式搭 D1 兼容层，
  `downgradeTo29()` 把 `schema.version` 退回 `"29"` 并删 `schema.steps` 强制重跑）。
  期望值是**手写字符串常量**，不是被测函数算出来的 —— 否则就是自证循环。
- **新增** `tests/editorComposition.dom.test.tsx`（373 行 / 7 条）：IME 行为测试。
  第 7 条「真实短组合：零 onChange 直接 compositionend，父级仍带初始 value，不许回灌」
  同时守住两个实现细节（补同步延迟、`notify()` 乐观同步），两条都被证伪为**必要**。
- `tests/vaultSchema.test.ts` 升号断言原本写死 `assert.equal(SCHEMA_VERSION, "29")`，
  升到 30 后真红（`'30' !== '29'`，`# tests 4029 / pass 4027 / fail 1`）。
  **不是**改成 `"30"` 了事（那会退化成「某处有个数字」），拆成两条：
  `Number(SCHEMA_VERSION) >= 29`（保住「只许前进」的原意）+ 字面量 `"30"`（签字位）。

**6 个变异无一全绿，且全部红在预期断言**：`rev+1` 退化成 `rev`（1 红）、
跳过 FTS 重算（1 红）、纯函数退化成子串替换（11 红，7 条纯函数全红 + 真库 4 条，
FTS 那条正交不红是对的）、跳过回收站（1 红）、去掉围栏保护（1 红）、
前缀形态改整行删（1 红）。每轮 sha256 各异、收尾回到原值。
⚠️ 变异时踩到：`src/` 是 **CRLF**，多行锚点用 `\n` 拼命中 0 次（假绿），必须按 CRLF 拼。

**门禁**：`tsc` 0 error / `eslint` **0 error（26 存量 warning）** /
单测 **4029 tests / 4028 pass / 0 fail / 1 skipped / 142.3s / exit 0** /
`build` ✓ 3.08s / **budget 37/37** / `smoke` 46 PASS。
唯一 skip 是 `uptime-check` 的软链（`EPERM`，Windows 环境限制，CI 上会跑）。

### 这次**没有**解决什么

- **`updated_at` 的禁令只有静态一层**。变异测试暴露：B1/B2/B4 三个变异会先红在
  「写回语句形状」断言上，`updated_at` 禁令压根没执行到；只有另起一条独立的
  `UPDATE notes SET updated_at = …` 才红在禁令本身。**运行层（真 SQLite 12 条）零覆盖**。
  应该补一条「迁移前后 `updated_at` 必须相等」的真库断言 —— 列为下一批。
- **围栏的两个已知限制没有固化成 fixture**：「围栏未闭合漏洗但幂等」「围栏前标记照常删」
  现在是实测结论，不是回归测试。应该各补 1 条，用例名标「已知限制的显式化」。
- **首屏 gzip 余量只有 0.19 KB**（285.52 / 285.71，headroom 4.83%）。这次是**净删**所以没踩线，
  但下一个前端特性开工前必须先量这条线，别再靠抬预算。
- `NoteEditorLivePreview` 的 90ms `refreshEffect` **没有加 composition 防护**。
  如果真机上还有拼音残留，这里是第一嫌疑点（本轮没动它）。
- dom 测试里仍有 **33 处** `assert.equal(DOM元素, null)` 同型写法散在 13 个文件 ——
  `node:assert` 失败时 `util.inspect` 会展开 React `__reactFiber$` 整棵树，触发 OOM。
  技术债，未动。

### 部署

**这次有数据库迁移，升级前必须备份。**

- `SCHEMA_VERSION` 29 → 30，容器启动时 `migrateIfNeeded` 会自动跑
  `notes-copy-callout-marker`。它是**幂等**的（`configs.schema.steps` 记录已跑的 id），
  重复启动不会重复洗。
- **回滚行为是这次特意查过的，不是推测**（读了 `migrateIfNeeded` / `runMigrations`）：
  回滚到 31.0.0 时那个镜像的 `MIGRATION_VERSION` 是 `"29"`，而库里是 `"30"`，
  比对用的是 `===` 不是「小于」，所以**会**走进 `runMigrations()` —— 但它的 `done`
  集合是从 `configs.schema.steps` **读出来的**，只会往里加、不会被覆盖，于是 v31 那 20 步
  全被判为已完成、全部跳过，`notes-copy-callout-marker` 这个它不认识的 id 也**原样留在集合里**。
  唯一副作用是 `writeSchemaVersion("29")` 把版本串**写回成 29**（下次升到 32 时再更正回来，
  步骤集合没丢，所以不会重跑）。结论：**回滚不会崩、不会重复洗、不会丢数据**。
- **但已经被洗掉的 `[!COPY]` 回不来了** —— 迁移是单向的，没有反向步骤。
  所以升级前的库备份是唯一的还原路径。
- 部署前用 `VACUUM INTO` 做一份一致性快照，别直接 `cp`（WAL 模式下 `cp` 可能拿到半写状态）。
- 纯后端 + 前端改动，**不涉及 `docker-compose.yml` / `deploy/upgrader/`**，
  30.1.0 那次「`deploy/upgrader/` 必须和 compose 一起同步」的前提本次不适用。

## 2026-11-05 · 重构 + 工程：笔记 `> [!COPY]` 可复制块改为行内虚线片段复制（31.0.0）

> **关于这个 major**：它由 `script/bump-version.mjs` 按 `git diff --cached` 的规模判定
> （13 文件 / 1333 行，超过 minor 的 1200 行线），其中 818 行是 4 个新增测试文件，
> 源码实际 354 行（314 增 / 40 删）。**这是行数口径的 major，不是对外行为的大版本** —— 没有接口、
> 数据结构、鉴权或部署前提变化，混版本跑不会看到不同语义。与 30.0.0（12285 行）、
> 30.1.0（1151 行）用的是同一把尺子，没有为了「版本号好看」手工覆写脚本。

### 用户要的是什么

这是对同一个功能的**第三次反馈**：`> [!COPY]` 块原来在右上角常驻一颗「图标 + 复制」胶囊，
并且为了不盖住首行，块顶固定预留 28px。问题有两个 —— 「占地方太大」，以及整块只有一个
按钮，**预览区里看不出到底能复制哪一段**。用户需要的复制内容一般都是短内容。

### 改了什么（方案三）

- **复制粒度下沉到块内每个反引号片段**。静止态只有一条 1px 虚线下划线，
  用 `display: inline`（inline 元素的 border 不参与行盒高度，长 URL 仍会正常换行），
  零占地；悬停 / 聚焦浮浅蓝底 + 一枚「⧉ 点击复制」气泡，复制成功 1.2 秒变浅绿。
  每个片段有 `role=button` / `tabIndex=0` / Enter·Space，可访问名带**片段原文**
  （「复制：10.0.42.18:5432」），读屏用户分得清是哪一个。
- **整块复制保留，但改成悬停整块才显形**（`@media (hover:hover) and (pointer:fine)` 下
  静止 `opacity:0`，`@media (hover:none)` 显式写回常显）。块顶那 28px 操作带删掉了。
  只藏 opacity 不藏 visibility/display，键盘 Tab 仍够得到。
- **块外行内代码不受影响**：`Cursor` 新增 `inCopyBlock`，只有 COPY 分支的
  `renderBlocks(child(body, c, 0, true))` 打开开关；块外仍是原来的灰底圆角胶囊。
- 气泡文字全部交给 CSS `::before`，DOM 里没有文本节点 —— 否则 jsdom 下
  `blockTextOf` 回落到 `textContent` 时，「整块复制」会把气泡里的字一起复制走。
- 交互演进史写进了代码注释（float 挤正文 → 半透明小图标看不见 → 常驻胶囊 + 28px 带
  → 现在），**三版都别再往回走**。

### 三个如实披露的取舍

1. **静止虚线的对比度达不到 WCAG 1.4.11 的 3:1**。亮色 `rgba(15,23,42,.28)` 实测
   **1.86:1**，暗色 `rgba(255,255,255,.34)` 是 **3.10:1**（达标）。保留 0.28 是因为
   「1px 浅灰虚线」是用户明确指定的视觉，抬到 0.48 就变成明显深灰虚线，等于换掉
   用户要的东西。而片段与正文之间**不靠颜色区分**（等宽字形 + `cursor:copy` + 悬停气泡
   + 可访问名），不构成「仅靠颜色」。缺口不掩盖，钉进测试：亮 ≥1.80 / 暗 ≥3.00，
   并加**上界**（亮 ≤2.30 / 暗 ≤3.60）挡住有人擅自抬到 0.48 去凑 1.4.11。
2. **首屏 gzip 预算 300 → 301**。实测 868.9 KB raw / **286.0 KB gzip**，5% 线原本在
   285.71，差 0.3 KB 踩线；新增状态样式约 1.7 KB minified ≈ 0.6 KB gzip。已经压过一轮
   （悬停蓝 / 已复制绿 / 弹层底全部复用既有 `--callout-note-*` / `--callout-tip-*` /
   `--surface-raised`，只新增 3 个变量）。不能 lazy：样式挂在渲染产物自带的 class 上，
   拆成随 chunk 加载的独立样式表会让 jsdom 侧 esbuild 报 `no loader for .css`。
   注释里写明「**这是最后一次为纯样式让预算**，下一个特性要么改懒加载，要么先还债」。
3. **`audit:contrast` 的「0 处不合格」对这组新配色不构成证据** —— 它的种子笔记里
   没有 COPY 块。没有往种子里加：同一份种子同时喂 `audit:visual`，加进去会造出一大片
   新基线漂移，唯一能变绿的办法是 `audit:visual --update`，那会把观察期里**已知的
   10 处漂移一起烧进基线**。所以改成单测直接量，见下节。

### 测试是被变异测试验过的，不是「跑绿了就算」

新增 `tests/copyBlockTokens.test.ts`（3 条）+ `tests/helpers/cssRules.ts`（带 `@media`
上下文的 CSS 规则索引器，一把抓的正则抓不到外包媒体查询，用它写的守卫是假绿）+
`tests/copyBlockFragments.dom.test.tsx`（13 条）+ `script/auditEnv.d.mts`（最小类型声明）。

- **对比度数学只有一份**：单测用 `new Function(CONTRAST_CORE)` 取 `NH.ratio`，就是
  `audit:contrast` 注入页面的那段源码，并用「白/黑 = 21:1」钉住拿到的不是假实现；
  颜色全部从 `src/index.css` 的 `:root` / `.dark` 读，测试里没有硬编码设计色。
  实测：虚线 1.86 / 3.10、气泡 14.68 / 14.42、悬停浅蓝底正文 13.03 / 14.41、
  已复制浅绿底正文 13.27 / 14.02（11px 小字按 4.5:1 判，不给大字号豁免）。
- **11 个变异（M1–M9 + M7b/M7c）无一全绿，且全部红在预期断言**：调淡虚线、
  调深虚线、改坏气泡字色、删 `.dark` 覆盖、去掉 `child(..., true)`、去掉
  `CopyFragment` 的 onClick、给 host 加 onClick、恒真开关、误伤块外那一行、给块外 `<code>`
  挂 `data-copy-op` 全部被抓。其中 8 条（M1–M6、M8、M9）一次就干净红在预期断言；
  另 3 条（M7 / M7b / M7c）在**断言布尔化之后重跑**（见下节），从 OOM / `RangeError`
  变成毫秒级（6.78 / 7.00 / 9.90 ms）红在同一条可读断言，零 OOM。
  其中 **M9** 是对症的那条：
  给 `md-copy-host` 加 `onClick={handleCopy}` 后，`written` 从 `['db_9981_xk']` 变成
  `['db_9981_xk', '<整块文本>']`，精确红在 `assert.deepEqual(written, [expected])` ——
  证明「点片段不会连带触发整块复制」这条断言不是摆设。所有变异均已还原并 sha256 自证。
- 门禁：tsc 0 error / eslint 0 error（28 存量 warning）/ 单测 **4026 / 4025 pass /
  0 fail / 1 skipped** / build 通过 / **budget 37/37** / smoke / `audit:a11y` 0 项 /
  `audit:contrast` 0 处（但它的种子笔记里没有 COPY 块，见上面取舍 3）。视觉基线方面，
  工程师用 stash 方式在 HEAD 上重跑做对照，两边「有差异」用例集 diff 为空（零新增漂移），
  未跑 `--update`（观察期那 10 处已知漂移仍在待查清单里）。

### 这次**没有**解决什么（别当成已经治好了）

- **M7 暴露的测试可诊断性问题：本轮已修，但只修了局部**。把 `if (c.inCopyBlock)`
  变异成恒真时，dom 测试进程原本 OOM 崩溃（58.8s / 372MB 堆），只报「文件级 not ok」
  没有断言消息。根因已定位，**不是渲染或查询路径无限增长**：`node:assert` 构造失败消息时
  会 `util.inspect` 比较值，而 React 18 `createRoot` 给 DOM 节点挂了可枚举的
  `__reactFiber$` / `__reactProps$`，inspect 顺着 fiber 图把整棵树展开成字符串，把堆打爆。
  所以「给 `renderToDom` 加节点数 / 耗时上限」这个方向是错的（DOM 本身很小，守卫永远绿，
  耗时守卫在 CI 上只会随机假红）。真正的修法是把三处 `assert.equal(DOM元素, null)`
  改成布尔比较（`assert.equal(x === null, true)`），落在
  `tests/copyBlockFragments.dom.test.tsx` 两处与 `tests/markdownRender.dom.test.tsx` 一处。
  修复后 M7/M7b/M7c 三条变异重跑，全部毫秒级红在「块外的行内代码不许带上任何复制单元」
  那条可读断言（`false !== true`），零 OOM；`copyBlock` 子集 16/16 仍全绿。
  **但项目里还有 33 处同型写法散落在 13 个 dom 测试文件**，随时可能在别的用例失败时
  重演同样的 OOM。系统级静态守卫（禁止把 `querySelector` / `closest` / `parentElement`
  的结果直接交给 `assert.equal` / `deepEqual`）本轮**没加** —— 一次性要动 33 处，
  改动面远超本次范围，列为下一批技术债。
- 首屏 gzip 余量从 ~5.0% 变成 286.0/301，仍贴线；下一个前端特性开工前必须先量这条线。
- 气泡在跨行 inline 片段上锚点会偏上 / 偏下（改 `inline-block` 会撑破版面，更糟）；
  整块按钮悬停浮现时会盖住长首行行尾几个字（静止不占位的必然代价）；表格 / 嵌套列表里
  气泡可能被容器裁掉。这些是形态取舍，不是待修 bug。
- 版本握手（根治「宿主机跑旧脚本」）、批量接口 `IN (...)` 切批、告警落地、视觉基线
  10 处漂移（观察期到 2026-12-31，**别跑 `--update`**）仍是上一批留下的尾巴。

### 部署

纯前端改动，**不涉及 `docker-compose.yml`、`deploy/upgrader/`、升级器脚本或数据库迁移**，
30.1.0 那次「`deploy/upgrader/` 必须和 compose 一起同步」的部署前提**本次不适用**，
常规 pull + recreate navihive 即可。

## 2026-11-04 · 工程：升级器脚本从 compose 抽出，补上三终态行为测试（30.1.0）

**⚠️ 这次有一个部署前提变了，升级的人必须先看**：升级器的执行体现在是一个**仓库文件**
`deploy/upgrader/upgrade-loop.sh`，它靠那条「宿主原路径同名挂载」被 upgrader 容器读到。
所以**只把 `docker-compose.yml` 同步到部署目录是不够的**，`deploy/upgrader/` 必须一起去。
少了一头，容器启动时的存在性检查会打两行 `[upgrader] 致命：…` 然后退出 1（响亮失败）。
`deploy/selfhost.md` 里按「部署目录是不是 git 工作区」分了两类写法。

### 为什么要动它

升级器是整套系统里**唯一持有 `docker.sock` 的特权容器**：应用只往共享卷写一个请求文件，
它轮询到之后执行 pull → recreate → 健康门禁 →（不健康则）回滚。而这段 shell 之前是**内联在
`docker-compose.yml` 的 `upgrader.command:` 里**的一段 80 行 block scalar，带来两个后果：

1. **它没法被任何测试真正执行**。`tests/systemUpgradeGuard.test.ts` 只能做文本锚点断言
   （数 `{{.State.Health.Status}}` 出现几次、断言某条命令字符串在不在），三个终态
   （`done` / `rolled_back` / `rollback_failed`）的行为是**零覆盖**。
2. **compose 文件不随镜像更新**。2026-11-04 发布 30.0.0 当天就撞上了：镜像里的 R05 回滚终态
   协议是新的，但宿主机 compose 里内联的还是三天前的旧脚本 —— 旧脚本在回滚之后**无条件写
   `done`**，于是「升级失败已自动回滚」会被 UI 显示成「升级成功」。而当时本地门禁全绿、CI
   也全绿，没有任何东西报警。

### 改了什么

- 新增 `deploy/upgrader/upgrade-loop.sh`（147 行）：从 compose 内联块**逐行搬出**，逻辑与
  文案一字未改；`$$`（compose 转义）还原成 `$`。compose 的 `upgrader.command` 缩成「存在性检查
  + `exec`」，路径用**相对** `working_dir` 的形式（脚本自己引用 compose 也一直是相对路径）。
- 新增 `tests/upgraderLoop.test.ts`：用「假 `docker` + `PATH` 前置」**真执行那个脚本**，覆盖
  `done` / `rolled_back` / `rollback_failed`×2 / 拉取失败 `failed` / 重建失败 `failed` 六个出口，
  并用调用流水做否定断言（例如「拉取失败时根本没有发起重建」）。
- 脚本新增 4 个**测试注入点**环境变量（spool 目录、两处轮询间隔、只跑一轮），默认值等于线上值，
  不设时行为与旧内联版逐字一致。
- 两份实现（spool 的 `.sh` 与 sock 模式 `server/upgradeHealth.ts` 生成的 shell）的锚点一致性
  仍由 `tests/systemUpgradeGuard.test.ts` 绑住，并新增两条反向钉子：compose 里不许再出现
  `{{.State.Health.Status}}`（防偷偷退回内联）、不许出现绝对脚本路径（防把「改两处」变成四处）。

### 测试是被变异测试验过的，不是"跑绿了就算"

把脚本故意改坏，看测试会不会红 —— 6 个变异点全部真红，并且红在预期的那条断言上：

| 变异 | 结果 |
|---|---|
| `done` 改回无条件写（复刻旧 bug） | 三个回滚用例同时红 |
| 回滚判定 `-eq 0` → `-ne 0` | `rolled_back` / `rollback_failed` 互相颠倒 |
| 删掉回滚后二次探活 | 「回滚 rc=0 但旧容器仍不健康」必须报 `rollback_failed` 那条红 |
| `rolled_back` 改字面量成 `done` | 回滚用例红在 error 文案 |
| 拉取失败分支继续往下走 | 否定断言（调用流水为空）抓到 |
| 「重建失败」分支写成 `done` | 补测**之前全绿**，补测之后两处同时红 |

最后那条是这轮最有价值的发现：它是**同一类假成功在另一个出口上**，而当时的门禁对它全绿。
根因是 `recreateRc` 参数定义了却从没被任何用例传过。已补 D2 用例，六相位现在 6/6 全覆盖。

另外把「`done` 写在健康门禁块**内部**」从 `indexOf` 顺序比较改成**按 `if…fi` 切块**的结构断言
—— 顺序比较证明不了「在块内」，别处再写一个 `done` 它照样绿。

### 这次**没有**解决什么（别当成已经治好了）

- 脚本**没有**随镜像发布，仍是一个要同步到部署目录的宿主文件。同步负担从「1 个文件」变成
  「2 个」，而线上部署目录与仓库目录本来就是分离的。所以「宿主机跑着旧脚本」这个失败模式
  **只是从静默变成可测 + 可响亮失败，没有根治**。
- 根治要做**版本握手**：脚本自报内容哈希、应用侧比对不一致就告警。那是另一件事，尚未做。
- 回滚分支（`rolled_back` / `rollback_failed`）仍没有在真实 docker 上制造过一次失败升级来验证；
  现在的证据是变异测试证明的**行为覆盖** + 线上成功路径的端到端演练。

## 2026-11-04 · 安全 + 修复 + 工程：独立审查 18 项按四阶段收口（30.0.0）

`deliverables/software-company/navihive-fresh-review-2026-11-03.md` 的 **R01–R18 全部落地**，
严格按报告第四节的阶段顺序推进（每阶段改完并验证通过才进下一阶段）。
这是 **major**：有五处**对外行为**变了（账号未知态从 401 改 503、覆盖率门禁与体积门禁改为 fail-closed、
导入统计新增 `partial`/`conflicts`、探针改为逐条声明期望状态、导入提交改成交错自足单元），
旧版本混着跑会看到不同的错误语义。

### 阶段 1 · 数据与升级正确性（R02 / R03 / R04 / R05）

**R02 乐观锁冲突时的业务副作用**。`updateNote` 原来把「解绑同站其它笔记」「自动标签」和主 UPDATE
放进同一个 `db.batch`：主 UPDATE 因 `rev` 不符命中 0 行时，**副作用照样执行** —— 别人刚改的那篇会被
解绑、旧正文的标签会落库。`db.batch` 是真事务，但「零行 UPDATE」是成功的 SQL，不会回滚。
改法是把副作用排到主 UPDATE **之前**并加 `EXISTS(… AND rev = ?)` 守卫，靠守卫而不是靠回滚。
不传 `rev` 的老客户端行为不变。

**R03 导入的恢复单元**。原实现「所有正文 → 所有关联 → 末尾补 FTS」，中途失败后重新导入，
因 `updated_at` 已被写成「现在」而被判 `skipped` —— **那条笔记再也导不进来**。
现在按逻辑笔记交错成自足单元（解绑 → 正文 → 标签关联 → FTS），切分点只在单元边界，FTS 与正文同批；
统计改为按实际提交累加，失败时带 `partial: true`。

**R04 导入的并发 ID 与覆盖窗口**。事务外 `MAX(id)+1` 预分配显式主键，并发下会撞主键；
folder/tag/note 的「源 id → 本地 id」映射现在改走稳定键子查询（`uuid` / `name` / `(parent_id, name)`），
主键交给 AUTOINCREMENT；已有笔记的 UPDATE 加 `AND rev = ?` CAS，命中 0 行计入 `conflicts`
（**保留对方那次编辑**，不覆盖）。

**R05 升级状态协议**。原来「容器重建成功但不健康、回滚后 API 仍报 done」，前端可能提前宣布升级成功。
新增 `rolled_back` / `rollback_failed` 两个终态：回滚命令检查返回码 + 回滚后**二次探活**（20×3s），
sock 模式用 helper 退出码 40/41 反解相位；前端 `upgradeWait` 改成**显式否决** —— 一读到回滚终态立即失败，
即使版本号已经变了也不报 upgraded。

### 阶段 2 · 可信门禁（R11 / R12 / R13 / R15 / R16 / R17）

- **R11 契约测试原本是自己比自己**：`PASSTHROUGH_CASES` 把同一个 `mockResult` 既当响应又当期望，
  `shapeOf(a) === shapeOf(b)` 恒成立，什么都没验证（`ai/status` 的真实响应多一个 `success: true` 就一直没被发现）。
  删掉 4 条恒等断言，新增 `tests/apiContractReal.test.ts` 用真 SQLite + 真 handler 断言真实字段。
  过程中还证实了一处类型谎言：`pinned / starred / archived` 实际返回 **0/1 整数**，类型却声明为 `boolean`。
- **R12 边界探针没有判据**：原来只有 `>= 500` 才算坏，401/404 全算「好」，于是「鉴权整个失效、
  所有接口都能匿名访问」也会全绿。现在登录后必须拿到会话（拿不到就退出码 2 中止），61 条 case 逐条声明
  `expect: number[]`，失败时保留 800 字符响应体。另加两条**故意不带会话**的 case 期望 401。
- **R13 覆盖率门禁会静默通过**：没装 c8 时 `exit(gateFailed ? 1 : 0)`、读不到 summary 时 `{failed: false}`。
  判定抽成 `script/coverageGate.mjs` 纯函数，缺 c8 / summary 缺失 / JSON 坏 / `lines.total === 0` 一律非零；
  新增显式 `--layer1-only`（手误写成 `--layer1_only` 直接拒绝，不会被默默忽略）。
- **R15 体积门禁在不该通过的时候通过**：`firstScreen()` 读不到 HTML 就 `return null`（后面全跳过）、
  资产读不到就 `continue`（少算），于是 dist 缺失或引用断裂照样报绿。新增 strict 模式
  （`npm_lifecycle_event === "check:budget"` 或 `NAVIHIVE_BUDGET_STRICT=1`），9 处 `t.skip` 逐个转成
  「strict 下 fail / 非 strict 下打印原因再 skip」。
- **R16 可访问名判据不合规范**：`aria-labelledby` 完全不认、`title` 优先级高于文本内容、
  `alt=""`（合法的装饰图）被判违规。改成规范实现：labelledby 递归解析（环检测、跳过 aria-hidden 与 display:none）、
  原生名字来源、`hasAttribute('alt')` 区分「没写」与「写了空」、`aria-hidden` 子树整体排除。
  **不引 axe-core、不加批量白名单**。
- **R17 视觉回归失败后无迹可查**：5 条退出路径全是直接 `done(N)`。现在把每个用例的 actual / 基线 / diff
  落到 `artifacts/visual-regression/<时间戳>/`，**每一个 `done(1)` 之前都 flush**（含 catch 中断分支，能写多少写多少），
  CI 侧加 `if: always()` 的步骤摘要与产物上传。`continue-on-error` 与基线**一个字没动**。

### 阶段 3 · 安全与体验（R06 / R07 / R09 / R14）

**R06 DNS 检查与连接分离**（自托管 SSRF 闭环）。原来「出站前解析一遍过黑名单」与「fetch 自己再解析一次」
是两个不同的解析结果，DNS rebinding 可以在这个窗口里换回内网 IP。现在自托管启动时装
`undici.Agent({ connect: { lookup } })`，**连接用的就是校验过的那份 IP**，Host 与 SNI 保持原样；
resolve 到的地址里只要有一个命中黑名单就拒绝整次连接（不做「过滤掉内网连剩下的」）。
`worker/safeFetch.ts` 只加了一个 `setFetchImpl` 注入点，不注入时（Cloudflare / 单测）行为完全不变。
undici 不能进 esbuild ESM 单文件（`Dynamic require of "node:assert"`），所以它成为**唯一**的运行期外部依赖：
精确锁 `8.12.3`、构建 external、镜像运行阶段只 COPY 这一个包目录（8.x 自身零依赖），
缺失时降级为「仅出站前复核」并在启动日志告警，**服务照常起**。
WebDAV 授权内网是**故意保留的例外**（`webdav.allowPrivateNetwork`），已写进 `SECURITY.md`。

**R07 账号未知态不再靠 `dbReady` fail-open**。`dbReady` 原是**实例字段**，而每个请求 new 一个实例，
且 `enforceAuth` 排在 `api.migrate()` 之前 —— 于是「迁移未跑完 → 放行」这条豁免在**稳态下永远成立**：
任何一次读失败（并发冲突、D1 抖动、语法错）都被当成「首次建表」放行，「停用/清除的账号靠旧令牌继续过审」
这道闸门其实从来没关上过。改法：就绪状态统一到模块级 `migrationState.ready`（两条迁移路径都置位）；
首建豁免**只认**「尚未就绪 + 明确缺表/缺列」，补跑迁移后重试一次；其余一律 `unavailable`。
`unavailable` 在鉴权中间件回 **503 + `Retry-After: 5`** 而不是 401 —— 401 会让客户端清掉登录态，
一次库抖动就把所有人踢下线；方向仍然是 fail-closed（挡在受保护路由之前）。
逃生口 `NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR=1` 保留，但必须留一条可检索的日志。

**R09 窄屏命令直达被重置**。设置面板原先每次 `open` 变化都把 `mobileStep` 重置成 `"list"`，
于是窄屏下带目标面板的命令仍落在目录页，要再点一次。现在「有没有目标」是**显式**表达
（`NavCenterPanelId | null`，`null` = 没有目标），不再靠「panel 不等于默认值」推断；
只在**本次打开**的首帧按意图定步进，用户在面板里点「返回」不会再被 effect 弹回去。
焦点接力：进面板聚焦标题（`tabIndex={-1}`）、返回聚焦目录里对应条目；≥600px 完全不跳焦点。
顺带修掉「关掉导航中心后 `navCenterPanel` 残留」的隐患（改成关闭时清空）。

**R14 性能首访证据不足**。原来同一个浏览器连跑 3 轮、缓存首轮就预热，取出来的中位数
「既不是首访也不是回访」；CLS 只记录不设门禁；`--json` 模式下失败被整段跳过（等于静默成功）；
本地审计服务器不做 gzip，与线上压缩传输不可比。现在冷/热分离（冷轮每轮清缓存 + 清 Service Worker 与
Cache Storage，热轮首轮当预热剔除）、CLS 取**全轮最大值**并入预算、`--json` 保留失败退出语义
（另给显式 `--report-only`）、审计服务器按 `Accept-Encoding` 协商 gzip、`pageErrors` 去重。
本机实测（单跑）：冷启动 FCP ~1944ms / LCP ~3400ms / CLS 0.031；回访 FCP ~184ms / LCP ~964ms。
gzip 口径的 A/B：同一份 dist 只切开关，冷启动 FCP 4828ms → 1960ms（−59%），说明旧口径确实偏悲观。

### 阶段 4 · 维护治理（R18 · 供应链 · 监控事件）

- **R18 依赖公告**：`npm audit` 报 15 个 moderate 节点，但**真公告只有 2 条**
  （`glob` 的 GHSA-3g3m-2fjr-6pw4、`minimatch` 的 GHSA-g3hv-75wg-m249），另外 13 个节点挂的是父包名；
  两条都没有 CVSS 向量，`moderate` 是 npm 默认档。逐条查过 registry：`minimatch` 的 10.x 线终点就是
  10.2.6，`eslint@latest` 与 `@eslint/config-array@latest` 仍写 `^10.x`，`c8@12`/`test-exclude@8` 已是 latest ——
  **没有一个允许范围内的升级能消掉公告**，`npm audit fix` 的方子是 major 降级（把 eslint 10 拆回 9），
  会破坏现行组合。所以走**有期限例外**：责任人 + 2027-02-28 到期 + 复查命令，登记在
  `docs/dependency-upgrade-assessment.md` 附录；生产依赖仍然是 **0**。守卫测试会拦「过期/糊弄责任人/漏登记」。
- **供应链固定**：基础镜像 `node:22-slim` 与 upgrader 的 `docker:27.5-cli` 已按 **digest** 钉死
  （本机连不上 Docker Hub，digest 用四个独立来源交叉验证：本仓 ghcr 镜像里 buildkit 的 provenance 记录、
  AWS ECR Public、两个官方镜像镜像站）。`docker-publish.yml` 的全局 `contents: write` 收窄到
  真正打 tag 的 merge job；6 个 workflow 全部改成「顶层只读 + job 级按需提权」。
  仍有两处浮动 tag 走例外登记（本地 `build: .` 产物的 digest 无法固定；粘贴式部署模板钉 digest 会把
  几个月后新装的机器冻在写模板那天）。
- **静默失败的结构化事件**：`shared/failureEvents.ts` 定义事件名常量，覆盖四条**出问题时没人会发现**的路径 ——
  `notes.import.partial`（导入只完成一部分）、`notes.import.conflicts`（并发冲突保留了对方编辑）、
  `migration.failed`（带失败的步骤 id）、`upgrade.rollback.failed`（`rolled_back` / `rollback_failed` 两个相位）。
  message 恒定、数字只进字段，所以同一事件可按 message 分组；**正常路径零事件**有专门的反向护栏用例
  （否则告警会被噪音淹掉）。`deploy/selfhost.md` 新增第十六节：哪个事件该叫醒人、收到先做什么、
  「本次没有选定任何日志平台、没有启用任何线上告警」的显式声明、以及可复制的 grep/jq。

### 验证（本轮实测，全部串行、堆上限 3 GB）

| 门禁 | 结果 |
|---|---|
| `typecheck`（六组 tsconfig） | 0 报错 |
| `lint` | 0 error；27 条存量 warning 未增；`react-hooks/exhaustive-deps` 预算 0/0 |
| `npm test` | **3992 条：3991 通过 / 0 失败 / 1 跳过**（跳过的是「本机不允许建软链」） |
| `build` + `check:budget`（strict） | 通过；**37/37、0 跳过**（改造前这里会静默 skip） |
| `check:brand` / `check:strict-idx` / `smoke` | 全部通过 |
| `audit:a11y` | 0 项不合格（新判据下重跑） |
| `audit:contrast` | 五个面 × 亮暗两态，各 0 处不合格 |
| `audit:perf` | 冷/热两组与 CLS 门禁全部达标 |
| `audit:visual` | 仍且仅 **10 个**已知漂移、diff 明细 **107 行**，与 10-24 记录逐行一致（观察期到 2026-12-31，**没有**跑 `--update`） |
| `probe:edge`（R12 改造后） | 61/61 全部符合显式期望 |
| `check:coverage` | 第 1 层 100%（427/427）、第 2 层 88.6%（96296/108653），均在地板之上 |

### 这一轮**没有**验证到的（别当成已验）

- **R06 的隔离网络动态 DNS 验收没做**：需要能把同一域名在「校验」与「连接」之间切换答案的环境。
  本地只做到「真 DNS 下 A 记录指向回环的域名被连接层拒掉」这一静态案例。
- **`docker build` 没真拉过钉住的 digest**（本机出网被代理挡住 Hub）；下次 `docker-publish` 构建成功即为验证。
- **CI 真跑**：workflow 权限写错的表现是某一步 403，YAML 解析阶段看不出来；首次流水线要盯一眼。
- **真 Cloudflare D1 的缺表文案没实测**：单测用的是 node:sqlite 的真异常 + 手工注入的 D1 风格文案。
  若线上文案不在 `no such table/column/function/index` / `does not exist` 里，首建豁免会退化成 503 闪一次（方向安全）。
- **R14 的 CI 真机数字没量**（本地 16 线程 vs CI 2 vCPU）；回访预算的 +300ms 下限是按「慢一倍」估的。
- 视觉基线的 10 处漂移仍在观察期，按纪律**不动基线**。

## 2026-11-03 · 重构 + 工程：路由表取代两条巨型 if 链，文档树归档重排（29.0.0）

独立审计 C 波剩余三项：**D2**（API 路由表）、**D6**（拆 `data.ts` 与 `App.tsx`）、**D7**（文档整理）。
三项合在一个版本里推，因为 D2 与 D6 动的是**同一张路由图** —— 分开做必然互相打架。

### D2 · 超时档位从「猜端点名」变成数据

`timeoutForEndpoint` 原来是 `/upload|download|backup|import|export|restore|icon/i.test(endpoint) ? 0 : 30s`。
改一个端点名就等于静默改一次超时语义，而且**现成的误伤已经在线上跑**：`recycle/restore` 与
`recycle/restore-batch`（回收站恢复，毫秒级 DB 操作）因为名字里带 `restore`，被划进了「不设超时」——
它们卡住时前端没有超时、没有报错，只有一个转不完的圈。现在这两条归位默认 30 秒。

- 新增 `shared/apiRoutes.ts`：`API_ROUTES`（57 条 `path → methods`）、`RETIRED_ROUTES`（6 条已下线）、
  `NO_TIMEOUT_ROUTES`（13 条）、`timeoutTierOf()` / `resolveRouteTier()`。
- `resolveRouteTier` 多回一个 `known`：「没登记过」不能被当成「跟默认一样」，否则新端点永远漏检。
  `tests/apiRoutesContract.test.ts` 拿它双向核：端点字面量（≥60 条，从源码抽）都要 `known`，
  表里每条都要有 worker 模块认领。
- **档位是精确路径匹配，不做前缀**：`notes/attachments` 一旦按前缀放宽，整个附件 CRUD 都会拿到 240 秒。
- 布局上分两层（进包的小表 / 被树摇的全量表）。不是洁癖：单表版本实测把 index chunk 顶到
  257.39 KB，`check:budget` 从 10/10 掉到 **8/10**（两条 5% 余量用例红）。合并回单表的前提是先把首屏腾出 1.4 KB。

### D6 · 后端：`worker/routes/data.ts` 的 864 行 if 链 → 7 行表驱动

`dispatchDataRoutes` 里那条从 `bootstrap` 一路 `else if` 到 1236 行的链，拆成 **50 条有序路由表**
（首匹配胜出）+ **53 个模块级 handler**，`dispatchDataRoutes` 现在只剩 7 行。

- **位置就是语义**。表头点名五个坑：`sites/changes` 先于 `sites/{id}`、`notes/shares` 先于
  `notes/{id}`、`notes/attachments/list|prune` 先于 `{id}`、`groups/{id}/share` 先于 `groups/` 的
  DELETE、`notes/folders|tags` 先于泛化 `notes/`。第 4 个最阴：`parseInt("1/share")` 是 1 且**不报
  NaN**，走错分支一声不响 —— 用户点「撤销分享」，整个分组连同卡片进回收站。
- 文件从 1236 行长到 **1565 行**。**行数涨了**，多出来的是 53 个签名与逐条「为什么这么写」；
  换掉的是一条没人能确认「新分支插对位置」的链。这个「变大」不打算藏。
- **等价性是证出来的，不是「测试过了」**：从 HEAD 抽出旧链 50 条条件、从新表抽出 50 条，逐位比对
  **零偏移**（差异条数 0）；再对 42 条路径 × 6 种方法 = **252 个组合**算「谁先命中」，两条链
  **完全一致**。`tests/routeCoverage.test.ts`（68 个 path+method 抽样）与 `tests/dataRoutes.test.ts`
  （666 行）**一字未改**，全绿。
- `writeGate` 从零参闭包变成 `writeGate(ctx)`（解构的就是原来捕获的同一个 ctx），8 处调用位置不变。

### D6 · 前端：`App.tsx` 移出 149 行，三块各自可读

- **`src/components/app/AppOverlays.tsx`**（151 行 / **9 个 prop**）：顶部九层浮层整块搬出。三条踩坑
  纪律注释**逐字保留**（分享对话框与断网横幅必须平级 / 限流条常驻自订阅 / 播报区先于内容）。
  9 个 `lazy` 声明跟着挂载点走，`ChunkBoundary` / `Suspense` / 条件挂载一个没动，块仍按需下载。
- **`navCenterArgs`**：`<NavCenterDialogBundle args={{…}} />` 里那段 82 行、80 字段的内联字面量，改成
  `return` 之前一个显式标注 `NavCenterDialogArgs` 的 `const`，JSX 里只留 `args={navCenterArgs}`。
  **刻意不加 `useMemo`、不提到模块级**：它现在是每次渲染新建的对象、引用恒变；加记忆化会改变
  中心的渲染时机（内部若 memo 或依赖引用相等的 effect，就是行为变更）。少一个字段 / 拼错一个名字
  现在直接在组装处报错，而不是等用户点开中心（那时已经在懒块里了）。
- **`notesBridges.ts`**（165 行）/ **`applyBootstrapExtras.ts`**（103 行）：两座笔记桥、bootstrap 的
  非分组落地各搬一块。合并顺序原样保留（`demoteLegacyDeadMarks` 必须在云端合并**之后**，否则开了
  同步的机器怎么都清不掉那些天天在用却挂着「失效」的站）；依赖用 `Pick`/`ReturnType` 从各 hook 取，
  不手抄签名。
- **350 行没做到，如实记。** 审计原话「拆成页面骨架 / 弹窗挂载区 / 底部栏三段」是错的：实测三段各需
  **60 / 60 / 48** 个 prop，硬拆就是审计自己在维度 3 里批评过的「9 个面板整包 props 接口（config 一组
  30+ 项）」。只有顶部浮层（9 个）能过 25 的线；根壳只要 3 个 prop，但要把 98 行 `OverlayHost` 塞进
  属性里，比不拆更难读。
- **真正的拦路是首屏预算**：`App.tsx` 的静态子组件进首屏包，而对象键名压缩不掉。三个边界实测
  **+968 B index**，真实首屏 gzip 余量 **5.09% → 5.03%**（只比 5% 那条线高 0.03 个百分点）。
  D 段 48 个值搬出去约 +1.5~2 KB gzip，属「拆完门禁必红」。**这条线现在是任何前端特性的硬约束。**

### D7 · 文档：顶层信噪比 1:2.5 → 可读，并加两条守卫

> ⚠️ 审计报告（2026-11-02 快照）在这项上给了三条**已经过期**的判据 —— `check:whitedot` 断链、
> `docs/README.md` 漏 `api/architecture/codes`、根 README 不链索引，**这三条在 26.0.x 波次就修好了**。
> 本轮先核实再动手，没有为了「对上报告」去改已经正确的东西。

- 归档 **27 份**一次性快照进 `docs/archive/`；`style-guide` / `state-map` 去掉日期后缀（长期维护文档
  不该带「过期日」）。**5 份**带日期但留顶层，各有理由：3 份被 `src/**` 的注释按原路径引用、1 份是
  现行移动端触控规范（`a11y-audit` 的分档照它实现）、1 份是架构决策记录（日期是决策日不是过期日）。
- **`CHANGELOG.md` 796,627 B → 92,305 B**，按月切四份归档（`docs/archive/changelog-2026-{09,10a,10b,10c}.md`）。
  段数守恒已核：**26 + 8 + 80 + 89 + 64 = 267**，与切分前的 267 段逐一对上；非空行 5,707 行逐行一致。
  `tests/changelogFreshness.test.ts` 关心的三件事（首行、最新一段留在根目录、日期倒序）全守住。
- 新增 `SECURITY.md`（报告渠道 + 密钥轮换 SOP + 两个信任开关必须成对 + 生产禁用开关 + 不该贴什么）、
  根目录 `CONTRIBUTING.md`（GitHub 只认根目录或 `.github/`，`docs/contributing.md` 一直看不见）。
- `docs/README.md` 整体重写：长期文档 11 份（`api`/`architecture`/`codes` 置顶）→ 已过期方案 5 份（标注
  落地状态）→ 顶层保留快照 3 份（写清理由）→ 归档 27 份 → changelog 归档 4 份 → 运维手册。
- **两条新守卫**（这是本轮最有价值的产出）：
  - `tests/packageScriptsExist.test.ts` —— `scripts` 里每条 `node script/*` 必须落得到实体，`npm run <name>`
    引用必须有定义，`ci` 整条链每一步都要能解析。**不钉死步数**（钉死就得手改，手改必然过时，那正是病根）。
  - `tests/docsIndex.test.ts` —— `docs/**` 每份 md 都必须出现在索引里（`archive/` 下的要带前缀）；
    索引 + 根 README + `SECURITY` + `CONTRIBUTING` 里 **82 条相对链接**必须解析到真实文件；另加一条
    反向守卫：`docs/` 顶层不许再冒出新的带日期快照（白名单 5 项附理由）。
  - 两条都做了**反向验证**确认会红（`touch` 一份没登记的文档 → 红；往 `CONTRIBUTING` 加一条死链 → 红；
    临时改掉 `probe-white-dot.mjs` 的名字 → 红），不是摆设。
- 顺手修掉 `src/utils/dialogChunks.ts:9` 引用的 `docs/perf-audit-plan-2026-10-17.md`（`git log --all
  --diff-filter=A` 确认**从未入库**，全仓唯一一处「被引用了但文件从来没存在过」的死路径）。只改注释。

### 验证

- `typecheck` 0 error；`eslint .` **0 error / 27 warning**（与改前逐条一致，新文件没引入 fast-refresh 违规）；
  全仓新增 `any` **0 处**。
- 全量单测 **3779 条 / 3778 pass / 0 fail / 1 skipped**（改前 3762，本轮新增 17 条：契约 9 + 文档索引 4 +
  脚本存在性 4）。
- `npm run build` 成功；`check:budget` **10/10**。
- `audit:visual` **10 个用例不一致 / 107 行明细**，与改前基线逐行 `diff` **输出为空**（没有跑 `--update`，
  10 处已知漂移的观察期到 2026-12-31）。
- `audit:a11y` **0 项不合格**（移动端 375×844，56 个可点元素）；`audit:contrast` 各面各态**各 0 处**；
  `smoke` 全部通过。
- 拆分过程的自审：误删过的 80 行 JSX 已从 `git show HEAD:src/App.tsx` 逐字节复原，并用「标签 / 属性
  多重集合比对」复核 —— HEAD 的 68 个 JSX 标签、266 个属性，在新代码里**每个都至少出现同样多次数**
  （缺失 0 处）。

## 2026-11-03 · 工程：视觉回归补 4 个高危面，基线 15 → 27 条（28.3.0）

独立审计 D4 项。`audit:visual` 原来只有 5 个场景（首页亮/暗、设置、记事本亮、分享页）× 3 视口 = 15 条基线；审计第 19 项点名的 `notes-dark` / 密码库 / 回收站 / 审计日志**从来没有基线** —— 这几屏跑位、变色、变号，只有真用户才会发现。

### 新增 4 个场景（× 3 视口 = 12 条基线）

- **`notes-dark`**：暗色记事本，选择器与 `notes-light` 完全一致、只换主题 —— 两边一旦分叉，原因必然是主题而不是采集面。
- **`vault`**：密码保险库。桩让 `/api/vault/keys` 回 `null`，覆盖「没建库 / 解锁」屏（Alert + 两个主密码框 + 创建按钮）。
- **`recycle`**：回收站（已并入「数据安全」长页）。等桩里的**站点条目**真的渲染出来再采（默认 tab 是站点页，分组条目在 tab=1，写进等待条件必然超时）。
- **`audit`**：审计日志（owner 专属）。等 `detail` 文案出现再采。

### 工具改造

- `visual-regression.mjs` 加 `openNavCenterPanel` 钩子：点 `#navigation-button` → 等 `[role="dialog"]` → 点 `[data-workspace-nav="<面板>"]`；三步全失败即抛错（选择器漂了就不量，量到的是错的东西）。手机视口不需要额外点「全部选项」——点导航项本身就切到面板步。
- 「就绪」判据用**文字闸门**而不是元素数：`.MuiButton-root` 的个数会随列表数据从 0 涨到 N，只在数据落地后才稳定。三屏都刻意不收 `.MuiListItem-root`（行数 0→3 的抖动面，收益不值）。
- `auditEnv.mjs` 补 3 组桩：`/api/vault/keys`（`null`）、`/api/audit`（`{success, log, hasMore}`）、`/api/recycle`（`{success, items}`）。**兜底的 `{success:true}` 对这三个是非法形状** —— `getVaultKeys` 会把真值对象当成「已建库」、`getAuditLog`/`getRecycleBin` 读不到字段，量到的是报错空壳（和附件抽屉那次同一个坑）。`deletedAt` 是 **unix 秒**（界面 `fmtDateTime(deletedAt * 1000)`），给毫秒会渲染成「57770 年」。
- `bump-version.mjs`：视觉基线 JSON 是生成物，不再参与版本档位计算。否则一次补 12 条基线（5000+ 行）会把纯测试变更判成 major（本次先跳成 29.0.0，已修正回 28.3.0）。

### 验证（重点：没洗白既有漂移）

- 改前：`audit:visual` **10 个**用例不一致，diff 明细 **107 行**。
- 4 个新场景各跑两遍（8 次运行 × 3 视口 = 24 次比对）：**全部 0 diff**。
- 改后无 filter 复跑：仍且仅 **10 个** 不一致；改前/改后明细 `diff` → **107 行 vs 107 行逐行完全一致**。没有跑无 filter 的 `--update`（那会把 10 处已知漂移一起洗白，观察期到 2026-12-31）。
- `scriptSyntax` 31/31；`bumpVersion` 11/11；`visualRegressionGuard` 5/5；`audit:a11y` 0 违规、`audit:contrast` 各面各态 0 处（改的是共用桩，顺带回归）。

### 覆盖边界（如实记）

- **密码库只覆盖「没建库 / 解锁」屏**，没覆盖解锁后的条目列表 —— 真解锁要跑 PBKDF2 并持有真密文，桩给不了，属另一轮（需要一组真密文夹具）。
- **回收站 / 审计只覆盖「有数据」态**，空态 / 失败态没有基线（要另加桩态切换，同 `setAttachmentMode` 的做法）。
- 登录页是浮层、不属于「3 类高风险弹窗」，本轮不做。

## 2026-11-03 · 新增 + 工程：429 限流可感知，离线队列跨标签页互斥（28.2.0）

独立审计 C6 项。两件都是「已经有一半、只差最后一步」的事。

### 429 可感知：把 `Retry-After` 从「读完即丢」变成按秒倒计时

服务端多处 429 早就回了 `Retry-After`（登录守卫、注册/恢复、写守卫都带），但客户端读完就丢——用户只看到一句「操作过于频繁」，不知道要等多久，也不知道等到了没有，只能反复点，还把限流窗口一次次续期。

- `ApiErrorInfo` / `ApiError` 加 `retryAfter?: number`：秒数是「还要等多久」的唯一权威来源，丢了就只能一辈子写「稍后再试」。
- `client.ts` 的 429 分支从响应头解析（`parseRetryAfter` **同时认 delta-seconds 与 HTTP-date**——中间隔着 CDN/反代，改形状不该让前端静默退化），能取到才带、取不到就留空，不编 0。
- 广播走 `transport.ts` 的 `notifyRateLimited`（与 401 的 `notifyUnauthorized` 同一套范式：传输层只发事件，不碰 UI 状态）。**广播在 throw 之前**——监听器是同步的。
- 新组件 `RateLimitBanner`：底部提示条「操作过于频繁，请 N 秒后再试」+ 逐秒倒计时，到 0 自动消失；连续被限流取更晚的窗口，不会把倒计时越改越短。没有限流事件时渲染 null，常驻挂载不占位。

服务端一行没动：`grep -rn "Retry-After" worker/` 复核到 8 处写头，与审计结论一致。

### 离线队列：跨标签页 flush 加 `navigator.locks`（降级到 localStorage 租约）

原来的多标签页保护只有两半：storage 事件合并（防「别页刚入队被覆盖写抹掉」）+ 服务端 `opId` 幂等（防「重复发做两遍」）。缺的是**同一时刻只让一个标签页重放**——两个标签页各有一份内存副本，同时 flush 会让 `sending` 状态互相覆盖，`drop` 的整份覆盖写盘还会把刚划掉的条目又捡回来。

- `flushOfflineQueue` 外面套一层 `navigator.locks.request("navihive-offline-queue")`，锁内**复查** offline / flushing / 队列空（等锁期间另一页可能已经做完）。
- 没有 Web Locks（老浏览器 / 非安全上下文）降级到 localStorage 租约：30s TTL、按**账号**分片，写不了 localStorage 就放行（那点互斥性由 `opId` 幂等兜着）。
- `navigator.locks` **调用时**读，不在模块加载时缓存——否则单测装不上替身，降级分支永远测不到。
- 循环体语义一行未改：退避、sending 租期、临时 id 翻译、失败列表全原样。

### 验证

- `grep -rn "rateLimited" src/`：0 → 1 行真实代码（`client.ts` 的 `API_ERROR_CODES.rateLimited`）。
- 新增 16 条用例：`rateLimit.dom.test.tsx` 10 条（429 带头/无头/HTTP-date/过去日期/乱码/非 429；组件不占位/文案/不缩短/0 秒忽略/归零自隐）+ `offlineQueueCrossTab.test.ts` 6 条（有锁：`requested=2`、`entered=2`、`peak=1`、去重 opId 全集、队列清空；无锁：别人持租约时 `calls=0` 且一条不丢、过期租约可抢、并发不重叠、按账号分片）。
- 全量单测 **3762 / 3761 pass / 0 fail / 1 skipped**；typecheck 0；eslint 0 error / 27 存量 warning；build 成功；`check:budget` 10/10；`audit:a11y` 双视口 0 违规；smoke 全通过。

### 预算：index chunk 266 → 270 KB（首屏 gzip 仍 5.1% 余量）

新代码 +2.51 KB（API 层 1.73 KB + Banner 0.78 KB），两笔都在故障路径上（被限流那一刻 / 联网重放那一刻），lazy 只会把「下载 chunk」加进那一刻。改之前基线其实已经过期 2.9 KB（250.01 → 实测 253.16，落在 5% 容差里没人发现），余量本已只剩 5.07%。抬到 270 后余量 5.60%，「谁再往首屏塞东西」的信号照旧抓得住；首屏 gzip 866.1 / 285.4（预算 920 / 300）没动。

## 2026-11-02 · 修复 + 工程：移动端触控目标达标，审计加双视口 fail-closed 闸门（28.1.0）

独立审计 D1 项：**移动端触控目标**。这件事之前从没被自动审计量过——`a11y-audit.mjs` 原有四段扫描面全在桌面视口跑（没开 `Emulation.setDeviceMetricsOverride`、没开触控仿真），桌面读数根本推不出真机。

### 先测量，再决定判据（没先定 44 再盲改）

加了 390×844 真仿真（deviceScaleFactor 3、maxTouchPoints 5），重加载让 `matchMedia` / MUI 的 `useMediaQuery` 按小屏重算。实测四个面（首页 / 设置中心 / 底部面板弹窗 / 批量操作条）共 **56 个可点元素**：

- **0 条低于 24px** —— 现有 WCAG 2.5.8 判据在移动端没回归；
- **35 条低于 44px**，但其中 **12 条已有 44×44 透明 `::after` 热区**（底栏 6 + 卡片设置/加星 6）。

所以结论是：**44px 是体验升级，不是修违规**。判据必须按「有效热区」量，按边框盒会把底栏（55.33×43.19，只差 0.81px）判成假红、逼人改本来没问题的代码。

### 6 处 CSS 修复（`src/index.css`，`(hover:none) and (pointer:coarse)` 守卫内）

- 顶栏 `header .MuiIconButton-root` → `header .MuiButtonBase-root`（文字按钮「显示设置」「打开记事本」一并进 44）；
- 伪元素热区名单补 `.nav-note-btn::after`（「绑定笔记」是移动端唯一完全没有热区的那颗）；
- `.nav-group-tools .MuiButtonBase-root::after` 补 44 热区，**走伪元素不撑高容器**（直接给 min-height 会把分组标题顶变形）；
- 弹窗右上角 × 用 `DialogCloseButton` 挂的 `[data-dialog-close]` 认（不用 `.MuiDialogTitle-root`——设置中心那套外壳没有 DialogTitle，同一颗 × 会落进不同档）；
- `.nav-bulk-bar .MuiIconButton-root` 补 44×44（「退出多选模式」36×36）；
- `.nav-display-pill .MuiIconButton-root` 补 min-width（「进入多选模式」36×44 宽不够）。

底栏 `py 0.5→0.6` **没做**——有效热区口径下 43.19 已被 44 伪元素兜住，不必动。

### 审计脚本：report-only → fail-closed 硬判据（双视口）

`script/a11y-audit.mjs` 那段移动端测量翻成真闸门：

- 三档阈值写死 `critical 44 / deco 40 / accept 24`，**按有效热区 = max(边框盒, ::after 伪元素)** 判定；关键/装饰档量伪元素热区、可接受档量边框盒即可。
- **双视口** `MOBILE_VIEWPORTS = [390×844, 375×844]`（iPhone SE 档），两档都判。
- **fail-closed**：仿真前提（viewport / matchMedia / maxTouchPoints / nav-touch）任一不成立、或四个面任一打不开 → 该视口/面直接判红，不再只打印「⚠️ 未测到」。末尾并入全局 `failures`，与原有各段共用同一出口。
- 有效热区口径修正：仅在祖先 `overflow ≠ visible` 时才与祖先求交（`overflow: visible` 的祖先不裁——伪元素溢出后仍真实可点，否则分组工具条会假红）。
- **反向验证**：临时把 `.nav-group-tools` 热区改成 20px，如期触发 8 条精确失败（装饰档要求≥40，实测 44×36）、审计整体判红；改回后回归 0，`grep` 确认无残留。

报告从「测量」升级为「测量 + 修复」：`docs/mobile-touch-audit-2026-11-02.md` 补了 6 处修复清单、双视口 0 违规结论、fail-closed 说明、复现方式。

## 2026-11-02 · 重构 + 修复：弹窗正文统一，断点收成一个真源（28.0.0）

审计第 2 批 C5 项。两件事：**给剩下的 19 个弹窗套上公共外壳**，以及**把断点从「5 个小数尾巴」收成一个人能讲清的真源**。

### 弹窗正文：19 个文件、21 处 `<DialogContent`

`src/components/dialogShell.ts` 里的三区外壳（`dialogPaperSx` / `dialogTitleSx` / `dialogContentSx` / `dialogActionsSx`）此前只有 11 个文件在用，剩下 19 个各写各的内边距 —— 同一个「确定」按钮在不同弹窗里高度不一样，就是从这里来的。

现在全部套上。**但不是无脑替换**，三个判断点值得记下来：

- **`helperText` 选择器会互相整块覆盖**。`dialogContentSx` 里有一条 `"& .MuiFormHelperText-root": { overflowWrap: "anywhere", wordBreak: "break-word" }`（帮助文字里常带长 URL / 长 token，窄屏会整段伸出输入框）。而 AccountDialog / AddSiteDialog / ConfigPanelBody / SiteSettingsModal 四个文件**本地也写了同一个选择器** —— `{...dialogContentSx, 本地同名键}` 会把外壳那条整块替换掉，等于「套上了，但外壳存在的理由丢了，而且看不出来」。这四处把断词那两行显式并进本地对象，并注明来源。
- **`p: 2` 不要用来覆盖外壳的 `pt: 0`**。`{...dialogContentSx, p: 2}` 能不能生效取决于 emotion 把 `padding` 排在 `padding-top` 之后 —— 读代码的人看不出结果。改成显式 `pt: 2, px: 2, pb: 2`，像素与改造前逐位相同。`p: 0` 同理。
- **`pt: 0` 依赖「上面有标题区」**。所以逐个文件确认了有没有标题行；6 个「纯套用」的都核过确实有 `<DialogTitle sx={dialogTitleSx}>`。剩下的按各自的 `pt` / `flex` 需求做展开覆盖，12 处每处都在行内写了为什么偏离。

顺带补了 `TagManagerDialog.tsx:115` —— 同一文件里另有一处 `<DialogContent>` 写着 `{pt: 0, pb: 1}` 而没走外壳，标签名一长那里就会缺断词。

### 断点：`.95` 和 `.98` 是两套语义，不要「统一」

全站曾有 5 个小数尾巴（359.98 / 599.95 / 599.98 / 899.95 / 899.98），审计原文也把它们当成「随手写的数字，收敛成 2 个常量」。**核下来不是**：

- **`.95` = 对齐 MUI `theme.breakpoints.down()`**。MUI 把 `down('sm')` 编译成 `(max-width: 599.95px)`（600 − 0.05）。手写的媒体查询必须**逐位相等**，写成 `.98` 会让 599.96~599.98 这 0.02px 里「CSS 认为是大屏、MUI 认为是小屏」。
- **`.98` = 手写档位，为了吃掉亚像素宽度**（1920 屏放大到 110% 时视口上报 899.5，`max-width: 899px` 会漏掉它）。站内「小屏」这个概念一律用这一档。

一律改成 `.98` 是错的。所以新增 `src/theme/mediaQueries.ts` 作为真源，把两套语义分别写成常量并在注释里讲清来历：`QUERY_BELOW_600`（599.95，对齐 MUI）/ `QUERY_BELOW_900`（899.98）/ `QUERY_BELOW_360`（359.98）/ 以及三对互补上界 `QUERY_AT_LEAST_900`、`QUERY_COMPACT_DESKTOP`、`QUERY_GROUP_RAIL_MIN`、加上 `QUERY_LANDSCAPE_SHORT` 和能直接当样式键用的 `MQ_BELOW_600`。

**修掉的真 bug**：`src/index.css` 的「横屏矮屏」段写着 `max-width: 899.95px`，而「底栏出现」是 `899.98px` —— 在 899.96~899.98 这 0.03px 的带子里，底栏已经出来了，弹窗却还按大屏算高度。这两个判断是同一件事的两面（手机一横过来同时成立），统一到 `899.98`。

**顺带收掉的第三套**：`useThemeController.ts` 里有 6 处 `@media (max-width:600px)` —— 无偏移，且 600px 本身落在 MUI 的 `sm` 区间内，于是 600px 宽时「小屏舒适内边距」和「sm 及以上」两套样式同时生效。改成 `MQ_BELOW_600`（= 599.95）。

### 新增守卫：`tests/mediaBreakpoints.test.ts`（4 条）

CSS 读不到 TS 常量，`index.css` 里只能写字面量 —— 两份数字**必然**存在，这才需要守卫：

1. 抽出 `src/index.css` 里所有 `max-width` / `min-width` 的 px 字面量，与真源导出的常量集合比对，**多一个就红**（白名单是从常量集合算出来的，不是手抄；报错会直接告诉你「该用哪个常量名」）；
2. 断言三条核心档位确实还在 CSS 里被用着（防止整段 `@media` 被删后测试「空对空」绿着）；
3. 断言互补关系没被改坏（`899.98 + 0.02 = 900`、`1343.98 + 0.02 = 1344`；横屏矮屏段的宽度字面量必须等于 `QUERY_BELOW_900` —— 就是钉住上面那个 bug）；
4. `script/ci-smoke.mjs` 里的 `matchMedia` 字面量（mjs 引不到 TS）也逐个数比对。

反验过一次：临时往 `index.css` 追加 `@media (max-width: 767px)`，用例如期红并报出 `767px`，随后还原。

### 没动的两处（有理由）

- **`HeaderActions` / `DisplayControls` 的门槛走 MUI 的 `display: { md: … }`**，由 `theme.breakpoints.values.md` 派生，本身就是单一真源、值正好等于 `QUERY_AT_LEAST_900`。只有注释里的裸数字换成了常量名。
- **`GroupNavRail` 的 1344 仍是算出来的**（`RAIL_CONTENT_MAX_WIDTH + 2 * (EDGE + GUTTER)`），没有反过来引用常量 —— 那会把「布局常量」和「断点常量」耦合起来，属设计决定。守卫目前保不住「栏宽常量改了而 1343.98 没跟着改」，已记入待办。

## 2026-11-02 · 性能：首屏少下载 30 KB，余量 3% 回到 7%（27.0.1）

审计 D5 项。**`src/` 一行业务代码没改**，改的是「谁算首屏」这件事本身。

### 根因：首屏扫描器跟着 `import type` 走

`vite.config.ts` 的 `scanFirstScreenMui()` 是**源码层静态扫描器**（不是 rolldown 的模块图），它算出的 MUI 集合决定哪些 `@mui/material` 文件归进 `mui-core` 块；而 `mui-core` 是入口静态依赖，会进 `index.html` 的 `modulepreload` —— 全额计入真实首屏。

问题是它不看「这条 import 运行时存不存在」，于是三条**类型导入**被当成了静态边：

| 位置 | 语句 |
|---|---|
| `src/App.tsx:125` | `import type { NavCenterPanelId } from "./components/navigationCenter/model"` |
| `src/components/OverlayHost.tsx:19` | `import type { CommandItem } from "./CommandPalette"` |
| `src/hooks/useAppCommands.ts:12` | `import type { CommandItem } from "../components/CommandPalette"` |

扫描器顺着它们走进**整棵懒加载弹窗树**（导航中心九屏 + 命令面板），把那些弹窗专用的组件判成「首屏要用」：`Alert`、`Dialog/DialogActions/DialogContent/DialogTitle`、`Switch`、`LinearProgress`、`FormControlLabel`，外加 12 个 `@mui/icons-material`（Lock / Logout / Palette / Storage / Insights / OpenInNew / Bolt / WarningAmberRounded / VisibilityOutlined / VisibilityOffOutlined 等）。**它们一个都不在真正的入口静态图里**，纯属白背。

### 修法

`STATIC_IMPORT_RE` 删掉 `(?:type\s+)?`（不再匹配 `import type … from` / `export type … from`），`clauseNames()` 把 `{ useTheme, type SxProps }` 里的 `type` 绑定**整条丢掉**（旧代码只是 `.replace(/^type\s+/, "")` 剥前缀，名字照样被当组件去查）。两条都写了「为什么」和实测数据在原地。

归错方向是安全的：值导入才真的把模块拖进来，漏判只是少一点分包稳定性，字节不涨。

### 结果

| 块 | raw | gzip |
|---|---|---|
| `mui-core` | 331.2 → **300.1** KB（−31.1） | 102.4 → **94.1** KB（−8.3） |
| `index` | 252.1 → 253.1 KB（+1.0，几个模块落回自然分包） | 82.9 → 83.3 KB |
| **真实首屏** | 888.6 → **858.5** KB | 291.2 → **283.2** KB |
| **余量** | 3.5% → **7.2%** | 3.0% → **5.9%** |

首屏 JS 仍是 5 个块（那条「不超过 8 个」的请求数判据不受影响）；`precache-manifest` 双向对齐、无缺失文件，`ConfirmDialog` 仍在 core 里（离线删除链路不受影响）。

### 门禁收紧（这次不只改代码）

`tests/bundleBudget.test.ts` 的余量断言 **3% → 5%**，用例标题同步改 —— 按 2026-10-24 那次留下的约定：「真把首屏压下来之后，把断言和标题一起改回 0.05，同一处改，别只改一个」。基线常量同时照实下调到 858.5 / 283.2（该文件对这种下调的要求是「若是有意压下去的，把基线更新掉」）。

顺带把四处**现在时**的过期说法改掉（`src/App.tsx`、`src/components/NavigationCenterDialog.tsx`、`tests/navigationCenterLazyGuard.test.ts` 的头注与断言消息）。历史叙述里那些「当时只剩 3%」保留原样 —— 那是那天的真事。

### 还留在桌上的两块肉（这次没动，风险高一档）

1. **dnd-kit 占 `vendor` 的 78%（≈59 KB raw / 28 KB gzip）**。看着像能懒加载，其实不行：`useSortable` 在 `SiteCard` / `GroupCard` 的**渲染期**就要跑，不是「进排序模式」才跑。真要砍得把「可排序卡片外壳」抽成懒组件、非排序态渲另一套 DOM —— 会动卡片结构与 CSS，必须配视觉回归 + a11y 审计。
2. **`@mui/material/Select`（≈8 KB）**是被 `HeaderSearchBox` 的 `TextField` 带进来的：MUI 的 `TextField.mjs` 内部静态 `import Select`（它要支持 `select` prop），而搜索框只用一个普通文本框。换 `OutlinedInput` 能省 8~10 KB，但会改搜索框的 DOM 结构与视觉。

## 2026-11-02 · 性能 + 安全 + 重构：独立审计的第 2 批（27.0.0）

第 2 批 7 项（C1–C7），顺手把 D3 的迁移记账一起落地 —— 它们都动数据库层，分开推要跑两轮迁移。**本版零首屏字节变化**，改的全是主线程之外的路径：限速怎么存、密钥怎么派生、鉴权读几次库、迁移失败记不记得住。

### ⚠️ 回滚须知（这条比升级步骤重要）

**凭据密文格式换了，回滚会「看起来把密码全丢了」。** 新写入的密文用 `enc$4$`（旧密钥）/ `enc$5$`（数据密钥），而 26.0.x 及更早的 `parseEnc` 只认 `enc$0$`–`enc$3$`，遇到不认识的 keyId 是**静默返回空串**——不报错、不告警，界面上就是密码一栏空了。库里的字节还在，用本版能读回来。

所以：本版上线后若要回滚，必须先确认「升级之后没写过任何凭据」；混跑（新旧实例连同一个库）同样会踩。真需要回滚又已经写过，就用本版导出一次备份、再在旧版上恢复（备份文件走的是明文 JSON，不受 keyId 影响）。

### 性能

- **限速状态从「一把锁一坨 JSON」改成「一个桶一行」（C1）**。此前 10 个 `auth.*Guard` 配置键各存一整块 `{version:2,buckets:{…}}`，单键上限 2000 个桶、约 220 KB，每记一次失败尝试都要把这 220 KB 读出来、改完、CAS 写回去，最多重试 3 次。现在是一条 `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING`——**原子递增，不再读-改-写**，并发下也不丢计数（此前同桶两次固定 `count=1` 会互相覆盖，爆破可以一直续杯）。旧 JSON 不再被读取，新表由迁移第 19 步 `rate-limit-bucket-rows` 逐键搬过去（只搬「还在锁定期」或「24 小时内动过」的桶）；老库读不出来时跳过那一把锁，不给整步失败。**注意：升级那一刻正在锁定中的限速会按搬迁结果延续，没搬过去的等于清零**——这是升级的一次性代价，不是漏洞。
- **冷启动的密钥派生从 N 次降到 1 次（C2）**。`aesKeyCache` 的键里含盐，而旧格式是**逐条随机盐**，于是进程刚起来时解 100 条密文要跑 100 次 PBKDF2（每次 10 万轮），自托管冷启动第一次打开设置页能卡住好几秒。新增 keyId `4`/`5` 用「`secret` 派生出的确定性盐」：同一次启动内所有密文共用一份派生结果，100 条密文只跑 1 次 PBKDF2。为什么不用进程级随机盐——那会让每次重启都重算一遍全库密钥，且缓存键无法命中；确定性盐的安全代价写在了 `src/API/crypto.ts` 的设计注释里（盐的作用是防彩虹表，而这里的输入是 32 字节随机密钥，本身不在任何表里）。旧 keyId `0`–`3` 仍能读，只是慢。
- **鉴权从三次读库合成一次（C3）**。`verifyToken` 原本依次查 `users.token_version`、再验签、再查 `token_blacklist`，每个带令牌的请求三次往返。现在一条 SQL 用三个标量子查询一次取回（版本号 / 账号态 / 黑名单命中），**黑名单判定被提前到验签之前**——与改造前等价（验签前本来就在用未验签的 uid 查 `users`），顺序理由写在了代码注释里，别「修」回去。历史上的库形态（缺表缺列）会走降级路径，与改造前**逐字一致**的三次独立读，所以老库不会因此 500。会话活跃时间的两次 touch 也合并成一次 `db.batch`。
- **`mapWithConcurrency` 挪出后端方法层（C4）**。它是纯异步控制流函数，却长在 `API/methods/transfer.ts` 里，钩子一 import 就把 1600+ 行带 D1 语句的方法层整个拖进前端依赖图。现在搬到 `src/utils/concurrency.ts`，`transfer.ts` 保留一行再导出，既有 import 路径不用改。

### 安全

- **健康检查终于分得清「活着」和「能用」（C7）**。新增 `GET /api/healthz`（进程活着就 200，不碰库）与 `GET /api/readyz`（真跑一次 `SELECT 1`，库不可用返回 503）。两个都**不鉴权、无副作用、`Cache-Control: no-store`**。`Dockerfile` 的 `HEALTHCHECK` 从 `/api/init` 改到 `/api/readyz`——打 healthz 会让「库挂了但进程还在」被判成健康，自动回滚于是永不触发。`server/upgradeHealth.ts`、`deploy/selfhost.md`、`docs/api.md`、`script/uptime-check.mjs` 里指向旧端点的说法一并改掉。
- **数据面补两条审计**：记事本导入（`notes/import`）与整体恢复（`restore`）此前不留痕——两个都是「一次性写进大量数据」的入口，出事时最需要知道谁在什么时候干了。现在分别记 `data.import` / `data.restore`，审计中心的标签也补上了。

### 重构

- **迁移失败开始记账（D3）**。新增 `schema.log`（`MigrationLogEntry[]`）：第几步、叫什么、成功还是失败、耗时多久、错误摘要。此前迁移某一步失败只留在当次启动的日志里，重启一次就没了——用户看到的现象是「功能时好时坏」，而唯一能定位的东西被日志滚动冲掉了。`dbReady` 的语义也改成「**这次跑完还有没有失败步骤**」，于是 `/api/readyz` 能如实回答「schema 没就绪」。
- **ESLint 加两条分层规则（C4）**：`src/**` 不许直接 import `API/methods/*` 的实现（要经 `navigationApi` 那层门面），`worker/**` 不许 import `src/components|hooks|context`。两条都开了 `allowTypeImports`——跨层只传类型是允许的。规则本身有 66 行注释记着两个坑：`export { x } from` **不产生本地绑定**（照抄会让调用点 `Cannot find name`），以及 glob 里的 `**/` 含 `*/` 序列、写进块注释会让整个配置文件 `SyntaxError`。

### 工程

- 单测从 3687 项涨到 **3742 项**，新增 5 个文件：`authProbe`（含黑名单读异常 fail-closed、`!dbReady` fail-open、降级路径与三次独立读的 `deepEqual` 等价）、`cryptoSingleSalt`（核心断言是「100 条新密文冷解密只调 1 次 PBKDF2」，对照组 5 条旧密文必须调 5 次）、`rateLimitBucket`、`migrationLog`、`healthRoutes`；`dataRoutes` 补 6 条审计用例，`dockerDeploy` 把断言从 `/api/init` 改成 `/api/readyz`。
- `tests/helpers/fakeBucketTable.ts` 把限速桶的内存版抽成公共桩（原子递增 / `DO NOTHING` 不覆盖 / 裁桶跳过锁定中，三处语义与真 SQL 对齐），避免两个用例各自实现一遍后在「`ON CONFLICT` 到底该 +1 还是覆盖」上漂移。
- 路由覆盖清单补齐 healthz / readyz（60 → 62 条）。清单本来就是抽样，用例名也改成了「抽样，不是穷举」，免得下次有人拿它当保护强度。
- 严格层守卫：`src/utils/concurrency.ts` 的下标读取改走 `entries()` 元组，不靠 `!` 关检查，豁免清单维持 62 条不变长。

## 2026-11-02 · 工程：修正自托管文档里过期的用例计数（26.0.1）

`deploy/selfhost.md` 三处写死的数字与实际不符：冒烟写「26 项」实跑是 33 项，`tests/server*.test.ts` 写「35 条」实际 61 条。这类数字和上一版修掉的 CI「26 个步骤」是同一类问题 —— 门禁每加一步它就过期一次，而读者会把它当成当前保护强度。改法是**删掉数字**而不是改成新数字（改成 33 一样会过期），项数由脚本自己统计并打印。`tests/dockerDeploy.test.ts` 的「17 条」核对无误，保留。纯文档改动，产品代码零变更。

## 2026-11-02 · 安全 + 工程：独立审计的第 0 / 1 批（26.0.0）

对全仓做了一次**从零、不采信历史结论**的 16 维度独立审计（产出 27 项问题），本版落地第 0 批（零/极低代码）与第 1 批（1 个 P0 + 4 个 P1）。

### ⚠️ 升级必做（两条，必须都看）

1. **反代部署要显式打开两个信任开关**。`NAVIHIVE_TRUST_XFF` 的默认值从 `1` 改成 `0`（`docker-compose.yml` 同步），并新增独立开关 `NAVIHIVE_TRUST_X_REAL_IP`（默认 `0`）。前面挡了反代的部署，请在 `.env` 里**两个都设 1**：
   ```
   NAVIHIVE_TRUST_XFF=1
   NAVIHIVE_TRUST_X_REAL_IP=1
   ```
   漏设的后果不是「限速变严」而是**限速全部塌缩成一个全站共享桶**：反代后 socket 恒为 `127.0.0.1`，`clientIp()` 拿不到真实来源，一个人连错 5 次密码就把所有人（含站长自己）锁在门外。用本仓 Nginx 模板时两个开关都要开；反代是 Caddy / Traefik（默认不写 `X-Real-IP`）时**只开第一个**，第二个开了等于把客户端自带的头当真。
2. **WebDAV 备份现在默认加密，且无法降级为明文**。没设 `webdav.backupPassword` 时，口令由 `AUTH_SECRET` 派生（HMAC-SHA256，派生输入带账号 id）。代价是：**换 `AUTH_SECRET` / `DATA_ENCRYPTION_KEY` 之后，旧的自动加密备份就解不开了**。要跨实例迁移、长期存档或预计轮换密钥，请另设一个独立的备份密码。既没有 `AUTH_SECRET` 也没有 `DATA_ENCRYPTION_KEY` 的实例，自动备份会**直接失败并提示去配置**（此前是静默明文上传）。升级前上传的明文备份仍能正常恢复（服务端先看文件头）。

### 安全

- **备份默认加密（P0）**：`worker/webdav/autoKey.ts` 新增 `deriveAutoBackupKey` / `resolveBackupPasswords`。此前「有口令才加密、没口令就明文 gzip」，而导出的备份里含**解密后的站点密码**（`src/API/methods/transfer.ts`），等于每周把全站凭据交到网盘上。现在上传侧一律 `encryptBackup`，一把根密钥都拿不到时**先于 `exportData()`** 就失败（不在内存里先摆一份明文）；记事本备份同样改成**无条件 fail-closed**，删掉了「调用方没传 env 就退回明文」的静默路径；
- **恢复侧同改**：`webdavDownloadBytes` 第三参放宽为 `string | readonly string[]`，**只下载一次**、在同一份字节上依次试「用户口令 → 自动口令」。否则「先没设口令、后来设了」的用户会把自己的备份误报成密码错误；失败文案会写明试过几个候选；
- **拆开 `TRUST_XFF` 与 `X-Real-IP` 的信任（P1）**：`clientIp` / `clientBucket` 增加独立开关。原来只开 `TRUST_XFF` 就会读 `X-Real-IP`，而反代若没**覆盖写**这个头，客户端自带的头每请求换一个就是全新空桶，登录 / 注册 / 分享口令的爆破锁全部失效。自托管入口在非双开时会主动 `delete("x-real-ip")`，启动日志打印两个开关状态并对「只开一个」的组合告警；
- `exportBucket` / `writeBucket` / `endpointBucket` / `shareBucket` 四个派生桶函数同步加参透传。

### 修复

- **`notesBackup` 的 `IN (...)` 无上限（P1）**：附件 id 来自对全部笔记正文的正则提取，没有任何上限，超过 99 个时会在 D1 上抛 `too many SQL variables` 让整次备份静默失败 —— 而本机 SQLite 的参数上限是 32766，这个缺陷在本地**永远测不出来**。改用已有的 `chunkByParamBudget` 切批，并显式预留 `user_id` 那一位；
- **`ALLOW_PLAINTEXT_SECRETS` 静默不生效（P1）**：`navigationApi.ts` 一直在读它，但它从来不在自托管的透传白名单里 —— 设了等于没设、还没有任何报错。已补入，并加了编译期断言防止复发；
- `package.json` 的 `check:whitedot` 指向一个不存在的文件，改为 `script/probe-white-dot.mjs`；
- `script/coverage.mjs` 里「由 `smoke:selfhost` 覆盖」是条假注释（该脚本只做 HTTP 断言、不起服务），改为如实描述；`src/API/apiError.ts` 里 429 的注释宣称「有重试按钮」，实际只有通用 toast、`Retry-After` 无消费者，一并改正。

### 重构

- **`Env` / `D1*` 契约收进 `shared/`（P1）**：新建 `shared/env.ts`，把原先 `worker/types.ts` 与 `src/API/schema.ts` 两份**各自漂移**的声明合成一份（17 个键取并集，注释逐条合并；顺带修正 `AUTH_RECOVERY_PUBLIC_KEY` 两处说法矛盾 —— 实测 `crypto.ts` 是 SPKI 优先、32 字节裸公钥兜底）。两个原文件改成纯再导出，既有 import 路径不变；
- **编译期断言焊死透传清单**：`Env` 里新增配置键却忘了投递，`tsc -b` 直接红（反向也钉：清单里出现 `Env` 没有的键同样红，堵住「拼错一个字母 → 永远投递不出去也不报错」）。`EXPLICIT_ENV_KEYS` 单独列出 `AUTH_ENABLED` / 两个信任开关 —— 它们由入口显式赋值、不走照搬循环。

### 工程

- **`smoke:selfhost` 接进 CI（P1）**：这个入口此前**没有任何门禁**。脚本原来只做 HTTP 断言、不起服务，直接接进 CI 必红，所以先给它加了自举分支（缺 `dist-server/entry.mjs` 时提示先 `npm run build:server`，自动挑空闲端口 + 临时库 + 跑完收掉并删目录），`argv[2]` 旧行为保留；`build_and_e2e` 新增一步，README 与 `deploy/selfhost.md` 的用法补上 `--`（npm 只有见到 `--` 才转发位置参数）；
- 严格层棘轮收紧：`worker/loginGuard.ts` 本轮已零报错，从 `script/strict-idx-exempt.json` 豁免清单删除（63 → 62 条）；
- CI 里「六条 e2e」「26 个步骤」两处写死的计数已失真，改为不写死数字（步骤总数随门禁增长，写死必然过期）。

### 测试

新增 4 个用例文件、净增 22 条：`clientBucketTrust`（9 条，覆盖双开关的真值表与伪造头）、`envContract`（4 条，含源码文本反向断言）、`webdavBackupEncryption`（6 条，断言上传字节真是密文、无根密钥时**一次 PUT 都不发**）、`notesBackup` 补 200-id 切批与 99/100 边界。另改写 5 个既有用例文件里编码了旧语义的断言（「没口令就明文上传」「只开 TRUST_XFF 就读 X-Real-IP」）。

## 2026-11-02 · 性能 + 修复：记事本 / 设置打开加速（25.2.2）

记事本与设置本来就是懒加载、且有三层预取，但打开仍偏慢——排查定位到两处真缺口 + 一处体验债，三条一起修掉：

**性能**
- 移动端「笔记」tab 与「设置」tab 补预取：移动端无 hover，旧逻辑触屏点开才现场下载 357KB 的 NotesOverlay 块。现在 tab 的 `pointerdown` / `pointerenter` / `focus` 即触发预取（`MobileTabBar.tsx`，笔记取 `notesOverlay`、设置取 `navigationCenter`），触屏按下到点击之间就开始取块；
- 空闲预取队尾补 `notesOverlay`：桌面 hover 笔记按钮已能提前取，这里兜底「开了页面没碰过按钮」的路径，且刻意排最尾——等前面 23 个常用小件都备齐、浏览器确实闲下来才取，不抢首屏带宽（`App.tsx` 的 `prefetchOnIdle`）。

**修复**
- 记事本整块加载有骨架了：`NotesOverlay` 是整页级懒块（本体 357KB + 编辑器 564KB），弱网真会等几秒，原来加载间隙是空白。`ChunkBoundary` 新增 opt-in 的 `loadingFallback`（默认仍 `null`，其余 30+ 弹窗零行为变化），记事本这一处挂骨架。骨架本身走**动态 import**（懒块），不写进 `index.html` 的 preload → **不计入首屏预算**（那条 3% 余量红线盯的是首屏字节），首屏体积与预算测试均无回归。

## 2026-11-01 · 工程：cron e2e 断言跟进自动备份保留 3 份（25.2.1）

25.2.0 把 WebDAV 自动备份改成滚动保留 3 份（DATA-9）后，`script/cron-e2e.mjs` 仍按旧语义（只留最新一份）断言「第 2 份备份后立即删第 1 份」，CI 红本地绿（本机 workerd 起不来，e2e 只能 CI 验）。断言改为新语义：2 份 / 刚好 3 份时谁都不删；第 4 份上传后回删最老一份、网盘剩 3 份——滚动清理与「手动备份永不入列」的覆盖反而更完整。纯测试改动，产品代码零变更。

## 2026-11-01 · 安全 + 工程：审计 P2 批次二·三（波次 1+2，25.2.0）

审计 P2 的第二、三波次（9 项，其中 ARCH-7 核实无需改动）。

**安全**
- 明文存量密码比对改常数时间：`src/API/crypto.ts` 新增 `constantTimeEqualString`（TextEncoder → UTF-8 字节 → 复用 XOR 累加），`verifyPassword` 明文分支不再用 `===`。不用 `node:crypto.timingSafeEqual` 是刻意的：Worker 无 `nodejs_compat`，三端通用的 XOR 实现才是唯一解。

**修复**
- 附件上传孤儿对象可自愈：`worker/routes/data.ts` 的 `createAttachment` 元数据写入失败时不再只抛 500 —— 先把 `{storage, objectKey}` 入队现有附件 GC 任务（`auth.attachment.gc.<id>`），已传到存储层的对象会被定时清理回收，不留永久孤儿。

**新增**
- WebDAV 自动备份滚动保留 3 份：`worker/webdav` 的 `MAX_AUTO_BACKUPS=3`，`selectAutoBackupsToPrune` 加 `retentionCount` 参数（缺省 1，向后兼容），`pruneAutoBackups` 改为列目录后按时间倒序保留最新 3 份、其余自动备份回删；手动备份铁律不变（永不入列）；
- 自托管 SQLite 备份脚本：新建零依赖 `scripts/backup-sqlite.mjs`（`VACUUM INTO` 在线快照 + `integrity_check` + 表数量比对 + SHA-256，`--check` 报距上次快照天数），补上 `deploy/selfhost.md` 第七节「仓库里没有 backup.sh」的缺口；
- 自托管 audit_log 自动清理：`server/entry.ts` 新增 `cleanupAuditLog()`（删除 365 天前的审计记录，fail-safe），并入 `runServerCron()`，两处 cron 入口统一走它；文档补「审计日志保留预期」小节；
- 自托管备份快照自检：服务启动时非阻塞检查本地快照距今天数（默认 30 天，`NAVIHIVE_BACKUP_WARN_DAYS` 可调），超期打警告——备份断了好几周这种事不能再靠人肉发现。

**性能**
- 语义搜索结果 LRU 缓存：`src/hooks/useSemanticSearch.ts` 加 20 条上限的 LRU（命中直接返回跳过模型调用，失败不写缓存保留重试），重复搜索不再反复打 AI。

**工程 / 重构**
- 镜像发布打源码 tag：`.github/workflows/docker-publish.yml` 的 `contents` 提权到 `write`，merge job 在发布成功后幂等打 `v<version>` git tag（仅 main、已存在跳过），镜像版本与源码 tag 对齐；
- Markdown callout 与高亮抽成语义 token：`src/index.css` 新增 `--callout-note/tip/important/warning/neutral/fold-*`、`--md-highlight-bg`、`--md-mark-bg`（亮暗两态各一份），`src/utils/markdownToReact.tsx` 16 处裸色值改 `var(--token, 原值)`；硬编码色守卫对应 cap 16→3（棘轮只降不升）；
- ARCH-7（App.tsx 的 Mock 导入污染生产包）核实为不成立：`import.meta.env.DEV` 被 Vite 常量折叠 + DCE，Mock 不进生产包，无需改动。

## 2026-11-01 · 安全 + 工程：审计 P2 批次一（25.1.0）

全维度重审遗留 P2 项的第一批低风险加固（其余批次另述）。

**安全**
- 邀请码审计脱敏：`worker/routes/account.ts` 的 `auth.invite` 审计 detail 只留邀请码前 4 位 + `****`，敏感凭证不再全文落审计；业务返回值仍透传完整码；
- 迁移表名校验：`src/API/methods/migration.ts` 的 `hasColumn`/`migrateOwnerColumns` 入口加 `/^[a-z_][a-z0-9_]*$/` 断言，非法表名直接抛错（防注入）；
- 服务端错误审计 ctx 透传 `trustXFF`：`worker/index.ts` 的 `recordServerError` 增加参数，审计带入真实客户端 IP。

**性能**
- 拖拽误触阈值：`src/App.tsx` 的 `PointerSensor` 激活距离 `1`→`5`px（避免点按被当成拖拽）；
- `SiteListBody` 用 `memo` 包裹，避免父级状态抖动导致的整列重渲染；
- `App.tsx` 抽出 `clearSearchQuery` 的 `useCallback`，消除每次渲染新建闭包。

**工程 / 重构**
- Dockerfile 两阶段基础镜像 `node:24-slim`→`node:22-slim`，与 `.nvmrc`/`ci.yml` 对齐（node:sqlite 行为一致，避免本地与镜像跑出不同结果）；
- `src/index.css` 滚动条占位 `scrollbar-gutter: stable` 补 Safari 18.2+ 版本边界注释；
- `src/utils/markdownToReact.tsx` 补「经批准的循环 import 豁免」注释（被引用方不反向 import，无有害循环）；
- 新建 `docs/codes.md`：内部代号索引（B1/B3/B4/A1~A3/Q-3/V1/V3 等，标注重名冲突），避免代号歧义；
- CI 视觉回归 step 补注释并明确摘帽期限 2026-12-31（保持 `continue-on-error` 现状，规避 CI 字体差异假红）。

## 2026-11-01 · 工程：cron e2e 失败时输出服务端日志（25.0.1）

CI「构建 + 端到端」job 的 cron e2e 出现一次 `PUT configs/webdav.lastAutoBackupAt → 500`（连锁 3 条 FAIL），但 wrangler 的服务端 stack 只落在 runner 的 /tmp 日志里、stdout 看不到。给 `cron-e2e.mjs` 的拨时间步骤加常驻诊断：失败时打印响应体与 wrangler 日志尾部，后续排障不用再盲猜。

## 2026-11-01 · 安全：堵住登录限速的伪造 XFF 绕过 + 15 项 P1 加固（25.0.0）

全维度重审（60 条发现，见 `.workbuddy/artifacts/audit-full-2026-11-01.md`）后的 P0+P1 批量修复。

**安全（P0）**

- 🔴 登录限速可被伪造 XFF 绕过：`NAVIHIVE_TRUST_XFF=1` + Nginx `$proxy_add_x_forwarded_for`（追加模式）组合下，攻击者每请求换一个伪造 `X-Forwarded-For` 首段，`loginGuard` 就落进新桶，爆破锁定完全失效。修法（三处同改，缺一不可）：
  - `worker/httpUtils.ts` 的 `clientIp` 增加 `trustXFF` 语义：优先级 CF-Connecting-IP → X-Real-IP（仅 TRUST_XFF=1 时信任）→ XFF 首段（仅 TRUST_XFF=1）→ socket 对端；`loginGuard` 审计桶与 `worker/index.ts` 审计 ctx 同步传入；
  - `server/entry.ts` 在 TRUST_XFF=0 时直接剥掉 `x-real-ip` 头（防止客户端伪造这个替代通道）；
  - 自托管 Nginx 模板（`deploy/nginx/.../navihive-selfhost.conf`）XFF 改为覆盖模式 `proxy_set_header X-Forwarded-For $remote_addr`——**已同步落在线上反代**，带随机 XFF 的连打实测会触发限速锁。

**修复**

- 全局快捷键穿透记事本全屏：`useGlobalShortcuts` 的遮罩检测补 `[data-notes-root]`（记事本全屏是普通 fixed div，非 MUI Modal，之前 Esc/快捷键会漏进去）；
- 离线队列多标签页互相覆盖：抽出纯函数 `mergeQueues`/`saveQueueMerged`，六个非删除写盘点改合并写并监听 `storage` 事件（`takeAll`/`drop` 保持整份覆盖语义）；新增 `tests/offlineQueueMerge.test.ts`；
- 附件写盘原子化：`server/file-kv.ts` 改同目录临时文件 + `rename`，进程中断不再留半个附件文件；
- `notesAttachment` 的三处 `as unknown as` 改走 `coerceNoteAttachment` 窄化函数，脏数据运行期拒绝而不是静默带过。

**性能**

- Mermaid 图延迟加载：`MermaidNode` 改 IntersectionObserver（rootMargin 300px）+ 等高占位，视口外不加载 iframe，渲染一次不重挂，20s 看门狗兜底；无 IO 环境退回立即渲染；
- 分组懒挂载补缺口：`GroupCard` 新增 `filterActive` prop，搜索/筛选时跳过 IO 全量挂载（否则被过滤的站点永远不渲染）；空分组立即挂载；
- 触控守卫扩面：触控目标 ≥44px 的守卫提为无断点基础规则 + `@media (hover: none)`；MobileTabBar / TagBar 补透明热区伪元素。

**工程**

- cron 三处失败（notesBackup / inactiveSweep / retention）接 `recordCronFailure` 告警；沉睡清理删除时写审计日志；
- CI unit/coverage 注入 `NAVIHIVE_STRICT_D1: "1"`（D1 模拟层严格模式进 CI，本地 SQLite 测不出的硬限制在 CI 挡住）；两工作流各加 `notify` job（失败时 POST `ALERT_WEBHOOK`，未配置则跳过）；
- `docker-publish` 追加 `:v<version>` 镜像 tag（按版本回滚不再靠翻 digest）；compose 给 navihive `mem_limit: 384m`、upgrader `128m` + `NODE_OPTIONS=--max-old-space-size=256`；`docker:27-cli` → `docker:27.5-cli`；
- `script/uptime-check.mjs` 拨测加磁盘水位（>85% 告警）与 TLS 证书过期（<14 天告警）两项，均自动降级（不支持 statfs/tls 的环境不误报）；
- ESLint 升 `recommendedTypeChecked` + `no-floating-promises`(error)，src 全量 0 error（顺手修 8 处悬浮 Promise）；
- 「全站设置」业务体从 `SettingsDialog.tsx` 整体迁往 `ConfigPanelBody.tsx`（导出面不变），旧文件退场删除；受牵连的 dialogChunks 预取、三处测试同步更新。

## 2026-11-01 · 重构：App.tsx 拆出「设置中心」prop 组装器与懒加载包装（24.8.0）

审计报告 A1：`src/App.tsx` 单函数撑到 2400+ 行，其中「设置」统一中心（NavigationCenterDialog）的九面板 props 是约 140 行的内联对象/闭包，直接摊在 return 里。

修法：
- 九面板 props 组装抽成纯函数 `buildNavCenterDialogProps`（`src/components/navCenterDialogProps.ts`）；「账号与安全」面板里逐字重复两遍的 `onAuthChange` 三字段派发收成一份 `makeAuthChangeHandlers`；
- 组装器与中心外壳一起收进懒加载的 `NavCenterDialogBundle`：App 只传一份 args，`ChunkBoundary when={navCenterOpen}` 关着时整块（外壳 + 组装器）都不下载。App.tsx 的中心挂载从约 140 行缩到约 82 行，全文件 2414 → 2358 行；
- `navigationCenterLazyGuard` 的挂载形态断言同步放宽（直接挂外壳或挂 Bundle 都算条件挂载），产物段守卫继续兜住「Bundle 被静态引入」的传递引入情形。

首屏反而变小：index chunk 251.5 → 250.7 KB（stats.nameOf 等闭包随组装器进了懒块），mui-core 与基线逐字节一致。

踩坑记录（值得记）：
- 🔴 对**懒块模块**的静态 `import type` 也会把该模块拖进入口模块图：面板用的 Tabs / Table / Slider / ToggleButton / 一批图标因此被抬进首屏共享块（mui-core +61 KB，首屏预算 4 项红）。类型检查与 ESLint 全都看不出来，最后靠 sourcemap 按模块归因定位。正解：跨懒块引用一律写内联 `import("./X").Type` 类型（App 对 `VaultTransport` 的既有写法同理）；静态 type import 只对「本来就在入口图里的模块」（各 hook、API client）安全。
- 首屏 gzip 余量长期只剩约 3%（基线 289.7 KB / 预算 300 KB），任何净增都会压破棘轮——这次靠「组装器懒块化」反而挣回 0.8 KB。

## 2026-11-01 · 新增：附件管理器支持拖拽 / 选择上传（24.7.0）

审计报告 V3（`.workbuddy/artifacts/audit-report-2026-11-01.md` 的 V3）：附件抽屉此前只有列表 / 删除 / 清理，**没有上传入口**——上传能力（`NavigationClient.uploadAttachment`）后端早已就绪，前端却没接线。

根因：照抄 inkstone 的 `AttachmentManager` 方案时只抄了「管理」那一半；`mgr` 接口没有 `upload` 字段，抽屉里也没有放置区与文件选择框。两处挂载点（`NotesPageShell` 左下角、`NotesDataTab` 设置·数据页）都已有 `uploadApi`，却没把上传方法透传进管理器。

修法：
- `AttachmentManagerApi` 加可选 `upload(file)`；抽屉在有 `upload` 时出现「上传」按钮 + 隐藏文件框，并整抽屉可接收拖放（`dragover/drop` + 拖拽高亮遮罩）；
- 批量上传在管理器内顺序调用 `mgr.upload`，逐个上报进度（`LinearProgress`），全部跑完再统一重拉列表；部分失败不影响其余，最后汇总提示；
- 两处挂载点把 `uploadApi.uploadAttachment` 透传进去（设置页经 `NotesOverlayLayer` 的 `onUploadAttachment` → `NotesDataTab` 的 `data`）；
- 门控不变：老部署没有 `uploadAttachment` 时整个上传入口（按钮 + 文件框 + 拖放）自动隐藏，管理器其余能力照常。

影响：用户终于能直接从附件管理器上传文件，不用绕回编辑器粘贴；拖放 / 选择两条路径复用同一个后端。守卫：`tests/attachmentUpload.dom.test.tsx`（门控 + 拖放 + 文件选择三条）。

## 2026-11-01 · 修复：审计日志把预期内 401 误报为「保存失败」（24.6.1）

独立审计（见 `.workbuddy/artifacts/audit-report-2026-11-01.md` 的 L2）抓到的真缺陷：访客/爬虫打开首页、未带会话，会触发 `bootstrap()` 401，前端把它当「前端错误」刷进审计流水，且 `name` 退化成 `NonError`。

根因：`src/App.tsx:718` 的 `handleError` 把**所有**非离线错误统一按 `source:"save-error"` 上报；`src/hooks/useSites.ts:113` 的「加载数据失败」串也走这条。预期内 401 本已由 `onAuthFail` 独立回登录页，却被重复记成一条「保存数据」错误。

修法：
- `handleError` 区分加载/保存来源：消息以「加载数据失败」开头 → `source:"load-error"`，其余仍是 `save-error`；
- 消息含「认证失败 / 请先登录 / 认证已过期」时**不再上报**为前端错误（认证事件由账号流程统一处理，不该进崩溃统计）；
- `src/utils/auditDetailText.ts` 补 `load-error → 加载数据` 中文标签，审计视图不再裸奔代号；
- 加一条断言锁住该标签。

影响：审计流水不再被 401 刷屏；加载失败与保存失败分门别类，崩溃统计更准。

## 2026-11-01 · 修复：审计日志两块内容看不懂 —— 代码代号与 JSON 原文翻成人话（24.6.0）

用户截图反馈：审计日志里「前端错误」和「操作日志」两块看不懂。查下来是两件事，同一个病根 —— **把内部的存储形态直接怼到了界面**。

### 一、`save-error /` —— 代号 + 一个孤零零的斜杠

「前端错误」视图的主行原本是 `{source} · {paths}`：

```
save-error /                                    10次
加载数据失败: 认证失败: 请先登录 · 最近 2026/11/1 03:29:50
```

`save-error` / `note-full` / `notes-sync-poll` / `notes-tags-list` 是上报端写在代码里的分类代号，页面路径在首页就是 `/`，两者拼起来就是「一串英文 + 一个斜杠」。

修法：新增 `src/utils/auditDetailText.ts` 的 `errorSourceLabel()`，按「主语词表 + 动作词表」把 66 个代号拼成中文（`save-error`→保存数据、`note-full`→笔记 正文、`notes-tags-list`→笔记 标签 列表），路径 `/` 显示成「首页」。

**为什么是词表组合而不是 66 条手写映射**：手写表每新增一处上报就得同步改一次，忘改就裸奔（这个项目已经发生过）。词表拼不出来也没关系 —— 未登记的词原样保留，宁可半中半英，也不要把原始代号吃掉。原始值同时挂在 `title` 上，想按 source 去日志里查的人悬停就能拿到。

### 二、`{"source":"save-error",...}` —— 一整坨 JSON 摊在流水里

「操作日志」视图的副行直接渲染 `row.detail`。而 `client-error` / `server-error` 这两类动作的 detail 本身是一小段 JSON（前端上报体 / 服务端未捕获异常），于是界面上就是一整行 `{"source":"save-error","path":"/","name":"NonError","message":"…","rid":"-"}`。

修法：`formatAuditDetail(action, detail)` 只在**确实是上报体**时才重排，其余原样返回：

| 场景 | 现在显示 |
|---|---|
| `client-error` 的 JSON | `保存数据：加载数据失败: 认证失败: 请先登录（请求号 xxx）` |
| `server-error` 的 JSON | `GET /api/sites：D1_ERROR: no such table（请求号 xxx）` |
| `site.delete` 的 `长期未登录，已停用` | **原样不动**（本来就是人话，不能误伤） |
| 解析不了的脏数据 | 原样返回，超 160 字截断 |

`server-error` 与前端上报**不共用**一套字段读取，因为三处实际差异：来源不是 `source` 而是「方法 + API 路径」；请求号叫 `rid` 不叫 `requestId`；它的 `path` 是 **API 路径**，绝不能走「`/` → 首页」那条规则。`code` 是内部错误码，不显示。

### 三、顺手修掉一处 CI 假红（不是这次改坏的）

第一次推上 CI，`构建 + 端到端 + 浏览器审计` 这个 job 红了：

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:8883
```

不是本次改动引起的 —— `e2e:share` 36 项全过之后，`e2e:share-extra` 起服务时端口被占。查下来是两个相邻脚本各用一套挑端口的办法，而且**落在同一段端口里**：

- `share-e2e.mjs` 走 `pickPort()`，在 **8800–9199** 随机探一个空闲的；
- `share-e2e-extra.mjs` 自己算 `8801 + (pid % 100)`，即 **8801–8900**。

于是「上一步随机到 8883 + 这一步 pid 也落在 8883」就炸。改成同样走 `pickPort()`（它会真的探一下那端口通不通，撞上自动换下一个），本地复跑 46 项全过。

这类脚本自己算端口的问题**必须让它红着被发现**，不该加源码守卫 —— 它不像判据那样会静默变绿，撞了就是一声响。

### 四、验的是什么
- 新增 `tests/auditDetailText.test.ts`（16 条纯函数用例）：代号翻译、字段缺失、非 JSON 原样返回、长度上限、`/api/sites` 不被误译成首页。
- 补 `tests/auditDialog.dom.test.tsx`（+1 条，共 8 条）：渲染后正文**不含** `{"source"`、**含**中文来源词、**不含**原始代号，两块内容一次钉住。
- 反向验证：把前端错误主行改回 `<b>{group.source}</b>`，那条 DOM 用例立刻红（抓到 `save-error · 首页`），改回即绿。
- QA 另做了 8 条反例核查（含 500 字长文本、`zzz-qqq-xxx` 不编造、`/api/sites` 原样），确认没有过度翻译。

## 2026-11-01 · 工程 + 修复：把「淡化」与「交互态」两类盲区扫进审计（悬停态抓出 4.37:1 并修掉）（24.5.0）

24.4.0 补的是元素 `opacity`，这一轮补的是它旁边还站着的三类东西。三类有同一个病根：**缺陷没被审计发现，不是因为界面没问题，而是审计没走到那个态**。

### 一、`filter: opacity()` 与 `opacity` 等效，却完全不参与计算

`filter: opacity(0.3)` 和 `opacity: 0.3` 在视觉上是同一件事（同样整组淡化、同样建层叠上下文），而且两者**相乘**。旧扫描器只读 `cs.opacity`，靠 `filter` 做的淡化被当成完全不透明量 —— 又一个「只会变绿不会变红」的静默放宽。现在 `filterOpacity()` 把两处乘起来进同一张 opacity 表。

顺手抓到一个更隐蔽的不同源：`measure` 里原本有一条 `Number(s.opacity) < 0.5 → return null`。**于是同一处「淡化到 30%」的文字，写成 `opacity` 直接不量，写成 `filter: opacity(.3)` 却量出 1.5:1。** 用探针在真页面上对同一元素两种写法各量一次确认后，删掉那条提前返回 —— 现在一律交给 `groupAlpha` + `A <= 0.02`（真正看不见才跳过），两条路给同一个数。删完 18 段审计仍然全绿，说明当年那条 `< 0.5` 挡住的是「时机」，而时机已经由 `waitAnimationsSettled()` 管住了。

### 二、悬停态：第一次量就抓到 4.37:1

静态扫描量的是**那一帧**。可首页上大量文字的终色是 `:hover` 才生效的（卡片标题转强调色、行底色加深、按钮换前景色），而「悬停才浮现」的控件（如 `nav-group-tools`）平时恒为 `opacity: 0`，会被整组跳过 —— 跳过是对的，但也意味着它们**一次都没被量过**。

现在用 CDP 真发 `Input.dispatchMouseEvent` 逐个压上去（22 个目标），等过渡跑完再量。第一次跑就红：

```
4.37 / 需 4.5  14px  rgb(25,118,210) on rgb(246,250,253)  「记事本」  MuiButton-outlined
```

根因不是哪颗按钮写错了，是这套配色的固有属性：MUI 给 `outlined` / `text` 按钮的悬停态压一层 **4% 强调色淡底**，而 `--accent`(#1976d2) 压在纯白上本来就只有 **4.61:1** —— 只比小字线高 0.11，这层淡底直接把它压到 4.37。顶栏「记事本」「菜单」两颗全中。

修法（`useThemeController`）：悬停时把文字按 **88% + 黑**再压一次（≈5.4:1），用 `currentColor` 派生而**不**写死 `--accent-on-wash` —— 记事本根节点会注入 `--accent: var(--notes-accent)`，写死令牌等于把悬停色钉在蓝色上。只挂 `text` / `outlined`，**不挂 `root`**：`contained` 是「实强调底 + 白字」，把白字压暗 12% 后压在 `--accent` 上只有 3.5:1，反而制造缺陷。

### 三、焦点环：从「有没有环」到「环够不够 3:1」

`a11y-audit.mjs` 一直只判 `outlineWidth > 0 || boxShadow ≠ none`。可 WCAG 1.4.11 要的是**非文本对比 ≥ 3:1**：一圈与底色几乎同色的细环，对键盘用户等于没有。**「有环」和「环看得见」是两件事，前者绿灯不代表后者。**

现在 `SCAN_FOCUS` 会带出环色、它的 alpha、身后底色与实测比值；半透明环按自己的 alpha 混算（否则当纯色算出虚高比值）。输入框那一类走 `via: 'focus-border'`，环色取 `fieldset` 的边框色 —— 不取的话整类输入框的 `ring` 恒为 null，判据对它们永远不生效。

实测结果：首页 25 个焦点元素全是 `outline 2px solid #1976d2`，压白 **4.6:1**，全部合格。也就是说这里**没有缺陷**，补的是判据 —— 以后谁把环调淡，会当场红。

### 四、抽屉的「无命中」分支也进扫描面了

`empty`（「还没有上传过任何附件。」）与 `none-match`（「没有符合筛选的附件。」）是两个分支（`files.length === 0` 与 `filtered.length === 0`），各写了一遍 sx，24.4.0 只量了前者。补法是给桩加 `setAttachmentMode('images')`（列表只给一条图片），再点「文档」筛选档制造无命中态。

顺带更正上一轮记错的一条前提：附件抽屉**没有拖拽功能**（拖拽在 `SiteListBody` 卡片排序与 `NotesNavPanel` 文件夹），原来计划的「拖拽悬停分支」并不存在，真实分支就是 empty / none-match / error。

### 五、测量核心下沉成一份

`SCAN` 里的测量数学抽到 `auditEnv.mjs` 的 `CONTRAST_CORE`，暴露 `NH.refresh()` / `NH.measure(el)` / `NH.ratio` / `NH.parse` / `NH.bgBehind`。整页扫描、悬停单元素扫描、焦点环扫描共用同一份 —— **两套数学早晚会漂开**，而漂开之后的红绿都不算数。

### 六、守卫

- **`tests/scriptSyntax.test.ts`（新增，31 条）**：对 `script/*.mjs` 逐个跑 `node --check`。本轮在模板字符串的注释里写了 **5 次**裸反引号（`` `opacity:0` `` / `` `:hover` `` / `` `Number(s.opacity) < 0.5` ``…），每次都是 `SyntaxError` 指向一行完全无关的代码。这条守卫让「改脚本改出语法错」当场红，不用等审计跑 90 秒才发现。
- **`tests/focusRingScanner.test.ts`（新增，4 条）**：钉住环色 alpha 混算、`need: 3`、输入框取 fieldset 边框色、数学核心单一性。
- **`tests/contrastScanner.test.ts`（改，8 → 11 条）**：数学下沉后原断言全都指向 `contrast-audit.mjs`，会变成**永远绿的空转** —— 改成从 `auditEnv.mjs` 读 `CONTRAST_CORE`。新增「`opacity` 与 `filter: opacity()` 判据必须同源」一条。

### 七、这一轮的账

对比度审计 **18 段**（9 面 × 亮暗，含新增的悬停态）、无障碍审计 6 段 + 焦点环对比判据，全绿。悬停态抓到的 4.37:1 是真缺陷，已修；焦点环是判据缺失，实测无缺陷。

## 2026-11-01 · 工程 + 修复：对比度审计混算元素 opacity（顺手抓出两处真缺陷 + 一处时机缺陷）（24.4.0）

24.2.0 修的是「前景色自带的 alpha」，24.3.x 修的是「无障碍审计的面」，这一轮补的是**最后一块拼接**：元素自身的 `opacity`。补上之后对比度这条尺子才算闭合 —— 在此之前，「半透明」这类设计手法在审计眼里等于不存在。

### 一、opacity 是分组属性，不是「一个数」

`opacity` 把**整个元素（连同它的底色和子内容）当作一张图**，一次性混到身后的底上。所以两件事必须同时做对：

1. **沿祖先链累乘** —— 外层 wrapper 设成 0.6，里面 `opacity: 1` 的文字一样只有 60% 可见。只看自己那一个数是错的（旧代码甚至连「祖先被淡化」这件事都不知道）。
2. **文字和底色一起淡化** —— 把「自己画的那层底」和「身后的底」分开算，再一起按 opacity 混下去。只淡化文字会得出偏乐观的比值，等于白改。

A ≈ 1 时整套运算是恒等变换，所以**既有输出逐字节不变**，这一改不动任何已经合格的界面。

### 二、抓到的第一处：笔记编辑器行号 3.69:1

`NoteEditor.tsx` 的行号槽是 `color: inherit` + `opacity: 0.55`（14px，压白）。字色 `rgba(0,0,0,.87)` 本来是 16:1，被那层 0.55 一糊就只剩 **3.69:1**（小字线 4.5）。旧扫描器不混 opacity，所以它一直是绿的。

修法不是把 0.55 调大，而是**去掉第二层透明度**：改成 `color: var(--text-muted)`（亮 4.70 / 暗 6.5 左右），「淡」由一个 token 表达 —— 和 24.2.0 拿掉 `BuildBadge` 的 `opacity` 是同一条规矩：**别在 token 之外再叠一层透明度**。

### 三、抓到的第二处：抽屉空态 2.68:1（这条是新扩面才看见的）

顺手把抽屉的**空态 / 拉取失败态**也扫进来（`data-att-state` 那三条分支以前一条都没进过任何审计面）。第一次跑就红：

| 位置 | 文字 | 原色 | 实测 | 修后 |
|---|---|---|---|---|
| 抽屉空态 | 「还没有上传过任何附件。」12px | `text.disabled` | **2.68** | 7.2（`text.secondary`） |
| 抽屉无命中 | 「没有符合筛选的附件。」12px | `text.disabled` | 同源 | 7.2 |

`text.disabled` 是「停用控件」的语义，用在**说明文字**上本来就不对 —— 而且 WCAG 只豁免 inactive UI，不豁免说明文字。这和 24.2.0 修的抽屉计数是同一个病，只是藏在另一条分支里。

### 四、抓到的第三处是**时机**，不是界面

一混 opacity，测量时机立刻变成污染源。实测抓到两处，都不是界面问题：

- 首页卡片的 `navReveal 0.5s` 进场动画没跑完，`MuiPaper` 停在 0.53 → 整张卡片的文字被按 53% 可见度量，白字白底、比值 1.00；
- 设置中心 `MuiDialog-container` 正在淡入（0.695）→ 左栏每一条都被糊掉。

所以扫描前加了 `waitAnimationsSettled()`：用 `document.getAnimations()` 等**会改 opacity 且会结束**的动画。只认这两种是有讲究的 —— 首页 `.nav-aurora` 有个 26 秒无限循环的装饰动画（只动 transform），不过滤的话每段白等 6 秒 × 7 段 × 2 态。

### 五、一条**不该报**的红

混算之后，设置中心「清除访问记录」这颗**禁用按钮**立刻变红（1.88:1）。这不是缺陷：WCAG 1.4.3 明确不要求 inactive UI 的文字达标。加了 `[disabled] / .Mui-disabled / [aria-disabled]` 豁免 —— 不豁免的话全站每颗禁用按钮都是一条红，真正的问题会被淹掉。

### 六、审计面：对比度 10 段 → 14 段，无障碍 4 段 → 6 段

- 对比度：**首页 / 记事本·即时渲染 / 记事本·源码态 / 附件抽屉·常态 / 附件抽屉·空态 / 附件抽屉·拉取失败 / 设置中心** × 亮暗 = **14 段**。桩态切换在 `auditEnv.mjs` 的 `setAttachmentMode`（`rows` / `empty` / `error`）。
- 无障碍：抽屉的**空态**与**拉取失败**各一段（与常态同一把尺子：无名按钮 / 无 alt / 无 label / 负 tabindex / 触控 < 24px）。这两态是**追加**的独立循环，不动既有段任何一行 —— 既有输出仍可逐字节对比。

⚠️ 顺手更正上一轮的一个说法：附件抽屉里**没有拖拽功能**（拖拽排序在 `SiteListBody` 与 `NotesNavPanel`）。原计划里的「拖拽悬停分支」不存在，取而代之的是真实存在的空态 / 无命中 / 失败三条分支。

### 七、守卫与反向验证

- `tests/contrastScanner.test.ts` 从 3 条扩到 **8 条**：祖先链累乘、文字与底色一起淡化、整组不可见就跳过、停用豁免、opacity 字段只在真淡化时输出（保证其余行输出不变）。
- 新增 `tests/attachmentEmptyStates.test.ts` 3 条：「无命中」这一态**进不了审计**（要造一份只含单一类型的桩数据，收益递减），所以用源码守卫钉住它和空态都不许用 `text.disabled`。
- 反向验证逐项做过：行号改回 `opacity: .55` → 亮色源码态 5 处红（3.69）；去掉停用豁免 → 设置中心 2 处红（1.88 / 2.71）；桩不认状态 → 新段「20 秒内没画成该状态」精确报错；`none-match` 改回 `text.disabled` → 守卫 1/3 红。

### 八、门禁

`tsc -b --force` / eslint **0 error · 27 warning**（基线）/ 全量单测 **3595 用例 · 3594 通过 · 0 失败 · 1 跳过** / 生产构建 / `bundleBudget` 10/10 / 冒烟全通过 / **对比度审计 14 段 0 处不合格** / **无障碍审计 6 段 0 项不合格** / 覆盖率第 1 层 100%（412/412）、第 2 层行 88.3%。

### 九、仍未覆盖（记账）

1. `filter: opacity()` 这类「等效透明度」不参与混算（全站目前 0 处使用）。
2. 抽屉「无命中」态仍未进审计（靠源码守卫兜着）。
3. 悬停/聚焦态的样式（`:hover` 才出现的颜色）不在任一审计面内 —— 这是比 opacity 更大的一个洞，需要逐控件模拟状态才能量。

## 2026-11-01 · 工程 + 修复：无障碍审计补上「记事本·附件抽屉」段 · 警示文字统一换 `--warn-on-wash`（24.3.1）

24.2.0 补的是**颜色这条尺子**（前景 alpha 不再被丢掉）。这一轮补的是**另一条尺子**：无障碍审计从来没走进过附件抽屉，抽屉里那套「文件名 = 预览入口的裸按钮 + 悬停才浮出的删除按钮 + 四档筛选」从上线起没有任何一条审计量过它。同一个抽屉在上一轮已经被对比度审计抓出 7 处不达标 —— 「没扫过的面 = 假的绿」这条规律，在它身上应验过一次了。

顺手把 `warning.main` 当**文字**用的问题一次收干净：全站 8 处逐处量过、按同色相压深换掉，2 处图形/底色按规则不动。

### 一、无障碍审计加上第四段：记事本·附件抽屉

- **`scanA11y` 参数化成函数**（`scanA11y(rootSelector?)`），与既有的 `scanTouch` 同构：不传参 = 全局 `document`，传了就限根，根找不到返回 `{ missing: true }` 交给调用方 fail-closed。既有三段（首页 / 记事本 / 设置中心）重构后输出**与改前逐字节一致** —— 先证明尺子没变，再拿它去量新面。
- **一个必须先修的坑**：抽屉一打开就拉 `GET /api/notes/attachments/list`，原先审计桩里没这个分支，请求落回通用的 `{ success: true }`，组件拿着它 `.slice()` 直接抛 `TypeError` —— 抽屉连挂都挂不上（四档筛选一起消失）。而那一刻量到的「0 处不合格」是**彻底的假绿**。之前 `contrast-audit.mjs` 在自己脚本里内联过一份补丁，只对它自己生效、还得赶在点开抽屉之前注入，`a11y-audit.mjs` 拿不到就一直崩在这里。
- **桩下沉到 `auditEnv.mjs`**：新增 `ATTACHMENT_ROWS` 三条，刻意覆盖三种渲染分支（图片走缩略图三态 / 文档图标占位 / octet-stream 落到「其他」筛选），`ref_count` 同时覆盖「引用 N 次」与「未引用」两种文案；两个审计脚本从此走同一条路，与「谁先注入」无关。`contrast-audit.mjs` 那份内联版本删掉（净 −33 行）。
- **fail-closed**：入口找不到 / 抽屉画不完 / Esc 关不掉，一律抛错并写明「这一节没测到」。一条会悄悄不跑的审计比没有审计更糟。
- 全新判定区一条同尺子：`noNameBtns` / `noAltImgs` / `inputsNoLabel` / `negTab` 全 0，并把抽屉的触控目标单独打表。

### 二、触控目标：抽屉里三项抬到 ≥24×24，**不做豁免**

| 控件 | 改前 | 改后 | 依据 |
|---|---|---|---|
| 文件名预览按钮 ×3 | 180×**17** | 180×**24** | 11.5px 字号 × 行高 1.5 |
| 删除 IconButton ×3 | **27**×27 | **28**×28 | `size="small"` 的实测盒子 |

- 文件名那颗是**裸 `<button>`**，盒子高度就是行盒算出来的 17px，比 WCAG 2.5.8 的 24px 底线矮 7px。修法是把**行盒**撑到 24（`minHeight` + `lineHeight: "24px"`），字号不动、文字仍在正中，视觉只多 3~4px 上下空隙。⚠️ 不能用 `display: flex` 居中替代 —— 那会破坏 `text-overflow: ellipsis`，长文件名截断就失效了。
- 删除按钮 27 已经过线，但落在 24~31 的提示档里；抬到 28 就离开那一档，只改盒子不改图标，视觉几乎没变化。
- 口径写死：**不做豁免**。豁免清单会腐烂 —— 半年后没人说得清哪几条还算数。要么抬到 24，要么把控件去掉。

### 三、`warning.main` 当文字：8 处逐处量过，换 `--warn-on-wash`

| 位置 | 底色 | 原（亮色 `#ed6c02`） | 修后 |
|---|---|---|---|
| `AccountDialog`「已停用，约 N 天后清除」 | `action.hover` 亮 `rgb(245,245,245)` | **2.86** | 5.24 |
| `BackupTab`「留空 = 不加密」说明 | 弹窗纸面 `#fff` | **3.11** | 5.72 |
| `BackupTab`「未加密」×2 处 | 同上 | **3.11** | 5.72 |
| `BackupTab`「自动备份已 N 天没成功」 | 同上 | **3.11** | 5.72 |
| `AttachmentPreviewDialog`「文件较大…」 | 同上 | **3.11** | 5.72 |
| `ImportPreviewDialog` 变更摘要（含悬停态） | `#fff` / 悬停 `rgb(245,245,245)` | **3.11 / 2.86** | 5.72 / 5.24 |
| `SearchStatusLine` 的警示行 | 页面底 `#fff` | **3.11** | 5.72 |

**暗色一处都没变**：`--warn-on-wash` 在暗态就是主题里 `warning.main` 的原值 `#ffa726`（压 `#121212` 9.64、压纸面 `rgb(23,26,37)` 8.93），所以这一轮在暗色下**视觉零变化**，只是把亮色的明度压下去。

**2 处刻意不动**：`BackupTab` 勾选框的描边（`borderColor`）与 `MaintenanceBanner` 的淡底（`bgcolor`）—— 都不是文字，走图形线 3:1，那档 `warning.main` 本来就达标。`index.css` 里那条令牌注释已同步改成「全站文字用法已收完，剩这 2 处不是文字」，免得后来人翻到它又去瞎换一遍。

### 四、门禁

`tsc -b --force` / eslint **0 error · 27 warning**（基线）/ 全量单测 **3587 用例 · 3586 通过 · 0 失败 · 1 跳过**（153s）/ 生产构建 / `bundleBudget` 10/10 / 冒烟全通过 / **对比度审计 10 段（5 面 × 亮暗）0 处不合格** / **无障碍审计 0 项不合格**（抽屉触控：低于 24px 的 **0 个**）/ 覆盖率第 1 层 100%（412/412）、第 2 层行 88.3%，各纯函数目录均在各自地板上。

### 五、CI 抓到的第一件事：24.00 太贴线

这轮推上去 CI 的红，**不在新加的抽屉段**（那段在 CI 里同样是 0 项不合格），而在记事本行尾那颗「⋯ 的操作」按钮：

```
记事本：触控目标小于 24px 的 1 个
  24× 24  「读书笔记 的操作」
```

打印 `24× 24`、判定「小于 24」—— 这两个数**不是同一个数**：判据比的是原始浮点（`r.width < 24`），打印用的是 `Math.round`。本机精确量出来是 **24.00**（3px 内边距 ×2 + 18px 图标 = 24），CI 那台机器把它排成了 23.98 之类。浏览器布局单位是 LayoutUnit（1/64 px），叠加 DPR 贴齐，这属于渲染精度，不是缺陷。

但这一红暴露了两个真问题，两个都修了：

1. **「刚好等于底线」本身就是脆的。** 那颗按钮加 `minWidth/minHeight: 24` + `box-sizing: border-box`，让盒子由布局决定、不再由图标度量决定 —— 换个字体度量或 DPR 都不再漂。
2. **门禁一边比浮点、一边打印取整。** 红了也没法从日志复现，只能重跑赌运气。现在判据留 **0.5px 容差**（远大于 LayoutUnit 舍入 ≈0.016，又远小于任何有意义的尺寸差：23.5 照样红，真缩水到 22/20 抓得住），打印改成 `toFixed(2)`，让日志里的数就是被判定过的那个数。顺带把「提示档 24~31」也用同一把尺子，消掉「既不算硬失败、也不算提示档」的黑洞区间。

新增 `tests/touchTargetScanner.test.ts` 三条源码守卫钉住它：容差被删、打印被改回取整、提示档自成一套，都要红。反向验证：把判据改回 `r.height < 24` 且打印换回 `Math.round`，**2/3 条当场红**；还原后 3/3 通过。

记一笔：**假红和假绿一样有害**。假红会把门禁训成「重跑一次说不定就过了」，而一旦开始重跑，真红也就没人看了。

### 六、仍未覆盖的洞（记账，不假装没有）

1. **元素自身的 `opacity` 在 0.5~1 这段仍不参与混算**（24.2.0 遗留）。所以「别在设计里叠第二层透明度」这条规矩现在靠人工守。
2. a11y 第四段只量「**有**附件时的抽屉」。空列表 / 拉取失败 / 拖拽悬停三种状态还没进面 —— 空态的「暂无附件」提示、失败态的重试按钮都是独立渲染分支，一样可能藏不合格。

## 2026-11-01 · 工程 + 修复：对比度扫描器不再忽略前景透明度（量出 3 处真缺陷）（24.2.0）

24.1.0 把审计的**覆盖面**扩到了 10 段，但扫描器本身还有一处方法论错误没修：**它只取前景色的 RGB，把前景自身的 alpha 丢掉**。`text.disabled` 是 `rgba(0,0,0,.38)`，被当成纯黑，实测 **2.66:1 报成 19.89:1** —— 等于「全站所有半透明文字，只要不达 AA 就一律报绿」。

这一轮把前景按背景混一遍 alpha 再算比值，然后**先只量、不改色**，把真实清单拉出来。结果比预想好得多：**全站只有 3 处**（且全在亮色）。

### 量出来的 3 处与修法

| 位置 | 文字 | 原色 | 实测 | 修后 |
|---|---|---|---|---|
| 页眉时钟的分隔点 | 「·」16px | `text.disabled` | **2.68** | 5.4（`text.secondary`） |
| 右下角版本徽标 | 「v24.x.x」11px | `--text-muted` 0.48 | **3.21** | 4.70（`--text-muted` 改 0.60） |
| 附件抽屉底部计数 | 「共 N 个」11px | `text.disabled` | **2.68** | 5.4（`text.secondary`） |

- **分隔点**：它是 `aria-hidden` 的装饰字符，但看不见就等于日期跟时间黏在一起，分隔作用正好没了 —— 所以调色而不是豁免。
- **版本徽标**：真实的比值比 3.21 还差。它除了 `--text-muted` 还叠了一层 `opacity: .75`，两层乘起来 alpha 只有 0.36（约 2.4:1），而扫描器**不混算元素 opacity**，照样报 3.21。现在把「淡」全部收给 `--text-muted` 一个旋钮表达，元素不再叠第二层透明度 —— 要么读得见，要么把字调大，不该靠透明度糊过去。`--text-muted` 的另一处消费者 `Kbd`（快捷键键帽）顺带也读得见了。
- **抽屉计数**：`text.disabled` 是「禁用控件」的语义，用在元信息上本来就不对。

### 给扫描器加一条守卫

这类改动的危险在于：**退化不会报错，只会让审计变宽松**（更绿）。所以新增 `tests/contrastScanner.test.ts`，用源码守卫钉住三件事 —— 前景要读自己的 alpha、混算必须发生在算比值之前、混算必须往算出来的真实背景上混（不能往写死的白/黑上混）。反向验证：把 `alphaOf(s.color)` 换成常量 1，三条守卫全红；还原后 3/3 通过。

顺带说清一个**仍未覆盖**的洞（已写进扫描器注释）：元素自身的 `opacity` 在 0.5~1 这段区间仍不参与混算。所以「不要在设计里叠第二层透明度」这条规矩现在靠人工守，以后要收就改 `bgOf` 的同一处。

## 2026-11-01 · 工程 + 修复：对比度审计扩面（记事本源码态 / 附件抽屉）· 令牌守卫改为花括号配对（24.1.0）

24.0.0 那一轮，**同一个病根咬了我们两次**：某个界面的对比度缺陷一直没被发现，因为审计根本没走到那个界面态（附件抽屉从来不在扫描面上；笔记编辑器的源码窗口被扫成了预览态）。这一轮不再修单个点位，改成把「量不到的界面」量起来。

### 一、对比度审计从 4 段扩到 10 段

原来的覆盖面是「首页 / 记事本 / 设置中心」三处 × 亮暗两态。现在变成：

**首页 / 记事本·即时渲染 / 记事本·源码态 / 记事本·附件抽屉（筛选 4 档） / 设置中心** × 亮暗两态。

两处新增的关键点都不是「多扫一遍」，而是**把状态确定性地摆到可量的位置**：

- **源码态**：编辑器先以源码态挂载、`useEffect` 之后才装即时渲染 —— 旧写法只等笔记列表标题出现就开扫，落在哪个态全看机器快慢（快机器扫到预览态变绿、CI 落进源码窗口变红，同一份代码两种结果）。现在主动读「即时渲染」开关并按需切换，判据**不是开关的 `checked`**（MUI Switch 受控，`click()` 后浏览器先把 DOM 翻过来，React 状态与 CodeMirror 的扩展重配都还在后面 —— 那半拍量到的正是「开关翻了、正文还没换」），而是**正文里看不看得见 Markdown 标记**，且要求连续两次轮询都成立才算稳定。
- **附件抽屉**：等的是「筛选 4 档都在 + `loading` 归零 + 至少一张卡片」三件同时成立。只等分段控件是不够的 —— 它在抽屉头部同步渲染，而列表是异步拉的，那一刻网格里还是「正在读取附件列表…」的骨架，扫出来 0 处不合格，又是一次「绿得毫无意义」。

两段都保持 fail-closed：开关找不到、状态切不过去、抽屉画不完，一律抛错，绝不允许「没扫到就当 0 处」。预算各自钉 0。

### 二、修复：附件抽屉里两处被「没量过」掩盖的不达标

抽屉第一次被量就抓出 7 处（亮色，2 类），根因是同一个：**把 `warning.main` 当小字文字色用**。

| 位置 | 前景 / 背景 | 修前 | 修后 |
|---|---|---|---|
| 卡片底部「未引用」（10.5px） | `#ed6c02` on `rgb(249,249,249)` | 2.95 | **5.41** |
| 缩略图失败占位「无法加载」（10px） | `#ed6c02` on `rgb(243,243,243)` | 2.80 | **5.41** |

修法是新增 `--warn-on-wash`（亮 `#9a5500` / 暗沿用 `#ffa726`），与 `--accent-on-wash` 同一个思路：底色几乎是白，要的是「同色相更深」而不是换色，色相仍读作「警示」。暗色这两处本来就有 9.18:1，视觉零变化。

顺手把「引用 N 次」从 `text.disabled` 换成 `text.secondary` —— 它是纯元信息、不是「禁用控件」，用 secondary 语义更对；而且 `text.disabled` 是 `rgba(0,0,0,.38)`，**混完 alpha** 在亮色只有 2.66:1（扫描器只取前景 RGB、不混 alpha，会把这种颜色报成 19.89 —— 那条判据的缺陷已记档，另开一刀）。

### 三、设计令牌守卫：块尾改按花括号配对找

`tests/designTokens.test.ts` 的 `block()` 助手原来是「从块开头的 `{` 开始，取遇到的第一个 `}` 当块尾」—— 不剥注释也不配对。24.0.0 期间有人在 `index.css` 的 `:root` 注释里写了一句 `{ tag: tags.meta }`，那个 `}` 直接把令牌块截断在注释处，守卫变红 2 条，而报错指向的是完全无关的「`:root` 里定义完整的一套语义变量」。这种失败方向很坏：截断后的块更短，既会误报，也可能反过来掩盖真问题。

现在抽成 `matchBlockEnd(text, openBraceIndex)`，按深度配对、跳过 `/* … */`、未闭合抛明确错误。配一条自造 CSS 片段的回归守卫（不依赖真实 `index.css`，否则注释被删掉守卫就白测），并做过反向验证：换回 `indexOf("}")` 后那条守卫必红，且红的方式正是「块被截断在注释里、连变量都找不到」。

### 四、左栏搜索：把拼接规矩收成纯函数并补验证

`searchText`（名称 + 别名 + 一行说明）原来是在 `NavigationCenterDialog` 里就地拼的数组表达式，**没有任何验证** —— 拼得对不对只有 `tsc` 和类型保证。现在抽成 `model.ts` 的 `navSearchText(item)`，用真实注册表跑断言：搜「主色」只命中「外观与搜索」（证明说明文字参与过滤）、搜「webdav」小写命中「数据安全」（证明别名 + 大小写不敏感）、搜「退出」**不命中任何设置项**（底部的「退出登录」才是用户要找的，让它命中账号页是误导 —— 这条刻意写成断言，防止以后有人「补全别名」时手滑）。

顺带把 `filterNavGroups` 从组件文件拆到 `navFilter.ts`，纯函数测试不必再把 React/MUI 拉进来，也消掉了那条 `react-refresh/only-export-components` 新增告警（全仓 warning 回到 27 条基线）。

## 2026-11-01 · 重构 + 修复：设置中心第二波（统一入口 / 页签轻量化 / 左栏搜索 / 两处对比度）（24.0.0）

A+B 收尾的第二波：把 23.5.0 合并出来的「数据安全」面板真正做顺，补上左栏的搜索，顺手修掉三个查出来的真缺陷。

### 一、统一「全站设置」入口：独立弹窗退场，只剩一个中心

`SettingsDialog` 原本还留着一个独立 `<Dialog>` 入口（命令面板的「打开网站设置」走它），和设置中心并存两套「设置」——同一批字段、两种壳子、两套关法。现在它**只做中心内嵌面板**：删掉自带的 `Tabs` 与 tab state、`withDialog` 包裹、独立 `<Dialog>` 与默认导出，`section` 改成必填；`App.tsx` 里那整块 `<ChunkBoundary when={openConfig}><SettingsDialog …/></ChunkBoundary>` 删除，命令面板「打开网站设置」改为 `openNavCenter("config-appearance")`。12 个文件 **+85 / −303** —— 少掉的那两百多行全是重复的壳子逻辑。

### 二、修复：试了色不保存直接关中心，配色会泄漏到全站

`accentPreview` 是**即时**预览（`pickAccent` 直接把它写进主题，全站立刻换色），但原来只有「成功保存」那条路会 `setAccentPreview(null)`。关掉中心不撤 → 这个没保存的颜色一直留到刷新或下次保存为止，而且界面上没有任何地方还在提示「这只是预览」。

修法是把撤销挂在中心**唯一的关闭出口**上（× / `Esc` / 点遮罩 / 退出登录确认都走同一条）：先撤预览、再 `onClose()`。接线走 `config.onCancelAccentPreview`，设成**必填**——App 忘了接线 `tsc` 直接红，比注释可靠。只撤预览，**不动 `tempConfigs`**：那是保存草稿，跨开关要留着（清了就是丢用户输入）。守卫是一条 `deepEqual(["onPickAccent","onCancelAccentPreview","onClose"])`，同时钉住「试色确实走了预览通道」「关之前确实撤了」「撤销排在面板卸载之前且没多调一次」三件事。

### 三、页签轻量化：「数据安全」面板不再「页签里套页签」

备份的「备份 / 恢复」和回收站的「站点（N）/ 分组（N）」原本是两条 48px 的整宽下划线 Tab，合并成一个面板后上下叠着。换成共用的紧凑分段控件 `SegmentedSwitch`（`role="group"` + 每颗 `aria-pressed`），**放弃 `role="tab"`**：原实现根本没兑现 ARIA Tab 契约（没有 `tabpanel`、没有 `aria-controls` 配对、没有 roving tabindex，是「长得像 Tab 的 div」），而这两处的语义本来就是「筛同一个集合」而不是两个平级视图。改完整个设置中心一个 `role="tab"` 都没有了，DOM 断言从「只覆盖 config 两段」升级成「整个中心成立」。

顺带修掉一个真 bug：回收站那条页签原本在 `overflowY:"auto"` 的滚动盒**里面**，合成流式长页后那层 `flex:1` 在非 flex 父级里高度塌成 auto —— 列表一长，想切「分组」得先把页面滚回顶部。现在它是滚动盒的兄弟节点。

配色上有个坑值得记：`AttachmentManager` 里那份同款分段控件，选中文字用的是 `var(--accent)`，压在 `var(--accent-wash)` 上实测 **4.04:1**（小字线 4.5）。附件抽屉至今没被对比度审计扫到，所以这个缺陷一直是绿的。这次一并换成共用件（文字走 `--accent-on-wash` = 5.04 / 8.04），顺手把那份重复控件删了。

### 四、新增：左栏搜索过滤框

九条内容 36px/条一屏就能看完，所以这个框的价值不是「东西太多」而是「我知道它叫什么，别让我逐行扫」——做成了左上角一条低调的输入行。过滤范围是**名称 + 别名 + 一行说明**，其中说明文字已经覆盖了大部分同义词（搜「主色」「圆角」「CSS」都能命中「外观与搜索」），别名只补说明里没有的词。

三个容易写错的点都钉了守卫：① `aria-label` 与键盘处理必须挂在 `slotProps.htmlInput`（写 `<TextField>` 顶层会被摊到外层 FormControl 的 div 上，运行时是**选不到、点不着**，不只是读屏问题）；② `Esc` 是**分级**的——有词只清空、不关弹窗，且必须 `stopPropagation`（MUI 的 `useModal` 明确不看 `defaultPrevented`，只写 `preventDefault` 会静默失效）；③ 分组之间那条 1px 分割线的下标必须是**过滤后**的，先 `map` 后 `filter` 会造出「第一个可见分组带着一条线、上面什么都没有」的假边界。

结果播报用 `role="status" aria-live="polite"`（`assertive` 每敲一个字就打断读屏）。危险区「退出登录」不参与过滤、始终常驻——它不是设置项，也没人会用「搜索设置」去找它。

### 五、修复：暗色下 Markdown 的结构记号几乎看不见（1.55:1）

`npm run audit:contrast` 报暗色·记事本 3 处不合格：`#404740` 的 14px「#」和「-」，实测 1.55:1 / 1.65:1。根因是 CodeMirror 的 `defaultHighlightStyle` 里有一条固定色 `{ tag: tags.meta, color: "#404740" }`，Markdown 的 `#`（标题记号）与 `-`（列表记号）标的是 `tags.processingInstruction`，而它是 `meta` 的子标签、走祖先链继承吃到了这条色。亮色压白底 ≈9.4:1 没问题，暗色压深纸面就只剩 1.5 —— 等于看不见。

修法：新增 `--notes-mark` 令牌（亮 `#404740` / 暗 `#9aa79a`，暗色最坏情况实测 5.70:1），用自定义 `HighlightStyle` 覆盖 `tags.meta` 的颜色。**技术要点只有一条：同一 tag 上先注册者优先**，所以 `syntaxHighlighting(markHighlight)` 必须排在 `syntaxHighlighting(defaultHighlightStyle)` **之前** —— 排在后面等于没生效，而且不报错、没有任何提示。这条顺序由源码守卫 + 一条样式的 DOM 证据（样式表文本里 `var(--notes-mark)` 的下标必须大于 `#404740` 的下标）双重钉住。

之所以本地一直绿、只有 CI 红：对比度审计的 `openNotesAndWait` 只等笔记列表标题出现就开扫，而编辑器先以源码态挂载、`useEffect` 后才装即时渲染，存在一个源码窗口——快机器扫到预览态（绿）、CI 落进源码窗口（红）。**审计脚本的时序加固是另一张票**，这轮只修缺陷本身。

### 净效果

- 设置中心只剩一个入口，独立设置弹窗与它的 303 行壳子逻辑退场；
- 「数据安全」三节（保留策略 → 备份与恢复 → 回收站）在同屏顺排，不再有叠着的整宽下划线；
- 左栏多了搜索框，`Esc` 分级（先清词、再关窗）；
- 试色不回滚、页签跟页滚走、暗色记号看不见 —— 三个真缺陷修掉；附件抽屉那处 4.04:1 的潜在缺陷顺路一起修。

## 2026-11-01 · 重构：设置中心左栏重排 11→9 条 + 数据安全合并面板（23.5.0）

对 B1 摊平后的左栏做了一轮信息架构整理（方案 A 重排 + 方案 B 合并），导航项从 11 条收回到 9 条，同类功能归位、使用频率高的靠前。

### 一、方案 A：左栏重排 + 数据保留策略迁家

- **三组九条**：「数据与活动」（统计 / 数据与维护 / 数据安全 / 审计日志）→「外观与工具」（外观与搜索 / 密码保险库 / AI 设置）→「个人与支持」（账号与安全 / 快捷键与操作帮助），危险区（退出登录）仍垫底。「数据与维护」描述改为「离线缓存、跨设备同步、失效链接检测与版本升级」——版本升级从消失的「高级」挪了过来，描述得如实。
- **数据保留策略迁家**：三个保留期字段（备份保留天数 / 不活跃停用宽限 / 删除宽限）原来在「数据与维护」里，但它管的其实是备份与回收站的保留，跟「数据安全」是一回事——迁到「数据安全」面板顶部，作为「数据保留」小节，与下方备份/回收站形成「先定策略、再看现状」的阅读顺序。迁出后 `SettingsDialog` 的数据页不再含 retention 块（测试钉死：数据保留不许留在 config-data）。

### 二、方案 B：备份 + 回收站合成「数据安全」面板，「高级」拆散吸收

- **数据安全**：备份与恢复、回收站原来各占一条，内容都属「数据兜底」，合并成一个面板——流式布局，数据保留策略 → 备份与恢复 → 回收站 三段顺排。实现上新建 `DataSafetyPanel` 薄壳，静态引入 `BackupPanel`/`RecyclePanel` 的转发体（`BackupBody`/`RecycleBody`），两个业务体文件原样保留、props 原样透传——**免删文件**（REST 推送不支持删除）且不重复代码。`model.ts` 删除 `backup`、`recycle` 两条，`NavigationCenterDialog` 删两个独立 lazy 入口，换成一个 `DataSafetyPanel` 入口。
- **「高级」拆散**：调节图标那条「高级」只剩两个孤儿字段——自定义 CSS 归入「外观与搜索」尾段（本就是站点外观定制），版本升级归入「数据与维护」尾段（`VersionUpgradeSection` 本就与数据维护同 chunk）。`config-advanced` id 删除，`ConfigPanel` 回到两个入口（外观与搜索 / 数据与维护），共享同一个 chunk 的形式不变。
- **净效果**：面板模块 9→8（守卫同步更新），左栏 11→9 条，无功能丢失——每个原字段都能按新路径找到（README 菜单守卫 `readmeMenu.test.ts` 同步盯住新项名）。

## 仍在待办（写在这里是为了不丢）

- **密码强度校验是死代码**：`validatePasswordStrength`（≥12 位、拒同字符重复）只有定义和单测，
  三个改密 / 注册路径都没接它 —— 管理员密码目前可以设成 `1`。
- **部署密钥轮换**：`AUTH_SECRET / PASSWORD / USERNAME / RESET_CODE` 的种子值曾经进过 Git 历史，
  上线前必须用 `wrangler secret put` 换成全新随机值。轮换 `AUTH_SECRET` 会让 D1 里的 `enc$` 站点 /
  WebDAV 密码解不开，需先备份、部署后重新填一次。
