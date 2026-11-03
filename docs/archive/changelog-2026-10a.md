# 更新日志 · 历史归档（2026-10-21 ~ 2026-10-31）

> 这是根目录 [`CHANGELOG.md`](../../CHANGELOG.md) 的历史归档，**最新记录见根目录那份**。
> 本文件内容为切分时原样搬运（未改写、未删减），按日期倒序，与原文一致。

## 2026-10-31 · 重构 + 修复：全站设置三张 Tab 摊进左栏 / 弹层锁白边与标题位移（23.4.0）

B1 + B4（23.1.0 留下的两个尾巴）落地，顺带修掉 23.3.0 滚动锁上线后用户实测发现的两个视觉回归。

### 一、B1：全站设置不再有二级 Tab，三条全在左栏

「全站设置」原来是一个面板内藏三张 Tab（外观与搜索 / 数据 / 高级）——左栏是第一层目录、面板里又藏一层，**目录里看不见的就找不到**。现在摊平成左栏三条（9→11 条导航项）：

1. **外观与搜索**（调色板图标）：站点名称、主色、圆角字号、背景壁纸、图标与拼音搜索。
2. **数据与同步**（存储图标）：离线缓存、跨设备同步、失效链接检测与数据保留策略。
3. **高级**（调节图标）：自定义 CSS 与版本升级。

三条共用**同一个懒加载 chunk**（三个 lazy 入口指向同一模块，业务体只在 `section` 上分叉）——拆三个文件会把这个大块复制三份进三个 chunk，首屏预算经不起。三段共用同一份草稿（`tempConfigs` 在 App），切面板不丢改动；顶部两段说明只随第一段出现，不再跟着每段跑。独立弹窗入口（命令面板「打开网站设置」）保留三张 Tab 不动。

### 二、B4：左栏滚动比预算进 smoke 门禁

23.1.0 的设计承诺是「一屏能看全的目录」——开始需要滚动就失去了意义。B1 加了两条后这条预算成了承重墙，所以进了发版门禁（`ci-smoke`，真浏览器）：

- **1440×950 与 420×780 两档**：设置中心左栏 `scrollHeight ≤ clientHeight`（滚动比 ≤ 1），实测 593/593 与 645/645，11 条全部一屏看全；
- 同时断言全站设置三条目在左栏（B1 落地确认）。

### 三、修复：弹层锁的「白条 + 标题位移」（23.3.0 回归，用户实测）

用户两张截图报了两个症状：开设置中心后**最右侧多一条白长条**；开合之间**「导航站」三个字左右跳**。

根因是同一个：`overflow:hidden` 后 `html` 仍是滚动容器，`scrollbar-gutter: stable` 的槽位**继续预留**（只是刻度没了），而滚动锁又按传统做法补了 `padding-right` —— 空槽 + padding 双份白边露在遮罩旁，内容整体左移一个滚动条宽。

修法：上锁时把 `html` 的 `scrollbar-gutter` 临时改成 `auto`（不再预留槽位）再 `overflow:hidden + padding-right = 滚动条宽`——内容宽度前后逐位相等（不位移、不撞 900px 断点），空槽不复存在，遮罩铺满整个视口。解锁时 overflow / padding / gutter 三项全部原样还原。守卫三处：`tests/overlayScrollLock.dom.test.tsx` 的 gutter 断言、smoke 的「打开中心零位移」断言（真浏览器实测 `before=after` 逐位相等）。

## 2026-10-31 · 修复：弹层打开时背景页面不再跟着滚（23.3.0）

用户报「打开设置弹窗滚动滚轮外面的页面还是会上下移动」。排查发现不是设置弹窗一个的问题——全站所有弹层（32+ 个弹窗、抽屉、菜单、气泡）都没锁背景滚动，一处根因、一次性修齐。

1. **根因**：本站滚动容器是 viewport（`html` 的 overflow 传播到 viewport），而 `useThemeController` 出于「锁滚动收走滚动条会引发 10px 宽度抖动、撞 900px 断点让顶栏重排」的老问题，把 MUI 全部弹层组件的 `disableScrollLock` 一刀切设成了 `true`——滚动锁彻底关死。且 MUI 内置锁只碰 `body`，对这种「html 传播到 viewport」的滚动本来就锁不住，所以即便打开它也救不了。

2. **修法**：新增 App 顶层常驻的 `useOverlayScrollLock`——一个 MutationObserver 盯着 body，只要出现任意 `.MuiModal-root / .MuiDrawer-root / .MuiPopover-root / .MuiMenu-root`（tooltip 除外），就对 `html` 做「`overflow:hidden` + 等宽 padding 补偿」，最后一个弹层关掉才还原。宽度零变化：`index.css` 的 `scrollbar-gutter: stable` 始终预留滚动条槽位，锁定瞬间槽位塌缩、padding 恰好补回，净零位移——**不会**重蹈 900px 断点重排的覆辙，老的 `disableScrollLock` 决策可以继续保留。

3. **所有权规则（防永久锁死）**：`html` 的 overflow 另有一位所有者——记事本页面（`NotesPageShell` 是 `position:fixed` 的普通 div，不是 MUI Modal，observer 看不见它）靠自带的 `useScrollLock` 锁 html+body，保持原样不动。全局锁上锁瞬间若发现 overflow 已是 `hidden`，就只跟随不接管：解锁时不写回，还原权归原主。否则会把记事本记录的 prev 污染成 `hidden`——记事本先卸载、observer 随后解锁的那一拍就会把 `hidden` 写回，整站永久锁死。这条回归线由新测试钉死（`tests/overlayScrollLock.dom.test.tsx`，含嵌套弹层「最后一个关掉才还原」与「与自有锁共存」两条）。

4. **覆盖面**：设置中心、全部导航站弹窗、笔记站内所有 Dialog/Drawer/Menu/Popover、移动端 fullScreen 弹窗——打开期间背景一律不可滚，关闭后立即还原。`disableScrollLock:true` 保留（MUI 不去碰 body，避免与 lightbox 的 body 锁相互污染）。

## 2026-10-31 · 修复：笔记暗色选中强调色对比度达标（23.2.1）

QA 把 `audit:contrast` 的暗色扫描修对后（之前主题漂移、实际量的是亮色，整段假绿），门禁从假绿变真红，抓出一处真实缺陷。

1. **问题**：暗色下笔记列表选中项的标题用 `--notes-accent`（旧 `#c96e60`）压在选中态背景（这枚色自身的 12% 淡层压在笔记深色纸面，合成 `rgb(46,35,34)` / `#2e2322`）上，13px 小字实测 **4.25:1**，低于小字线 **4.5**，差 0.25。`NotesPageShell.tsx:767` 那句注释还写着"暗 `#c96e60` 达标"——假结论，它假设压的是纸面，从没测过选中态背景。

2. **修法**：暗色 `--notes-accent` 从 `#c96e60` 提到 **`#d18276`**（同色相提亮，仍是那枚红棕"记号"色，不引入新色相）。选中背景本身就是这枚色的 12% 淡层，提亮时背景同步变浅，但文字提得更多，比值稳升——实测 **~5.05:1**，一次过线且留余量。WCAG 相对亮度公式自算与审计实测一致（改前 4.25 与 QA 报值逐位吻合，可反推模型，改后由 `npm run audit:contrast` 复核为 0 不合格）。

3. **为何不连同亮色改**：亮色 `--notes-accent` 是 `#a03c32`，压亮纸面本来就达标——QA 只报了暗色 1 处，亮色动它就是引入新问题。本次只动 `.dark` 块。

4. **顺手修正了误标注释**：`NotesPageShell.tsx` 那段"亮/暗两个都达标"改成如实描述——亮 `#a03c32` 在亮纸面达标、暗值 2026-10-31 才提到 `#d18276` 达标，并写明"之前一直假绿、这次修扫描才暴露"。不再留"达标"的虚假结论。

## 2026-10-31 · 工程：浏览器审计覆盖设置中心 + 修复 color-mix 解析（23.2.0）

QA 在八道门禁之外补测时发现：对比度审计与无障碍审计从来只扫「首页 + 记事本」，**改了最大两个文件的设置中心外壳一直没被审计看过一眼**——这种绿是假的。本轮把审计面补上，并顺手修了一个会让审计自己算错的解析坑。

1. **补盲区（设置中心）**：两个审计各加 `openCenterAndWait`——点顶栏那颗**可见文本严格等于「设置」**的按钮（`site-audit.mjs` 里已有 `exact: true` 的先例，避开了「显示设置 / 网站设置」误点），轮询 `[data-workspace-nav]` 数量 ≥ 8 再开扫，亮 / 暗两套主题各扫一遍。a11y 顺带把中心的触控目标也复扫了一次（左栏 10 条 + 关闭按钮）。**fail-closed**：点不到「设置」、中心没渲染、或 `[data-workspace-nav]` 条数不够，一律报红并写明「打不开设置中心」，绝不允许静默跳过——一条会悄悄不跑的审计比没有审计更糟（这条写进了脚本头注释）。

2. **修解析坑（color-mix）**：Chrome 把 `color-mix(in srgb, … 10%, transparent)` 序列化成 `color(srgb 0.098 0.4627 0.8235 / 0.1)`——分量是 **0~1 的浮点**。旧 `parse` 照 `rgb()` 当 0~255 解析，等于把一层 10% 的淡蓝当成「接近纯黑」，合成底色假性变暗：**亮色偏悲观假红、暗色偏乐观假绿放行**。已加 `v <= 1 ? v * 255` 分支。实测设置中心暗色选中态 **8.04:1**（不再假绿 10.15）、亮色 **5.04:1**——这一对配色在 23.1.1 已调到达标，本轮只是让审计能正确量到它。

3. **反向验证（证伪「永绿」）**：临时把 `index.css` 里 `--accent-on-wash: #1565c0` 改回修复前的 `#1976d2`，重跑对比度审计，设置中心亮色选中项**必报 4.04:1 红**；`git checkout` 还原后恢复 5.04:1。证明这条审计真的扫到了那 10 条、且会咬人。

## 2026-10-31 · 修复：设置中心亮色选中态对比度达标（23.1.1）

QA 在八道门禁之外做对比度补测，抓到一处亮色下 AA 不达标。位置：设置中心左栏选中条目的文字。

1. **问题**：亮色选中项用 `--accent-op`（#1976d2）压在 `--accent-wash`（10% 强调色淡底，合成 rgb(232,241,250)）上，字号 13.5px / 500 = 小字，实测 **4.04:1**，低于小字线 **4.5**，差 0.46。这条选中配色本轮没动，是历史遗留——但上一轮把左栏底色去掉后，底从「淡底压 #f9f9f9」变成「压纯白」，比值从 3.84 升到 4.04，方向对了还差临门一脚。

2. **修法**：新增 token `--accent-on-wash: #1565c0`，语义明确为「压在 `--accent-wash` 上的文字色」。同底实测 **5.04:1**，一次过线。色相不变，仍读作「可操作的蓝」，只压了明度；改的只有 `SettingsWorkspaceNav.tsx` 那一行 `color`（选中态文字）。

3. **为什么不动 `--accent-op`**：它是全站「可点元素」语义（焦点环 / 拖拽落点 / 尺寸手柄 / 多选按钮 / 开关档位），见 index.css 那段分工注释——动它等于动全站。同一块里的 3px 选中指示器也仍用 `--accent-op`：那是图形不是文字，图形线是 3:1，而 #1976d2 压同一块淡底是 4.04:1，作为文字差 0.46、作为图形超出线 35%，没必要跟着暗化。

4. **暗色**：`--accent-on-wash` 直接跟随 `--accent-op`（#90caf9 压浅蓝 10% 深底实测 **8.04:1**），本来就够，无需另挑深色。亮暗两态都在 `hardcodedColorGuard` 里登记，删掉任一侧守卫会红（已反向验证）。

## 2026-10-31 · 重构 + 修复：设置中心视觉收敛 / 探针误判修正（23.1.0）

用户反馈一句「设置中心对比笔记页仍不够简洁美观」。顺着这句做代码级诊断，定位到六条病根，
这一版解决其中四条视觉问题（标题层级 / 左栏密度 / 分隔手段 / 说明文字）加两条结构问题
（小节原语四套并行 / 底栏只有一个「完成」）。**面板内的二级 Tab 与首屏预算留到下一轮**，
那两个要动交互，不塞进这一版。

### 一、标题层级：外壳「设置」从主标题降为窗口标签

原来外壳那句「设置」是 17/600，面板主标题「全站设置」也是 17/600 —— 同字号同字重，
第一眼看到的是**两层同级标题在打架**，读者得靠位置猜哪个才是这一屏的名字。

现在外壳那句降到 **13/600 + 次要色**，顶栏高度 56 → **48**：它只是「你在哪个窗口里」的标签，
不再参与内容层级；面板那行 17/600 成为整屏**唯一**的主标题。面板头部内边距同步收紧
（`pt` sm:2 → 1.5、`pb` 1 → 0.5），省下的高度全给正文。

窄屏第二步那颗「全部选项」返回按钮是 44px，顶栏降到 48 后上下各剩 4px —— 实测
**顶栏 52 / 按钮 44 / 未被裁切**（`minHeight` 是下限，按钮撑得住就自然长到 52）。

### 二、左栏瘦身：208 → 192、行高 44 → 36、三个分组标题退场

原来的账很清楚：208px 宽 + 44px 行高 + 三个分组标题 + 组间 16px 留白，9 条内容要
约 590px，而正文可用高约 600px —— **再加一条导航就得滚**。一个「一屏能看全的目录」
开始需要滚动，就失去了它作为目录的意义。

- **宽度 208 → 192**（不是更瘦的 176）：条目可用文字宽 = W − 16（左栏内边距）− 24（条目内边距）
  − 18（图标）− 10（间距）= W − 68。最长条目「快捷键与操作帮助」8 个汉字 × 13.5px = 108px，
  W=176 时可用**正好 108px** —— 实测那一行真的折成两行（行高 49，其余 9 条 36）。192 留 16px 余量。
- **行高 44 → 36**（桌面），窄屏仍是 44：`script/a11y-audit.mjs` 的硬判据是 WCAG 2.5.8 的
  **24px**（32 以下才报 borderline），36 两档都过；44 是**触控**舒适线，鼠标不需要，手指必须要。
  这条判断写进了组件注释，免得下一个人以为 36 是随手压的。
- 图标 20 → 18、条目字号 14 → 13.5、条目间距 4 → 2。
- **三个分组标题删掉**，分组关系改用「8px 留白 + 1px 细线」表达。但**语义没删**：
  每组仍是 `role="group"` + `aria-label`，读屏照样念得出「数据与活动，共 4 项」——
  视觉上省，语义上不省。

实测（1440×950）：左栏滚动容器 `scrollHeight 593 / clientHeight 593`，10 条无折行；
窄屏 390×844：`709 / 709`，10 条全 44。**两个视口都不需要滚动。**

### 三、分隔手段从五种减到两种，说明文字从六七段压到两段

原来一屏里并存五种分界：纸面描边、左栏右描边、左栏底色、底栏上描边、面板小节之间的
`<Divider/>`。五种都在同一屏里出现时，眼睛读不出「哪条是结构、哪条只是随手画的」。

- 左栏底色去掉（它与纸面只差 alpha 0.05，看不出层次，反而让右栏正文像贴上去的一块），
  只留右缝那一条 1px 结构线；底栏上描边去掉；面板内 `<Divider/>` 全部去掉，
  改成 `spacing 2.5`（20px 留白）—— **留白比线更能表达「这是两段」**。
- 纸面描边与左栏右缝保留：这两条是结构线，去掉会散。

说明文字同理：`Section` 的段落级 hint 从 6 条压到 **2 条**（只留「外观」与「维护」
这两处真会误解的）。删掉的 4 条不是凭空消失 —— 讲「数据存哪儿」的那条挪进了开关的
caption，讲「写错会影响显示」的那条降成了自定义 CSS 字段的 helperText。
**删说明不等于删信息**，每一条都逐条判断过落点。

### 四、小节原语：四套并行实现并成一套，并加守卫

同一个设置中心里原本并存四份「小节标题」：`dialogSection.tsx` 的 `Section`、
`AccountDialog` 里**逐字重复**的一份拷贝、`StatsPanel` 的 `SectionTitle`（无竖条）、
`PasswordHealthDialog` 的 `SectionTitle`（带 icon）。差距只在「有没有竖条 / 有没有图标 /
留白多少」—— 单看每处都合理，放在一起就是「左栏切一屏，小标题换一种长相」。

现在只有 `dialogSection.tsx` 一处实现：`Section` 增加可选 `icon`，另导出 `SectionHeading`
（只出标题行，供「正文是多块并列、包不进一个 Stack」的屏用），两者共用同一段渲染。

守卫 `tests/dialogSectionUniqueness.test.ts`：扫 `src/components/**`，除共用件外**不许**
再出现 `Section` / `SectionTitle` 的定义，失败信息点名 `文件:行号`。**反向验证写在用例里**
（在内存里变异源码 → 断言守卫必须报错），不靠「我手工试过一次」——那种验证会随时间失效。

### 五、底栏退场：桌面不再有那颗「完成」

底栏占一整条 44px + 一条描边，里面只有一个「完成」。可中心里绝大多数面板改完即生效，
没有「保存」语义 —— 那颗按钮实质是**第二个关闭按钮**。撤掉之后出口仍有三个：
右上角 ×、Esc、点遮罩；窄屏第二步另有「全部选项」返回。未保存草稿的
`requestClose` / `dirty` 那套逻辑一行未动。

底栏退场顺带还回约 85px 正文高度（备份面板正文高 521.5 → 606.5）。

### 六、顺带：`script/ui-probe.mjs` 的「面板正文被裁」是**探针量错了容器**

上一轮我在探针里报了一个「备份面板内容被裁掉且滚不到」的缺陷（框底比可视下沿低 67.9px，
且滚动容器 `scrollHeight` 恒等于 `clientHeight`）。**这个缺陷不存在。**

`[data-workspace-panel-body]` 是面板外壳的**直通容器**：`display: block`，唯一子元素是
`height: 100%`，父子等高 —— 它按设计永远不滚。真正会滚的是面板内部那一层
（备份面板 = `BackupDialog` 里那个 `ref=scrollRef` 的 Box，实测 662/505，可滚 157px），
滚到底那个框完整可见。我量错了对象，还差点让一条不存在的 bug 写进更新日志。

修正：探针改成取被测元素的**最内层**可滚祖先，判据也从「有没有越过下沿」换成
**「滚到底能不能看全」**——长页面一打开超出可视区是正常的，看不到才是 bug，
这个区分原来没有。

另加 `tests/panelScrollChain.test.ts`，钉住四处**真的承重**的声明（删掉就会让内容永久看不见）：
面板正文 `overflowY: auto`（实测改 visible 后，全站设置最后一行在五档高度上全部不可达）、
`RestoreTab` 根部 `flex: "1 0 auto"`（不许被压缩，改回 `flex: 1` 后 WebDAV 框五档全滚不到）、
备份内层容器 `overflowY: auto`（这条**不是**可达性判据，是「标签页不跟着滚」）、
远端列表自滚（父盒是 `overflow: hidden` 的固定窗口，此条为结构判据、未起 WebDAV 实测）。
每条都标注了证据等级。

**刻意没有钉**那几处 `minHeight: 0`：实测删掉它五档数字逐字相同 —— flex 子项只要
`overflow` 非 `visible`，automatic minimum size 本来就是 0，这行是冗余的。
给冗余行加断言只会制造假红，而假红比没有守卫更糟。这条判断写进了守卫文件头，
免得有人「顺手补上」。

版本号 23.0.2 → **23.1.0**：13 个文件 / 1102 行，落在 minor 线（20 文件 / 1200 行）内，中位动。

## 2026-10-31 · 工程：拆分后的守卫补强（toolchainPin 全量校验 / unit 步骤更名）（23.0.2）

CI 拆分上线实测：整场 **712s → 354s**，四个 job 并行跑 —— 覆盖率 349s / 单元测试 190s /
构建+e2e 186s / 静态检查 144s，汇总 3s 收尾。省下来的正是原来「排队等长杆」的那部分。
拆完之后有两处守卫跟着变松了，这一版把它们补回去。

### 一、toolchainPin：从「取第一个」改成「全量必须一致」

原来它用 `ci.match(/node-version:…/)` 只取**第一个**命中。单 job 时代 ci.yml 里只有一处，
取第一个和取全部没区别；拆成四个并行 job 后变成四处，而这条守卫仍然只比第一个 ——
四处现在都是 22，结论照旧对，**但哪天有人给某一个 job 单独降/升版本，它会静默通过**：
它看的那一处没变，另外三个跑在别的 Node 上，它根本不知道。

守卫一旦会静默通过，就等于没有 —— 它不再拦住任何人，却仍然让人以为「这条有人盯着」。
所以改成：全部 `node-version` 都取出来，**去重后的主版本必须只剩一个**，且等于
`@types/node` 的主版本；失败信息把收全的原始值摊开（`22 / 22 / 22 / 20`），不让人回去自己数。

⚠️ 判据特意写成「彼此一致」而不是「都等于 22」：写死当前值，将来真升版本时这条守卫会
从护栏变成绊脚石，而那时最省事的处理是把它删掉 —— 那才是最坏的结果。

判据抽成纯函数 `checkNodeVersionPin` 并单独立了一条用例，两个方向都钉住：四个 22 → 通过；
三处 22 + 一处 20 → 红并指出是 20。另外补了两个同样会静默通过的方向：四处都是 20 但与
`@types/node` 对不上、某处写成 `lts/*` 算不出主版本 —— 两者现在都红。

### 二、`unit` 的步骤名：「纯函数单测」→「单元测试（含组件）」

这一步跑的是 `npm run test`，本次实测全套 3530 条，含 `.dom.test.tsx` 那两千多条组件用例。
名字只写「纯函数」，将来有人照着名字把它改成只跑 pure，DOM 那一半会**静默失去 CI 覆盖**
—— 又一次「没有任何东西会报错」。名字与内容对齐，比多写一句注释有用。

版本号 23.0.1 → **23.0.2**：3 个文件 / 189 行，落在 patch 线（5 文件 / 200 行）内，末位动。

## 2026-10-31 · 工程 + 修复：CI 拆四个并行 job / spool 模式启动不再打假警报（23.0.1）

两件本来不相干的事凑一版：一件是把变慢的 CI 拆开，一件是把「看着像故障、其实只是走错了
通道」的启动告警堵掉。

### 一、CI 拆成四个并行 job + 一个汇总

拆之前是单 job 串 26 步，一整场 712s。把逐步骤耗时（CI #41159720927）摊开看：覆盖率分层
门禁 278s、纯函数单测 154s —— 两者合计 **61%**；而七条 e2e 加起来只有 21s。所以该拆的是
「长杆」，不是「看起来最重的东西」：把 2s 的活挪到另一台 runner 上，省下来的只有 runner
启动时间而已。

现在四个 job 各管一摊，彼此没有依赖、跑在不同 runner 上：

- `lint_and_types`（~130s）静态检查：gitleaks / 依赖漏洞 / 类型 / 严格下标 / 代码规范 ——
  全是「只读源码、不需要构建产物」的活，最慢一步也才 31s，拆开压不出并行收益，
  合在一组反而省三次 runner 启动；
- `unit`（~205s）纯函数单测：`npm run test` 在 dist 不存在时会让 bundleBudget 用例主动
  跳过，这与拆分前「test 排在 build 之前」的顺序等价（语义没变），真正的体积硬门禁在
  `build_and_e2e` 的 `check:budget`；不和 coverage 串在一起排队 —— 那边要 278s，
  串行等于让单测陪跑；
- `coverage`（~330s）覆盖率两层门禁：278s 的**关键路径**，只有让它独占一台 runner，
  其它检查才不用排队等它；
- `build_and_e2e`（~195s）需要构建产物的一切：构建 → 体积预算 → 六条 e2e → 五条审计 ——
  彼此有严格顺序（构建必须在体积门禁与所有 e2e 之前），再拆收益只有个位数秒，
  反而多三次 runner 启动。

外加 `verify` 只做判定、不跑任何检查：四个 job 分散在四台机器上，「这条流水线到底过没过」
需要一个唯一的结论点，这里就是。它的 id **沿用原 job 名** —— 可能有人按这个名字看状态、
配分支保护规则，改名等于让那些地方静默失效。

两个不显眼但必须这么做的地方：

- `verify` 必须 `if: always()` 且「非 success 即失败」。没有 `always()` 时，上游任一 job
  一挂它就被**跳过**，而「跳过」在工作流级 conclusion 里不是 failure ——
  `docker-publish.yml` 读的正是工作流级 conclusion，跳过就等于门禁变绿灯。同理不能只拦
  `failure`：`cancelled` / `skipped` 都意味着那道门禁根本没跑。
- **job id 一律用下划线**（`lint_and_types` / `build_and_e2e`）。`needs.<id>.<prop>` 里的
  连字符在 GitHub Actions 表达式里有被当成减号解析的风险，一旦不被接受就是整份工作流解析
  失败、一个 job 都不跑 —— 而这个仓库的 `.github/workflows/` 下没有先例可借，不留这个赌。
  Actions 页面上的可读性交给各 job 的中文 `name:`（页面显示的是 name，不是 id）。
- npm 缓存第一次跑可能不生效：四个 job 同时冷启动，各家都可能 miss 再各自 save 一次，
  第二次起才谈得上命中。

步骤一步没少，命令 / env / `continue-on-error` 全部照抄。两处刻意没动：
`NAVIHIVE_STRICT_D1` 仍**逐步骤**声明（提到 job 级会让本来没声明它的构建 / 冒烟 / 各审计
也吃上这个开关，那就是语义变化）；视觉回归仍 `continue-on-error: true`（观察期不卡门）。
`coverage.mjs` / `unit-tests.mjs` 里的锁与清理逻辑也一行没改：拆并行后各 job 在独立 runner
上、`script/tmp-tests` 本来就不会互删，但那是「顺便消失的问题」，不构成删掉防御的理由。

### 二、spool 模式启动不再打「清理 helper 容器失败」的假警报

现象：23.0.0 在 spool 形态下健康启动会刷一条
`[upgrade] 清理 helper 容器失败（不影响运行）: Error: connect ENOENT /var/run/docker.sock`
—— 看起来像故障，实际只是走错了通道。

根因：`cleanupUpgraderContainer()` 只判 `dockerAvailable()`，而它在 spool 模式下**恒为
true** —— 那是「这个部署形态支不支持网页升级」的判据，不是「本进程连不连得上 daemon」的
判据。而主容器**故意不挂** `/var/run/docker.sock`（一键升级由宿主上的 `navihive-upgrader`
长驻 sidecar 消费 `/spool` 任务）。于是清理函数顺着 Docker API 通道去连一个根本没挂进来的
socket，健康启动也报 ENOENT。

修法：函数体最前面 `if (spoolEnabled()) return;` —— spool 模式下本进程**从不创建** helper
容器，带 `com.navihive.upgrader=1` 标签的只可能来自下面那条 Docker API 路径
（`runUpgraderContainer` 创建时贴的 Labels）；spool 的收尾归宿主上的 upgrader 服务，
而它连标签都没有，就算连得上 daemon 也筛不出来。

为什么不顺手把 `/spool` 目录清掉：`request` 是**待执行命令**（删了 = 静默取消一次升级）、
`state.json` 是 upgrader 写的进度（删了会让 `GET /api/system/upgrade` 在升级中途退回
idle）、`request.tmp` 还可能与并发的写入抢 rename。这三样都不归本进程管。

函数 doc 里写明「只在 docker-api 模式下有意义」，并加了一条源码守卫钉住**结构事实**：
spool 判定必须在函数体最前面、且排在所有 Docker API 调用之前 —— 谁把 early return 挪到
后面或删掉，`tests/systemUpgradeAudit.test.ts` 立刻红。少了这条守卫，下次又会是「健康
启动刷一条看起来像故障的 warn」，而没有任何东西会报错。

版本号从 23.0.0 跳到 **23.0.1**：按 `script/bump-version-lib.mjs` 的机械阈值，本轮落在
3 个文件上（`ci.yml` / `package.json` / `CHANGELOG.md`，patch 线是 5 文件 / 200 行），
末位动。第二件（spool 修复，2 个文件）此前已单独提交、只是没记进日志，这一版一并补上；
五个文件仍在 patch 线内，档位不变。

## 2026-10-31 · 修复 + 重构：入口更名「设置」/ 面板不再叠层 / 退出登录钉底（23.0.0）

上一轮把「更多选项」下拉菜单收成了统一中心，但入口名还叫「更多选项」——菜单已经没了，
名字却还留在顶栏、中心标题和移动端底栏上，读起来像「还有一堆菜单项没展开」。这一轮把
入口三处统一叫**「设置」**，顺手修掉中心里两屏还会再弹一层弹窗的问题，并把「退出登录」
钉到左栏底部。58 文件 / 530 行。

### 一、入口更名（顶栏 / 中心标题 / 底栏）

- 顶栏按钮、中心弹窗总标题、移动端底栏统一叫「设置」（`id='navigation-button'` 与
  `aria-haspopup='dialog'` 不变，读屏语义不受影响）；底栏图标 `MoreHoriz` 换成齿轮
  `Settings`。
- 引导文案跟着走：用户在界面上读到的 `更多选项 → X` 全部改成 `设置 → X`。
- 源码注释与 README 同步归零：**45 个文件**的注释把「更多选项」改成「设置」/「设置中心」
  （按「入口按钮叫设置、弹窗叫设置中心」区分，避免满屏「设置中心中心」），
  `grep 更多选项` 在 `src/ tests/ script/` 已无命中 —— 避免后来读代码的人以为入口还叫旧名。
  机械替换会产出「设置 → 设置」这类半句，逐条核过的例外：`a11y-audit.mjs` 修回
  「设置 → 全站设置」、`index.css` 两条路径补全成「设置 → 全站设置 → …」。

### 二、修「全站设置 / 账号与安全 在中心里又弹一层 Dialog」

- 根因不在中心，而在**转发层拿了默认导出**：`SettingsDialog` / `AccountDialog` 的默认
  导出是 `(props) => <XxxPanel {...props} withDialog />` —— `withDialog` 被硬写成 `true`
  且写在 spread 之后，调用方传 `withDialog={false}` 会被顶掉，于是中心里再长出一层弹窗。
- 修法：`navigationCenter/panels/` 的两个转发文件改取**具名导出**（业务本体），再显式
  `withDialog={false}`；默认导出保持原样，命令面板等旧入口行为不变。
- 回归用例钉住「选中 config / account 后 `[role="dialog"]` 只允许有 1 个」
  （`tests/navigationCenter.dom.test.tsx`），叠层复现即红。

### 三、退出登录钉在左栏底部

- 原来分组与危险区同在一个内容高度的 flex 列里，危险区紧跟在最后一个分组后面，分组一多
  就被推着走。现在**分组区 `flex: 1` 自己滚**、**危险区 `flexShrink: 0`**，退出登录永远
  贴着左栏下沿；外壳左栏改成 `overflow: hidden`，滚动交给导航内部（左栏与右栏各自滚，
  整张 paper 不滚）。

### 四、文案对齐真实标签 + 审计脚本跟上中心化

- 改名后引导文案让人去「设置 → 账号管理」找一个不存在的条目：一律对齐左栏注册表
  （`账号与安全` / `备份与恢复` / `AI 设置`）。顺带修掉两处**指错了面板**的老文案：
  `AccountDialog.tsx:808` 的「网站设置 → 数据保留」、`VisitsPanel.tsx:116` 的
  「网站设置 → 数据同步」—— 这两节只存在于「全站设置」面板（`SettingsDialog.tsx:706/655`），
  `网站设置`（`SiteSettingsModal`）里只有 基本信息 / 分组与标签 / 描述与备注 / 登录凭据；
  文案改成「设置 → 全站设置 → …」，钉死它的断言（`tests/accountDialog.dom.test.tsx`）
  同步更新。
- 手工审计脚本跟上中心结构：`script/site-audit.mjs` 的入口匹配加 `exact`（「设置」是
  「显示设置」「网站设置」的子串，包含匹配会点错地方）；`script/ui-probe.mjs` 的备份
  测量从「下拉菜单 + `MuiDialogContent/Actions`」改成「左栏 `[data-workspace-nav=backup]`
  + 面板正文 `[data-workspace-panel-body]` + 底栏」，两张表的「一打开 / 滚到底」对比保留。

版本号从 22.0.0 跳到 **23.0.0**：按 `script/bump-version-lib.mjs` 的机械阈值，本轮
58 文件超过 minor 的 20 文件线，就是 major —— 顶栏入口名、弹窗层级、左栏布局三样
用户看得见的东西都变了，不虚高。

## 2026-10-31 · 重构 + 工程：导航页「更多选项」收进统一中心 / 九屏全量内联（22.0.0）

「更多选项」原来是一个下拉菜单，十来个动作点开各有各的弹窗 —— 尺寸、标题栏、底部按钮
文案都不一样，找一项设置要在两层之间来回跳。这一轮收成**一个中心弹窗**：左栏按
「数据与活动 / 系统与工具 / 个人与支持」分组，右栏换面板，尺寸与视觉统一。九屏全部是
**真实业务体**，不再有占位。44 文件 / 5038 行。

### 一、外壳：一个弹窗 + 左栏换面板

- 新增 `NavigationCenterDialog` + `settingsWorkspace/`（Dialog / Nav / Panel 三段外壳）：
  桌面「左栏 + 右栏」，移动端全屏两步式导航；标题、关闭、「完成」统一。
- 条目注册与权限（审计日志仅 owner；账号与安全 / 退出登录仅登录态）集中在
  `navigationCenter/model.ts`，改分类只改一处。
- 无障碍命名写在 `slotProps.paper`（MUI 把 role=dialog / aria-modal 放 paper 插槽），
  写 `<Dialog>` 顶层会落到 Modal 根 —— 守卫钉在 `tests/navigationCenter.dom.test.tsx`。

### 二、九屏全量内联（业务体抽取 + withDialog 标志）

- 每个原弹窗抽出一个**业务体**（`XxxPanel`）＋一个 `withDialog` 标志：
  `true` 自带 Dialog 壳 + 标题 + 关闭（供命令面板等原入口继续用）；`false` 只出内容，
  由中心统一给标题与「完成」。
- 覆盖：统计 / 备份与恢复 / 回收站 / 审计日志 / 全站设置（`ConfigPanel`）/ AI 设置
  （`AiPanel`）/ 密码保险库（`VaultPanel`）/ 账号与安全（`AccountPanel`，含嵌套
  「恢复私钥」子弹窗）/ 快捷键与操作帮助（`ShortcutsPanel`）。
- 挂载/卸载语义替代原来的 open 语义：保险库「打开探测 / 关闭清空」、AI「打开重读配置」
  改成基于 React 挂载，中心内联时保存/恢复不关中心。
- 「账号与安全」激活时经 `onAccountActivate` 拉会话列表 / 账号清单（原来在打开独立
  弹窗时拉），避免这一屏进去看到空数据。

### 三、懒加载与清理

- 双层 lazy 不变：中心外壳 lazy，九面板各自 lazy 且只挂载被选中那一个
  （守卫 `tests/navigationCenterLazyGuard.test.ts`；首屏 gzip 预算仍过）。
- 删除 `MoreMenu` 下拉菜单、`PlaceholderPanel` 占位体及其守卫标记；移除
  `NavCenterPanelProps` 与「打开原弹窗」兜底通路。
- 8 道门禁全绿：typecheck / lint / 3527 单测 / build / budget 10/10 / smoke /
  a11y 0 / contrast 0。

## 2026-10-30 · 修复 + 工程：离线队列不再静默丢 / 保留策略真库用例 / Q-3 豁免分批（21.1.0）

21.0.0 把 P3 六项的骨架立起来之后，这一轮补的是骨架下面的洞：离线队列从「写不进就静默丢」
改成「超限就显式拒绝」，保留策略补上真库用例，Q-3 的 63 条豁免按季度分批到期。零新依赖，
7 文件 / 777 行。

### 一、离线队列：总字节闸门 + 不可序列化载荷显式拒绝

**问题**：以前只有单条载荷上限（256 KB），队列整体没有上限；更要紧的是 `writeJson` 吞掉
localStorage 配额异常，**写不进就静默丢**。

**做法**：
- 新增总字节闸门 `MAX_QUEUE_BYTES = 1 MB`：`enqueueMutation` 在单条检查之后再算总量，超限抛
  `OfflineQueueFullError`，文案直接展示给用户。
- 失败清单同样加 `MAX_FAILED_BYTES = 1 MB`，按最旧先丢裁到上限（`while (failed.length > 1 && …)`，
  保底留 1 条）。
- **QA 挖出的真缺陷**：`estimatePayloadBytes` 的 `catch { return 0 }` 让不可序列化载荷（循环引用）
  被判成 **0 字节**——两道闸门都当它免费放行，`writeJson` 再把 stringify 的错吞掉，结果
  **内存有、盘上无**，而且**一条就能毒化整个会话**（之后正常操作也写不进盘，刷新全丢）。
  修法：catch 改成 `Number.POSITIVE_INFINITY`，`enqueueMutation` **先判 `Number.isFinite` 再判单条上限**，
  非有限值抛新的 `OfflineQueueUnserializableError`。
  - **为什么用 Infinity 不用 `MAX_PAYLOAD_BYTES + 1`**：后者会落到「载荷过大」的文案，对用户说错原因。
  - **为什么顺序不能反**：先判上限会让 `QueuePayloadTooLargeError` 打印出 `Infinity KB`。
- `pushFailed` 裁剪时先取 `droppedBytes`、判 `isFinite` 再减——否则 `failedBytes` 变 `-Infinity`，
  裁剪循环立刻退出，防线静默失效（正是这轮在修的那类缺陷）。

**口径诚实**：`MAX_QUEUE_BYTES` 是「args 序列化字节上限」，**不是盘上硬上限**。实测每条信封开销
约 123 B（kind/ts/uid/opId/state），102 条时闸门口径占 99.8% 而盘上 101.0%，极端条目数下溢出约 1.2%。
余量靠的是 5 MB 配额远大于 1 MB——不要照这个常量去断言盘上字节数。

**测试**：`tests/offlineQueue.test.ts` +3 条，核心是**反毒化断言**——拒绝一条循环引用之后，
再入一条正常载荷必须成功**且盘上真的多一条**（断言顺序特意先盘上后内存：反过来报错只会说
「内存多了 1 条」，而真正致命的是盘上没动）。`tests/siteCreator.dom.test.tsx` +1 条覆盖用户可见文案链路。

**红绿验证**：把 catch 临时改回 `return 0`，3 条新用例全红，反毒化那条报的正是
`盘上也必须真的多一条 —— 否则刷新就丢 / 0 !== 1`。改回 Infinity 后全绿。

### 二、保留策略补真库用例（D-16）

**问题**：FakeD1 不执行 SQL，两个 purge 函数的语义差异测不出来。

**做法**：新建 `tests/retentionRealDb.test.ts`，用 `node:sqlite` 真库跑 4 条：无参清过期 /
`purgeExpiredIdempotency(7)` 反证删 0 条 / `purgeExpiredAudit(7)` 走 `datetime('now','-N days')` /
`cleanupExpiredRows().idempotency === 2`。

**D-16 的真相**：`purgeExpiredIdempotency(now = Date.now())` 的入参是**毫秒时间戳**
（`expires_at` 是 INTEGER 毫秒），不是天数。传 `7` 的后果不是「误删未过期键」，而是
**一条都删不掉**——永久静默空转。真库实测：2 过期 + 2 未过期，无参删 2 留 2，传 `7` 删 0 留 4；
`typeof(expires_at)` = `integer`、13 位毫秒。对比 `purgeExpiredAudit(days)` 走
`datetime('now','-N days')`，`created_at` 是 TIMESTAMP 文本。

**变异测试**：把 `recycle.ts` 的调用改回 `purgeExpiredIdempotency(days)` → 4 条里 1 条红，正是
「D-16 接线」那条；把 `expires_at <= ?` 翻成 `>= ?` → 3 条红。证明用例不是空壳。

### 三、Q-3 豁免按季度分批到期

**问题**：63 条 `noUncheckedIndexedAccess` 豁免的 `due` 全是 `2026-12-31`，到期那天集体爆掉，
等于给未来埋了一颗定时炸弹。

**做法**：按文件路径排序切成 21/21/21 三批，`due` 分别为 `2026-12-31` / `2027-03-31` / `2027-06-30`，
`reason` 标注批次；`path` / `owner` 不动，基线 `maxEntries: 63` 不动。守卫实测仍是
「严格层 366 处 / 63 文件；豁免 63 条」。

**负向验证**：临时删掉 `worker/util.ts` 那一条 → 守卫变红并准确点名「这些文件在严格层报错，
但不在清单里：worker/util.ts」，366/63 不变、清单 62。证明守卫不是空壳。

### 四、首屏预算刻度 264 → 266 KB

`index` chunk 实测 251.49 → 251.77 KB，264 的余量只剩 **4.98%**（差 0.06 KB 跌破 5%），
而上一版 5.20% 本来就贴线。入队闸门必须跑在「离线写失败那一刻」，物理上没法 lazy，属于躲不掉的字节。
抬到 266 后余量 5.35%。

**盯一下**：真实首屏（含 modulepreload 与 css）gzip 余量已降到 **3.54%**（289.7 / 300 KB，剩 1.56 KB），
下一轮任何首屏增长都会先撞这条，且会以「gzip 余量 < 3%」的形式发作，不太好归因。

### 五、下一轮挂账

- `script/coverage.mjs`：抢锁失败时内层 runner 不给数据，c8 把覆盖率算成 **0.0%**，报出来像
  「覆盖率崩塌」。应改成「内层 runner 非零退出 → 直接中止并转述锁冲突」，绝不基于空数据算地板。
  仓库已有 `unitRunnerLockGuard` 用例，有现成落点。
- `tests/bundleBudget.test.ts` 的 `BASELINE_KB` 仍 250.01，是预算推导时的历史锚点，本轮刻意不动
  （每轮跟着改会抹掉漂移信号；「当前实测 vs 预算」那条检查用的是实测值，没有假绿）。
- 「合并 RenderBoundary 与根 ErrorBoundary」约 1.3 KB，可作预算紧张时的刀。

## 2026-10-30 · 工程 + 修复：P3 六项持续项 —— 覆盖率分层 / Q-3 棘轮 / 离线载荷上限 / 保留策略 / 扩展契约 / Safari 守卫（21.0.0）

评审报告 §18 的 P3 六项（T-01–T-06）。这一档原本是「持续项」（优先级最低），所以取舍是
**只做机械可绿、收益确定、不破既有门禁的那部分**；任何「全量翻修 / 新增重依赖 / 传染同步路径」
都单列专项（见文末）。零新依赖。

### 一、覆盖率门槛分层（T-2）

**问题**：函数覆盖率地板长期停在 66%，而实测是 69.2%——地板比实测低 3 个点，等于没在防回退。

**做法**：① 先补 `tests/mockClientSurface.test.ts`（把 `MockNavigationClient` 原型上 133 个方法
逐个真调一遍，演示模式那批函数以前只覆盖 27 个）→ 全局函数覆盖 **69.2% → 72.8%**；
② **再**把 `MIN_L2.functions` 从 66 抬到 **70**（顺序不能反，先抬就当场红）；
③ 新增 `MIN_L2_BY_DIR` 按目录的函数覆盖地板：utils 90 / API-methods 91 / worker 87 / server 88 / shared 84。

**为什么地板取「实测 − 约 2pt」而不是 floor(实测)**：QA 独立复核算过，取 floor(实测) 会让
API/methods(93.23) / worker(89.18) / shared(86.67) 三个目录**一个函数都掉不得**——以后任何无关改动
往 worker 添一个没覆盖的分支函数就红，而那不是回归。地板是**防回归**，不是追单个函数的波动；
天天假红的门禁等于没有门禁。

### 二、Q-3 `noUncheckedIndexedAccess` 骨架 + 棘轮守卫

**先纠正一个方案级错误**：原方案想用「独立 tsconfig + exclude 豁免文件」做分层——**不可能**。
TS 的 `exclude` 只影响根文件选择，被 import 的豁免文件仍然进程序、照样报错（实测：`worker/httpUtils.ts`
等 3 个文件就是被 src 的 import 闭包拉进来才报的）。

**做法**：
- `tsconfig.shared.json`：`shared/` 先开该 flag（6 文件 / 194 行 / 零相对 import，按构造即干净，**0 报错**），
  加进根 `tsconfig.json` 的 references。
- `tsconfig.strict-idx.json`：全 `src` 开 flag，**不靠 exclude**。
- `script/strict-idx-guard.mjs`：跑严格层 tsc，解析**真实报错文件集合**，断言「每个报错文件都登记在
  `script/strict-idx-exempt.json` 里」；清单外出现即失败 → **新文件默认进严格层，不靠人记**。
- 单调性：豁免清单只能 shrink——条目数不得超过 `script/.strict-idx-baseline`，`due` 过期未清即失败。
- 已接进 CI（`npm run check:strict-idx`，`.github/workflows/ci.yml`）。

**当前基线**：严格层 366 处 / 63 个文件，豁免 63 条（due 2026-12-31）。全量放开专项另立项。

### 三、离线队列载荷上限（E-3，降级版）

**先修前提**：评审说「大段笔记离线编辑可能触配额」——**不成立**。队列只收 12 个 mutation，笔记编辑
从不入队。真实溢出只有两条：`importData` 整份备份、带 `data:` 图标的批量建站。

**做法**：单条载荷超过 `MAX_PAYLOAD_BYTES = 256 KB` 就抛 `QueuePayloadTooLargeError` 且**不入队**，
调用方（新建分组 / 新建站点）直接展示「该操作过大无法离线保存，请联网后重试」。
体积按 `TextEncoder` 的 **UTF-8 字节**算，不按字符数（中文标题不会被低估）。
全量迁 IndexedDB 单独立项（要改 3 处同步读 + 33 条既有用例前提，收益只在 >5MB 时兑现）。

### 四、数据保留策略（D-16 / D-20）

- **D-16**：`purgeExpiredIdempotency` 其实早就写好、还有单测，只是**生产零调用点**。接进既有周清
  `cleanupExpiredRows()`，返回计数加 `idempotency`。⚠️ 接线时发现一个真坑：该函数入参是**毫秒时间戳
  now**（`expires_at <= ?`），传 `days=7` 会一条都删不掉（清理永久静默空转），必须无参调用。
- **D-20**：`getAuditLog` 原来**每读一次就 purge 一次**（读被放大成写）。改成模块级 6h 节流
  （远小于 7 天保留期，滞留可控），并导出 `resetAuditPurgeThrottle()` 供用例重置模块级状态。

### 五、扩展契约测试 + 标注实验性（F-2）

**为什么值得做**：`extension/` 与主站的编解码（base64url、URL 归一化）从来没有测试钉住，
漂移的表现是「点扩展没反应」，而扩展不在 CI、用户也不会报。

- 新增 `tests/extensionDeepLink.test.ts`：用 `vm` **真加载** `extension/popup.js`（不是把逻辑抄进测试），
  断言 `encodePayload` ↔ `readAddSitePrefill`、`normalizeSite` ↔ `normalizeUrl` 双向一致。
- **抓到一个真 bug**：`popup.js` 的 `normalizeSite` 会把 `file:///etc/passwd` 补成
  `https://file///etc/passwd`（主站会拒），`//example.com` 也会变四斜杠。已按主站判据对齐
  （非 http(s) 显式协议直接拒、抹开头多余斜杠、去默认端口、无 host 拒）。
- `extension/README.md` + `manifest.json` 标注「实验性」。

### 六、Safari 静态兼容性守卫（T-4，降级版）

**为什么不做真机 WebKit**：全链路是自研 CDP + 本机 Chrome，加 Playwright WebKit 要新依赖 + 独立
CI job（15min 单 job 会被挤爆），而收益可由「不引入超基线 API」的静态守卫以近零成本覆盖大部分。

- 新增 `tests/safariApiGuard.test.ts`：10 条超基线 API 清单（`toSorted` / `Object.groupBy` /
  `Array.fromAsync` / `URL.canParse` / `Promise.withResolvers` …），出现必须伴随特性探测或行内豁免。
  ⚠️ 方案原稿把 `AbortSignal.any` 与 `.timeout` 并成一条会误报——仓库里 3 处都是 `.timeout`
  （Safari 16，在基线内），只留 `.any`。
- `docs/architecture.md` 新增 §5.1 浏览器最低支持基线（chrome/edge/firefox ≥111、safari ≥16.4）。
- 真机 WebKit 列专项（需 `playwright` devDep + 独立 job）。

### 验证

八道门禁全绿：`tsc -b --force` / `lint`（0 error，22 既有 warning）/ 单测 **3512 项 3511 pass** /
`build` / `check:budget` 10/10 / `check:coverage`（行 88.2%、分支 87.7%、函数 72.8%）/
`tsc -p tsconfig.shared.json` 0 错 / `check:strict-idx`。

QA 独立验证专门打了负向用例，证明这些守卫不是空壳：豁免清单置空 → 逐个点名 63 个文件；
清单涨 1 条 → 单调性红；新文件漏判空 → 红并点名；`[].toSorted()` → Safari 守卫红且行号准确；
`getGroups` 返回 undefined → mock 执行面用例红。D-16 另用 `node:sqlite` 真库验证「删过期、留未过期」
（FakeD1 不执行 SQL，桩库证明不了这件事）。

### 未做（单列专项，不在本轮）

- E-3 全量迁 IndexedDB（复用 `iconCache.ts` 的 `openDb` 范式）。
- Q-3 全量 src 放开（357 处，2–3 人日，豁免清单逐条毕业到 0）。
- T-4 真机 WebKit CI job。

## 2026-10-30 · 工程 + 修复：P2 收口 —— 弹窗可访问性审计 / 命令面板可访问名 / App.tsx 下沉 / 两篇活文档（20.0.0）

评审报告 §18 的 P2 八项（#13–#20）。其中 #16 本轮复核后确认「早已成立」，#15 的「≤600 KB」
实测**不可达**并如实报告；真正新增能力的是 #18 的弹窗审计 —— 它一上线就量出两个真缺陷。

### 一、弹窗可访问性审计（#18，新增能力 + 修一个真缺陷）

**为什么必须有这一节**：首页与记事本那两遍扫描都是在「没有弹窗」的 DOM 上做的。弹窗是**另一套
焦点规则**（焦点陷阱 / 关闭后归位 / `aria-modal`），里面那批控件从来没被任何自动审计看过 ——
首页全绿推不出弹窗没问题。

**入口选 `Ctrl+K` 而不是点「更多选项 → 设置」**：菜单是两步操作、选择器还会随菜单项文案漂移
（文案一改就静默漏测）；快捷键是产品合同的一部分，用它当入口顺带把快捷键本身也验了。

**判据三条**（`script/a11y-audit.mjs` §4.5）：
- 弹窗有可访问名 + `aria-modal="true"`，内部无无名按钮、无 <24px 可点元素；
- 焦点陷阱：连按 Tab 12 次，焦点始终不出弹窗；
- Esc 关闭 + 关闭后焦点回到**打开前那个元素**（不是掉回 `body`）。

**量出来的真缺陷**：两个命令面板的 `[role="dialog"]` **没有可访问名**。根因是 MUI Dialog 把
`role="dialog"` / `aria-modal` / `aria-labelledby` 全放在 **paper 插槽**上，而 `{...other}` 是往父级
Modal 根（`role="presentation"`）铺的 —— 直接写 `<Dialog aria-label>` 会落在**错误的元素**上，
读屏软件念出来只有「对话框」，没有名字。改法：`slotProps={{ paper: { "aria-label": "命令面板" } }}`
（`CommandPalette.tsx` / `NotesCommandPalette.tsx` 各一处）。

**实测结果**：焦点陷阱 Tab 12 次 **0 次逃出**；Esc 关闭 ok、焦点 `restored`（回到「打开记事本」）；
修完 `audit:a11y` 0 项不合格。另加 `tests/dialogFocus.dom.test.tsx` 三条 DOM 守卫（打开后焦点进弹窗
且 `aria-modal="true"` / 连按 6 次 Tab 不出弹窗 / 关闭后归位），把同一套判据钉在单测里 ——
审计脚本要 build + 起浏览器才跑，单测里那三条是更早的一道闸。

### 二、`App.tsx` 下沉（#17，2440 → 2388 行）

先纠正一个前提：评审点名的两块**在之前批次已经搬走了** —— 站点列表交互在 `useSiteActions` /
`useBulkActions` / `useSiteSearch`，命令面板在 `OverlayHost`。本轮搬的是唯一还在内联的有状态块：
「新增站点弹窗的 AI 补全」（70 行）→ `src/hooks/useNewSiteAiAssist.ts`。

搬出来不是为了行数好看，是这段的正确性靠三个**易漏**的细节，散在 2400 行里改一次就容易顺手改坏：
① 请求序号（弹窗关掉又重开、URL 改一次又改回来，晚到的响应会往**新表单**里写旧结果）；
② 30 秒超时与真响应赛跑（AI 供应商卡住时弹窗会永远转圈）；
③ 重置时机是 `openAddSite + newSite.url`（换 URL 时旧补全结果对新 URL 就是错的）。

配套：`tests/addSiteDialogAi.dom.test.tsx` 的静态守卫改指新 hook，**并新增一条接线守卫** ——
断言 `App.tsx` 真的调用了这个 hook、且把返回值接回原来的引用名。原因是「逻辑搬走了但没接上」
这种错，两条静态守卫都会绿，产品却什么都不做。

### 三、首屏体积核查（#15）—— 结论：**600 KB 目标不可达**，如实报告

实测（本机构建，2026-10-30）：**883.0 KB / gzip 289.7 KB / 6 个文件**

| 文件 | 未压缩 | gzip | 说明 |
|---|---|---|---|
| `mui-core` | 328.8 KB | 101.6 KB | 首屏静态闭包里的 **59 个** MUI 组件 |
| `index` | 250.5 KB | 82.3 KB | 业务代码（App + hooks + components） |
| `react` | 201.9 KB | 62.6 KB | react + react-dom + scheduler（框架地板） |
| `vendor` | 75.3 KB | 35.8 KB | dnd-kit 等第三方 |
| `index.css` | 23.3 KB | 5.8 KB | — |
| `preload-helper` | 3.2 KB | 1.5 KB | Vite 运行时 |

**「MUI 按需」在构建层面已经生效**：`vite.config.ts` 的 `scanFirstScreenMui()` 做源码级闭包扫描，
只把首屏**真用到**的 MUI 归进 `mui-core`，弹窗专用的交回 rolldown 自然分包。所以那 328.8 KB
不是「全量 MUI 被拖进来」，而是「首屏真的用了 59 个组件」这个事实。

**为什么 600 KB 不可达**：react(201.9) + mui-core(328.8) = **530.7 KB** 是框架地板，占首屏 60%。
要压到 600 KB，需要把 mui-core 砍到 ~48 KB —— 只剩 Box/Typography/Button 三件套，等于重写首屏
组件库。review 里另外记着一条同向结论：摘掉 dnd-kit/utilities 实测 **0 收益**（已回退）。

**可选的后续大刀**（都不在本批，需要专项）：① dnd-kit 整体出首屏（−75.3 KB → 807 KB），代价是
牵动四处、且切换排序模式会整列表重挂载；② 把只服务弹窗的 MUI（Dialog 系 / Select / Slider / Switch）
逐个改 lazy 边界，预估 30–60 KB。要不要做，取决于「首屏 raw 883 KB / gzip 290 KB」是否真的值得付
这些风险 —— gzip 290 KB 对这类 SPA 属于正常量级，本批的判断是**先不付**。

### 四、elk / mermaid 二级懒加载（#16）—— 复核确认：早已成立

`elkjs` **不在** `package.json` 里 —— 它是 mermaid 自带的布局引擎。产物侧已核实：`elk-*.js`
是独立的 1.46 MB 块（gzip 455.7 KB），**不出现在 `index.html` 首屏清单**，也**不是 `mermaidSandbox`
入口的静态依赖**（走 `__vite__mapDeps` 动态依赖表）。所以打开页面、渲染普通 `flowchart`（dagre）
都不会下它，只有图表真用了 elk 布局才按需拉取。

这条由 `tests/elkChunkGuard.test.ts`（2026-10-22 补）钉住 —— 一旦有人改成静态 import，1.46 MB 会
立刻回到沙箱入口路径上，而**体积预算拦不住它**（沙箱不在首屏清单里）。本批只把它写进了
`docs/architecture.md` §6，避免下次再当成待办重查一遍。

### 五、`useSites` 回调稳定化（#13）

`applyRemoteData` / `fetchData` 改 `useCallback`，用 `depsRef`（空依赖 + 最新 deps 引用）解掉
「回调引用每次渲染都变 → 挂载 effect 反复重跑」的老问题。挂载 effect 的依赖从 `[]` + `eslint-disable`
改成 `[applyRemoteData]` —— 不再靠注释豁免，靠引用真的稳定。

### 六、`build.target` 与 `browserslist` 显式化（#14）

`vite.config.ts` 的 `build` 段加 `target: "es2022"`，`package.json` 加 `browserslist`
（chrome/edge/firefox ≥111、safari ≥16.4）。原因是这两个默认值都会随工具链升级漂移，
而漂移的表现是「产物在体积或兼容性上突变」，很难在 code review 里看出来。

### 七、`TRUST_XFF` 默认改 0（#19）

`server/entry.ts` 的 `NAVIHIVE_TRUST_XFF` 默认值 `"1"` → `"0"`。自托管 compose **已显式写 1**，
所以标准部署行为不变；只有「绕过 compose 自己起服务、又直接暴露公网端口」的部署才受影响 ——
那种情况原本会因为无条件信任 `X-Forwarded-For` 而让限流/审计拿到伪造 IP。`deploy/selfhost.md`
的环境变量表与「不要把 8787 直接暴露公网」一节同步改了口径。

### 八、两篇活文档（#20）

新增 `docs/architecture.md`（265 行）与 `docs/api.md`（256 行，122 个端点）：
部署拓扑（Mermaid flowchart，Cloudflare 与自托管两条链路并列）、目录职责、一次请求的时序
（sequenceDiagram）、数据表与迁移机制、前端分层、构建分包策略、部署与升级；API 按资源分组的
端点表（方法 / 路径 / 用途 / 鉴权 / 处理文件）。

**关于「历史快照移 `docs/archive/`」这一步，本批没做**：`docs/` 下 43 份文档里有 33 份带日期快照，
逐一比对引用后 **可安全归档的为 0** —— 全部被 README / 其它文档 / 代码注释引用，整批移动会断链。
要归档得先改引用，那是另一件事；在那之前，两篇活文档作为入口，旧快照就地保留。

### 门禁

版本 `19.4.0 → 20.0.0`：按 `bump-version.mjs` 的机械规则，本批 **14 文件 / 1282 行**越过了
1200 行线升`major` —— 涨的主要是两篇新文档（521 行），不是 API 破坏性变更。

tsc `-b --force` 0 错 / eslint 0 error（25 warning，`react-hooks/exhaustive-deps` 0/0）/
单测 3486 项 3485 pass 0 fail 1 skip（新增 4 条）/ build 通过 / 体积预算 10 项通过
（首屏 883.0 KB 距预算 920 KB 余 4.2%）/ 冒烟通过 / `audit:a11y` 0 项不合格（含新增弹窗节）/
`audit:contrast` 0 项（亮/暗 × 首页/记事本四遍）。
⚠️ `npm audit` 本轮**没跑成**：registry 的审计端点连返 502（`upstream connect failed`），
本地试了两次都一样 —— 所以这里**不写「0 漏洞」**。CI 里那条硬门禁会照跑，以 CI 结果为准。

## 2026-10-30 · 工程 + 修复：P1 收口 —— D1 严格模式 / 全文索引 / 升级健康门禁 / SW 外壳 / 视觉回归（19.4.0）

两件事互相联动，所以一起做：**先让模拟层在违反 D1 限制时主动报错**，再用它回头修数据层的缺陷
—— 而不是逐条修完继续漏。

### 一、D1 严格模式（`server/sqlite-d1.ts`）

**现象**：本机 SQLite 的绑定变量上限是 32766、也没有语句数上限，而 D1 的上限是**单条 SQL 100 个
绑定参数 / 100 KB 语句长度**。所以 `IN (?×500)` 这种写法在本机跑得飞起、到线上必炸 —— 评审里已经
因为它漏掉了 4 处同源缺陷。

**根因**：差异只在上线那一刻才存在，本机没有任何东西会报。这与本轮 P0 那三处是同一类病：
检查一直在跑，但它能检查的东西里根本没有失败的那一项。

**改法**：
- 数字写进代码里（`src/API/d1Limits.ts`），不再只活在注释里 —— 只有能被 import 的数字才会被单测钉住。
  取值逐条标注来源：`D1_MAX_BOUND_PARAMS = 100`、`D1_MAX_SQL_LENGTH_BYTES = 100_000` 取自
  <https://developers.cloudflare.com/d1/platform/limits/>（2026-10-30 校验）；
  **`D1_MAX_BATCH_STATEMENTS = 1000` 未能核实** —— 官方文档只说「单条语句的限制适用于 batch 内
  每条语句」并举例 2000 条的 batch 能跑，**没有给 batch 语句数上限的数字**，所以这是本仓的工程
  保守值而非平台限制，已在常量注释里写明。
- 另加一条文档可核实的差异：D1 的 `bind()` 只支持 `?` 与 `?NNN`，不支持 SQLite 认的
  `:name` / `@name` / `$name`（取自 prepared-statements 页）。
- 违反时**抛错**而不是 `console.warn`：警告会被淹没，这一整轮评审的教训就是「检查一直在跑但没人看」。
  报错里带上折叠过的 SQL 形状（`?×101`），一眼能认出是哪种调用形态。
- 默认关，靠 `NAVIHIVE_STRICT_D1=1` 打开；CI 的 e2e 步骤带上它跑。
  ⚠️ 只有跑在自托管 `server/` 上的步骤真的走这套检查（走 workerd 的那几条用 D1 模拟器，
  读不到这个适配器）—— 这一点写在 ci.yml 的注释里了，免得以后以为它守着所有路径。

### 二、批量删除的分批与原子性（`data.ts` / `recycle.ts` / `transfer.ts`）

**现象**：一次最多删 500 张卡，但实现把 500 个 id 拼进**一条** `IN (?×500)`；而同一份仓库里
`transfer.ts` 那边是正确分批的 —— 两种写法并存，因为本机谁也炸不了。

**改法**：
- 按 `chunkByParamBudget` 切批（预留 `scopeSql` 追加的那个 `user_id` 参数，边界上差一个就是
  「线上失败 / 本机全绿」）。实测：改动前的实现在 250 个 id 时一条 SQL 绑 **250 个参数**、
  500 个 id 时绑 **500 个**；改动后最坏一条 ≤ 100。
- 每批**一次 batch**：`[回收站 INSERT×k, 墓碑 INSERT×k, DELETE, 审计]` 同一个事务。
  以前「写回收站」是一个 batch、「删真身 + 墓碑 + 审计」是另一个，中间崩一次就留下
  「回收站里有、站点还在」—— 用户看到的是卡片没删掉、回收站却多了一堆条目，且无从解释。
  **实测（把改动前的实现换回来跑同一条用例）**：删真身失败后，回收站留下 3 条、墓碑留下 3 条；
  现在是一条都不留。
- 顺序改成「先写墓碑、再删真身」：同一批里顺序不影响原子性，但表达的是「先留痕、再动手」——
  反过来的话，任何一次拆分提交都会留下「墓碑已删、卡片还在」的幽灵卡片。
- 还原路径的 `INSERT OR REPLACE INTO sites`：这个 id 已被一张**活着的**卡片占用时改为不指定 id，
  让 SQLite 另分配一个。以前会被整行顶掉，现象就是「删两次只能恢复一次」。
- 备份恢复（D-8）按语句数上限切批。**这条要明说代价**：D1 **没有跨 batch 的事务**，所以
  「要么全成、要么一个字节都没动」只在装得下单个 batch 时成立；装不下时原子性降级到「每批」，
  报错里会写清「共 N 批，第几批没过、前面已写入多少条，重跑可收敛」（导入是幂等的）。
  ⚠️ 跨批原子性是 D1 给不到的，不是没做。

### 三、全文索引启动真实探测（#8，根治「索引永久不启用」）

**现象**：评审发现线上 `notes` 4 行 / `notes_fts` **0 行** —— 全文索引建了但一行没写，所有搜索永远走 LIKE 全表扫（性能问题，结果仍对；但埋着「索引真空时 0 命中直接返回空、不退 LIKE」的真漏洞）。

**根因**：`migrationState.ftsReady = true` 只在迁移**步骤**里点亮；正常冷启动走的是版本快路径（已是最新版本直接 return），那一步被整段跳过 → `notesFtsReady` 恒为 false，所有 FTS 写入被 `if (!this.notesFtsReady) return` 静默跳过。**没有任何一条自动检查会失败**，只能人肉从零重审才看得见。

**改法**：
- 每次冷启动**真实探测**：先 `probeNotesFtsMatch` 探活（实际跑一次 MATCH），再据实补建 / 补齐索引，最后把 `ftsReady` 设成「行数对得上才是真的 ready」。`ensureNotesFtsReady` 全程不抛，失败降级为 LIKE 而非崩。
- `NOTES_FTS_ROWID_REBUILD_SQL` 从「先 DELETE 后 INSERT」改成「先 INSERT OR REPLACE 新行、再按 rowid 删旧行」—— 中途失败不再留空索引。
- 0 命中分支按「索引可不可信（行数是否对得上）」决定退不退 LIKE，而非「命中数是否 0」：正常空搜索不再每次多付一次全表扫，索引真空时仍退 LIKE 不漏结果。
- 配套 `tests/notesFtsProbeRealSql.test.ts` **6 条真 SQLite 用例**（FakeD1 不执行 SQL，测不出这类失效；改用 Node 自带的 `node:sqlite` 真库）。

### 四、Service Worker 外壳网络优先（#10，根治发版后 15 秒空屏）

**现象**：发版后用户打开站点会空屏最长 15 秒，直到 SW 自己超时。

**根因**：SW 外壳（壳 HTML / 引导脚本）走 cache-first，新版本上线后旧壳还被缓存着、又引用了已被删除的旧 chunk → 主模块脚本 404 → JS 没跑 → 首屏死骨架不消失。`/api/bootstrap` 一次都不发，从服务端日志就能判定「JS 压根没跑」。

**改法**：外壳改为**网络优先**（network-first），发版后立刻拿到新壳、新 chunk 引用也对得上；仍保留 boot-guard 兜底（15s 骨架仍在 → 清 Cache + 注销 SW + reload 一次）。

### 五、升级健康门禁 + 失败自动回滚（#9）

**现象**：原来网页「一键升级」只有「拉镜像 → 重建 → 报告 done」，没确认新容器真能服务。compose 重建成功、容器却起不来（镜像坏 / 迁移卡死 / 配置错）时站点直接停摆，要人半夜手动回滚。

**改法**：两条升级路径（spool 模式的 `docker-compose.yml` upgrader + sock 模式的 `entry.ts` `upgraderCommand` 起一次性 helper 容器）现在都在 `compose up` 之后多一段：
1. 重建**前**：`docker inspect` 拿当前（旧）镜像 ImageID，打 `navihive:previous` 锚点（recreate 之后 latest 已是新镜像，旧镜像只剩这一份）；
2. 重建**后**：轮询 `docker inspect` 的 `Health.Status`（≤40×3s=120s）—— Dockerfile 自带 HEALTHCHECK 探 `/api/init`，不依赖容器里有没有 curl/wget；
3. 明确 `unhealthy` 或超时（一直 starting）就 `docker tag previous` + `compose` 回滚到旧镜像。

决策抽成纯函数 `shouldRollback`（`upgradeHealth.ts`）由单测逐格钉死；两条路径的脚本由 `tests/systemUpgradeGuard.test.ts` 钉住相同锚点 tag / 探活字段 / 回滚命令。**本机无 daemon，端到端行为无法本地验证**，靠单测 + 守卫保证两路径一致、且不会因一侧改了回滚命令而另一侧没跟上。

### 六、视觉回归指纹法（#11，故意排除在 CI 外）

**做法**：`script/visual-regression.mjs` 用**布局 / 计算样式指纹**而非像素截图比对（基线 15 份，覆盖 desktop/narrow/mobile × home-light/dark / settings / notes / share-note）。

**为什么排除在 `npm run ci` 外**：CI 跑器的字体与本地不一致，像素截图必然假红；指纹法对字体不敏感，但为彻底避开「CI 偶发红」仍只作为**本地 / 人工复核**工具，由 `tests/visualRegressionGuard.test.ts` 守基线文件齐全（15 份）。

### 七、门禁

`tsc -b --force` 0 error / `eslint` 0 error（25 warning，全是既有 react-refresh）/
单测 **3482 用例、3481 通过、0 失败、1 跳过** / `build` 成功。
本批发新增门禁用例：FTS 真 SQLite 探活（`notesFtsProbeRealSql`，6 条）、升级健康门禁守卫
（`systemUpgradeGuard`，14 条）、视觉回归基线守卫（`visualRegressionGuard`，5 条）；
FTS 用例跑在 Node 自带的 `node:sqlite` 真库上（FakeD1 不执行 SQL，测不出这类失效）。
`npm run e2e:share-extra` 在 `NAVIHIVE_STRICT_D1=1` 下 46/46 通过 —— 它没走到批量删除路径，
所以这条只说明分享那条链干净，不代表全库干净。

## 2026-10-29 · 修复：六项 P0 —— 三处静默失效 + 三个兜底缺口（19.2.0）

来源是一次**不引用任何既有结论的从零重审**。六项里有三处是同一类毛病：**代码在跑、界面在显示、
自动检查全绿，但事情其实没发生**。这类问题不会让任何测试变红，只能靠人肉重读一遍代码才看得见，
所以优先做掉。

### 修复一：加载失败被显示成「还没有任何分组」

`useSites` 里 `setError` 从来只被赋过 `null`——取数失败时只弹一条 6 秒后自己消失的 toast，
而列表的渲染守卫是 `!loading && !error`。于是**请求失败后守卫恒成立**，`groups` 是空数组，
页面照常渲染空态文案「还没有任何分组」。

用户视角的后果比崩溃更糟：崩溃至少不会被误认为数据丢失；这个会让人以为几百个网站没了，
甚至跑去重新建分组。

顺带修掉了同一个状态的**反向误用**：`error` 还被 `useAccountSession` / `useSiteSettings` 用来装
「账号已注销」「已退出登录」「凭据已更新」这类**流程提示**，写进去之后整个站点列表会直接消失、
页面上一个字都没有。这两处改走 `notify`，`onDataError` 这个参数整个删掉——留着它，下次还会有人往里塞。

- 取数失败（非 silent）：`setError(message)`，成功即清，重试成功后错误面板自己退场。
- 静默刷新（缓存垫底后的后台取数）失败：仍只弹 toast，不升级成整页错误。
- 渲染改三态 `error → loading → 列表`，错误面板带「重试」并明说「数据没有丢」。
- 错误面板与 `RenderBoundary` 的崩溃面板**共用面板样式常量**（`components/panelStyles.ts`），
  边框与底色刻意保留差异：一个是「中性故障」，一个是「原位顶替整个列表的占位」。

### 修复二：自动备份开着，但链路已经十周没产出

每周自动备份的窗口被写死成 **UTC 周一 02:00–02:59 这一个小时**，错过不补跑；触发器又是进程内
`setTimeout` 对齐整点——容器恰好在那一小时里重启/升级，这一周就整周没有备份，而且**没有任何补跑逻辑**。

线上对账（只读）：最后一次自动备份停在 `2026-10-19`，10-26 那一周整周空白。更隐蔽的是
`webdav.lastAutoBackupAt` **从来没被写过**，而 `webdav.lastBackupAt` 会被手动备份覆盖——
界面那句「上次备份：10月26日 18:40（手动）」看着一切正常，实际自动链路早就断了。

- 到点判定改成「**距上次成功 ≥ 6.5 天就补跑**」（`worker/cronLogic.ts` 的 `shouldRunNavBackup`），
  任意时刻进程活着都能补上，重启/升级不再吃掉一周。
- 补写 `webdav.lastAutoBackupAt`，与记事本备份的 `notesBackup.lastAutoBackupAt` 对齐。
- 存量兼容：没有该键时从 `webdav.lastAutoBackup` 文件名里解析时间戳；两样都没有 = 视为该跑。
- 界面把「上次备份」拆成**自动 / 手动两行**；自动开关为开且超过 8 天没成功时用警示色提示。

### 修复三：懒加载块的「重试」按钮，点了 100% 失败

`ChunkBoundary` 的 `retry` 只是把 `attempt` 加一、让 `<Suspense key={attempt}>` 重挂子树；
但 `React.lazy` 把 `import()` 的 rejected promise **缓存在组件对象上**，重挂拿到的是同一个对象、
同一个 rejected 缓存，首帧就原样再抛一次。也就是说：用户看到「重试」按钮，点下去界面闪一下、
回到同一句错误——而它正是断网/部署切换场景里唯一能自救的按钮。

- 改成 `clearCachesAndReload()`：清 Cache Storage（单条失败不影响）→ reload，带 3 秒兜底定时器，
  与 `public/boot-guard.js` 的自救语义一致。按钮文案改「刷新页面」。
- 文案层（`utils/chunkFailure.ts`）不再许诺「重试会重新取一次」，改成「会刷新页面后重新加载」。
- 删掉 `attempt` state 与 `<Suspense key>`，并把那条反向注释改写成「为什么重挂子树不可能救回来」。

### 修复四：备份是明文 gzip，界面一句提示都没有

`webdavUpload` 在口令为空时直接上传未加密的 gzip。而备份里有**两条各自独立的明文密钥通道**：
站点密码（`exportData` 先解密，受「备份含登录凭据」控制）与 **`ai.apiKey` / `ai.cfToken`**
（走 `ownConfigs`，读完即解密，**完全不受那个开关影响**）。

这台实例的 `webdav.backupPassword` 恰好没配。

- 走「强警示」而不是硬拦（硬拦会打断已有实例的手动备份流程）。
- 服务端写 `lastBackupInfo.encrypted`，「上次备份」那行直接显示「已加密 / **未加密**」。
- 口令框下常驻一句说明：留空 = 不加密，文件里有站点账号密码（当前设置下）与 AI 密钥。
- 老记录没有 `encrypted` 字段时既不猜「已加密」也不猜「未加密」——不编。

### 修复五：依赖漏洞扫描永远绿

CI 里是 `npm audit --audit-level=high || true`，等于没有门禁。改成两段：
`--omit=dev` 的**运行时依赖卡门**（改了就让 job 红）+ 全量审计继续只报告
（devDependencies 的高危常常没有修复版本，全量卡门会让 CI 长期红）。

改前本地实测 0 漏洞，所以这门一开就是绿的。

### 修复六：只有容器内健康检查，站挂了没人知道

`Dockerfile` 的 HEALTHCHECK 打的是容器里 `127.0.0.1` 的 `/api/init`——它只能回答
「容器里的 Node 进程还活着吗」。宿主网络挂了、DNS 错了、反代 502 了、证书过期了，它全都看不见，
因为**它跟服务在同一个网络命名空间里，压根不经过那些环节**。

- 新增 `script/uptime-check.mjs`（零依赖纯 Node，能在什么都没装的小机器上由 cron 跑）：
  `/` 要 200 且含 `id="root"`（防空壳——反代指错时 nginx 默认页也可能返回 200）、
  `/api/init` 要 200；可选 `--container` 翻容器访问日志算 5xx 条数与占比。
- 失败时 `ALERT_WEBHOOK` 非空就 POST `{text, base, failures[], at}`（通用形态），为空只打 stdout。
- 抓不到容器日志（没装 docker、容器名不对）就**跳过并说明，绝不因此判失败**——
  拨测脚本自己误报一次，运维就会永久忽略它的告警。
- `deploy/selfhost.md` 新增「十四、外部拨测与 5xx 告警」，含 5 分钟 crontab 示例与局限说明。

### 附：首屏预算常量为什么动了

`tests/bundleBudget.test.ts` 的 `BUDGET_KB` 261 → 264、`BASELINE_KB` 238.44 → 250.01。

错误面板**必须静态进首屏**：它出现的场合正是「请求失败」，这时再去下载一个 chunk 等于让
错误提示自己也转圈。单独的 esbuild 实测是 1522 字节。而改之前 index 块已经是 248.5 KB、
离 5% 余量线（248.57 KB）只剩 0.1 KB——这道门禁在当时就已经贴线，任何首屏代码都会红。
`BASELINE_KB` 原本停在 238.44 是历史遗留的陈旧值，这次一并标定回真实大小。

复用 `RenderBoundary` 的面板样式常量后，index 块落在 **250.00 KB**，余量 5.6%。

### 验证与边界

已跑：`tsc -b --force` 0 error / `eslint` 0 error 25 warning（全部为既有 `react-refresh`）/
全量单测 **3447 个用例、3446 通过、0 失败、1 跳过**（基线 3408，新增 39；跳过的是「软链调用」用例，
Windows 建软链要管理员权限，Linux CI 上会真跑）/ `build` 成功 / `check:budget` 10/10 / `smoke` 通过。

已实测（非推断）：
- 拨测脚本在 VPS 容器内对公网真跑：`/` 156ms、`/api/init` 35ms；
  `--container` 用宿主 60 分钟真实日志解析出 **226 条请求、5xx 0 条**，另有 8 行非访问日志正确排除在分母外。
- 拨测脚本改名后会静默退出 0（启动守卫按文件名正则匹配），已改为与文件名无关的判据并加回归用例。

未验证：自动备份的「补跑」只在单测层面覆盖到时间判定，**没有真的把系统时间推到 6.5 天后跑一遍**；
`ALERT_WEBHOOK` 只验证了「非空才发」，没有对真实 Slack/飞书端点发过。

## 2026-10-29 · 工程：cron-e2e 对齐「满 6.5 天才备份」的新语义（19.2.1）

19.2.0 第一次进 CI，「定时任务端到端」挂了 3 条（17/20 通过）。**不是产品代码回归**——
是这条 e2e 自己的假设过时了。

### 现象

三条断言同时红，都在「再触发一次会再传一份」这条链上：第二次上传没发生，于是「上一份被删掉」
不成立，兜底分支那条「确实列了目录」也跟着白不起来。

### 根因

旧 `isNavBackupDue` 里有一条放行：`cronExpr !== HOURLY_CRON` 就直接判「到点」。cron-e2e 用通配
表达式 `* * * * *` 触发，正好命中它，所以同一秒里连触发几次就真的备份几次。19.2.0 把到点判定换成
「距上次**成功**满 6.5 天」（`shouldRunNavBackup`），这条旁路同时被删掉——第二次触发被**正确跳过**，
测试照着旧假设断言，自然全红。

顺带说一句：那条旁路本身就是「错过窗口不补跑」这个线上 bug 一直看不见的原因——测试永远走不到时间判定。

### 改法

不给生产代码加回测试后门，改成**测试自己把时间往回拨**：

- 新增 `backdate(days)`：把 `webdav.lastAutoBackupAt` 拨到 N 天前。需要再备一次的两处（手动备份那段、
  兜底分支那段）先拨 8 天再触发；兜底那段顺序固定为「删记录 → 拨时间 → 触发」。
- 新增三条断言把这套语义钉死：① 6.5 天内再触发**不重复备份**（PUT 次数不变）；② 被跳过的触发
  **不改写** `lastAutoBackupAt`（这个键只在成功后才写，没变 = 这一轮没有产生新的成功记录）；③ 满
  6.5 天再触发**会补上一份**并滚掉旧的。
- 补一条正向断言：备份成功后 `webdav.lastAutoBackupAt` 必须被写。旧代码从来不写这个键，界面因此
  看不出自动备份已经停下——这是 19.2.0 那批修复的核心之一，值得有一条 e2e 守着。
- 删掉 `worker/cron.ts` 里「其它表达式同样全量照跑」那段已失效的注释。

e2e 在本机跑不了（Windows 上 workerd 崩栈，`.wrangler-cron-e2e` 起不来），真实验证靠 CI 的 Ubuntu；
本机门禁 tsc / eslint / 单测 / build 全绿。

### 顺带：Deploy 工作流从「CI 绿自动部署」降级为「手动应急入口」

同批核对发布链路时发现：`.github/workflows/deploy.yml` 一直在跑，也一直在红。

**现象**：`Deploy` 连红 **15 次以上**（回溯到 10-27 之前），没人发现——因为它从来没成功过，
也没人指望它成功。

**根因**：最后一步是 `npx wrangler deploy`，而仓库里**没有** `CLOUDFLARE_API_TOKEN`
（2026-10-29 实测 `/actions/secrets` 返回空列表）。这条自动线从加进仓库那天起就不可能成功，
每次推送只是白跑一遍 `npm ci` + `build`，然后固定失败。

**真正的问题不在这条流水线**：它红着，生产却照样在更新——Cloudflare 侧的 **Workers Builds**
（Dashboard 连 GitHub）是 push 即构建部署，**不等 CI**。实测 `0ae2c189` 那次 CI 是红的，
Cloudflare 上已经把它自动部署上去了。所以 Cloudflare 这条线**本来就没有门禁**；「VPS 那条有门禁」
的印象没错，但两条线的安全感被混起来算了。

**改法**：删掉 `workflow_run` 自动触发，只留 `workflow_dispatch` 手动入口；文件头注释重写成
「常态走 Workers Builds、这里只是应急通道」；门禁脚本随之只保留手动一条路径——原来那段
`if [ -n "$RUN_CONCLUSION" ]` 已经不是「暂时走不到」而是**永远为假的死分支**，留着它只会让下一个人
以为自动触发还在。**没有整份删掉**是因为 2026-10-02 Workers Builds 的构建令牌失效过一次，当时唯一的
补救手段就是手动 `wrangler deploy` —— 那是同一事故的应急钥匙。用它之前必须先补
`CLOUDFLARE_API_TOKEN`，否则手动跑同样死在最后一步。

**没修的**：Cloudflare 那条线的门禁。Workers Builds 的构建命令在 Dashboard 里配，仓库这边改不了；
要装门禁，得把构建命令改成带测试的（如 `npm ci && npm run build && node script/unit-tests.mjs`）。

## 2026-10-29 · 修复：首屏卡死骨架自愈 + 笔记写着写着变空（19.1.0）

两个线上反馈，一个在首页、一个在记事本。

### 修复一：首屏停在骨架不动

`index.html` 里的纯 CSS 骨架只在 React 提交首帧后由 `main.tsx` 删除；一旦主模块脚本没执行
（chunk 取不到、线路抽风、或浏览器里留着引用已删 chunk 的旧外壳），页面就永久停在骨架 ——
而所有「版本漂移自救」代码都在那个跑不起来的 bundle 里，救不了自己。

- **新增 `public/boot-guard.js` 首屏兜底**：外链脚本（CSP 是 `script-src 'self'`，内联会被拦），
  15 秒后若 `#boot-skeleton` 仍在，则清空全部 Cache Storage、注销 Service Worker，然后 reload 一次。
  主资源在 reload 时强制回源校验，因此「HTML 缓存 60 秒」不会把旧外壳再喂回来。
- **同会话只救一次**：`sessionStorage` 记记号（存储被禁时退回 URL 参数判据），服务器真挂了不会无限刷新；
  挂载成功后才清掉记号，保证下次仍能自救。
- **失败不阻塞用户**：清缓存 / 注销本身卡住时，3 秒后直接 reload；缓存 API 抛异常也照样往下走。

已验证：主脚本缺失的页面在 15 秒后重载一次且不再循环；正常页面挂载不受影响（登录页照常渲染）。
真机表现为「多等 15 秒后自动恢复」，不是即时修复 —— 首次中招仍需一次硬刷新才能拿到带兜底的新外壳。

### 修复二：笔记写到一半整篇变空

记事本列表用 `summary` 模式取正文（长笔记在列表里只有开头一段）。原来一见到
`content_truncated` 就把草稿清成 `null`，于是**每次自动保存成功后**：PUT → 列表刷新回摘要态 →
草稿被清空 → 编辑器空白、字数归零、再敲字也进不去。库里内容其实一直在
（本次线上核对：该笔记正文 325 字完好，并已先做一份数据库备份）。

- 草稿播种改为按「这份草稿属于哪条笔记」判断（`components/notes/seedDraft.ts` 纯函数）：
  换到别的笔记且未补全才清空；同一条笔记刷新回摘要态保留草稿；同一条补全回全文也不覆盖
  用户正在敲的字。
- `dirty` 在摘要态不做比较：拿 200 字摘要跟全文草稿比永远「不相等」，会让自动保存每隔几秒
  重复写同一条笔记（写完又刷回摘要，形成循环）。补全回来后 `dirty` 照常算对并落盘。

## 2026-10-29 · 工程：批次三，模块拆分与公共工具收口（19.0.0）

`script/bump-version.mjs` 已按本批机械变更规模（55 文件 / 9419 行）确定版本由 18.1.1 升至 19.0.0；版本确认不代表已部署。

### 重构与修复

- **NotesPage 实际拆分**：入口组合 `useNotesPageModel` 与 `NotesPageShell`，编辑、列表、批量操作、分类与行菜单逻辑迁入对应 hooks；页面壳层负责展示与组合。
- **导入按阶段编排**：准备、清理、分组/站点/笔记导入、收尾拆为独立阶段，沿用既有单事务边界，不改变导入的数据语义。
- **统一服务端日志**：公共 `shared/logger.ts` 提供 debug/info/warn/error；生产或未知构建环境过滤 debug/info，warn/error 保留，日志调用异常不打断业务。此处不承诺调用方和日志对象全部被 tree-shake。
- **格式化工具收口**：共享日期/字节实现；将 `YYYY-MM-DD HH:MM:SS` 标准化后解析，保留调用方原有 locale/compact 输出及空值约定。目标是解决 Safari 非标准日期解析兼容性，尚未在真实 Safari 上实测。
- **拖拽中文辅助说明**：三个 DndContext 共用中文拾起、移动、放下与取消播报，按当前站点/分组名称解析目标，保留原键盘传感器。
- **死导出按实际引用清理**：核查配置常量全集后仅删除零代码引用的 `BACKUP_NOTES_CONFIG` 及过时注释，其余 33 项保留；不删除历史配置数据，也不改变备份行为。设计文档将原开关方案标为历史。

### 工程与文档

- **disable 理由门禁**：使用现有 TypeScript/TSX 解析器的真实注释 token 检查行级、块级及无规则 ESLint 禁用指令；须同行有非空理由或紧邻上一行有理由注释，避免字符串、模板及 JSX 文本误报。支持引号规则名和含双横线的规则名。
- **长期文档入口与贡献指南**：补 docs 索引，说明 Node/Worker 适配、具名路由处理器、客户端/服务端域注册与真实契约验证边界，移除未验收的生产构建断言。
- **Windows 单测命令行长度**：runner 将 bundle 转为相对仓库路径并以仓库根目录运行，缩短参数总长度，避免触及 Windows 命令行长度上限。

### 当前验证状态

- 已实际通过：全量单测 3393/3393（含新增四项 ESLint 逗号规则回归；覆盖率采集时重跑同数亦全部通过）、tsc、lint（0 错误 / 22 警告）；颜色守卫 / logger / format / dnd 定向回归 37/37。
- v19.0.0 最终构建通过，budget 10/10、smoke、a11y（0 问题）、首页与 notes 亮暗主题 contrast（全部 0 问题）、perf 均通过。
- 覆盖率为行 87.0% / 分支 87.2% / 函数 69.2%，均高于现有地板；Node share-extra 46/46 通过，edge 探测 59 项未出现 5xx。
- **尚未通过 / 待确认**：Worker E2E 被本机 workerd 访问冲突阻断，待 Ubuntu CI 验证；视觉回归仍有 10 场景基线差异；隔离旧 HEAD 同环境复测得到相同差异，未发现本批新增；不更新基线、不记为通过。
- 上述结果不代表已部署。真实 Safari 与真实读屏浏览器不在上述验证范围内。

## 2026-10-29 · 工程：批次二，性能与数据层 + 两条门禁补实（18.1.1）

评审报告 §4 列的 10 项 P1 为主，外加验证过程中撞出来的两条新问题。没有新功能。

**要点**：几千条笔记时每次保存从 76.5ms 降到 4.6ms（FTS 定位方式）；后台轮询不再每轮倒几十 KB 重复数据；两个「名字对但没在量」的门禁第一次真的开始量了 —— 覆盖率从假的 100% 变成真的 87.0%。

### 性能

- **笔记全文检索改成按 rowid 定位**（`notes_fts`）：原来 `note_id` 是 `UNINDEXED`，
  `DELETE ... WHERE note_id = ?` 走全表扫描，实测 3 千条时**每次保存 76.50ms**
  （1 万条外推 ~250ms）；改让 FTS 的 rowid 等于 `notes.id` 后走 rowid 主键，降到
  **4.63ms**，16.5×。附带加了 `notes-fts-rowid` 迁移步骤，把老库按新语义整表重建
  （版本号随之到 28）。
- **`listNotes` 加分页**：原来一次拉全部笔记，现在支持 limit/offset。
- **轮询带变更指纹**：跨设备同步每 30 秒一轮，原来每轮都把「文件夹 + 标签 + 标签关联」
  整份倒一遍。现在服务端算一个指纹，没变就只回 `unchanged`，不再重复那几十 KB。
- **附件上传不再撞 30 秒超时**：慢端点判定没覆盖 `notes/attachments`，而附件上限 25MB
  （25MB / 30s ≈ 830KB/s，弱网必超时），已纳入并给与体量匹配的超时。

### 两条「名字对但没在量」的门禁

- **覆盖率第 2 层第一次真的跑起来了**。以前它调的 `c8` 从来没装过，于是一直只有第 1 层
  「文件被 import 过」—— 全部 100%，连一个 900 行零测试的文件都算「已覆盖」。
  装上之后第一次实测：**行 87.0% / 分支 87.1% / 函数 68.9%**（386 文件 98620 行），
  与第 1 层差 13 个百分点。地板已按实测值回填（85 / 85 / 66）。
  ⚠️ 修这条时挖出一个真因：esbuild 配 `outExtension: {".js":".mjs"}` 时，
  `sourcemap: "external"` **不会**写 `sourceMappingURL` 注释，c8 找不到 map 就不重映射，
  覆盖率全落在打包产物上又被排除，报出来是「98620 行 covered 全 0」。改成 inline 才有数。
- **备份导入加了版本闸门**：导出包里有 `version` 字段，但导入侧读完就丢、从不校验 ——
  新版备份在老版本上导入会静默丢字段。现在比当前版本新的直接拒绝并说明，老的照常进。

### 运维

- **`POST /api/system/upgrade` 补审计**：这是批次一上线当天撞出来的 —— 容器被重建了，
  但审计表里查不到是谁、什么时候、从哪触发的。现在受理 / 提交失败 / 非 owner 越权都会落
  审计（匿名与 501 不记，避免一次盲扫刷满一屏）。
- **Node 版本对齐到 24：试过，CI 红，已从本批剥离**（`.nvmrc` / CI 四处 / `engines` /
  `@types/node` 一并回退到 22）。理由本来很硬：生产容器一直是 24，而所有测试跑在 22 ——
  等于**生产那个运行时没有任何测试覆盖**。一次翻到 24 之后 CI 挂了一条
  `markdownRender.dom` 的图片缓存用例（Node 24 下缓存不命中），本机只有 Node 22 无法复现，
  所以拆出来单独做，不拖住本批。现状与待办已写进 `deploy/selfhost.md` 的 Node 段。
- **更正批次一的一处错误归因**：「自托管 API 响应从未压缩」不成立。`gzip_types` 早就含
  `application/json`，生产 nginx 压静态资源也正常；批次一那行 `gzip_proxied any` 既没修
  什么也没进生产。报告与手册里的相关段落已订正。

### 工程

- 测试替身 `realSqliteD1` 的 `run()` / `batch()` 补上 SELECT 结果回传（与 `server/sqlite-d1.ts`
  的 `runSync` 对齐）—— 否则「batch 里塞 SELECT 取计数」的写法在替身上永远拿到 0。
- 首屏预算 258 → 261 KB（余量 4.33% → 5.5%）。这一批进首屏的是常驻的后台轮询指纹逻辑，
  「合并 ErrorBoundary」那刀评估过最多省一份副本、盖不住这 2 KB，且动的是白屏兜底路径。
- 单测 3335 条（+77）；tsc / lint（0 错 22 警）/ build / budget 10-10 / a11y 0 /
  contrast 4 组各 0 / smoke / ui-probe 全绿。

## 2026-10-28 · 工程：批次一，14 项 P0 止血（17.0.0）

从零重审项目（性能 / 可维护性 / 可测试性 / 兼容性 / 依赖 / 数据 / 日志 / 可访问性 / 文档 /
部署运维 / 容错，见 `docs/engineering-review-2026-10-28.md`）后列出的 14 项 P0，这一批全部清掉。
**没有新功能，全是「已经处于风险状态、一旦触发就是数据丢失 / 权限暴露 / 上线失控」的东西。**

**要点（用户能感觉到的只有第二条，其余是「别再出事」）**

- **（修复）任意接口的 401 都会把用户送回登录页，不再只是 bootstrap 那一条路。** 原来令牌过期后，
  用户点任何按钮都只弹同一句 toast、界面停在原地 —— 看起来就是卡死。现在分三层：
  ① `worker/routes/middleware.ts` 那 **4 处纯文本 401** 全改成统一 envelope（`{error:{code,message}}`）。
  它们以前回 text/plain，客户端 `response.json()` 直接抛 → `parseApiError` 拿到 null → 错误码退化，
  前端于是只能靠 `message.includes("认证")` 猜 —— 改一个字的文案，判据就整体静默失效。
  ② `client.ts` 在**任何** 401 上广播 `navihive:unauthorized`（无载荷；`throw` 之前发，否则监听器永远收不到）。
  ③ `App.tsx` 用一个 `handleAuthFailure` 统一处置，bootstrap 的 `onAuthFail` 与广播共用它，
  靠 `authRequiredRef` 幂等 —— 并发 401 不会重复 `logout()` 再打出一条必然失败的请求。
  连带把 `useSites` / `useAccountSession` / `authFlow` 里 **5 处 `message.includes(...)`** 换成
  `isAuthError()`（判 `code`，`status === 401` 只作老形状的兜底）。
- **（修复）站点列表与登录页不再「一张脏卡片打掉整站」。** 全站原来只有根上一个 `ErrorBoundary`，
  而 `SiteListBody` 与 `LoginScreen` 都在它下方且中间没有边界 —— 一条 `site.tags` 不是数组就能
  让整页变成错误页，用户连「去记事本」这个自救入口都点不到。新增 `RenderBoundary`
  （纯 DOM + 内联样式，不引 MUI）分别包住这两处；它只包住出问题的那一块，头部 / 搜索栏照常可用。
  **不复用 `ChunkBoundary`**：它的文案是给「chunk 没下载下来」写的，对渲染期异常会把人往网络问题上带。
- **（修复）`docker-publish` 不再把 CI 红的提交发成生产镜像。** 原来它是 `on: push: branches:[main]`，
  **完全不看 CI 结论**，而生产（VPS 的 kPanel / compose）拉的正是它产出的 `:latest` ——
  同一个仓库里 `deploy.yml` 的门禁写得极严，唯独通生产这条洞开着。现在改成
  `workflow_run`（只认 `conclusion === success` 且跑的是 `main`，且发布**CI 验证过的那个 sha**，
  不是「那一刻的 main」）+ `workflow_dispatch`（必须填 `ci_run_id`，机器再查一次结论）。
  门禁脚本与 `deploy.yml` 逐字同源，只换措辞。另加工作流级 `concurrency`（`cancel-in-progress: false`），
  避免相邻两次 CI 同时往 `:latest` 上盖。**去掉 paths 白名单不会增加构建量** ——
  `bump-version.mjs` 每次都改 `package.json`，它本来就在白名单里。
- **（工程）单测运行器的两个假红源头都堵了。** ① 加 `--test-timeout`：默认 Infinity 时一条永不
  resolve 的用例会把整个 CI job 挂到 `timeout-minutes`，日志里只剩一句 `job cancelled`，查不出是哪条。
  ⚠️ 但它**也管文件级那条**（node 把每个文件包成一个顶层 subtest，时长算整个文件），所以值不能小 ——
  实测最慢的 `notes.dom.test.tsx`（6802 行 / 226 例）单跑 **120 秒**，一开始写 60000 就把这个健康文件
  当挂死砍了，连带 115 条用例报 cancelled、看起来像大面积失败。定稿 600000（10 分钟，CI job 是 15 分钟），
  余量 5 倍。② 锁文件加 PID 活性探测：`SIGKILL` / OOM / CI 强杀都会把锁留在盘上，原来只照文件报
  「已有运行器在跑」，说的与事实相反、只能人工去删。现在拿不到锁先 `process.kill(pid, 0)` 探活，
  死锁自动回收（`EPERM` 算活着），活锁照旧拦。两个分支都实测过。
- **（新增）服务端异常终于留下了可追的痕迹。** 以前 500 只打一行没有上下文的
  `console.error("[api] 未处理的错误:", err)`，不落库、没有请求 ID，日志轮转后就永久丢失。
  现在 `shared/requestId.ts` 定义唯一头名，`server/entry.ts` 在入口生成并注入（一律覆盖客户端带的值，
  否则伪造同一个 rid 就能把两条请求的日志串起来）、`worker/index.ts` 没有则自生成并**校验白名单字符**
  （防日志注入），响应头回写，`errorReporter` 从 `ApiError.requestId` 带出去 ——
  用户截图里的那句报错与 `audit_log` 里同 rid 的 `server-error` 从此能对上。
  访问日志改成响应结束时打一行 JSON（原来在转发**之前**打，只能证明「请求进来了」，没有状态码也没有耗时），
  只记 pathname 不记 fullUrl（query 里可能是分享口令）；`server-error` 落库按端点节流（10 秒 20 条），
  **不落 stack**（体积 + 容器内路径 + 局部变量值）。
- **（文档）`deploy/selfhost.md` 大修。** ① `:191-250` 原来自相矛盾地教人挂 `docker.sock` + `user:"0:0"`，
  与 `docker-compose.yml:72` 的现方案**完全相反**，照做等于主动交出宿主机 root —— 重写成「为什么不挂」
  + spool → upgrader 容器流程 + 三条备选路线 + 残留风险（写 spool 卷 ≈ 能换运行镜像）。
  ② 第七节改成「备 / 验 / 恢」三段，并补上**恢复演练状态**（见下）。③ 新增第八节升级与回滚
  （`NAVIHIVE_IMAGE` 指到 `<sha>` tag 是唯一的回滚旋钮；「只回退代码不回退库」的有效期与判定 SQL）。
  ④ 新增第九节账号与密钥（三个脚本的分工）＋ 自托管改密码的实测命令。⑤ 顺手脱敏、修掉过期的 gzip 注释。
- **（文档）新增 `docs/README.md` 与 `docs/deploy/release.md`。** 前者是 41 份 markdown 的三列索引，
  并且明确点出四份运维手册**互相有矛盾**、要先认形态（当前生产 = `selfhost.md`）；后者是发布流程
  （本机 → GitHub → GHCR → VPS）五步 + 「pull 前后比对 digest」的纪律 ——
  这套知识原来只存在于不进仓库的本地笔记里，换个人接手等于从零开始。
- **（文档）README 第 0 步补 `.dev.vars`。** 不建就 `npm run dev` 全站 503（这是有意的），
  而 503 的文案「请在部署环境里设置 AUTH_SECRET」会把人往 Cloudflare 后台带。新人第 2 分钟就撞这个。
- **（工程）包管理器不再事实上混用。** `pnpm-workspace.yaml` 在、`pnpm-lock.yaml` 不存在且被 gitignore ——
  `pnpm install` 会装出一棵**没有任何锁约束**的树，而且永远查不出来。删掉 workspace 文件、
  显式声明 `packageManager: npm@10.9.7`，`.gitignore` 里加注释说明为什么不再忽略 lock。
- **（安全）公开仓库地址脱敏 16 个文件。** 真实域名与 VPS 公网 IP 出现在 CHANGELOG、运维手册与历史报告里。
  统一成 `<your-host>` / `<cf-host>` / `<vps-ip>` / `<origin-host>` / `<webdav-host>`。
  **刻意不改的**：`ghcr.io/zwjttztt/navihive`（镜像地址要人能 pull）、
  `script/prod-smoke.mjs:31` 的 `DEFAULT_PROD_URL`（要泄露的是 IP 不是域名，域名本来就是给人访问的；
  改它会弄坏一个每天要用的脚本，而且没有任何测试会红）。⚠️ git 历史里仍有旧值，
  改历史要 force push 会废掉所有克隆 —— **优先做的是缩小暴露面（换端口 / Cloudflare IP 白名单），不是重写历史**。
- **（工程）首屏预算 256 → 258 KB。** `RenderBoundary` 必须常驻（得在卡片崩掉那一刻已经在树上），
  用不了「改成 lazy」那一刀。实测 245.26 KB，抬完余量 5.2%。同时把「真要腾空间该砍哪里」写进注释：
  把 `RenderBoundary` 与根上的 `ErrorBoundary` 合并成同一个组件、用 prop 区分整页 / 局部两种呈现。
- **（验证）全绿**：typecheck / lint（0 err，22 个既有 warning）/ **3258 条单测**（基线 3248，新增 10）/
  build / `check:budget`（10/10）/ `audit:a11y`（0 项）/ `audit:contrast`（首页亮暗 + 记事本亮暗各 0 处）/
  `smoke`（含批量删除撤销）/ ui-probe（P1/P2 + P3 + P4 + 390×844）。
- **（验证）恢复演练（命令级，2026-10-28）**：用 `node:sqlite` 造一个 WAL 模式的合成库
  （`-wal` 里真堆着 1.06 MB 未落盘数据），按第七节三段跑完，**11 项断言全过** ——
  其中「WAL 里未 checkpoint 的数据也在快照里」是「不能直接 `cp`」那个论断的实证
  （快照 16 KB，却拿到了全部行）。**真实库演练仍未做**，那件事只能在另一台机器上、留出一小时来做。

## 2026-10-28 · 修复：复制键改成可读胶囊 + 图标并进站点名称行 + 关闭键提示错位（16.5.0）

**要点**
- **（修复）复制键第三次改：从「图标」变回「图标 + 文字」的浅底胶囊**。16.4.0 把它提到 0.62 半透明，用户仍然反馈「看不清」—— 病根不是不透明度，是**形态**：一个 13px 的灰色线描图标夹在中文正文里，读者根本认不出那是一颗按钮。现在改成 `⧉ 复制` 的胶囊：24px 高、12px 圆角、`--md-inline-code-bg` 浅底 + 1px `--neutral-hairline` 描边 + `--text-secondary` 文字，hover / focus 提亮描边与文字，复制成功变强调色并把文案换成「已复制」。**动作要有重量，别指望用户猜。**
- **（修复）胶囊不再压住窗口边缘**：原来 `right: 0` 贴着正文右边线，长段落时视觉上像是被裁掉一半。现在 `right: 12px`，并且 COPY 块 **预留 28px 操作带**（`paddingTop: 28`）—— 胶囊绝对定位在带内，正文从带下开始，**一个像素都不重叠**。
- **（重构）站点图标并进「网站名称」行**：网站设置 / 新增站点里原来有一个独立的「图标」小节（预览框 + 地址输入 + 获取按钮，占掉整整一屏）。现在图标预览变成名称输入框的**左侧装饰**（`startAdornment` 里一颗 26px 圆角小徽章：有图标显示图标、没有就显示站名首字），点它才展开「图标地址（可选，留空用站名首字）」小面板 —— 默认不占版面。
- **（修复）预览徽章不再是「白洞」**：远程 favicon 拉不到时，`Avatar` 只挂 `src` 会渲染成一块空白。现在无论有没有 `src` 都带上底色 / 强调色 / 描边 / 字号与**首字兜底**，输了地址但图裂了也看得见东西。
- **（修复）新增站点右上角 × 的「关闭」提示跑到几百像素外**：`DialogCloseButton` 把 `position: absolute` 写在了 `IconButton` 上，而 MUI `Tooltip` 认的锚点是它的**直接子元素** —— 那个 `<span>` 是静态的、宽高 0×0，于是气泡挂在了标题文字右边。现在绝对定位挪到包着按钮的 `Box component='span'` 上（它才是 Tooltip 的直接子元素），探针实测气泡在按钮正下方居中（`dx: 0, dy: 42`）。
- **（调整）「获取图标」跟着图标走**：一键获取按钮从名称行右侧挪进「图标地址」小面板内部（`endAdornment`），和它填的那格输入框待在一起。名称行只留左侧预览徽章，右侧干干净净。
- **（守卫）** ① `tests/dialogConsistency.test.ts` 新增「关闭按钮的绝对定位必须在 Tooltip 的直接子元素上」（正则扫源码：`<Box>` 里要有 `position:"absolute"`、`<IconButton>` 里不许有）；② `COPY 块…` 用例重写为断言胶囊形态 —— `position:absolute`、`right:12px`、`textContent === "复制"`、有 svg、无内联 `background`/`color`、块 `padding-top: 28px`、点完 `data-copied="1"` **且**文案变「已复制」；③ `index.css` 的 `.md-copy-btn` 样式守卫改为要求「有边框 + 有底色 + 有文字色 + 有字号」，hover 规则至少要改动 `background|border|color` 之一；④ `addSiteDialog.dom.test.tsx` 断言「图标地址」不再常驻（点徽章才展开）、首字兜底、获取按钮只在小面板里且无链接时禁用；⑤ `SiteSettingsModal.dom.test.tsx` 断言没有独立的「图标」小节标题。
- **（验证）真机浏览器**：`dist/client` 起静态服务用无头 Chrome 实测 —— 胶囊 `62×24`、底 `rgba(15,23,42,0.06)`、边 `1px rgba(128,128,128,0.18)`、字 `12px`；设置页名称行 `hasEdit:true / fetchInsideNameRow:false`，展开后 `fetchInsideIconField:true`；提示气泡 `dx:0 dy:42`；新增站点名称行 `fetchInNameRow:false`。截图五张逐一目视确认。
- **（验证）全绿**：typecheck / lint（0 err，22 个既有 warning）/ **3248 条单测** / build / `check:budget`（10/10）/ `audit:a11y`（0 项）/ `audit:contrast`（4 组各 0 处）/ `smoke`（含批量删除撤销）/ ui-probe（P1/P2 + P3 + P4 + 390×844）。

## 2026-10-28 · 修复：复制键看不见 + 换 logo 后标签页图标不更新（16.4.0）

**要点**
- **（修复）复制键从「隐形机关」改回常显**：16.3.0 在 `@media (hover: hover) and (pointer: fine)` 里写了静止 `opacity: 0`，于是鼠标环境下它**完全不显示**、只有恰好悬停到那块区域才现身 —— 用户原话「复制按键看不见」。现在静止态就是 **0.62** 半透明，悬停 / 键盘聚焦提到 1，点完的 1.2 秒变强调色（`[data-copied="1"]`）。宁可稍微显眼，也不做隐形按钮。
- **（修复）颜色 / 底色交回样式表**：组件里那两句内联 `background: transparent` + `color: inherit` 优先级高于 `index.css`，把 `:hover` 的灰底和「已复制」的强调色**全压掉了**（改了没反应那种）。内联现在只管定位与尺寸。
- **（修复）`public/favicon.ico` 还是 2026-09-26 那版旧图**：换 logo 时只换了 `favicon.svg`，`.ico` 漏了 —— 支持 SVG 的浏览器读 `.svg`、Windows 快捷方式与老浏览器读 `.ico`，于是「logo 没变」的观感有一半来自这个文件。现在用 **sharp** 从新图重建，5 档尺寸（16/24/32/48/64）；**16/24 用简化版**（去掉六边形描边、只留加粗白指针）—— 原图缩到 16px 会糊成一个浅色方框，实测对比后才这么分档。
- **（修复）图标 URL 带版本号，绕过浏览器 favicon 缓存**：浏览器存 favicon **不看 Cache-Control**，键是图标 URL；16.3.0 只改文件内容不改 URL，标签页就一直是旧图。`index.html` 三个图标链接改成 `?v=__ICON_V__`，构建期由 `vite.config.ts` 的 `versionedIcons()` 换成 `package.json` 的版本号 —— 每次发布一个新 URL（发布本来就会 bump 版本），不多不少。
- **（工程）`npm run icons:ico`**：`script/gen-favicon-ico.mjs` 常驻，换 logo 时跑一次重建 `.ico`（临时脚本转正，别下次又漏）。
- **（守卫）** ① 新增静态守卫「复制按钮的样式：静止态可见、永不被藏成 `opacity: 0`」—— 扫 `index.css` 里所有 `.md-copy-btn` 规则：任何一条把它设成 `opacity: 0` 直接红，且静止态不透明度必须 ≥ 0.4、必须有 `:hover`/`:focus-visible`/`[data-copied]` 三条反馈（jsdom 不跑媒体查询层叠，算不出这个坑，只能扫源码）；② `COPY 块…` 用例加两条：内联样式**不许**写 `background` / `color`；③ `tests/brand.test.ts` 新增「图标链接带版本占位符 + 插件已注册 + `.ico` 是多尺寸真 ICO（头 type=1、≥4 档、负载是 PNG）」。
- **（验证）构建产物核对**：`dist/client/index.html` 三处链接为 `/favicon.svg?v=16.4.0`、`/favicon.ico?v=16.4.0`、`/icons/apple-touch-icon.png?v=16.4.0`，`__ICON_V__` 残留 0 处。


## 2026-10-28 · 重构：复制块改成绝对定位图标 + 新 Logo（指南针蜂巢，跟随强调色）（16.3.0）

**要点**
- **（重构）预览窗复制键不再影响文字排版**：`> [!COPY]` 的复制按钮原来是 `float: right` 放在正文**前面**，float 占掉首行约 70px、正文被迫绕排（用户报「复制键影响文字排序」）。现在改成 `position: absolute` 定位到块右上角 —— **完全脱离文档流**，对正文零影响；按钮也从正文前挪到正文后，读屏 / Tab 顺序变成「先内容后操作」。
- **（调整）复制键只留图标**：去掉「复制 / 已复制」两个字的胶囊，换成 13px 的复制图标，默认半透明（0.45）；真能悬停的环境里默认藏起、hover / 聚焦才显形，触屏保持半透明常显（否则永远点不到）。点击后图标换成对勾（`data-copied="1"`），1.2s 后复原。
- **（新增）新 Logo：指南针蜂巢**：`public/favicon.svg` 从「蓝圆 + 两层嵌套六边形 + 中心点」换成「圆角方形底板 + 单个六边形 + 指南针指针」—— 六边形保留 NaviHive 的 hive DNA，指针表达「导航」，圆角方形与界面卡片圆角同一套语言。同步重出 PWA / OG / Apple 图标（192 / 512 / maskable / 180）。
- **（新增）Logo 跟随界面强调色**：`BrandMark` 从 `<img src="/favicon.svg"> + 白色底板` 改成**内联 SVG**，底板用 `var(--accent)`、图形用 `var(--on-accent)` —— 亮 / 暗主题与强调色都能跟上；同时去掉「白牌套蓝圆」的双层容器。⚠️ 形状要和 `public/favicon.svg` 保持一致（静态资产 vs 内联组件，改一处记得改另一处）。
- **（守卫）** ① 单测 `COPY 块…` 改写：断言按钮 `position:absolute` 且不再 `float`、图标-only（`textContent` 为空）、`aria-label` 存在、点击后 `data-copied="1"`；② `index.css` 新增 `.md-copy-btn` 的显隐规则（`@media (hover:hover)` 才允许隐藏，触屏常显），transition 走 `var(--dur-fast)`（motion token 守卫）。
- **（验证）全绿**：typecheck / lint（0 err，22 个既有 warning）/ **3242 条单测** / build / `check:budget`（10/10）/ `audit:a11y`（0 项）/ `audit:contrast`（4 组各 0 处）/ ui-probe（P1/P2 + P3 + P4 + 390×844）/ smoke。
- **（验证）新图标**：`icon-512.png` 实际渲染为蓝底圆角方形 + 白色六边形 + 上白下淡的指南针指针 + 中心点。

## 2026-10-28 · 重构：记事本中栏分割线上移 + 左栏搜索框上移（三栏上方不再对齐）（16.2.1）

**要点**
- **（重构）中栏「所有笔记 / 全文搜索」下方的分割线上移**：头部从吃满 `--notes-header-h`（78）改成 `calc(var(--notes-header-h) - 18px) = 60`，同时去掉之前为在 78 高度下把内容顶回原线而加的 `pb: 2.5`。下方那 32px 的留白消失，分割线从 78 抬到 60 —— 用户原话「空太多了」。
- **（重构）左栏搜索框上移一点点 + 去掉它上面的线**：标题行不再套用编辑区的「头部 − 工具栏」算式（那是为让左栏标题行底边和编辑区工具栏底边撞在同一条 78 线上），改成 `calc(var(--notes-header-h) - var(--notes-search-h) - 12px) = 36`，把搜索框那条带子往上提，搜索框整体随之上移约 3px；标题行底部的分隔线已去掉（用户要的「去掉搜索框上的线」）。
- **（调整）三栏上方不再对齐**：用户明确「三栏的上方不用对齐」。所以编辑区 / 侧栏仍走 `calc(var(--notes-header-h) - var(--notes-toolbar-h))`（头部带含工具栏），中栏独立减 18px，左栏按搜索框算 —— 三栏第一行内容各按各的高度，不再强求同一条线。
- **（守卫）** ① 单测 `三栏头部用同一个高度变量` 改写：中栏从「钉 `var(--notes-header-h)`」改为「钉 `calc(var(--notes-header-h) - 18px)`」；② `script/ui-probe.mjs` 的 **P4** 断言改写：不再钉「四底边同高」，改成钉三件事 —— 中栏分割线确实上移（≤66）、搜索框高度仍 ≤34（没被撑厚）、搜索框仍包在左栏头部内（没溢出）。
- **（验证）ui-probe P4 实测通过**（中栏 listHeader.b = 60、搜索框高 30px 且顶 / 底都在左栏头部内）。
- **（验证）全绿**：typecheck / lint（0 err，22 个既有 warning）/ **3242 条单测** / build / `check:budget`（10/10）/ `audit:a11y`（0 项）/ `audit:contrast`（亮暗 × 首页记事本 4 组各 0 处）/ ui-probe（P3 + **改写 P4** + P1/P2）/ smoke。

## 2026-10-27 · 重构：记事本三栏头部那条线统一到 78（搜索框底边 = 工具栏底边）（16.2.0）

**要点**
- **（重构）三栏头部下边界统一到 78px**：原来左栏搜索框下边停在 **60**、编辑区工具栏下边停在 **96**，差 36px，并排看是断的。用户在原图上用**红框**圈搜索框、**黄框**圈标题行、两条横线标出基准，要求「搜索框下方和工具栏下方的线对齐」「各让一半」→ 两边各挪 18px，一起落到 **78**。
- **（重构）编辑区 / 侧栏的「头部带」从今天起把工具栏算在内**：`78 = 标题行 42 + 工具栏 36`。这两栏的标题行高度写成 `calc(var(--notes-header-h) - var(--notes-toolbar-h))`，工具栏的 `minHeight` 改吃同一个变量 —— 两个值只要有一个单独改，工具栏底边立刻脱离那条线。
- **（重构）左栏那 18px 给了标题行，不是给搜索框**：中途试过把搜索框撑到 48px 填满整条带子，截图一看比工具栏还厚，「白框太大」的老问题又回来了。最终：标题行 30 → **48**（「记事本」随行居中，下移 9px），搜索框仍是 **30**，下边正好落在 78。
- **（重构）中栏那 32px 留白是故意的**：中栏没有工具栏，头部带变高之后只有一行字。补了 `pb: 2.5` 把「全文搜索」连同三个图标压回原来那条线（29.5 → 28.5，肉眼无差）。用户明确「这两个标题不用统一」，所以两边标题都没动。
- **（技术细节）新增 `--notes-toolbar-h: 36px`**：工具栏高度与标题行算式共用同一个变量，避免「改了工具栏忘了改算式」。
- **（守卫）** ①单测 `三栏头部用同一个高度变量` 改写：编辑区/侧栏钉 `calc(var(--notes-header-h) - var(--notes-toolbar-h))`，中栏钉直接的变量，并新增「工具栏 minHeight 必须吃同一个变量」；②`script/ui-probe.mjs` 新增 **P4** 实测断言：真浏览器量**四条底边**（左栏头 78 / 中栏头 78 / 搜索框底 78 / 工具栏底 78）必须同高，且搜索框高度必须 ≤34（防止又把框撑厚）。jsdom 不算布局，`calc()` 在单测里恒为 0，这条只能靠真浏览器钉。
- **（验证）实测**：左栏头 78｜中栏头 78｜搜索框底 78（框 30px 高）｜工具栏底 78；「记事本」文字中心 14.5 → 24，「全文搜索」29.5 → 28.5。
- **（验证）全绿**：typecheck / lint（0 err，22 个既有 warning）/ **3242 条单测** / build / `check:budget`（10/10）/ `audit:a11y`（0 项）/ `audit:contrast`（亮暗 × 首页记事本 4 组各 0 处）/ ui-probe（390×844 + P1/P2 + P3 + **新增 P4**）/ smoke。
- ⚠️ **中栏那条 78 的线以下，「共 N 条」这一行会跟着下移到 78 起**（它本来就在头部外面，属于内容）。

## 2026-10-27 · 修复：左栏搜索框占位符被切成半个字（窄列自动收 ⌘K 提示）（16.1.2）

**要点**
- **（修复）搜索框里只剩「搜」+ 半个字**：用户报「左栏上方太拥挤」时顺手放大截图，才看见占位符是被**裁断**的。逐层量出真因不是「框太大」，而是框**内部**被挤爆 —— 左栏默认 `NAV_COL_W = 128` ⇒ 字段 112px，减掉 MUI outlined 内部左右各 14 内填充（28）、放大镜 20+8、⌘K 胶囊 26.6+8 ⇒ **输入区只剩 19.4px**；16px 字号下一个汉字就要 16px，所以永远只显示一个半字。
- **（修复）窄列里 ⌘K 提示自动隐身**：把桌面左栏声明为**命名容器**（`container-name: notesnav` / `container-type: inline-size`），搜索框里的提示加一条 `@container notesnav (max-width: 147px) { display: none }`。147 是临界值：列宽 ≥148 时输入区还剩 41px 以上，提示才挂得下。
- **为什么不用「命名」以外的写法**：搜索框是三处复用的同一个组件（桌面左栏 / tablet 顶栏 / 手机列表），匿名容器会让后两处跟着某个祖先的宽度乱收。命名后只对桌面左栏那条列生效。
- **为什么不去缩内填充**：把 14 缩到 8 只能挤出 12px，仍不够两个字，反而把放大镜贴到描边上；隐掉提示一次拿回 34.6px。
- **（调整）占位符「搜索标题与内容」→「搜索」**：七字文案在 128px（甚至 104px 最窄档）里永远放不下。语义没丢，`aria-label` 仍是「搜索笔记」。
- **（修复）⌘K 胶囊文字几乎看不见**：它现在是**白底**，原来用 `text.disabled`（38% 黑）压在白底上实测淡到读不出（放大后是一团白）。改 `text.secondary`（60% 黑）。
- **（验证）实测数据**（headless Chrome 真浏览器，非 jsdom）：列宽 128 → 字段 112 / 输入区 **46** / 占位符 32 / ⌘K `none`；列宽 200 → 输入区 91.4 / ⌘K `block`；列宽 104（最窄档）→ 输入区 22 ≥ 占位符 20，仍不裁切。
- **（守卫）** ①`tests/notes.dom.test.tsx` 新增静态守卫：导航列必须声明 `containerName: "notesnav"`、提示必须带 `@container … 147px → display:none`、占位符必须是「搜索」；②`script/ui-probe.mjs` 新增 **P3** 实测断言（用 canvas `measureText` 量占位符真实像素宽，比 `input` 宽度；并断言 ⌘K 在默认列宽下是 `none`）——这条断言直接把用户报的「被切成半个字」钉死，以后再挤回去就红。
- **（验证）全绿**：typecheck / lint（0 err，22 个既有 warning 预算通过）/ **3242 条单测全绿**（+1）/ build / `check:budget`（10/10）/ `audit:a11y`（0 项不合格）/ `audit:contrast`（亮/暗 × 首页/记事本 4 组各 0 处）/ ui-probe（390×844 + P1/P2 + **新增 P3**）/ smoke 全绿。

## 2026-10-27 · 重构：记事本左栏上方参考 inkstone 重排 + 复制块去掉「引用块外壳」（16.1.1）

**要点**
- **（重构）左栏上方三块实色压成一块**：返回键原来是 30px **玻璃白方块**（`--glass-border` + `--glass-bg-hover` + `--header-radius`），配上右边白色搜索胶囊、下面粉色选中行，90px 里塞了三块实色 —— 正是用户说的「太拥挤」。现在缩成 **24×24 裸图标**（hover 才出 `--neutral-hover` 淡底），是全列最轻的一档。
- **（重构）「记事本」标题从居中改靠左**：居中会让它跟上面的返回箭头、下面的搜索框各对一条竖线，三条都对不齐就是「乱」。改成紧贴返回箭头的左对齐品牌行（14px / 500 / `text.primary`），参考 inkstone 左栏第一行「app 名」的写法。
- **（重构）搜索框去掉白底**：底色 `--glass-bg-hover` → **透明**，只留 `--neutral-border` 描边（30% 灰）。⚠️ 描边**不能**退回 `--glass-border` —— v16.0.2 踩过「白底白边、糊成一根灰条」。字段变平之后，右边的 `⌘K` 提示反过来做成**白底小胶囊**（`--neutral-hairline` 边 + `--glass-bg-hover` 底），这才像 inkstone 那块「字段是平的、快捷键是浮起来的」。
- **（重构）左边界统一到 8px**：标题行控件组 `px:1`、搜索框 `px:1.5 → 1`、视图行 `px:0.75 → 1`，原来三条竖线分别在 6 / 12 / 8px。
- **（重构）视图行加前置图标**：全部 `Description` / 最近 `History` / 收藏 `StarBorder` / 未归类 `Inbox`（15px）。纯文字的四行堆在一起没有落脚点，四种视图看起来像四行同样的东西。
- **（重构）复制块去掉全部外壳**：原来是 8% 灰底 + 1px 描边 + **左侧 3px 灰竖线** + 10px 圆角 —— 那就是「引用块」的视觉语言，第一眼必被当成引用；再加 `padding-right: 74px` 把**每一行**都削掉一截，右边留一条死区。现在无底色、无边框、无竖线（`display: flow-root`），只剩一枚 float 的「复制」胶囊挂在首行右上角，正文从第二行起铺满整宽。
- **（修复）复制块里还残留一根竖线**：清掉块级样式后那根线还在，因为它来自**外层 blockquote 包装**（其它内容块刻意保留它当「这是一块内容」的标记）。COPY 现在只摘最外层那一对 `blockquote_open/close`，嵌套在里面的引用照常渲染。
- **（技术细节）按钮从 `position:absolute` 改 `float:right`**：absolute 配容器 `padding-right` 会削掉每一行；float 只让**碰到它的那几行**绕开，第二行起自动回满宽。DOM 顺序也跟着挪到正文**前面**（float 要求先出现）。
- ⚠️ **没走「返回+搜索+收起并成一行」那条路**：真能省 30px，但左栏默认宽度 `NAV_COL_W = 128`（用户可拖到 104~260），并成一行时**搜索框只剩 66px**、占位符挤成两个字 —— 已实测并回退，原因写进代码注释。这一列是可调宽的，不能按宽栏假设排版。
- ⚠️ **配色一律用既有 token**，不新增色值字面量（`hardcodedColorGuard` 按次数计 cap）：胶囊底 `MD_BLOCK_BG`、边 `--neutral-border`，复制图标用内联 SVG 吃 `currentColor`。
- **（验证）** typecheck / lint（0 err，22 个既有 warning 预算通过）/ **3241 条单测全绿**（守卫同步改写：「记事本」标题由「必须居中」反转为「必须靠左且不许居中」，并新增「返回键不许用玻璃白底」「返回键要 24px 级」两条）/ build / `check:budget`（10/10）/ `audit:a11y`（0 项不合格）/ `audit:contrast`（亮/暗 × 首页/记事本 4 组各 0 处）/ `ui-probe`（390×844 + P1/P2 几何，窄屏工具栏 ≤2 行）/ smoke 全绿。

## 2026-10-27 · 新增：可复制块「复制按钮」（16.1.0）

**要点**
- **（新增）工具栏多一颗「复制块」按钮**：选中一段文字 → 点它 → 这段被包成 `> [!COPY]` 内容块；渲染出来块的**右上角常驻一颗「复制」按钮**，点一下整块纯文本进剪贴板，按钮当场变「已复制」再复原（1.2 秒）。
- **（新增）复制的是渲染后的纯文本**，不是 markdown 源码 —— 用户选中的是「看到的那句话」，粘出去不该带 `**` 和 `#`。
- **为什么按钮不挂在「选中文字的右边」**：即时渲染是**块级**的（`NoteEditorLivePreview` 按空行把整段换成组件），一行字在源码里没有自己的 DOM 节点，能挂按钮的只有「渲染出来的块」和「工具栏」。所以做成「块级锚点」，不做「行内浮动」。
- **为什么常驻而不是悬停才出现**：悬停版在触屏上永远点不到（含被 `nav-touch` 判成触屏的笔记本），与卡片浮层那次是同一个坑。
- **语法**：`> [!COPY]` **独占一行**，正文每行带 `> `。不能写成 `> [!COPY] 正文` —— 正文以 `1. ` / `## ` 开头时 markdown-it 会先切成列表/标题，标记摘不掉，整块退化成普通引用、`[!COPY]` 漏在正文里。
- **（修复）内容块首段多一口气**：`> [!NOTE]` 这类标记独占一行时，摘完标记会留一个空段落（多一段 `--md-para-gap` 的空白）。现在解析层把这三个 token 一起摘掉。
- **（修复）内容块首行不再顶一个空行**：markdown-it 把段内换行拆成 `softbreak` 子节点，摘标记后首个子节点成了「换行」→ 段首空一行。现在摘完标记会清掉紧跟着的换行/空白文本。
- ⚠️ **源码模式看不到按钮**：光标所在那段显示的是原始 markdown，只有渲染出来的块才有按钮（架构决定，见上）。
- ⚠️ **HTML 导出里 `[!COPY]` 会以引用块 + 原样标记出现**：导出走的是独立模板，和其它内容块（NOTE/TIP/…）的既有表现一致，本次不动。
- **（验证）** typecheck / lint（0 err，22 个既有 warning 预算通过；新增 1 条 react-refresh 提示）/ **3241 条单测全绿**（+6 条：解析 3、渲染+真实点击复制 2、工具栏插入 1）/ build / `check:budget` / `audit:a11y`（0 项不合格）/ `audit:contrast`（亮/暗 × 首页/记事本 4 组各 0 处）/ ui-probe（390×844 + P1/P2 几何断言，窄屏工具栏仍 ≤2 行）/ smoke 全绿。
- **（未做）** 没在真机截图核对块内按钮与长句的避让；纯色半透明底 + 继承文字色，对比度与正文一致（未引入新色值，`hardcodedColorGuard` 计数不变）。

## 2026-10-27 · 修复：记事本四栏头部 72→60（编辑区标题栏不再空一大截）（16.0.4）

**要点**
- **（修复）编辑区头部偏高**：`--notes-header-h` 原为 72px（= 左栏标题行 36 + 搜索框 36），但编辑区 / 中栏 / 侧栏都只有**一行**内容（44px 标题输入框 + 图标），上下各留约 14px 死白。用户问「标红区域（编辑区头部）是不是太大了」。
- 接 16.0.3：左栏两个控件已收到 30px，这里把**行高**也收到 30，于是 `--notes-header-h` 72→**60**（30 + 30）。四栏头部同步变矮，底边仍对齐在同一条线（实测 nav / list / editor 三栏 header 高度都是 60、bottom 都是 60）。
- 左栏标题行 `height` 从 `HEADER_CONTROL_H(36)` 改吃 `NOTES_NAV_CTRL_H(30)`；`NotesNavPanel` 不再 import `HEADER_CONTROL_H`。
- 再往下（< 60）就得连标题输入框 `PANE_HEADER_H(44)` 一起缩，会动到标题字号手感，本次不越界。
- **（验证）** typecheck / lint（0 err，21 个既有 warning 预算通过）/ 3235 单测 / build / `check:budget` / `audit:a11y` / `audit:contrast` / ui-probe（含 390×844 与 P1/P2 几何断言）/ smoke 全绿；探针实测四栏 header = 60px、底边对齐。

## 2026-10-27 · 修复：记事本左上角两个白框缩小 + HTTP→HTTPS 跳转核验（16.0.3）

**要点**
- **（修复）左上角两个白框太大**：记事本左栏的「返回站」按钮与搜索框沿用顶栏的 36px 规格，放进约 230px 宽、还叠着文件夹树的左栏显得笨重（用户报「两个白框都太大了」）。新增 `NOTES_NAV_CTRL_H = 30`，两者各缩到 30px（在 36px 行内居中）。⚠️ 只动这两个控件：`HEADER_CONTROL_H(36)` 不动（否则导航页顶栏一起缩）、`--notes-header-h(72)` 也不动（缩的是控件不是行高，三栏头部对齐不受影响）。搜索框高度走 `--notes-search-h` 变量，仅导航列那份设 30，tablet 顶栏 / mobile 列表仍回落 36。
- **（核验）HTTP → HTTPS 跳转已生效，无需改动**：实测 `http://<your-host>/` → **301** → `https://<your-host>/` → **200**；根路径 / 深层路径带 query / 无尾斜杠 / IPv6 全部 301，Cloudflare 边缘与 nginx 源站（`if ($scheme = http) { return 301 … }`）双层均已生效。浏览器若仍走 HTTP，多半是本地缓存了旧响应，硬刷新 / 无痕窗口即可。
- **（验证）** typecheck / lint（0 err，21 个既有 warning 预算通过）/ 3235 条单测 / build / `check:budget` / `audit:a11y` / `audit:contrast` 全绿；截图核对亮/暗两态：返回站 30×30、搜索框 30px 高，布局仍居中、三栏头部对齐未变。

## 2026-10-27 · 修复：记事本左上角再强化（标题分隔 / 搜索框描边 / 选中态）（16.0.2）

**要点**
- **（修复）标题行分隔线看不见**：v16.0.1 用的是 `--neutral-hairline`（`rgba(128,128,128,0.18)`，18% 灰），左栏是浅底，这道线几乎看不见，标题行和搜索框仍糊成一块。换成 `--neutral-border`（`rgba(128,128,128,0.3)`，30% 灰，与主题无关），亮/暗两套主题里都读得出，是一道「看得见的分隔」而不是若有若无的线。
- **（修复）搜索框看着像灰条、不像输入框**：原来描边走 `--glass-border`（亮色 = `rgba(255,255,255,0.6)` 白底白边、暗色 = `0.12` 白），在纯浅底左栏里等于没有边界。换成 `--neutral-border`（30% 灰）—— 正好是 MUI 默认 outlined 输入框的描边强度，亮/暗都读得出，形状上一眼就是个「输入框」而非浮在底上的灰条。
- **（修复）左栏选中态不够直白**：选中行底色从 14% 强调色提到 20%，配合原有的左侧 3px 强调色竖条（红棕记号色），当前所在位置更一眼可辨。
- **（验证）** typecheck / lint（0 err，21 个既有 warning 预算通过）/ 3235 条单测全绿 / build / `check:budget`（10/10）/ `audit:a11y`（0 不合格）/ `audit:contrast`（亮暗 × 导航+记事本 4 组各 0 不合格）；并截图核对亮/暗两态左上角（标题分隔、搜索框描边、选中态）渲染正确。

## 2026-10-27 · 修复 + 重构：回退卡片网格 + 记事本头部与选中态优化（16.0.1）

**要点**
- **（修复）导航卡恢复固定列宽**：v16 把卡片宽度从固定列数改成 `repeat(auto-fit, minmax(240px, 480px))`，分组里卡片少时每张被撑成约 480×100 的扁长条（≈3:1），用户反馈「不好看也不实用」。回退到 v16 前的固定列 `{50%/33.33%/25%/20%}`，卡片恢复接近方形的紧凑形态；描述行也一并回到原来的三行截断（原先的 `textOverflow/wordBreak` 是跟着 v16 卡片改动一起进来的）。ui-probe 实测每组每卡 276px，最宽/最窄 1.00×。
- **（修复）记事本左栏头部分隔**：标题行（返回站 / 记事本 / 收起列表）与下方搜索框叠在 72px 头部里、之间没有分隔，看着糊成一块。两行之间加一道 `var(--neutral-hairline)` 发丝线；用 `border-box` 让 1px 落在 36px 控件高度内，不顶高头部、不破坏三栏对齐。
- **（重构）记事本选中态更突出**：左栏视图 / 文件夹 / 标签的选中行原来只有 10% 淡底色，不够直白。改为「左侧 3px 强调色竖条 + 14% 底色」（记号色 = 红棕，与「你正在看哪一篇」的语义一致），一眼能认出当前位置。
- **（验证）** 3235 条单测 / typecheck（`tsc -b --force`）/ lint（0 err，21 个既有 warning 预算通过）/ build / `check:budget`（10/10）/ smoke / `audit:a11y`（0 不合格）/ `audit:contrast`（亮暗 × 导航+记事本 4 组各 0 不合格）/ ui-probe 全绿。

## 2026-10-26 · 重构 + 修复：界面评审落地九项（三栏头部 / 字号阶梯 / 强调色分工 / 卡片网格 / 左栏密度 / 手机工具栏）（16.0.0）

**要点**
- **（重构）记事本三栏头部统一到一个高度变量**：新增 `--notes-header-h: 72px`，左/中/编辑/侧四栏的头部容器全部改吃它。原先三栏各算各的（编辑区常量 44、左栏「标题行 44 + 搜索框 36」自然堆叠、中栏 `pt8 + 标题 + pb4 + 描边 ≈45`），实测三栏第一行内容的 y 是 **66 / 60 / 53** —— 并排看是一条被啃断的线。顺带把搜索框从滚动区挪进固定头部：它「随时都要用」，本来就不该被文件夹推走。`PANE_HEADER_H` 保留，语义收窄为「标题输入框自己的高度」。实测 1440 / 1180 / 900 三档下三栏第一行内容 **0px 差**。
- **（重构）编辑器承载面**：分屏时两栏各套一层与单栏预览同款的纸面（`surface-raised` + `card-border` + `--notes-radius-block` + `--shadow-1`），不再「单栏有纸、分屏两片纯白」。中间的分隔从「−4px 负边距 + 发丝线」改成 **9px 真实间隙**（命中区仍是 9px、仍撑满高度，拖得到），纸边+发丝+纸边三根线挤在 9px 里的脏边没有了。
- **（修复）行号在即时渲染下只标半屏**：行号槽改走 `gutterCompartment` 热插拔，与「即时渲染」互斥。原因：即时渲染把非当前段落整块 `Decoration.replace({block:true})`，那些行连 `.cm-line` 都没有，gutter 只可能给剩下的几行编号 —— 实测一篇 5 行的笔记只剩「2」「5」吊在半屏空白里，看着像行号坏了。**只标一部分行比完全不标更让人困惑**，所以即时渲染态整列不挂，回到源码态再逐行编号（走 Compartment 是为了不重建编辑器、不丢撤销历史）。
- **（修复）导航页头部时钟与站名不在一条基线上**：原来是一个 36px 高的**两行**文字块（17px 时间 + 11px 日期）用 `alignItems: center` 挨着 32px 的 H1 —— 两行的光学中心被迫去对单行标题的中心，时钟整体浮在站名右上方。改成**单行**元信息块（13px 时间 + `·` + 12px 日期，`text.primary` / `text.secondary`），`alignItems` 换 `baseline`。顺带加 `compact` prop：滚动进紧凑模式后只留时间。⚠️ 新增 `.nav-clock-meta` 而不是改 `.nav-clock-time` —— 后者被 `VisitsPanel` 的统计大数字复用着。
- **（重构）字号阶梯补上 12px 这一档**：原来只有 18 / 14 / 11，中间断层，于是「分组标题」（导航）和「状态栏」（元数据）视觉重量完全相同。新增 `--notes-label-font: 12px`（分组标题 / 面板标题，600 / `text.secondary`）与 `--notes-meta-font: 11px`（状态栏 / 计数 / 空状态，`text.secondary`）。**导航永远比元数据重一档**。这两档刻意不吃 `--notes-font-scale`：11px 再乘 0.94 就没法读了，随档位缩放的只有正文。
- **（重构）强调色分工（用户选的方案 B）：红棕 = 记号，蓝 = 操作**。新增 `--accent-op`（亮 `#1976d2` / 暗 `#90caf9`）。记事本根节点原来把 `--accent` 改写成红棕，于是**「点一下会发生事」的东西也全成了红棕** —— 焦点圈、拖拽落点、尺寸手柄、多选按钮、面板开合、设置开关。现在判据写成一句话：**「关于这篇笔记的身份与状态」→ 红棕（选中行 / 标签 / [[双链]] / 置顶星标 / 大纲当前行 / 模式段控件当前档）；「命令」→ 蓝**。全站焦点环（`:focus-visible`）也改吃 `--accent-op` —— 导航页两个变量同值所以**零视觉变化**，记事本里焦点终于不再套「记号色」的框。用户在外观里挑的自定义色仍只覆盖 `--accent`（记号），操作色恒定。
- **（修复）导航卡网格：少卡片的分组缩在左边 + 描述硬切**。卡片宽度从固定列数 `{50%/33.33%/25%/20%}` 改成 `repeat(auto-fit, minmax(240px, 480px))`，拖拽策略 `horizontalListSortingStrategy` → `rectSortingStrategy`（前者只算水平位移，换行网格里拖到第二行会算错）。两个关键决定：**用 `auto-fit` 不是 `auto-fill`**（auto-fill 保留空轨道，2 张卡还是各 20%，等于没改）；**上限写 480px 不是 `1fr`**（纯 `1fr` 时「只有一个站点的分组」那张卡会吃掉整行，1440 下实测 845px，跟 8 张卡那档差 3 倍）。描述补 `textOverflow` + `wordBreak: break-word`（中文无空格长串不放过就横向溢出，被卡片的 `overflow:hidden` 切在边线上，就是「到边就断、没有省略号」）。
- **（重构）记事本左栏减负**：计数改成**悬停 / 选中 / 键盘聚焦才浮出**（`opacity` 过渡，不是 `display:none` —— 后者会把数字从读屏里一起藏掉）；分组标题原来**两颗常驻**图标（+ 新建文件夹 / 新建笔记）收成一颗「⋯」菜单（另开一组 state，不与「条目重命名/删除」那份菜单串台）；条目行图标统一进 16px 定宽容器放 14px 字形（不定宽的话深一层级的名称左边缘会跟着抖）。触屏用 `html.nav-touch` 兜底常显 —— 没有 hover 的设备上，悬停才显等于功能被藏掉。
- **（修复）手机工具栏占 3 行（约 190px / 844px）**：窄屏（`bp === "mobile"`）第一行只留 8 个高频入口（标题层级 / 加粗 / 斜体 / 删除线 / 无序 / 有序 / 任务 / 链接），其余全部收进新的「插入」下拉（保留每项的 `data-tool`，冒烟与 a11y 审计照旧能定位）。实测 **390 下从约 190px 降到 41px**。宽屏行为一行没变。
- **（修复）列表行标签换行打断列表节奏**：只平铺前 2 个，其余折成 `+N`（`flexWrap: nowrap`，`title` 给出全部标签名，数字不丢）。`+N` 刻意**不带** `data-note-tag` —— 那是「真标签」的记号，把「+2」算进去等于多出两个标签。
- **（工程）`script/ui-probe.mjs` 加了三处几何断言**（E 段）：头部 `alignItems` 必须 baseline（+ 时钟必须单行）、卡片最宽/最窄比 ≤2.2、窄屏工具栏 ≤2 行且 ≤120px。这三处全是「CSS 写对了但没量过」—— 单测没有布局，抓不到。（踩坑记录：窄屏下页面里同时挂着两份编辑区，侧栏那份 `display:none`，直接 `querySelector` 会量到 0 而 0 会让「≤2 行」假通过；必须先选中一条笔记，否则编辑区整块不挂载。）
- **（验证）** 3235 条单测 / typecheck（`tsc -b --force`）/ lint（0 err，`exhaustive-deps` 0/0）/ build / `check:budget`（10/10）/ smoke（40 项）/ `audit:a11y`（0 不合格）/ `audit:contrast`（亮暗 × 导航+记事本 4 组各 0 不合格）/ ui-probe 全绿。

## 2026-10-26 · 修复 + 工程：界面实测修五处（选中行断边 / 弹窗重叠 / 手机双栏 / 状态栏折行 / 标题被挤）（15.1.0）

**要点**
- **（修复）笔记列表选中行「断了一条边」**：`divider` 列表档里 `borderBottom: "1px solid var(--card-border)"` 是完整简写，把上面 `borderColor` 设的底边颜色一起覆盖了 —— 选中行上/左/右是强调色、底边掉回 8% 的灰（叠在强调色底纹上几乎看不见）。改成选中行显式再给一次强调色，`--card-border` 只留给未选中的行当分隔线。
- **（修复）备份弹窗「从 WebDAV 恢复」的框在缩放时与下方重叠**：`RestoreTab` 根 Stack 是 `flex: 1`（= `1 1 0%`，允许压到 0）。矮视口下它被压成 187/88/8/0px，而内部 WebDAV 块有 `minHeight: 220` 压不下去 → 溢出父级、被 `DialogContent` 的 overflow 从中间切一刀，下边框和下内边距看不见。改 `flex: "1 0 auto"`（不许压缩），矮视口由内容区整体滚动。**1440 宽下 CSS 视口高 < 834px 必现**（≈125% 缩放 + 900px 窗口就是这个状态），实测重叠量由 +14.9 / +114.9 / +194.9 / +274.9 全部转为 −55.1。
- **（修复）手机 390px 编辑区仍是左右双栏**：断点（1180/768）本身没问题，是编辑区**内部**的源码/预览分屏没跟着收，两栏各约 190px 正文不可读。引入 `finePane`（这一刻在显示什么）与 `pane`（用户上次选了什么）分离：窄屏把 `split` 渲染期降级成 `preview`，`pane` 本身不改（桌面布局习惯要留着）。顺带修掉一处隐患 —— `canInsert` 原来按 `pane` 判，窄屏降级后编辑器其实没挂载却告诉工具栏「能插」，用户传完文件发现正文没变。
- **（修复）手机 390px 状态栏折行裁字**：六项信息把「17 字」拆成竖排的「17」/「字」、「工作」截成「工…」、「创建于…」尾巴切出屏幕。窄屏只留**字数**一项（条件渲染，从 DOM 卸掉），容器 `nowrap`。保存状态不受影响（在标题行的 `SaveDot` 上）。
- **（修复）手机 390px 笔记标题被图标挤掉**：标题输入框只剩约 130px，「会议纪要」被硬切成「会议」（`<input>` 不会出省略号）。窄屏把「置顶 / 收藏 / 大纲」收进「⋯」菜单 —— 菜单里三项入口一个不少，零损失。
- **（工程）新增 `script/ui-probe.mjs`**：真实 Chrome + 只读 API 桩，量选中行四边 border 的实际颜色、`elementFromPoint` 命中、弹窗内各块 rect 与 `scrollHeight/clientHeight`，并出图（导航/记事本 @1440 & @390、备份弹窗 5 档视口高度、笔记三种列表档）。上面两条视觉缺陷都是它量出来的 —— 这类问题**单测抓不到、人眼也容易习惯**。
- **（验证）** 3235 条单测 / typecheck / lint（0 err，`exhaustive-deps` 0/0）/ build / 探针复量全通过。

## 2026-10-26 · 性能 + 修复：笔记列表改「摘要优先，正文按需补全」（15.0.0）

**要点**
- **（性能）列表默认不再拉全文**：`GET notes?fields=list` 从「笔记超过 200 条才开」变成**默认档**（正文只回开头 200 字 + `content_truncated` 标记）。`useNotes` 里 `SUMMARY_LIST_THRESHOLD` 与首拉前的 `countNotes` 探测整块删掉 —— 那个开关存在的唯一理由，是「有几条路径把列表正文当全文用」，而不是「摘要不好」。这次把那些路径逐条补上「按需取全文」，开关就没有存在意义了。
- **（新增）`loadFullNotes()`**：一次把所有截断的笔记补成全文（6 路并发、未截断的一条请求都不发、补完写回 state），给整库导出 / 反向链接 / 关系图这类「要看全量正文」的功能用。单条路径继续走既有的 `ensureFullNote`。
- **（修复）草稿种子拿到半截正文 —— 这条会静默丢数据**：摘要档下打开一条长笔记，`active` 第一次进来只有前 200 字，草稿 effect 把它灌进编辑器；补全后 `active` 换对象但 id 没变，依赖只有 `[active?.id]` 所以**不会重跑** —— 编辑器里永远停着半截正文，用户一编辑一保存就把整篇砍成一段。现在截断期间不灌草稿（草稿显式置 `null`：`dirty` 因此为假，避免失焦/切标签页时「立刻落盘」把上一条的正文写进这一条），补全后 `content_truncated` 变 false 触发依赖变化，那时才是真全文。
- **（修复）整库导出（JSON / ZIP）导出的是截断正文**：备份文件本身就是坏的，而用户以为备份好了。现在两条路都先 `await loadFullNotes()` 再打包。
- **（修复）附件上传期间切走笔记**：回写走 `列表里的正文 + 附件链接`，摘要档下等于把这条笔记的尾巴整段砍掉。现在先补全文再拼，补不全就放弃写入（附件本身已存下，能在附件管理器里找回）。
- **（修复）三处单篇导出**（行菜单的 Markdown / HTML / PDF）：同样是半截正文，改成先补全文再导。
- **（修复）附件「引用 N 次 / 未引用」改吃服务端 `ref_count`**：摘要档下本地扫正文会**少算**，尾巴里的引用数不到 → 正在用的附件显示成「未引用」→ 用户照界面清理就真删了。服务端 `INSTR` 数的是库里全文，只会多算不会少算（宁可不删，不误删）。
- **（修复）设置→数据「总字数」改吃服务端 `notesStats.words`**：本地扫实现的只留作老部署兜底（`??` 而不是三元，老返回体缺该字段时不显示空白）。
- **（新增）服务端两个聚合字段**：`notesStats` 增 `words`（SQL 去空白后数字符，正文不出库 —— 老实现是前端把每条笔记读回来再数）、attachments 列表增 `ref_count`；`NOTE_FIELDS` 开始回吐 `link_count`（库里本来就有，只是没暴露）。
- **（工程）拆出 `utils/noteWikiLinkCount.ts`**：`countWikiLinks` 原先住在 `noteWikiLink.ts` 里，而后者顶层 `import MarkdownIt`；`App.tsx` 又静态 import 了 `MockNavigationClient` —— 于是 `mock → noteWikiLink → markdown-it` 这条边把整个 markdown 渲染器（106 KB）拽进了首屏预载，`check:budget` 直接红（982.9 KB / 预算 920）。纯计数搬到不依赖 markdown-it 的独立模块（`noteWikiLink.ts` re-export，实现仍只有一份），首屏预载回到 5 个 chunk、预算 10/10。
- **（工程）CSP 注释纠正**：`trusted-types navihive-sw` 是**收紧**不是后门 —— 缺这条指令时策略名其实不受限（Chrome 155 实测确认），所以指令保留、只把写反的注释改对；Service Worker 注册失败时补一句 `console.warn`，不再静默失去离线能力。
- **（验证）** 3235 条单测 / typecheck / lint（0 err，`exhaustive-deps` 预算 0/0）/ build / smoke / `check:brand` / `check:budget`（10/10）/ `audit:a11y` / `audit:contrast` 全绿。

## 2026-10-26 · 安全 + 工程：五维质量评估后的加固（密钥 / 令牌 / 迁移 / 部署门禁 / 性能）（14.0.0）

**要点**
- **（安全）JWT 过期声明改成必需**：旧逻辑 `typeof exp === "number" && exp < now` 对「根本没有 exp」是放行 —— 一枚不带 exp 的令牌等于永不过期，而改密那条路只 bump `tokenVersion`，覆盖不到「没有 tv 声明的老令牌」与被清除的账号（连版本都没有）。现在反过来：不是 number（缺失 / 字符串 / NaN）一律拒绝，是数字才比时间；放在 `tokenVersion` 校验**之前**，两条互不干扰。
- **（安全）明文存储改为显式 opt-in**：原先「没开鉴权且没配密钥」会自动降级成明文落库（用仓库里公开的常量假加密）。自动降级意味着「忘了配密钥」会静默通过，而明文会跟着备份文件上传到网盘 —— 比弱密钥加密更糟（后者至少防住拖库即读）。现在默认仍加密（只是启动时喊一句警告），只有明确设 `ALLOW_PLAINTEXT_SECRETS=1` 才走明文。
- **（安全）历史明文站点凭据一次性加密回填**：升级前落库的明文密码（D1 导出 / 备份文件里唯一可能躺着明文的一段）在迁移里补一道加密写回；先探密钥再动笔，拿不到密钥宁可留明文也不写空（写空比留明文更糟）。`sitePasswordBackfill` 用例钉死「迁移后必为密文、读回来还原成原值」。
- **（安全）密码下限校验 + 迁移步骤表**：账号创建 / 改密走统一的 `MIN_PASSWORD_LENGTH`（6 位）下限校验，避免空密码 / 极短密码；迁移从「全局版本号」改成「步骤表 + 已执行集合」（加一条步骤 / 一条索引就自动顶号），「补列写了却忘了升号」这类事故在结构上不可能再发生；失败的步骤不进集合、下次冷启动重试，一次 D1 抖动不会吞掉整条升级链。
- **（安全）会话 Cookie 名与幂等键统一**：新增 `shared/sessionCookie.ts` 单一真源；`Idempotency-Key` 全链路统一；CSP 收紧 `require-trusted-types-for 'script'`。
- **（修复）笔记自动保存静默失败**：上传 / 粘贴 / 程序化派发绕过 150ms 合并窗口（`emit` 里的 `pushImmediate`），只有打字才合并；保存失败加重试上限，不再无限重试或静默吞掉。
- **（修复）触屏设备行操作 fallback**：`html.nav-touch` 下笔记行操作按钮常显（触屏笔记本之前会被 `@media (hover: hover)` 反制成隐藏，长按才出菜单）。
- **（修复）空态对比度 / 附件预览占位**：空态文字从 `text.disabled` 提到 `text.secondary`；图片加载占位用 `Skeleton` + 固定宽高比，不再闪白。
- **（性能）并行化笔记 meta 加载**：`useNotes` 并行 `Promise.allSettled` 拉 meta，`loading` 标志不再整页假死；`paneCtx` 收进 `useMemo`，`setDraft` 合并写入。
- **（性能）速率限制加容量上限**：`rateLimit` 加 LRU 淘汰，避免内存无限增长；自托管 `static.ts` 加 gzip + ETag。
- **（工程）部署门禁**：`deploy.yml` 的发布步骤改挂 `workflow_run`（CI 全绿）之后，不再能「测试没跑就上线」。
- **（验证）** 全量 3234 条单测 / typecheck / lint（0 err，exhaustive-deps 预算 0/0）/ build / smoke / bundleBudget / a11y / contrast / perf 全绿。新增 / 修订守卫：`vaultSchema` 版本号随迁移升到 27；`dialogConsistency` 补「`<Dialog>` paper 不许写死圆角（含三元表达式）」；`sitePasswordBackfill` 修复「只退 `schema.version` 不退步骤集合」导致的回填被跳过。

## 2026-10-25 · 重构：全站视觉一致性（顶栏控件 / 焦点环 / 遮罩 / 弹窗外壳 / 确认链路）

**要点**
- **（修复）系统弹窗彻底退场**：`window.confirm` ×4（附件预览的「未保存关闭」、回收站单条/批量「彻底删除」、笔记「外部变更后刷新」）与 `window.prompt` ×1（保险库「修改主密码」）全部换成站内组件。其中**保险库那条最要紧**：主密码原本用 `window.prompt` 收，输入框不回显成掩码、旁边有人就能看见，且不能二次确认、不能校验强度 —— 现在改成内联表单（两个 `type='password'` + 两次一致校验 + 明确提示「改完建议重新生成恢复码」）。其余四条统一走 `ConfirmDialog`（危险色 + 影响面 + 不可撤销 + busy 锁）。
- **（重构）弹窗外壳三区统一**：33 个弹窗的标题（原 15/16/17px 三档、内边距四五种）、正文、操作区（原 px 2/2.5/3 混用）全部收进 `dialogShell` 的 `dialogTitleSx / dialogContentSx / dialogActionsSx`；关闭按钮位置统一 12px（原两处被覆盖成 8）。顺带去掉了 5 个弹窗标题里自带的 `variant='h6'`（20px，比统一值大 3px）与 3 个死类名 `nav-dialog`（CSS 里没有任何规则）。
- **（核查）弹窗出入场本来就统一，这条撤掉**：审查时以为「只有全站设置用了 Slide、其余 32 个是 Fade」，实际是我把 `Slider` 看成了 `Slide` —— 33 个弹窗全是 MUI 默认 Fade，没有不一致。中途试过注入统一过渡组件（窄屏 Slide up / 宽屏 Fade），结果全量单测连续三次在早期 DOM 段挂起（单跑必过、并发必挂，`--test-force-exit` 救不了「测试永不结束」），已完整回退：**一个无法被验证的动效比没有更糟**。
- **（修复）遮罩深度各有各的**：弹窗走 MUI 默认 `rgba(0,0,0,.5)`，笔记抽屉走 `--scrim`（82%）。现在拆成两个**语义** token：抽屉 `--scrim`（要盖死整页导航）、弹窗 `--scrim-modal`（只压一层），并在 theme 的 `MuiBackdrop` 里定死出口。
- **（修复）焦点环会把元素圆角改掉**：`:focus-visible` 里写着 `border-radius: 6px`，于是 22px 的卡片、12px 的列表行一聚焦就「缩角」跳一下。outline 自 Chrome 94 起本就跟随元素圆角，这行是冗余且有害的，已删。
- **（新增）选中文字跟随强调色**：加了 `::selection`（原有默认系统蓝，与红棕强调色体系无关）。
- **（重构）顶栏控件圆角派生**：`HEADER_RADIUS` 从写死 `"14px"` 改为 `var(--header-radius)`（= `calc(var(--card-radius) * 0.64)`，柔和档 14.1px 与改造前一致）。导航页搜索框里散落的 14 / 16 / 12 三个写死值一并收口 —— 切「直角」档时顶栏与卡片终于一起变。
- **（重构）笔记页顶栏与导航页同一语言**：搜索框从 MUI 默认外观（40px 高 / 4px 圆角 / 实色描边）改成 36px 高 + `--header-radius` + 玻璃底 + 细描边；左栏「返回导航站」从裸小图标改成 36px 玻璃方块；中栏头部四个图标按钮统一材质（尺寸刻意 32px —— 中栏最窄可拖到 128px，装不下 4 个 36px）。
- **（新增）字号档位覆盖记事本**：新增 `--notes-font-scale`，祖先 `data-font-scale` 直接继承（笔记页是 `.nav-root` 的子孙），列表标题 / 摘要 / 分组标题 / 标签四处写死 px 改成 `calc(Npx * var(--notes-font-scale, 1))` —— 用户调「字号档位」时两页同步，不再只有导航页变大。
- **（新增）单栏阅读纸面**：`pane === "preview"` 时预览区加一层淡纸面（`--surface-raised` + 细描边 + `--notes-radius-row` + 极轻阴影，980 上限居中）。分屏仍保持无框 —— 那是刻意的。
- **（新增）拖拽抬升与悬停反馈细节**：笔记行拖动中补 `--shadow-pop`（原来只有半透明）；卡片模式 hover 升阴影、染强调色边。
- **（工程）首屏基线照实更新**：`bundleBudget` 的「离上限至少 3%」被压破（874.2 KB / 900 KB，余量 2.9%）—— 但这 21.8 KB 不是本轮涨的，是 v12.6.0 笔记美化 + v12.7.0 视觉对齐 + 本轮的 CSS token 三轮累积，而基线还停在 852.4。基线更新到 874.2、预算 900 → 920（余量回到 5.2%），注释里写明「下次数涨先分清是内容涨还是有组件被改回同步 import」。
- **（验证）** 新增 `dialogConsistency` 6 条守卫：禁 `window.confirm/prompt`、`DialogTitle`/`DialogActions` 必须引用公共 sx、`<Dialog>` 的 paper 不许写死圆角、`HEADER_RADIUS` 必须派生、`:focus-visible` 不许改圆角、`MuiBackdrop` 必须取 `--scrim-modal`。全量 3234 条单测 / typecheck / lint（0 err）/ build / smoke / bundleBudget / a11y / contrast 全绿。
- **（说明）两件刻意不做**：① 滚动容器边缘渐隐（`mask-image` 会给整个滚动容器建合成层，几百行笔记滚动时代价不划算，收益只有 16px 渐变）；② 编辑区分屏加纸面（会把两栏中间那根线变成两条边，破坏「分屏无缝」的既有设计）。

## 2026-10-25 · 重构：记事本视觉语言对齐导航页（圆角 / hover / 阴影 / 分隔）

**要点**
- **（重构）圆角阶梯改为派生自 `--card-radius`**：用户在「外观 → 圆角风格」里能选柔和 22 / 标准 14 / 直角 6，导航卡一直跟着变，记事本却把圆角写死成 12 / 10 / 8px —— 切到直角档后导航是 6px、记事本还是 12px，同一个站点像两个产品。新增三个派生变量（`--notes-radius-row / -chip / -block`），并把记事本里 **14 处**写死值全部换成变量：笔记行、左栏行、格式工具栏（含拼合按钮的左右分段）、设置分段按钮、备份卡片、编辑区头部、侧栏面板、回收站行、代码块 / 引用 / 内容块。soft 档视觉与此前一致（12.1 / 7.9 / 9.9），standard 档 7.7 / 5 / 6.3，sharp 档 3.3 / 2.2 / 2.7。
- **（新增）中栏列表行补 hover 反馈**：同一页面里左栏的行一直有 hover 底色，中栏的行却没有（只有「⋯」按钮显隐）——指针当前停在哪一行读不出来，而导航卡的 hover 也会变底色。补上 `--neutral-hover`（卡片模式用 `--surface-card-hover`，选中行用 accent 16%），并用 `@media (hover: hover)` 包住，避免触屏笔记本把 hover 粘成一片。
- **（修复）卡片模式补成一枚真卡片**：之前「列表样式 → 卡片」只加了底色 + 描边，没有阴影，看着像贴纸。现在静置给 `--shadow-chip`、hover 升 `--shadow-pop` 并把描边染成 accent 35%（与导航卡 hover 的 `boxShadow` / `borderColor` 同一语言）。⚠️ 刻意**不加** `backdrop-filter`：行背后就是中栏纯色底，模糊无物可糊，几百行只会白付合成开销。
- **（新增）中栏头部与列表的分隔**：头部在滚动容器**之外**、又和列表同色，滚动时第一行「凭空贴上来」没有截断感。加一条 `--card-border` 细线，与导航页分组之间的分隔同一语言。⚠️ 一开始还想给头部「微提亮」（`color-mix(bg-base 88%, surface-raised)`），结果底色变半透明、壁纸透上来把标题压成 4.35:1，被 `audit:contrast` 当场抓住并撤回——**这条线才是真正需要的那一层**。
- **（核查）选中行标题染色 —— 本来就有**：上一轮方案里我以为「选中只加粗不染色」，实际代码早已是 `color: isActive ? var(--accent)`（`NotesListPane.tsx` 标题 sx）。本轮核对确认，未做无谓改动。
- **（验证）** 新增 `notesRadiusTokens` 4 条守卫：三个派生变量必须建立在 `--card-radius` 上、圆角档位三值仍在、**记事本组件里不许再出现写死的行/按钮圆角**（`borderRadius: 1.5 / 1.25 / "8px"` 一旦回来就红）、关键容器确实引用了派生变量。全量单测 / typecheck / lint / build / smoke / bundleBudget / a11y / contrast 全绿。
- **（说明）两处「看起来不一致但其实不该改」**：① 编辑区仍是「分屏无框、只有中间一根线」——加卡片会吃掉横向空间并破坏分屏无缝写法（代码里有注释钉着）；② 导航卡边框是白色 60%（给壁纸上的玻璃卡用），记事本在暖白纸面上必须用深色 hairline，照搬会等于没有边框。

## 2026-10-25 · 重构：笔记页面整体美化（排版 / 留白 / 分隔 / 标签 / 暗色）

**要点**
- **（重构）标题建立起层级**：Markdown 的 h1–h6 以前是浏览器默认（h1 2em、h5/h6 比正文还小、字重 700、上下间距相等）。现在定了一套相对正文的比例（`1.75 / 1.42 / 1.2 / 1.06 / 1 / 0.95em`）、统一 600 字重、`line-height 1.35`，并且**上间距 > 下间距**（标题贴着它下面的正文，归属关系才读得出来）。用 em 而不是 px：用户把字号调到 24px，层级跟着一起缩放。
- **（重构）竖向节奏统一**：段落 / 列表 / 引用 / 代码块 / 表格 / 内容块的间距以前是 `8px`、`0.6em`、`2px` 混用，现在统一走 `--md-para-gap`（舒适 12px、紧凑 8px）。顺带把「段距」和「行高」解耦了——行高现在只控行内，用户把行高拉到 1.9 也不会让段落糊成一片。
- **（重构）块的外框语言统一**：代码块 / 引用 / 折叠块 / 内容块统一 `--radius-sm` 圆角 + 细描边 + 一致的内边距；内容块保留自己的语义色左边线（那是语义，不是装饰）。表格边框与表头底色也换成了变量。
- **（重构）暗色块改「提亮叠层」**：以前块底色统一用 `rgba(128,128,128,.14)` 这种中灰——在暖白底上发脏、在暗底上更脏（既不亮也不暗，块边界糊进正文）。现在新增 `--md-block-bg / --md-block-border / --md-inline-code-bg / --md-table-head-bg / --md-rule / --md-quote-border` 六个变量，亮暗各一套（暗色走 `rgba(255,255,255,.06~.18)`）。**渲染器一行 dark 分支都不用写**，切主题自动换。
- **（新增）分隔符分两档**：`---` 仍是细线（切小节），`***` 现在渲染成居中三点（长文分章）——以前两者长得一模一样，作者没法用分隔符选型表达层级。
- **（新增）列表样式三档**（设置 → 外观）：无线（极简）/ 分隔线（默认）/ 卡片。以前只有「透明行 + 选中态描边」，几百条笔记时相邻行边界全靠留白，长列表很难「一行一行看」。选中态永远压过分隔表达（选中是状态，分隔是装饰）。
- **（新增）标签自动配色**：手设过颜色的标签照旧（用户选择优先）；**没设过**的按名称 FNV-1a 哈希取 6 档固定色相（`utils/tagPalette.ts` + `--tag-1..6-fg`），同一名字在任何设备/会话都是同一个颜色。亮态取 900 档、暗态取 300 档：标签会落在**灰底行**上（选中/勾选/hover 后的行底约 rgb(200,199,196)），按 700 档实测只有 3.7–4.5:1，被 `audit:contrast` 抓出琥珀那条 4.2/4.5 后才定的 900 档——最差底色上仍有 5.3:1 以上。
- **（新增）双链样式区分**：`[[笔记]]` 改成点状下划线 + 500 字重（普通链接仍是实线）——笔记类应用里「跳到另一篇笔记」和「跳外链」值得用一条线分开。
- **（重构）内容宽度带留白联动**：预览区左右留白跟着「内容宽度」档位走（窄 24 / 标准 32 / 宽 48 / 满 40），以前固定 20px，宽档 980 时正文贴到屏幕边、长行回来很难找行首。
- **（重构）导出 HTML 对齐**：导出的独立 `.html` 文件补齐同一套标题层级（1.75/1.42/1.2/1.06/1/0.95em）与统一段距，导出的笔记和站内阅读观感一致。⚠️ 该模板是脱离本站运行的静态文件，拿不到 CSS 变量，色值仍硬编码（颜色守卫的豁免计数不变）。
- **（验证）** 新增 `notesAppearanceTab.dom`（4 条：三档存在 / 点哪档回调哪档 / 高亮受控 / 内容宽度回归）、`tagPalette`（5 条：跨会话稳定 / 档位不越界 / 空名返回 null / 分布够散 / 变量名 1..6）、`markdownRender.dom` 追加 5 条（标题梯度与上大下小 / 段距走变量 / 分隔符两档 / 块色走变量 / 双链点线）、`notesSettings` 追加 3 条（listStyle 默认与脏值回落）。全量 3224 条单测 / typecheck / lint / build / smoke / bundleBudget / a11y / contrast 全绿。
- **（工程）颜色守卫 cap 顺势下调**：`markdownToReact.tsx` 的硬编码色从 25 降到 16（块级颜色搬进 CSS 变量了），守卫的 cap 跟着降——只许降的棘轮。

## 2026-10-25 · 修复：笔记备份导入不再丢失卡片绑定（指纹重连）

**要点**
- **（修复）真 bug**：笔记备份导入的 INSERT 把 `site_id` 硬编码为 `NULL`——任何导入（哪怕是同一台服务器的「恢复」）新建的笔记都会丢掉与站点的绑定；主备份导入端虽有 siteIdMap 重映射逻辑，但导出端不带笔记，这条链路形同虚设。
- **（修复）导出带指纹**（改法 1）：`exportNotesData` 新增 `boundSites` 字段——只收集被笔记引用的站点 `{ id, name, url }`；导入端按「规范化 URL 唯一命中 → 名称唯一命中」在目标库重连 `site_id`，匹配不到或多处歧义一律置空（宁可断绑不错绑）；老备份文件没有 `boundSites` 同样置空，行为与从前一致。
- **（修复）INSERT 去 NULL 硬编码**：`importNotesData` 的 plan 增加 `siteId` 计算（含 usedSites 先到先得，一站一篇约束对脏数据也成立），INSERT 的 `site_id` 由硬编码 NULL 改为 plan 值；UPDATE 路径同样带 `site_id`（CASE 保旧值）；绑定前先解绑同站已有笔记（与 updateNote/createNote 的「一站一篇」约束同一套语义）。
- **（验证）** `tests/notesBackup.test.ts` 新增 3 条真实 SQLite 用例：①跨库按 URL 重连（目标库占位站占 id 1、改名站占 id 2，证明是指纹重连而非照抄旧 id）；②指纹匹配不到 / 老备份无指纹均置空；③一站一篇先到先得 + 本地占位被解绑。notesBackup 全套 24 条、全量 3207 条单测 / typecheck / lint / build / smoke / bundleBudget / a11y / contrast 全绿。

## 2026-10-25 · 重构：密码健康从「更多选项」独立弹窗挪进「账号与安全」

**要点**
- **（重构）入口归位**：「密码健康」（把当前账号各站点已存的登录凭据过一遍，重复 / 弱口令 / 久未改 + 检索，方案 A）原本挂在「更多选项」里、紧贴「密码保险库」——两者名近易误点，但数据来源完全不同：密码健康分析的是 bootstrap 拿到的站点登录密码，而保险库（方案 B）只装用户主动存进去的条目、拿不到站点凭据。把它挪进「账号与安全」(AccountDialog) 的「账号与密码」段下方作为内嵌面板，归类更准确（看的正是「我的登录凭据是否安全」）。
- **（重构）去掉独立 Dialog 外壳**：`PasswordHealthDialog` 改为只导出 `PasswordHealthPanel`（纯分析面板，不再自带 Dialog），由 `AccountDialog` 承载，避免「弹窗里再弹一个弹窗」；账号管理本身已是懒加载，面板随之并进 account chunk，不增加首屏体积。
- **（重构）「账号与安全」拆成 Tab 分页**（同日追加，commit e263b30）：仿「数据备份与恢复」的顶部 Tab 写法（MUI `Tabs` fullWidth），弹窗分「账号信息 / 密码健康」两页——账号管理各段（改密、恢复密钥、登录设备、邀请码、沉睡治理、注销）留在「账号信息」，「密码健康」独占一页，不再和账号管理信息堆在同一个长页里。
- **（重构）全站设置拆成三个页签**（commit eb5eb31b）：「外观与搜索」（基本信息 / 外观 / 背景与毛玻璃 / 图标与缩略图 / 搜索）、「数据」（离线与缓存 / 数据同步 / 维护 / 数据保留）、「高级」（自定义 CSS / 版本与升级）。paper 层写死高度（备份弹窗同款做法），切页签弹窗不跳；「保存设置」按钮留在底部全局层，切页不丢草稿；「改的是整个站 / 单个网站去卡片齿轮」的作用域说明保留在页签上方。
- **（重构）回收站按类型分页签**（同 commit）：「站点 / 分组」两页签带计数（导航站回收站只收这两类，笔记归记事本自己的回收站），行内冗余的类型标注随之去掉；「清空回收站」仍是全局动作，确认文案写明「站点与分组」。
- **（验证）** typecheck / lint / settingsDialog + recycleBinDialog + accountDialog DOM 用例全绿（页签切换后断言已同步）/ build / bundleBudget 通过。
- **（清理）删除链路**：`MoreMenu` 的「密码健康」MenuItem 及 `onOpenPasswordHealth` 声明 / 透传（`MoreMenu.tsx` / `HeaderActionsSlot.tsx` / `App.tsx`）一并移除；`App.tsx` 不再单独持有 `passwordHealthOpen` 状态与懒加载，改为把全部站点 `allSitesWithCreds` 作为 `sites` 传给 `AccountDialog`。
- **（验证）** typecheck / lint（0 err）/ 受影响 DOM 用例（moreMenu、accountDialog 全绿）/ build / bundleBudget 均通过。

**说明**
- 「密码保险库」入口保留在「更多选项」不动（双轨决策：站点凭据不进保险库）。

## 2026-10-25 · 修复：首屏骨架屏在跨境回源抖动时被长时间举起

**要点**
- **（修复）根因**：站点经 Cloudflare 反代（`cf-cache-status: DYNAMIC`，每次回源 VPS，约 1.1s 基线）跨境访问，首屏 `bootstrap?full=1` 原本有两个缺陷，合起来就是「打开网站偶发卡在骨架屏」：① `App.tsx` 已从 `firstPaintCache` 把上次快照画出来，但 `useAccountSession` 的初始 `fetchData()` 仍走**非静默**，把骨架屏重新举起——缓存「先画后取」的效果被抵消，每次打开（含二次访问）都白屏等回源；② `bootstrap` 走全局 `REQUEST_TIMEOUT_MS=30s`，再叠加 `useAccountSession` 的两次失败重试，链路偶发抖动时骨架屏最长可举约 90s 才放弃。
- **（修复）缓存先画后取下沉到 `useSites`**：挂载即把可用快照画出来，并用 `paintedFromCacheRef` 标记「已垫底」，让那次初始 `fetchData` 自动转**静默**——二次访问直接看到上次数据、骨架屏不再出现；首次访问（无缓存）仍正常举骨架屏。非静默的 401/认证处理、后台静默刷新逻辑均不受影响。
- **（修复）`bootstrap` 单独收紧超时到 10s**（`src/API/clientMethods/system.ts`）：正常 1s 回源，10s 已是 10 倍余量；抖动时更快暴露失败、交给既有两次静默重试自愈，而不是把骨架屏一直举着。其余非慢端点不受影响（慢端点 backup/import/export/restore/icon 仍走 0 超时）。
- **（验证）`useSites` / `firstPaintCache` / `apiClient` / `clientErrors` / `clientSurface` / `initRace` 六套相关用例共 78 条全绿**；typecheck / lint（0 err）/ build / bundleBudget 均通过。

**说明**
- 这是跨境链路延迟的「前端韧性」修复。要进一步压低首屏延迟，根因在 Cloudflare→VPS 回源（可考虑 Argo Smart Routing / 给 `/api/init` 加短 TTL 边缘缓存），属基础设施层，不在本次代码改动内。

## 2026-10-25 · 方案 B 开工：端到端加密层 + 保险库 schema（先地基）

**要点**
- **拍板 4 项决策**（写进 `docs/password-manager-scope.md`）：① 保险库主密码**独立于登录密码**；② 忘主密码用**恢复码**找回；③ **现有站点凭据不迁**进保险库（双轨，站点卡片照旧）；④ **不做自动填充**（方案 C 搁置）。
- **（新增）加密层 `src/utils/vaultCrypto.ts`**（客户端 WebCrypto 纯函数，未接 UI）：envelope 结构——主密码/恢复码各经 PBKDF2（默认 60 万 iters，客户端跑）派生包装钥，包同一份随机 DEK；条目整体 AES-GCM（随机 IV）加密。服务端只存盐+迭代数+两份 wrapped_dek+条目密文，**永远解不出明文**。`tests/vaultCrypto.test.ts` 9 条，含🔴全链路：主密码解锁 + 忘密码靠恢复码解出同一 DEK + 找回后改密重裹；错密码/错恢复码/密文被改一律认证失败抛错（不会静默解出垃圾）。
- **（工程）保险库 schema 26**：新增 `vault_keys` / `vault_entries` 两表（`migrateVaultTables` 显式建，SCHEMA_VERSION 25→26），服务端只存密文、scopeSql 隔离。`tests/vaultSchema.test.ts` 用真 SQLite 验证迁移建表 + 关键列齐全。

**说明**
- 按 `password-manager-plan-B.md` 的顺序推进：**B1 加密层 + B2 schema + B3 API/路由 + B4 界面** 已交付，保险库**端到端可用**。
  - B3：`src/API/methods/vault.ts`（5 方法，服务端**只搬密文**）+ `worker/routes/vault.ts`（PROTECTED_ROUTES、writeGuard 限速、scopeSql 隔离）；`tests/vaultApi.test.ts` 真 SQLite 验 CRUD + 🔴账号隔离。
  - B4：`src/utils/vaultSession.ts`（客户端编排：建库/解锁/找回/改密/条目加解密，传输层可注入）+ `src/components/VaultDialog.tsx`（建库送**一次性恢复码**、解锁、恢复码找回、条目增改删/复制/显隐、空闲 5 分钟自动锁、**DEK 只在内存**）+ 客户端 5 方法（`clientMethods/vault.ts`，mock 对齐）+「更多选项 → 密码保险库」入口。
  - `tests/vaultSession.test.ts`：Node 真 WebCrypto + 内存传输层跑通 建库→解锁→CRUD→错密码拒绝→🔴恢复码找回数据不丢→改密旧密码失效。
- **B4 改了前端产物**（VaultDialog 进包），本轮**需要部署**才上线。

## 2026-10-25 · 方案 B 收尾：B6 全量备份/恢复现在带走保险库密文（可恢复导入）

**要点**
- **（新增）导航全量备份/导出现在携带保险库密文**：`exportData` 在库里已有保险库时，把 `vault_keys`（KDF 参数 + 两份包好的 DEK）+ `vault_entries`（全部条目密文信封）整包塞进同一份备份 JSON（`src/API/methods/transfer.ts`）；没建保险库 / 老备份自然不含该字段。**服务端全程只搬密文、永不解密**，与「备份文件再整体 AES-GCM 一次」的既有约定一致。
- **（新增）保险库备份的导入语义**（与笔记同源的「字段缺失 = 不动本地」）：`importData` 在**同一个事务**里处理保险库——合并模式且本地无库→整包`adopted`；合并模式且本地已有→整体`skipped`（保留本地，否则本地条目永久解不开）；覆盖模式→整包`replaced`；备份无 `vault` 字段→本地一根汗毛都不动（`none`）。动作通过 `ImportResult.vault` 回报 UI。
- **条目 `site_id` 跟着站点重发号重映射**，绑定不丢；映射不到置 `null`。账号隔离：导入写入的是**当前导入者**的 `user_id`，不会改写别人的保险库。
- **（新增）`tests/vaultBackup.test.ts` 7 条**（真 `node:sqlite` + 真 WebCrypto 端到端）：导出只出密文（主密码/明文绝不入 JSON）、🔴导入到另一账号后原主密码仍能解开、合并跳过、覆盖替换且旧主密码失效、🔴老备份无 vault 不动本地、🔴site_id 重映射、🔴账号隔离。
- **（工程）测试桩修正**：真 SQLite 适配器 `makeRealD1` 的 `run()` 必须回 `meta.rows_written`（幂等锁 `claimIdempotency` 靠它区分 acquired/busy/unavailable，否则被误判为「有别的恢复在跑」把导入拒掉）；`batch` 必须按 D1 语义走 `.all()` 而非 `.run()`，否则导出 `queryExportBundle` 的 SELECT 结果被吞掉、备份变空触发「空备份闸门」。

**说明**
- B6 与 B1–B4 串起来：保险库从**建库→使用→备份→跨账号恢复**全链路闭环，且服务端视角永远只有密文。
- 全量验证：tsc 0 / eslint 0err / 单测 **3204** / build / budget 10 / smoke / a11y 0 / contrast 0。

---

## 2026-10-25 · 方案 A：密码收纳增强（生成器 + 健康检查 + 检索）

**要点**
- **（新增）密码生成器**：站点新建/编辑的密码框加「生成随机强密码」按钮。`utils/passwordGenerator.ts` 纯客户端生成（`crypto.getRandomValues`，拒绝采样消除取模偏置）：默认 20 位、大小写/数字/符号各保证出现一次再洗牌、默认排除易混字符（0O1lI|）；附强度评估（熵 + 常见弱口令/连续序列/重复字符告警）。
- **（新增）密码健康检查**：「更多选项 → 密码健康」弹窗（`utils/passwordHealth.ts` + `PasswordHealthDialog.tsx`）。对前端已持有的解密后凭据做客户端分析：**重复密码**（一码多用分组）、**弱口令**（含具体原因）、**久未改**（>365 天），外加按站点名/用户名检索。**纯前端、零 schema、零迁移、不碰服务端**——这正是方案 A 的定义。
- 方案取舍详见 `docs/password-manager-options-overview.md`（合并三份设计文档的总览，并校正了其中一处过期的「站点密码明文」判断）。

**工程**
- 新增 `tests/passwordManager.test.ts`（19 条：生成器不变量 + 强度/健康确定性用例）；`moreMenu` 计数守卫同步 9→10 项、click-through 用例补「密码健康」。
- 全量验证：tsc 0 / eslint 0err / 单测 **3178** / build / budget 10 / smoke / a11y 0 / contrast 0。

---

## 2026-10-25 · 大文件拆分 #538 + Docker 默认非 root + 性能多轮采样

**要点**
- **（重构）`src/API/methods/notes.ts`（2078 行）按职责拆进 `src/API/methods/notes/` 子模块**：`notesShared`（共享常量 `NOTE_FIELDS` 与防环 `validateFolderParent`）、`notesShare`、`notesBackup`、`notesNote`、`notesAttachment`、`notesFolder`、`notesTag`、`notesRevision`、`notesSearch` 九个文件。主文件只保留 `NotesApi` 接口与组合点（`...shareMethods, ...noteMethods, ...` 展开合成 `notesImpl`）；各子模块导出 `Pick<NotesApi, ...>` 的方法组，方法体保留 `this: NavigationAPI` 写法、由 `http.ts` 混回原型。**组合不改变 `this` 绑定与调用语义**，对外（`navigationApi.ts`、mock 对齐、单测）完全不变。
- **（工程）Docker 默认不再以 root 跑**：`docker-compose.yml` 加 `user: "${NAVIHIVE_RUN_AS:-node}"`，部署容器里的 `node` 用户已就位（S5）。
- **（性能）首屏体感审计改为多轮采样取中位数**：`script/perf-audit.mjs` 默认 3 轮（上限 9 轮）取中位数，`.github/workflows/ci.yml` 注释同步。单轮抖动（实测区间 164–4992 ms）被中位数吸收，Slow-4G + CPU 4× 下 FCP/LCP 稳定落在预算内。

**工程**
- 配套更新 5 个直接 `readFileSync` 解析 `notes.ts` 的静态守卫测试（`noteSql` / `apiMockParity` / `folderRuleParity` / `noteRecycle` / `noteRoutes`）：让它们改读拆分后的子模块，或把 `notes/` 下相关源拼成「虚拟 notes.ts」再跑原有切分/正则逻辑，保证形状守卫不失效。
- `tsc -b` / `eslint` / 全量单测（3159）/ `vite build` / `check:budget` / `smoke` / `audit:a11y` / `audit:contrast` / `audit:perf` 全绿。

---

## 2026-10-25 · P1/P2 收口：WebDAV 出站闭环、依赖清零、覆盖率补到 100%

**要点**
- **（安全）WebDAV 出站也过 DNS 解析复核**：davFetch 因为要支持非标准端口 / 内嵌凭据 / WebDAV 方法语义，一直没走 safeFetch，于是自托管注册的「解析 IP 复核」只覆盖了图标与 AI 两条路 —— 这条路径对 DNS rebinding 是**裸的**。现在 worker/safeFetch.ts 导出 isEgressAllowed()，WebDAV 每一跳（含初始地址）都会复核；显式开了 allowPrivateNetwork 时不复核（否则家里 NAS 全废）；Cloudflare 侧不注册 resolver，行为零变化。两条用例把接线钉住。
- **（安全）依赖漏洞清零**：npm audit 的 6 个命中（1 critical / 2 high / 3 moderate）全部处置 —— 用 overrides 精准升 dompurify 3.4.17（mermaid 生产依赖）、zod 4.6.7（ESLint 插件链）、undici 按来源分别升 7.30.1（miniflare）与 8.12.3（jsdom）。**没有**跑 audit fix --force —— 它给的建议是把 @cloudflare/vite-plugin 降到大版本，那会拆掉工具链。现在 npm audit 报 0 vulnerabilities。
- **（工程）覆盖率统计不再漏掉 server / shared**：script/coverage.mjs 以前只扫 src 与 worker，自托管适配层和前后端共享契约在报表上「不存在」。现在两层进统计并各设 100% 下限；server/entry.ts（Node 进程入口，由 smoke:selfhost 覆盖）显式排除并写明理由。
- **（修复）备份状态「假绿」**：runWebDavBackup 写完文件后记 webdav.lastBackup* 的那段被 try/catch 包着，测试桩没给 setConfig 时报错只落一行 console.error、用例照样绿 —— 「到底写没写」从来没被断言过。桩补齐 + 三条断言（成功要写、详情含耗时、写失败仍算备份成功但必须留日志）。
- **（修复）AI 标签建议的站点指纹只拼 id**：改了站名/网址而 id 不变时依赖数组纹丝不动，弹窗里显示的还是旧名字、建议也按旧内容算。现在指纹含 id + 站名 + 网址，分隔符改用 \u0000（站名里出现逗号是常事）。顺带把文件里两处**字面 NUL 字节**改成转义写法 —— 它让整个文件被 grep/git 当成二进制。

**工程**
- 体积预算口径统一：tests/bundleBudget.test.ts 那条用例标题写着「留 5% 余量」、实际断言是 3%，报告里的「还有 5%」是假的。现在标题与断言一致写 3%，并在注释里记下「设计目标是 5%，当前实测 3.3% / 5.0%，差约 14 KB」—— 没有靠抬预算把数字做漂亮。
- 覆盖率补到 **100%**：新增 tests/ThemeToggle.dom.test.tsx（三档可访问名 + 点击回调）；notesPageCtx.ts 经确认为纯类型文件后按既有约定排除，并由新增的 tests/pureTypeFiles.test.ts 反向守着「被排除的文件必须真的是纯类型」，防止以后有人往里塞运行时代码就悄悄退出所有统计。components 下限回到 100%。
- 本地 npm run ci 与 CI 工作流对齐：补上工作流单独跑的 check:coverage / probe:edge，以及本机一直在跑的 audit:visual。
- 视觉回归进 CI（**观察期，暂不卡门**）：基线在开发机录的，跨机器字体差异会让它两边都绿不了；先让它天天跑、把差异暴露在日志里（continue-on-error），等基线与容差收稳再摘掉。

---
## 2026-10-24 · P1-8 & P1-9：覆盖率分层门禁 + data.ts 表驱动

**要点**
- **（P1-8）覆盖率分层门禁上线**（`npm run check:coverage`，实现见 `script/coverage.mjs`）：按 API / worker / components / hooks / utils / context / 其他(src 顶层) 七层分别统计源文件「触及率」（被任意用例间接引入即算触及），并对每层设下限（components 98%、其余 100%）；任一层跌破即退出码 1、CI 红。纯类型声明与入口文件（`responses` / `schema` / `types` / `main` 等 7 个）已排除，不会逼出无意义的测试。这道门禁抓的是「以后往某层塞了没测的文件」，而不是凭空定个 95%。
- **（P1-9）`src/API/methods/data.ts` 表驱动收口**：把 6 处重复的 `await this.migrate(); return this.withSchemaRetry(() => this.queryX(...))` 模板收成一个类型安全的 `delegate<R, A extends unknown[]>` 转发器（传具体方法引用而非字符串键，`this.queryX.apply(self)` 与原闭包等价），未破坏 `DataApi` 接口契约，tsc 干净通过。

**工程**
- `package.json` 新增脚本 `check:coverage`；`.github/workflows/ci.yml` 在「纯函数单测」之后、「构建」之前插入「覆盖率分层门禁」步骤（零依赖，不依赖构建产物）。
- 当前实测：API / worker / hooks / utils / context / 其他 均 100%，components 98.4%（下限 98%），合计 99.4%；未触及的逻辑文件仅 `notesPageCtx.ts(303)` 与 `ThemeToggle.tsx(60)`，列为下一批补测名单。

---

## 2026-10-24 · P1-2：后端两处「为一个小数字扫全表正文」改成 O(1)

**要点**
- **数据页的「双链」计数不再拉全站正文**。原来 `notesStats` 是
  `SELECT content FROM notes` 把当前账号的**全部正文**从 D1 搬进 Worker，再逐条正则数
  `[[…]]` —— 打开一次数据页就是几 MB 的传输加几 MB 的正则扫描，只为得到一个两位数。
  现在给 `notes` 加了一列 `link_count`（**SCHEMA_VERSION 24 → 25**）：
  写入时算好（新建 / 改正文 / 导入三条路径都维护），读取时一次 `SUM`。
  迁移里带回填（`WHERE link_count IS NULL` 分批 200 条，中途失败下次接着填），
  哨兵用 **NULL 而不是 0** —— 「0 条双链」是合法值，不能和「还没算过」混淆。
- **附件清理不再把全表正文拼成一个大字符串**。`pruneAttachments` 原来是
  「拉全部正文 → `join("\n")` 成一份 corpus → 逐个附件 id 做 `includes`」，
  峰值内存是正文总量的 2 倍。现在交给 SQLite 一次算完：
  `NOT EXISTS + INSTR`，正文一个字都不进 Worker，内存只跟**结果集**有关
  （被删的附件通常是个位数）。
- **顺带修掉一个既存缺陷**（是这次新写的用例抓出来的）：`pruneAttachments` 的注释一直
  写着「正文全集（含回收站 / 归档）」，但 `deleteNote` 其实是「把整行搬进
  `recycle_bin.data`（JSON）→ 再从 `notes` 删行」，所以**回收站里的笔记正文根本不在
  `notes` 表里**。老实现因此会把「一条带图的笔记进回收站 → 清一次附件」的图真删掉，
  用户还原笔记后图片打不开。现在补了第二层 `NOT EXISTS`：在 `recycle_bin.data`
  这份 JSON 文本里找附件 id（id 是 uuid 字符串，原样出现在 JSON 里，`INSTR` 就够）。
- **`renameAttachment` 保持原样**。它也要用前置通配符 `LIKE '%/attachments/<id>%'`
  扫全表，但这是**低频操作**（改附件名），且没有关系表就只能扫。要根治得引入
  `attachment_ref` 关系表 —— 那是另一件事，不在本次范围。代码里写清了这条判断。

**工程**
- `countWikiLinks` 从 `methods/notes.ts` 搬到 `utils/noteWikiLink.ts` 并导出：
  迁移回填也要用它，而 `migration.ts` 不该反过来引 `methods/notes.ts`。
  **两处必须同一份实现** —— 各写一份的话，回填出来的数和之后新增的数会来自两套规则，
  总数永远对不上。
- 新增 `tests/noteLinkCount.test.ts`（9 条，真实 `node:sqlite`）：
  三条写入路径都维护这一列、只改标题不动它、`notesStats` 是求和而不是现扫、
  导入的新增与覆盖两条分支、迁移回填只挑 `NULL` 的行（已有值不被重扫覆盖）、
  附件清理的「有引用留下 / 无引用删掉 / 回收站里也算还在用」。

---

## 2026-10-24 · P1-6：自动审计覆盖面从首页扩到记事本与分享页

**要点**
- **可访问性审计现在会打开记事本再扫一遍**。此前所有自动审计（无障碍 / 对比度 /
  视觉回归 / 生产冒烟）都只测首页一个 URL，记事本与分享页从未被任何自动化看过 ——
  而记事本整块是懒加载的独立 chunk，控件数是首页的两三倍。
  接入后**立刻抓出 14 处不达标的触控目标并全部修掉**：左栏 11 个图标按钮实测 22×22
  （图标 18 + padding 2×2），把 padding 提到 3px 正好 24px（WCAG 2.5.8 底线）；
  工具栏 3 个「主按钮 + 下拉箭头」拼接件的右半被写死 `width: 16`，提到 24。
- **焦点环判据补上「由子元素承担焦点指示」这一类**。记事本的两条列宽拖动条刻意把宿主
  outline 设成 none，改用「聚焦时把 1px 发丝线变成 2px 主色」——这是有效的焦点指示，
  但只量宿主量不到，会被误判成「键盘用户找不到焦点」。现在组件上加
  `data-focus-indicator="child"` 显式声明，审计才做额外的子元素前后对比。
  **必须显式标记，不让审计自己猜** —— 猜就会把 hover 与过渡中间帧全算进来。
- **修掉一处审计判据缺陷**：「无 label 输入」原先把 `<input type="file" style="display:none">`
  也算进去（记事本有图片 / 附件两个隐藏选择器，由旁边的按钮触发点击）。用户看不到也
  Tab 不到，加 aria-label 是形式主义。判据改为只算**可见**的输入。首页没有隐藏 file input，
  所以这条一直没被触发过。
- **对比度审计也扩到记事本**（亮/暗两态各扫两页）。接入后抓到 4 处不达 AA，
  都是真问题：`NotesPage.tsx:2819` 用 inline style 把 `--accent` 覆盖成记事本的
  `notesSettings.accent`（默认 `#b0433a`），**盖掉了 index.css 里亮/暗分态的默认值**
  （`#1976d2` / `#90caf9` 那两个都达标）。这类「用户可配置强调色」没法保证任意取值达标，
  而正确修法要动「默认强调色分态」+「文件夹/标签色板按底色亮度选黑/白字」两件事，
  属于独立一块工作 —— 所以本轮把存量设为**明确的预算**（4 处，脚本里写着修法），
  超出预算即失败。**没有关掉判据**：明细照常打印，新增一处就会红。
- **生产冒烟补两条分享 API 的 not-found 语义**。这两条路的契约刻意不一样：
  笔记分享回 404 + 错误体，分组分享回 **200** + `{status:"not-found"}`
  （前端按 `status` 字段分支）。加这两条的直接原因：前一轮给分享接口令限速时，
  第一版顺手把分组分享的 need-password 改成 401，那会让公开分组页整页显示「加载失败」。
- **视觉回归基线从 9 份扩到 15 份**：新增「记事本（亮色）」与「公开笔记分享页」×
  三个视口。刻意**不采编辑器正文区**（CodeMirror 排版随字体差得远，采了就是稳定假红），
  只采 `data-notes-root` / `data-nav-col` / `data-s` 这类稳定的 `data-*` 属性。

**工程**
- `script/auditEnv.mjs` 的只读桩补齐记事本与分享页：笔记列表 / count / 文件夹 / 标签 /
  tag-links / stats / changes、单条笔记、两个分享读取。铺了 3 条笔记，
  覆盖置顶、收藏、入文件夹、带标签四种渲染形态 —— **不能只铺空态**，
  空态与有内容是两条完全不同的渲染分支（站点审计里踩过同一个坑）。
- 桩里公开分组响应的形状按 `PublicGroupAccess` 写：分组名嵌在 `group` 里
  （`{status:"ok", group:{name}, sites, views}`），不是顶层 `name` ——
  第一版写错，公开分组页直接抛 `Cannot read properties of undefined`。
- `tests/visualRegressionGuard.test.ts` 的「基线必须有卡片 + 至少 5 类元素」
  改为按场景分档：公开分享页本来就没有卡片，拿首页的标准卡它是误伤。
  底线不变 —— 仍然要求「有按钮」，那条才是真正防骨架态的判据。

**同日收尾：把记事本那 4 处对比度修完，预算从 4 降到 0**
- **根因是「默认外观本身就不达标」**。`NotesPage` 用内联 style 把 `--accent` 覆盖成记事本
  设置里的 `notesSettings.accent`，而它的默认值 `#b0433a` 在暖白底上只有 4.18:1、
  暗底上 3.19:1 —— 两头都不到 WCAG AA 的 4.5。也就是说这个「默认」从来没达标过，
  只是没人量过。
- 修法：默认强调色改成**空串 = 跟随主题**，注入时写 `--accent: var(--notes-accent)`，
  由 index.css 按亮/暗分态给值 —— **亮色 `#a03c32`（≈4.85:1）/ 暗色 `#c96e60`（≈5.19:1）**，
  同一色相提亮/压暗，观感仍是记事本那个红棕家族。用 CSS 变量而不是在 JS 里判断亮暗，
  是为了主题切换时不必重渲这一层。
- **账号 Avatar 的文字色改成 `var(--on-accent)`**。这是「强调色**底上**的字」专用 token
  （亮色白 / 暗色深），项目里 MobileTabBar 早就在用，只有这个 Avatar 漏了 —— 它落到 MUI
  默认的 `background.default`，暗色下那个是深色，压在浅红底上只有 3.31:1。
- **存量迁移**：localStorage 里存着 `#b0433a` 的用户其实从未主动挑过颜色（那是当年的
  默认值被写进去了），读取时把它视同「没设过」，跟着一起升级。用户**自己**挑的其它颜色
  原样保留，不做二次加工。
- 设置面板「强调色」前面补了一个**「跟随主题」**档（半红半蓝的圆点）。没有它的话，
  默认（空串）时那 8 个色点一个都不高亮，用户看不出当前用的是哪一档。
- 实测（CDP）：亮色 `--accent=#a03c32` + Avatar 白字；暗色 `#c96e60` + Avatar 深字
  `rgb(13,27,42)`；笔记标题与状态栏标签同步跟随。对比度审计 **首页 + 记事本、亮 + 暗 四组全 0**。
- 视觉回归 15/15 一致 —— 这次只改了颜色、没动布局，与预期相符（颜色由对比度审计把关，
  两条判据互补）。

---

## 2026-10-24 · 质量评估 P1 行动项：弹窗材质唯一真源 · 分享口令限速 · 账号与回收站写限速 · 依赖告警清零

**要点**
- **弹窗材质只剩一个真源**。`index.css` 里那条「弹窗材质基线」`.MuiDialog-paper { … }`
  **从来没生效过**——它是纯单类选择器（0,1,0），而 emotion 的运行时 `<style>` 注入排在
  `<link>` 之后，同特异性下后注入者赢。浏览器实测：把它改成 `99px`，computed
  `border-radius` 纹丝不动（仍是 theme 给的 `22px`）。现在删掉这条死规则，
  并在 `useThemeController` 的 `MuiDialog.styleOverrides.paper` 里把底色从硬编码
  `rgba(255,255,255,0.94)` / `rgba(23,27,38,0.94)` 换成 `var(--surface-modal)`
  （取值与旧硬编码逐位相等，**零像素回归**）。从此改 `--surface-modal` 一处，
  32 个弹窗一起变——CDP 实测三个不同弹窗（全站设置 / 新增网站 / 卡片设置）
  `rgba(255,255,255,0.94) → rgb(255,0,0) → 还原`，全部跟着 token 走。
- **分享口令不再能被无限次猜**。分享口令是全站唯一还能反复试的密码入口
  （登录 / 注册 / 找回 / 初始化四条公开路径都有限速），而它的校验是 PBKDF2-SHA256
  （Workers 侧 10 万次迭代）——不限速既能让弱口令被爆破，也是一条**免费的 CPU 放大器**。
  新增第七把锁：按「来源 IP + 分享 token」分桶，同一 IP 对同一分享猜错 5 次后锁
  5 分钟起（指数退避，封顶 1 小时）；锁定期内**连哈希都不跑**，
  口令正确则清零。公开页第一次打开（GET，压根没带口令）不算失败。
- **账号域与回收站域补上写限速**。`account.ts` 的 9 条写路由（退出 / 邀请码 /
  沉睡扫描 / 吊销设备 / 账号状态 / 注销 / 改凭据 / 改恢复密钥）与 `ops.ts` 的 5 条
  回收站写路由（还原 / 永久删除 / 两个批量版 / 清空）此前**一处闸门都没有**——
  而永久删除不可逆、清空一次能抹掉几千行，改账号凭据又是攻击者最省事的持久化手段。
  现在与 `data.ts` 同构接入 `enforceWriteGuard`。
- **依赖告警清零并上锁**。`react-hooks/exhaustive-deps` 从 23 条降到 **0**，
  其中两条是真 bug：①`useNotes` 的 `runUpdate` 在冲突覆盖路径上捕获了首渲染的
  `updateNote`（现在 `ensureFullNote` 进依赖、`updateNote` 用 ref 打破循环引用）；
  ②`NotesOverlay` 运行时探测 `api.updateTag`，但没把它列为依赖——后端补上这个方法后
  `useMemo` 不会重算，「设置颜色」入口永远不出现。其余 21 条是「缺 `setXxx`」与
  「unnecessary `api`」的假阳性，已逐条带理由 disable。
  新增 `script/lint-warnings-budget.mjs` 把预算钉死为 0，`npm run lint` 已接上。

**工程**
- 新增三条静态守卫，防止同类问题复发：
  `tests/muiSelectorSpecificity.test.ts`（index.css / App.css 不得出现不带 `!important`
  的纯单类 MUI 选择器；自带「@media 里的规则必须被扫到」的反向自检，避免解析器假绿）、
  `tests/writeGuardedRoutes.test.ts`（含写方法分支的路由文件必须有闸门；
  `account` / `ops` 还要「写分支数 == `writeGate()` 调用数」；`writeBucket` 必须传 `trustXFF`）、
  `tests/shareGuard.test.ts`（桶粒度 / 阈值 / 锁定期不延长 / 存储故障放行，14 条）。
- `tests/hardcodedColorGuard.test.ts` 里 `useThemeController` 的豁免 cap 从 6 降到 4
  （两处 rgba 已改成 token），不然那条「cap 必须与实际命中数一致」的用例会红。

---

## 2026-10-24 · 分享文案统一 · 开机掉登录与登录设备去重 · 备份范围写清 · AI 设置进备份 · 请求体守卫收口 · 自托管 SSRF 闭环 · 视觉回归收紧 · mock 行为对齐 · 设置弹窗拆分 · 镜像触发路径修复 · 复查行动项清账

**要点**
- 分组分享页失效时原来写「分享不存在或已过期」，笔记分享页写「分享不存在、已过期或已撤销」——
  同一个处境两种说法，用户会以为「已过期」和「已撤销」是两回事。现在统一成后一句。
- **开机后第一次打开不再莫名回登录页**（用户原话：「每次电脑开机后第一次打开这个网站还是需要登录」）：
  ① 冷启动先等网络——浏览器比网卡先起来时 `fetch` 立刻失败，重试再密也等不到网，现在挂
  `online` 事件最多等 6 秒；② 三次重试仍失败时，本地那条 JS 可读的登录标记（`navihive_session`）
  丢了也**不代表**会话没了——它只是附属物，真正的会话在 httpOnly 的 `navihive_token` 里。
  判据从公开端点 `/api/configs` 换成 `/api/auth/me`：拿得到「我是谁」就保持已登录，401 才回登录页。
- **登录设备列表不再有「重复」**（用户第二次报）：截图里两条都是「Chrome · Windows」。
  ① 查库发现其中一条 `device_id` 是 NULL（老客户端 / 脚本 / 隐私模式留下的）——现在这类
  认不出来的行按「UA 家族 + 系统相同（或 IP 也相同）」**只折叠显示，不吊销也不删行**
  （误踢 = 那台机器下次打开要重新登录）；② UA 识别能认出无头浏览器 / curl / Python 脚本 /
  程序调用，不再照普通浏览器念、和用户的真机撞名。
- **备份范围在界面上写清**（用户问「AI 设置、全站设置会不会跟着导入导出」，原来一个字都没写）：
  站点 / 分组、全站外观与常规设置跟着走；AI 设置整组（见下条）也走；
  不跟着走的是各类凭据（本站账号密码、WebDAV、备份口令）与记事本（有独立备份）。
- **AI 设置整组跟着备份走**（用户当天进一步要求：换设备恢复不用把模型服务 / 端点 / 密钥重填一遍）：
  8 个 `ai.*` 键整组导出、导入，按账号各存一份（走备份文件的 `configs` 通道，
  恢复时落回导入者自己的 `user_configs`）。密钥会写进备份文件——界面明示「建议设备份口令、
  文件妥善保管」；导入侧对 `ai.endpoint` 做形态校验（必须是 http(s)://，否则整条跳过），
  挡被改过的备份把 AI 请求导到别处。
- **请求体守卫收口**（全站复查 P1）：19 处写接口原本用 `request.json().catch(() => ({}))`
  裸解析——「解析成功但不是对象」（字符串 / 数字 / 布尔）会静默流过、逐个字段取到
  undefined，与没守无异；第一版守卫测试还把 catch 模式当「有兜底」豁免，是制度性漏洞。
  现在全部换用 `readJsonBody` / `readJsonValue`（非对象一律 400），守卫同步收紧豁免
  （只剩 `util.ts` 的 `safeJson`——它的调用方含 GET，无 body 是合法输入）。
  `safeJson` 与收紧后的守卫都补了注释说明各自语义，防后人再混用。
- **自托管 SSRF 闭环**（全站复查行动项）：`safeFetch` 的 hostname 黑名单判不了 DNS
  rebinding，而 Node 运行时没有 Cloudflare 的平台层 egress 拦截。新增
  `setEgressResolver` 注入点，由 `server/entry.ts` 注册「出站前 dns.lookup 逐 IP 过
  同一套黑名单」的实现（60s 缓存、解析失败放行）；worker 侧与测试环境不注册，
  行为零变化。注入式而非内置 `node:dns`：worker 构建/运行时会 reject，单测也会
  真去查 DNS。⚠️ 缓解非根治（lookup 与 fetch 内部再解析之间有窗口），注释里写明了边界。
- **视觉回归收紧**（全站复查行动项）：`audit:visual` 原来在「基线文件不存在」时
  **静默录一份当通过**——新场景第一次跑就拿到免检金牌。现在记为「无基线」并判失败，
  引导显式 `--update`。顺带把停留在一周前的基线按 10-23 弹窗整改 + 站点↔笔记绑定
  的有意改动重录（9 个用例的差异全部可归因于这两批，无意外回归）。
- **style-guide 补第 2.0 条**：`index.css` 覆盖 MUI 组件样式时选择器必须带前缀
  （特异性 ≥ (0,2,0)）——emotion 的运行时注入排在 `<link>`（index.css）**之后**，
  单类选择器 `.MuiDialog-paper`（0,1,0）**永远输**。写法：两层前缀
  （`.nav-settings-dialog .MuiDialog-paper` 或 `html.dark .MuiDialog-paper`）。
  反面教材（真实发生、静默一年）：小屏「底部面板」整套写在单类选择器里，
  CSS 没报错、没有控制台警告，但**规则从来没生效过**，375px 下弹窗一直是
  居中卡片。这条规则此前只活在代码注释里。
- **mock 与真实链路的行为对齐**（复查行动项 6）：`mock.ts` 的 `exportData` 原来
  `{...mockConfigs}` 全量吐、`importData` 全量收——演示模式下「敏感键不进备份」
  形同虚设，备份范围的改动在演示模式验证不到。现在导入导出都走
  `utils/backupScope` 的同一份判定（AI 整组进、webdav/auth 不进），
  `apiMockParity.test.ts` 加静态守卫钉住。
- **设置弹窗拆分**（全站复查行动项 5）：`NotesSettingsDialog` 2372 行 → 311 行，
  拆成外观 / 编辑器 / 数据 / 同步 / 分享 / 备份 六个 tab 组件（`components/notes/`），
  主文件只留 Dialog 外壳 + 左列导航 + 右侧分发。拆分中右上角关闭 × 一度被写丢，
  `dialogCloseAffordance` 守卫当场拦下并补回——真实功能缺失被守卫抓住，
  不是靠人眼发现。
- **镜像触发路径修复**：`docker-publish` 的 paths 原来只有 `src/API/**`，
  注释还声称「前端 src/（非 API 部分）不进镜像」——**错的**：Dockerfile 的 builder
  跑 `vite build`，`dist/client`（含全部前端）整体打进镜像。于是纯前端批次
  （只改 `src/components` 之类）**不触发镜像重发**，VPS 上跑的还是上一个 commit
  的构建（实测：设置弹窗拆分批次推送后，VPS 前端 hash `index-Dbw-jaEx`，
  本地已是 `index-DIYC2fib`）。paths 收成 `src/**` 并补 `index.html` /
  `vite.config.ts` / `public/**`，注释同步修正。
- **复查行动项清账**（行动项 4/7 实证关闭，报告已同步修正）：
  ④ 首屏性能——实测首屏 871.4KB 构成：mui-core 328.8KB 经 class 字符串精确探测
  （`MuiDialog-root`/`MuiSelect-select`/`MuiButton-root` 一个都不存在）证实是
  **@mui/system + styled-engine + emotion 样式底座**而非混入的非首屏组件；
  barrel import（68 处）实验性改具名后 mui-core 字节级不变，同样不是原因。
  框架固有成本（react 202 + mui 底座 328 + dnd-kit 60）砍不动，接受现状，
  预算探针继续当哨兵。⑦ LCP 硬预算——`perf-audit.mjs` 的 FCP/LCP **早已**双双
  判红且已在 `ci.yml` 跑，无需改动。

**排查来源**
全站功能 / 交互排查（路由、控制台、边界态）时顺手对齐的：
`/sg/<无效 token>` 与 `/s/<无效 token>` 都会正确落到「不存在」文案，不白屏。

**门禁**
`tsc -b --force` 0 error；lint 0 error；单测 **3104** 全绿；build；体积预算 10/10；
冒烟全通过；a11y 0 项不合格；对比度亮/暗 0 处不合格；视觉回归 9/9 一致；
首屏体感审计通过（FCP/LCP 均在预算内）；品牌信息三处一致。

## 2026-10-23 · 32 个弹窗全量整改（四批一次做完）

**要点**
1. **外壳收口**：小屏「底部面板」那套 CSS 之前**根本没生效**（375 实测仍是居中卡片、上下各留 32px），
   现在真的贴底 + 全宽 + `92dvh`；弹窗材质 token 统一成一份（`dialogPaperTokens`），
   全站设置与站点设置不再各写一套。
2. **关闭出口**：新增 `DialogCloseButton`，9 个原本没有 × 的弹窗（审计日志 / 注销账号 / 编辑分组 /
   文件夹外观 / 分享笔记 / 快捷键 / 回收站 / 标签颜色 / 批量打标签）都补上；
   两处英文 `aria-label='close'` 改成中文（读屏不再念英文）。
3. **同名弹窗拆开**：顶栏齿轮那个改叫「**全站设置**」（菜单入口同步），
   卡片齿轮的「网站设置」保持不变 —— 两个窗口作用域完全不同，同名必然走错门。
   标题下补一句范围说明。
4. **信息架构**：站点设置上了参考样式那套分组骨架（基本信息 / 图标 / 分组与标签 / 描述与备注 /
   登录凭据 / 相关笔记）；危险按钮位置统一「靠左」（原来站点设置在左、确认框在右）；
   列表类弹窗抽出 `DialogListRow` + `DialogEmptyState`。
5. **尺寸与缩放**：记事本设置纸面换成公共外壳 + `height: { xs: "86dvh", sm: 560 }`；
   四处写死的 px 高度改成 `min(Npx, 45dvh)`；`100vh → 100dvh`（软键盘不再顶走保存按钮）；
   关系图小屏整屏。
6. **标签重命名改内联**：就在那一行里改，不再弹第二个窗口；撞上已有标签时当场说清「等于合并」。

**为什么小屏那套 CSS 之前没生效**
MUI 的组件样式由 emotion 在运行时注入到 `<head>` **末尾**，排在 `index.css` 之后。
两边都是单类选择器（0,1,0），后插入的胜出 —— 所以规则在构建产物里明明存在，
实测却是 `align-items: center` + `max-height: calc(100% - 64px)`。
修法是把选择器提到 0,2,0（`.MuiDialog-root .MuiDialog-container` /
`.MuiDialog-container .MuiDialog-paper:not(.MuiDialog-paperFullScreen)`），
与加载顺序无关。⚠️ 以后在 `index.css` 里写覆盖 MUI 的规则，都要带前缀，不能只写单类。

**守卫**
`tests/dialogCloseAffordance.test.ts`：① 每个渲染 `<Dialog>` 的文件都必须有可见关闭出口
（命令面板是白名单：输入即搜索，预期就是 Esc / 失焦关）；② 不许再出现英文 `aria-label='close'`；
③ 反向验证，防止守卫自己假绿。

**门禁**
`tsc -b --force` 0 error；lint 0 error（42 warning 为既有 react-refresh 提示）；
单测 **3084** 全绿；build；体积预算 10/10；冒烟全通过；a11y 0 项不合格；
对比度亮/暗 0 处不合格；品牌信息三处一致。

## 2026-10-23 · 站点设置里点笔记标题也走预览 + 去掉那句说明

**要点**
- 站点设置「相关笔记」里点已绑定的标题，先弹**只读预览**（与卡片角上那颗按钮同一个弹窗），
  想在预览里点「编辑」才跳进记事本。
- 去掉那行说明文字「一个网站只绑一篇笔记。绑上之后，卡片右上角那枚笔记按钮点开就是它。」

**为什么点标题也要走预览**
上一轮已经把卡片上那条路径改成「先预览、再编辑」，这一节却还是直接 `open(id)` 跳走 ——
同一个东西两套手感，而且从站点设置里点一下就被换掉整页，比多点一次更烦人。

预览弹窗用 `lazy(dialogChunks.siteNote)` 按需加载：它带 markdown 渲染层，静态 import
会把那一整包拽进站点设置块。与 SiteCard 里那个 lazy() 指向同一模块，产物里仍然
只有一个 `SiteNoteDialog` 块（6.2 KB）。悬停标题时顺手预热，点下去不用等。

⚠️ 传给预览弹窗的 site 用「这一节当前显示的绑定关系」拼（`{...site, note_id: bound.id}`）：
刚在下面绑完、App 还没重取完时，`site.note_id` 还是旧的，直接用会出现
「列表里显示 A、预览窗里是 B」。

**守卫**
`tests/siteNotesSection.dom.test.tsx`：点标题必须**不跳转**、预览窗里能读到正文、
点「编辑」才跳；另加一条把用户点名删掉的那句钉成反向断言（字符串不许再出现）。

**门禁**
`tsc -b --force` 0 error；lint 0 error；单测全绿；build；体积预算 10/10；冒烟全通过。

## 2026-10-23 · 绑定收敛成「显式一对一」：笔记右键可绑网站 + 删掉自动关联

**要点**
- 笔记右键菜单加了「绑定网站…」：在这里选一个网站就把这条笔记挂上去。
- 删掉「正文里提到站名 / 网址就算相关」那套自动关联（`utils/siteNoteLink.ts` 整个删除）。
- 站点「相关笔记」那一节不再有那两段长说明，改成能直接在这一节里**绑定 / 换一篇 / 解除**。

**一、笔记 → 网站：反过来也能绑**
原来只能从卡片上选笔记，用户的念头从「这条笔记是给哪个站写的」起头时就得绕回去
找卡片。现在笔记右键（列表行与左栏内联笔记两个菜单都加了）→「绑定网站…」→
选网站 →「绑定」。
选择器里会**提前**标出「这个站已经绑了『X』」——不说的话用户点完才发现把别的笔记顶掉了。

⚠️ 写库只走一条路：`onUpdate(noteId, { site_id })`（笔记自己的更新通道，库与本地
notes 一起变，状态栏那行「绑在哪个站」立刻跟上），然后让 App 重取一次卡片
（`siteLinkApi.refresh()`）。**没有**在 siteLinkApi 里另开一个写入方法 ——
那会变成两次写、两边乐观更新打架。
⚠️ `onUpdate` 撞并发冲突返回 false 时要抛错，不能给「已绑定」的假回执。

**二、删掉自动关联**
「正文里提到站名或网址」这套启发式整个删了（`utils/siteNoteLink.ts` 与其单测一起）。
理由就是用户这次说的：**一个网站绑一篇笔记**——真正的一对一，靠显式绑定表达；
启发式既靠不住（写没写到、代码块里提到算不算），又会让人疑惑「我明明没绑，
它怎么冒出来了」。
`utils/siteMatch.ts`（`[[站名]]` 点击跳站点卡片）保留：那是**点击时认出站名**，
与「谁跟谁算相关」是两件事。两个文件里解释「为什么不能碰 Markdown」的注释
也跟着改成了现状，免得后人照着一句已失效的话做决定。

**三、相关笔记那一节现在能自己绑**
去掉两段说明文字，换成：已绑定 → 标题 + 「已绑定」+「换一篇 / 解除」；
未绑定 → 「绑定笔记」按钮，点开是带搜索的笔记列表（只在真要选时才拉列表）。

**守卫**
- `tests/noteSiteDialog.dom.test.tsx`（4 条）：选中网站后按「笔记 → 网站」落库、
  目标站已被别人占着要提前提示、已绑定时解除、以及**静态断言右键菜单两个变体都有
  「绑定网站…」**（少一个就成「换个地方右键动作就没了」）。
- `tests/siteNotesSection.dom.test.tsx` 重写（4 条）：已绑定显示 + 跳转、没绑时
  绑定入口与选中落库、能解除，外加一条**反向守卫**——这一节里不许再出现
  「提到」那套判据与文案，`siteNoteLink.ts` 也必须已经不存在。

**门禁**
`tsc -b --force` 0 error；lint 0 error；单测全绿；build；体积预算 10/10；冒烟全通过。

## 2026-10-23 · 修复：站点设置看不到已绑定的笔记 + 专注模式在即时渲染下没效果

**要点**
- 站点「编辑」窗口的「相关笔记」现在**先列卡片上绑的那一篇**（标「已绑定」），
  下面才是正文里提到它的笔记 —— 原来只列「提到的」，用户亲手绑的那篇反而看不到。
- 专注模式在**开着即时渲染**时终于有效果了：当前段落以外的渲染块也会一起淡化。

**修复一：绑了却看不到**
`SiteNotesSection` 一直只列「正文里提到这个站名 / 网址」的笔记（走搜索 + 启发式判据），
而 #477 的真绑定存在笔记侧（`notes.site_id`），站点上带出的是 `note_id` / `note_title` ——
那一节根本没读这两个字段。结果是「明明绑成功了，打开设置像没绑」。
现在：已绑定那篇直接摆最上面并标「已绑定」（点一下跳过去），
下面才是「提到它的」，且**排掉已绑定的那条**（同一个标题出现两次会让人以为绑了两篇）。
空态文案也分开写：已绑定但没别的笔记提到时是「没有别的笔记提到它」，
并指路到卡片右上角那颗按钮（新用户唯一的绑定入口）。

**修复二：专注模式没效果（只在即时渲染开着时）**
即时渲染会把**当前段落以外的段落整块替换成 widget**（`.note-live-block`）——
那些行连 `.cm-line` 元素都不存在了，而专注模式的淡化是
`Decoration.line(class: "cm-focus-dimmed")` 挂在**行**上的，于是无处可挂：
开关打开、屏幕上一动不动。两个开关单独开都好使，一起开就失效，所以拖到现在才被发现。
修法：开关打开时在编辑器根上加 `.cm-focus-on`，CSS 把 widget 本体一起淡化到同一档
（0.38，与源码行一致）。用 class 而不是给 widget 加装饰 —— widget 由另一个
StateField 产出，两边耦合更容易漂。

**守卫**
- `tests/siteNotesSection.dom.test.tsx`（3 条）：绑定那篇要出现并标「已绑定」、
  点它跳转、**不在「提到」列表里重复出现**、空态指路到卡片按钮。
- `tests/editorFocusMode.dom.test.tsx`（4 条）：源码态挂 `cm-focus-on` 且有淡化行、
  关掉要摘干净、即时渲染态同样挂类且 widget 真的存在、
  **CSS 里那条对 `.note-live-block` 生效的规则必须在**
  （前三条只证明类挂对了，少了 CSS 用户照样看不见变化）。

**门禁**
`tsc -b --force` 0 error；lint 0 error；单测全绿；build；体积预算 10/10；冒烟全通过。

## 2026-10-23 · 修复：预览窗「编辑」跳转慢 + 预览里的附件链接整页跳走

**要点**
- 点预览窗的「编辑」不再干等：悬停卡片上那颗笔记按钮时就把记事本整块预取下来。
- 预览正文里的 txt / json 等附件，点开**在弹窗里看**，不再把整页顶到 `/api/notes/attachments/…`。

**修复一：点「编辑」要等很久**
记事本是一整块懒加载：`NotesOverlay` 本体 315 KB，还会连带拉编辑器（564 KB）
与 markdown 依赖。原来点「编辑」才开始下载那一串，用户看到的就是「点了没反应、
几秒后才跳」。而 App 那层的 `ChunkBoundary` 用的是 `fallback={null}`
（2026-10-17 用户明确要求「不要转圈」），所以这段时间连个指示都没有。

修法沿用同一套思路 —— **把下载挪到点击之前**，而不是加转圈：
- 悬停（或键盘聚焦）卡片上那颗笔记按钮时，`prefetchChunk` 同时取
  `siteNote`（弹窗本体）与 `notesOverlay`（记事本整块）。悬停已经是明确的意图信号。
- 预览窗一挂载再补一次 `notesOverlay`：触屏上没有 hover，那次预取永远不会发生。
- `prefetchChunk` 幂等，两条路重复调不会重复下载。
核对过产物：`NotesOverlay` 仍然只有一个块（314.7 KB），没有因为多一条动态边而复制。

**修复二：预览里的附件点了整页跳走**
预览正文是用 `renderMarkdownToReact` 渲的，而这条链路**没挂
`AttachmentPreviewProvider`** —— `AttachmentLink` 于是按设计退回成裸
`<a href="/api/notes/attachments/…">`（那是给分享页用的分支），点击既不弹窗、
也没人拦默认行为，浏览器整页跳到附件地址。
现在预览窗里挂上同一个 Provider + 同一个 `AttachmentPreviewDialog`
（与记事本里点附件是**同一个组件**），只是不给 `onSaveContent` / `onRename`
—— 预览本来就是只读的，要改点「编辑」进记事本。

**守卫**
`tests/siteCard.dom.test.tsx` 新增一条：预览正文里放一个
`[文本文件.txt](/api/notes/attachments/abc123)`，点它必须
`defaultPrevented === true`（不拦就是整页跳走），并断言它被渲染成
`AttachmentLink` 而不是裸 `<a>`。

**门禁**
`tsc -b --force` 0 error；lint 0 error；单测全绿（+1）；build；体积预算 10/10；
冒烟全通过。

## 2026-10-23 · 修复：卡片笔记入口浮层不消失 + 交互改成「先预览再编辑」

**要点**
- 鼠标离开卡片后，角上的「笔记」按钮现在会正常收回去（原来会常亮）。
- 点它不再直接把人扔进记事本：**先弹一个只读预览**，想改再点「编辑」。
- 顺带修掉同源问题：带触摸屏的笔记本上，设置按钮也会被误判成「触屏常显」。

**修复：浮层该收不收回**
用户实测反馈「鼠标不放卡片上时，笔记按键不会消失」。查下来是两件事叠在一起：
1. `utils/device.ts` 靠「无悬停指针 + 有触摸点」判触屏，而带触摸屏的 Windows 笔记本
   在触控优先时会**同时满足**这两条 → 整站被标成触屏 → 三颗浮层按钮全部常显。
   判据本身没法在 JS 里再收紧（这两条已经是最可靠的信号），所以在 CSS 末尾补一层
   `@media (hover: hover)`：只要这个环境此刻**真的能悬停**，就按悬停规则走，
   忽略 `.nav-touch`。真触屏（`hover: none`）里这段整体不生效，常显照旧。
2. 上一版我给「已绑定」的卡片加了「常显」——想着绑了却看不见等于白绑，
   但这个常显和上面那条叠在一起，就成了「鼠标走了还杵着」。按用户要求去掉，
   改由 `aria-label` / tooltip 带出笔记标题（悬停就能看到绑了哪篇）。

**交互：先预览，再决定编辑**
- 点卡片上的笔记按钮：已绑定 → 弹预览窗（标题 + 渲染后的正文，最高 52vh 可滚），
  底部「编辑 / 换一篇 / 解除绑定」；未绑定 → 还是原来的选择器。
- 预览窗里的「编辑」才跳进记事本并定位到那条 —— 在导航页点一下就被换掉页面，
  比多点一次更烦人。
- 笔记已被删（`site_id` 悬空）时预览写「这篇笔记已经不在了」，可以直接换一篇；
  正文为空时写「还是空的，点编辑去写点什么」，而不是给一块空白。
- 正文渲染走 `utils/markdownToReact`。这在**首屏**是禁忌（会把 markdown-it 拖进首页），
  但本组件只被 `lazy()` 引，属于打开才下载的块 —— 体积预算 10/10 照旧通过。

**守卫**
- `script/ci-smoke.mjs`：浮层显隐那条断言补上 `.nav-note-btn`（原来只量快捷条 /
  设置 / 星标，**漏了它等于没守卫**），并新增「悬停后浮出」「移开后必须收回」两条。
- `tests/siteCard.dom.test.tsx`：已绑定那条用例从「点一下直接打开」改成
  「先预览、正文可见、点「编辑」才跳转」，把新交互钉死。

**门禁**
`tsc -b --force` 0 error；lint 0 error；单测全绿；build；体积预算 10/10；冒烟全通过
（含触屏常显那条）。

## 2026-10-23 · 站点↔笔记双向绑定（#477）+ 记事本拆分第三批

**要点**
- 卡片右上角多了一个「笔记」入口：**一个站点最多绑一篇笔记**，换绑自动让位（原笔记不删）。
- 没绑过就点开选择器（可搜标题、可「新建笔记并绑定」）；绑过的点一下直接打开那篇。
- 反向也通：笔记开着时状态栏显示它绑在哪个站点上，点一下关掉记事本并滚到那张卡片。
- 卡片删了笔记**不删**，状态栏照实写「站点已删除」——悬空引用是刻意的，不静默抹掉。
- `NotesPage.tsx` 3539 → 3297 行：导入（197 行）、整库导出（104 行）搬成两个纯过程模块。
- 只补了一条索引：绑定关系直接用上早就存在的 `notes.site_id`，没有新列、没有新表。

**新增：站点↔笔记绑定**
- 绑定关系存在**笔记侧**（`notes.site_id`），站点上的 `note_id` / `note_title` 是
  `querySites` / `querySite` / `queryBootstrap` 用相关子查询反查出来的只读字段。
  这样「卡片删了笔记还在」不需要级联，也不会出现两份真相。
  顺带兑现了 `useNotesList` 里那句注释 ——「记事本里根本没有把笔记挂到某个站点的
  入口，所以 site_id 永远是 null」：这条链的列、patch 白名单、导入导出、
  回收站还原、mock 早就全通，缺的确实只是一个入口。
- 站名解析不走请求：App 从内存里的分组树查（几十张卡的一次线性扫），跳转复用现成的
  `jumpToSite`（关掉记事本 → 滚到卡片 → 闪一下轮廓）。
- 「一个站点最多一篇」的收口在 `updateNote` / `createNote`：绑定前先把同一站点上
  **别的**笔记解绑，同一条 batch 里**排在主语句之前**（顺序反了会把刚绑好的又清掉）。
  约束只有这一处，任何调用方都绕不过；账号隔离跟着 `scopeSql` 走，动不到别人的笔记。
- ⚠️ 差点漏掉的越权口：绑定前必须确认那张卡片是自己的。不校验的话，任何人都能把
  自己的笔记挂到**别人的站点 id** 上 —— 那位用户会在自己的卡片上看到一篇陌生的
  笔记标题，点开还能读正文，等于一个反向的信息泄露。`assertOwnedSiteForNote` 挡住；
  而 `PUT` 传 `site_id: null`（解除）不校验 —— 它本来就是清悬空引用的那条路。
- 读写都绕开「JOIN 会让卡片翻倍」：子查询带 `ORDER BY updated_at DESC, id DESC LIMIT 1`，
  宁可多一次索引探测，也不让同一张卡在列表里出现两行。
  `n.user_id IS s.user_id` 用 `IS` 不用 `=` —— 单账号部署两边都是 NULL，
  写等号会一条都带不出来（与 `note_revision` 那条 `IS ?` 是同一个坑）。
- 结构版本 24：新增 `idx_notes_site`。老库吃的是「版本号相同就跳过迁移」的快路径，
  版本号不 +1 这条索引永远建不上，站点列表那两个子查询就退化成每张卡一次全表扫。

**工程：记事本拆分第三批（按「有没有 React 状态」划线）**
- `notes/importNotesFile.ts`（197 行）：认文件类型 → 解包 → 附件并发回传 →
  改写正文里的附件链接 → 写库 → 让当前页重拉。全程没有一处 state。
- `notes/exportNotes.ts`（104 行）：JSON / ZIP 两条整库导出。
  两处行为刻意逐字保留：下载后 4 秒才 `revokeObjectURL`（立刻回收在部分浏览器会打断下载）、
  ZIP 里附件名是 `id__filename`（导入靠这个前缀把正文里的旧 id 换成新 id）。
- ⚠️ 搬的时候踩到一个必踩的坑：`importNotes` 是类方法（内部用 `this.request`），
  直接把 `shareApi.importNotes` 当函数传进去会让 this 变 undefined —— 调用方必须
  包一层箭头函数。这条钉在 `importNotesFile.ts` 的文件头注释里。
- 剩下的 3297 行是真正缠在一起的那块（搜索子系统 ↔ 排序 ↔ 分组树 ↔ 虚拟列表），
  下一批要连派生链一起动，不是「再抽一个 hook」能解决的。

**守卫**
- `tests/siteNoteBindingRealSql.test.ts`（6 条，真实 SQLite）：绑定往返带出标题、
  换绑让位（库里断言「同一站点最多一行」）、解除绑定、新建即绑、账号隔离
  （别人的卡片带不出我的标题）、站点删除后悬空引用保留。
  ⚠️ 顺手修了测试替身：`batch()` 原来用 `run()` 拼、`results` 恒为 undefined，
  真 D1 不是这样 —— `createNote` 会因此抛「创建笔记失败」，看着像业务 bug、其实是桩不准。
- `tests/noteRoutes.test.ts`：新增「绑定站点前要确认那张卡片是自己的」，
  并给 stub 补了 `getSite`（可传 `ownedSiteIds: []` 模拟别人的卡）。
- `tests/siteCard.dom.test.tsx`：卡片入口三态（未绑定 / 已绑定 / 没接上记事本桥不渲染）
  + 未绑定点开选择器会拉列表。

**门禁**
`tsc -b --force` 0 error；lint 0 error（41 条既有 warning）；单测 **3076 全绿**
（基线 3065 + 新增 11）；build / 体积预算 / 冒烟 / a11y / 对比度全通过；
`probe:edge` 无 5xx。

## 2026-10-23 · 全站复查（P2 之后的逐处体检）：请求体入口收口 / 单测运行器并发

五个 P2 项全部做完之后，按「功能 / 交互 / 路由 / 接口 / 控制台报错 / 响应式 /
安全 / 性能」八个维度重跑了一遍，两处真实缺陷直接修掉，其余各门全绿。

**复查结果（全绿部分）**
全站体检 28 项 0 问题（4 视口 × 多路由 + 弹窗 / 搜索 / 菜单 / 记事本深挖）、
a11y 0 不合格、对比度亮暗两态 0 不合格、分享补充面 E2E 46/46、浏览器冒烟全通过、
单测 3065 全绿、`tsc -b --force` 0 error、lint 0 error、体积预算 10/10、
线上只读冒烟 15/16（唯一失败是尚未部署的 P2-8）。
另外单独验了**全新空库的空态**（分组 / 文件夹 / 标签全空）：首页、记事本、
设置、搜索四处 0 控制台报错，空态文案都在 —— 体检脚本会先铺数据，
「一条数据都没有」那一档以前没人验。

**修复一：写接口的请求体入口收口（9 处 500 → 0）**
各路由原本直接 `const data = await request.json() as X` 就去读 `data.title`。
新写的探针（`npm run probe:edge`，57 项畸形 / 超限 / 异常输入，只找 5xx）实测命中：
- body 是 `null` → `null.title` 抛 TypeError，冒泡到入口变 **500**（命中 9 处：
  `POST /api/notes`、`/api/login`、`/api/groups`、`/api/sites`、`/api/notes/folders`、
  `/api/notes/tags`，`PUT /api/notes/:id`、`/api/configs` …）；
- body 是 `"字符串"` / `123` → 属性访问会装箱、逐个字段取到 undefined，
  于是**静默建出一条全空的笔记**（比 500 更难发现）。

修法：新增 `worker/routes/jsonBody.ts`，`readJsonBody`（要对象）/ `readJsonArray`
（要数组）/ `readJsonValue`（两者都收，给「两种形状都认」的老接口）三个入口，
统一挡掉 null 与非对象，解析失败一律 400。24 处调用点换过去。
500 的本质是「服务端自己崩了」，与 4xx「正确地拒绝」不是一回事 ——
它会触发告警、客户端还会当故障重试。
配套：`tests/jsonBodyGuard.test.ts` 静态钉住「不许再裸解析」（反向验过：
插一行 `await request.json()` 立刻报红）；`probe:edge` 进 CI 做运行时那半。

⚠️ 教训（改错过一次）：`PUT /api/note-orders` **既接受顶层数组也接受
`{orders:[...]}`**，第一版给它挂了 `readJsonBody`，等于把原来能用的请求改成 400
—— 被 `noteRoutes.test.ts` 的「接受数组或 { orders } 两种形状」当场抓回。
所以「坏的被拒」和「好的别被拒」必须各钉一条，探针里两条都补上了。

**修复二：单测运行器并发会互相删产物（假红）**
`script/unit-tests.mjs` 进来先 `rm -rf script/tmp-tests`、跑完再删一次。
两个运行器并发时后一个把前一个刚打好的 bundle 删掉，`node:test` 报
MODULE_NOT_FOUND —— 表面「152 条用例失败」，实则一条都没跑。
（把 `npm test` 与 `npm run check:budget` 并行跑就能稳定复现，两者是同一脚本的两个入口。）
修法：O_EXCL 独占锁 + 信号与异常路径都放锁，拿不到锁就明确退出并提示，
不再硬跑出一个假结果。配套 `tests/unitRunnerLockGuard.test.ts`。
假红比没门禁更糟 —— 它会训练人忽略红灯。

## 2026-10-23 · 质量盘点第二批（P2）：路由表 / 设计 token / 客户端拆分 / 视觉基线 / 线上冒烟

一次做完五项。五项都是「平时不痛、出事就难查」的那类，所以每项都配了复发守卫。

**① SPA 回退收紧（P2-8）**
以前任何取不到静态文件的路径都会回 `index.html` —— 于是 `/wp-login.php`、
`/.git/config` 这类扫描路径也返回 200 整页，既不诚实也白吃流量。
现在前端路由表成了单一事实来源：`shared/spaRoutes.ts`（零依赖，三端共用），
Cloudflare 与自托管两侧同步收紧 —— 带扩展名走资产（找不到就真 404），
无扩展名但不在路由表里的直接 404，只有 `/`、`/s/<64hex>`、`/sg/<64hex>` 回整页。
前端入口也从内联正则换成同一张表（以前三处各写一份 `[a-f0-9]{64}`）。

**② 设计 token 收敛（P2-7）**
`src/index.css` 补齐 20 个语义 token（亮暗各一份）：成功/危险色、三级阴影、
五档中性灰、遮罩、弹窗与内凹面、图标托底、编辑器选区与查找高亮等。
组件里 100+ 处硬编码颜色换成 token：17 档中性灰 alpha 归并成 5 档、
7 个组件各自抄死的 `rgba(176,67,58,*)`（默认主色的 RGB）统一成 `--accent-wash`
（换主色不再有七处不跟着变）。顺带修掉两个真实缺陷：
- 暗色下角标白字压在浅蓝主色上，对比度 1.9:1（基本看不见）→ 新增 `--on-accent`；
- `getGroup` 声明返回 `Promise<Group>`，实际查不到时返回 null → 改成 `Group | null`。

**③ 前端 API 客户端拆分（P2-10）**
`src/API/client.ts` 1530 行 / 90 个方法 → 传输核心 230 行 + `clientMethods/{auth,notes,sites,system}.ts`。
照抄服务端 `http.ts + methods/*.ts` 那套已验证的 mixin 范式（Object.assign 混回原型），
对外签名一行没改。会话 cookie 的读写抽到 `transport.ts`，演示客户端不再自己拼 cookie 串。

**④ 视觉回归基线（P2-9）**
`npm run audit:visual`：3 视口 × 3 场景（亮 / 暗 / 设置弹窗）采**布局指纹**
（一批 `.nav-*` 语义 class 的几何 + 关键计算样式）与 `tests/visual-baseline/` 的基线比对。
刻意**不做像素截图比对**：CI 与开发机字体不同，截出来必然整页位移，那是稳定的假红；
也刻意**不进 `npm run ci`**（同上理由），只留手动通道。
反向验过：给卡片加 24px 内边距 → 精确报「h 98 → 122（差 24px）」。

**⑤ 线上只读冒烟 + 性能报告（P2-11）**
`npm run smoke:prod` 对真实实例打 16 项 GET/HEAD（首页 / 清单 / 首个 JS / 安全响应头 /
favicon / 缺失资产 404 / 分享路由 / 未知路径 404 / `/api/init` 形状 / HEAD 无正文 …），
每天 01:00 UTC 定时跑 + 可手动触发，地址走仓库变量。只读是硬约束，有守卫钉着。
`audit:perf` 的数值以前只打印在日志里，现在写进 `$GITHUB_STEP_SUMMARY`（不降级门禁）。

线上实测（`https://<your-host>`）：15/16，唯一失败「未知无扩展名路径 404」——
线上跑的还是旧版，正是 ① 要修的那条，随本次部署生效。

## 2026-10-22（十七）· 性能：首访体感 —— HTML 加 stale-while-revalidate

**先量化**（`npm run audit:perf`，移动端 Slow-4G + 4× CPU 节流）：
FCP 4964 / LCP 5736 / TTFB 10 / DCL 4826 / 传输 876KB / 79 请求。
TTFB 只有 10ms —— 说明本地侧 4.9s **全花在下载 + 解析执行**，不是服务端。
而线上首访那 1 秒 TTFB 拆开来是：TLS 握手 0.52s + CF 回源 0.5s。

**诊断过的、确认不用动的**：
- 332 处图标全是命名引入，tree-shaking 正常（`mui-core` chunk 里没有 createSvgIcon）；
- `modulepreload` 已覆盖首屏 4 个关键 chunk；
- 静态资源早已是 `max-age=31536000, immutable` 且实测 CF `HIT`；
- 重依赖（mermaid 614KB / CodeMirror 550KB / cytoscape 424KB / elk 1428KB / katex 253KB）**全部不在首屏**。

**本次改动**：`public/_headers` 里 HTML 的 `Cache-Control` 从裸 `max-age=60`
改成 `max-age=60, stale-while-revalidate=60`。
原来注释写着"没上 SWR 是刻意的"，怕旧版窗口拉长 —— 但那个顾虑可以用**短 SWR**解决：
窗口锁死最多 2 分钟（升级本来就要等镜像，2 分钟可接受），换来的收益是
**已缓存的场景零等待**：过期后立刻用旧版渲染，后台静默刷新，用户不再等回源。

验证：改完重跑 `audit:perf`，FCP 5012 / LCP 5772（基线 4964/5736），在噪声范围内，**无退步**。

⚠️ **这一步要和 Cloudflare 配合才拿满**：CF 默认对 text/html 不缓存
（实测 `cf-cache-status: DYNAMIC`），HTML 每次都回源 —— 那 0.5s 是首访 TTFB 的大头。
在 CF 加一条 Cache Rules：URI 含 `/`、内容是 text/html → Eligibility: Eligible、
Edge TTL: 2 minutes、Browser TTL: respect origin。配完之后首访 TTFB 约 1000ms → 520ms。

**下一档（本次没做，收益与风险都记在这）**：把 `@dnd-kit`（75KB raw，首屏）挪出首屏。
它是唯一明确可移出的大块，但牵动 `App.tsx` / `GroupCard` / `SiteCard` / `SiteListBody` 四处，
且切排序模式会整列表重挂载 —— 需要单独一轮 + 拖拽功能的真机验收。

## 2026-10-22（十六）· 重构：NotesPage 拆出第六个 hook（useNotesList）—— 收尾

搬走列表派生链 `filtered → sorted → listGroups → visibleIds`（外加 `lazyListGroups` 懒挂载判定）。

**踩到一个真问题，值得记下来**：这条链和搜索子系统**互相依赖** ——
`filtered` 在搜索视图下要吃 `searchHits`（搜索子系统的产出），而搜索子系统里的
`searchHits` 又要用 `searchableText`（原本和 `filtered` 写在一起）。
第一版把 `searchableText` 也搬进 hook，直接构成**循环依赖**：hook 要放搜索前面
（搜索用 searchableText），却又需要搜索的产物。tsc 报了一串
`used before declaration` 才发现。

**解法**：`searchableText` 留在 NotesPage，改成 hook 的**入参`；hook 调用放回搜索子系统之后。
两边都不动，只是把「谁定义、谁使用」分清楚。

**搜索子系统整体不搬**：`searchEpoch` / 拉远端搜索的 effect / `searchSnippets` /
`highlightRanges` 都留在原处 —— 那里面有 abort 与竞态处理，跟列表派生不是一件事。

**累计成果**：`NotesPage.tsx` **3,818 → 3,539 行**，六个 hook 全部落在 `src/components/notes/`：

```
useNotesPanels     弹层开关
useNotesRowActions 行操作 / 多选 / 删除确认
useNoteAutoSave    草稿自动保存
useNotesFilters    搜索 / 视图 / 排序 / 选中项
useNotesData       纯数据派生（active / 各计数 / 配色 / 按文件夹分组）
useNotesList       列表派生链（filtered → sorted → listGroups → visibleIds）
```

剩下的 3,539 行是：编排逻辑（打开/切换/删除笔记的回调）、搜索子系统、JSX。
**拆分到此告一段落** —— 再往下就不是"拆文件"而是"重新设计这个组件的状态流"了。

## 2026-10-22（十五）· 重构：NotesPage 拆出第五个 hook（useNotesData）

搬走 5 个**与筛选无关**的纯数据派生：`active`（当前笔记）、`folderCounts`、
`tagCounts`、`tagColorByName`、`notesByFolder`，并把 `folders/tags/noteTags`
（只是 `folderTags` 的空值兜底）一并收进 hook。

**边界为什么这么切**：这几個只依赖 `notes + folders/tags/noteTags`，与搜索词、视图、
排序、选中的文件夹都无关 —— 所以不会和 `useNotesFilters` 打架。而：
- `filtered` / `sorted` / `listGroups` / `visibleIds` **留下**：依赖搜索词、视图、排序键，
  且 `filtered` 要吃 `searchHits`（带高亮区间），那是一整条链；
- `viewCounts` **留下**：依赖 `trashedNotes`（回收站派生），搬它会把回收站逻辑一起拖出来；
- `attachmentRefCounts` **留下**：依赖 `settingsOpen` / `attManagerOpen` 两个开关 + 模块级常量。

**累计**：`NotesPage.tsx` **3,818 → 3,634 行**，五个 hook 全部落在 `src/components/notes/`。
剩下的 `filtered/sorted/listGroups` 链条是最后一块，也是耦合最高的一块 —— 建议单独一轮。

## 2026-10-22（十四）· 重构：NotesPage 拆出第四个 hook（useNotesFilters）

搬走 8 个**纯筛选条件** state：搜索词、视图、排序键与排序菜单锚点、选中的文件夹/标签、
远端搜索结果（连同检索方式）、最近打开的笔记。

⚠️ **刻意没搬**：`notes` 列表本身和那些派生 `useMemo`（按关键词过滤、按文件夹归类、
排序后的可见列表）仍留在 NotesPage —— 它们和分组树、拖拽、虚拟列表缠在一起，
要搬必须连派生一起搬，那是独立一轮的事（方案里写明了）。

**四步汇总**（每步都单独 `tsc -b --force` + 全量 3,029 + build + 冒烟 38 项）：

| hook | 内容 |
|---|---|
| `notes/useNotesPanels` | 版本历史、图片灯箱、快捷键、分享、文件夹外观、标签颜色、移动抽屉、大纲开关、顶栏 ⋯ 菜单 |
| `notes/useNotesRowActions` | 多选、批量删除确认与忙碌态、右键菜单锚点与关闭动画、行内浮层、删除确认、新建重命名提示框 |
| `notes/useNoteAutoSave` | 草稿自动保存（保留 `saveRef` / 卸载 flush 第二个 ref / 失焦立即落盘三处技巧） |
| `notes/useNotesFilters` | 搜索、视图、排序、选中的文件夹/标签、远端结果、最近打开 |

文件从 3,818 行降到 3,711 行，且**搬走的都是自成一体的状态域**，
NotesPage 里剩下的是真正的编排（列表数据 + 派生 + JSX）。

## 2026-10-22（十三）· 重构：NotesPage 拆出第三个 hook（useNoteAutoSave）

搬走「草稿自动保存」：3 个 state（`saveState` / `savedAt` / `tick`）+ 4 个 effect
（30 秒 tick、防抖主逻辑、失焦/切走 flush、卸载 flush、⌘/Ctrl+S），净减 90 行。

**原样保留的三处技巧**（注释一并搬了过去，这是这段代码的灵魂）：
1. `saveRef`：`save` 的身份随 `onUpdate` → `notes` 变化，effect 的依赖数组只认
   `dirty / draft / noteId` 三样，用 ref 存最新 save，防抖才不会被打断；
2. 卸载 flush 用**第二个** ref：卸载是同步的 await 不上，只能 fire-and-forget，
   再套一层是为了让「卸载那一刻」拿到最新的 dirty/save；
3. 失焦 / `visibilitychange` 立即落盘：防抖放宽到 5 秒后，这是「打完字切走」的补偿。

**`dirty` 与 `save` 刻意不搬进来**：`dirty` 还被「关闭前的未保存确认」用，
`save` 依赖调用方的 `onUpdate` / `onNotify`，都由外层以参数传入。
`draft` 在 hook 里类型是 `unknown` —— 它只用于进依赖数组，hook 不读它的字段。

验证：`tsc -b --force` + 全量 3,029 全绿 + build + 冒烟 38 项。

## 2026-10-22（十二）· 重构：NotesPage 拆出前两个 hook（useNotesPanels / useNotesRowActions）

**为什么不是按 JSX 切**：实测这个文件 3,818 行里 **JSX 只占 524 行**（第 3294 行之后），
其余约 2,970 行是逻辑，而且有 **67 个 useState**、56 个 useCallback、34 个 useEffect。
JSX 早就拆过了（`src/components/notes/` 下已有 13 个子组件）。继续按 JSX 切，
文件还是 3,600 行，收益极低 —— 真正该拆的是**状态归属**。

**另外作者自己在 2347 行附近留过警告**：「引用的 active / setShareId / openRevisions
都在更上面才声明，提到前面会 `used before declaration`」—— 声明顺序本身就是隐含契约，
所以每一步搬完都要重新过一遍 `tsc` + 全量测试，不能攒到最后。

**本轮完成两步**（每步都单独跑过 `tsc -b --force` + 全量 3,029 条 + 无回归）：

| hook | 搬走什么 | 依赖 |
|---|---|---|
| `notes/useNotesPanels` | 版本历史、图片灯箱（含换图复位的 effect）、快捷键帮助、分享、文件夹外观、标签颜色、移动抽屉、大纲开关、顶栏 ⋯ 菜单 | 只读 `activeId` 与 `onListRevisions` |
| `notes/useNotesRowActions` | 多选集合、批量删除确认与忙碌态、右键菜单锚点与关闭动画、行内标签/导出浮层、删除确认、新建重命名提示框 | **零外部依赖**（全是开关与锚点） |

**踩到的坑**（都已处理）：
- `useNotesRowActions` 的解构一开始放在组件前部，结果 `closeRowMenu`（依赖 `rowMenu`）
  和菜单关闭的 effect（依赖 `menuClosing`）报 `used before declaration` ——
  这正是作者警告的那类问题，最后把解构挪回**原声明位置**才解决。
- 多行泛型 state（`namePrompt`）用字符串匹配删除时匹配到了别处的 `>(`，
  留下一个 `null);` 残尾导致语法错误；改成按位置切片处理。

**还剩两步**（方案已写进 `deliverables/notespage-split-plan-2026-10-22.md`）：
- ③ `useNoteDraft`：草稿、脏标记、自动保存 debounce、侧边编辑。**高耦合** ——
  `save` 依赖 `onUpdate`，而 `onUpdate` 又依赖 `notes`，原实现用「ref 塞进定时器」绕开身份变化，搬的时候必须原样保留。
- ④ `useNotesData`：列表、搜索、筛选、排序、文件夹树。**耦合最高**，其余全都依赖它。

## 2026-10-22（十一）· 修复：点「更新」后的提示文字被切掉半截

**现象**（用户截图）：「网站设置 → 版本与升级」里点了更新，两个提示卡片（「发现新版本 v7.3.1…」
与「升级中：正在拉取镜像并重建容器…」）的第二行/第三行只显示上半截，下半截没有，也没有滚动条。

**根因**：MUI 的 `AlertMessage` 样式里**自带 `overflow: auto`**
（见 `@mui/material/Alert`：`{ padding: '8px 0', minWidth: 0, overflow: 'auto' }`）。
只要祖先给的高度比内容差一点点，多出来的那一行就变成 **message 内部的滚动**，而滚动条在
卡片内部几乎看不见 —— 肉眼看到的就是「字被切了」。再叠加两个诱因：
- 2026-10-18 为了让提示和按钮排在同一行，把 Alert 的 `py` 压成了 `0`（高度更紧）；
- 今天新增的文案比原来长（多了「更新内容见发版页」与「页面自动刷新前请勿关闭」）。

**修法**（三处一起改，缺一个都可能复发）：
1. 在提示行之父容器上加 `& .MuiAlert-message { overflow: visible }` ——
   这一条是**机制性**的：即使高度仍然偏紧，文字也只会溢出显示，不会再被裁成滚动；
2. `py: 0` → `py: 0.25` + 钉住 `lineHeight: 1.5`（原来零内边距太贴边）；
3. 把两段文案收短（`发现新版本 v7.3.1 · 点「更新」自动升级 · 发版说明` /
   `升级中：拉取镜像并重建容器（已等 N 秒，最多 2 分钟）· 完成后自动刷新`），
   窄弹窗里尽量两行内说完。

**顺带**：提示行的 `alignItems` 从 `center` 改成 `flex-start` —— 两个卡片高度不同时，
垂直居中会让矮的那个看起来"缩"在中间，顶部对齐更整齐。

## 2026-10-22（十）· 安全：应用容器不再握 docker.sock（升级器独立成服务）

**这是评估报告里那条 P1 的落地**：应用容器挂 `/var/run/docker.sock` 等于把宿主机 Docker
的完整控制权交出去 —— 容器一旦被攻破，攻击者能起特权容器、挂宿主目录、读全部数据，
等于宿主机 root。

**试过但走不通的路**（记下来免得再试）：用 socket-proxy 收权限（`deploy/docker-socket-proxy.yml`），
实测跑不通 —— compose 要做 create/stop/networks/volumes，而一旦放开
`POST /containers/create`，就等于把 daemon 全权交出去，加固归零。**「在容器里驱动 compose
重建自己」与「不给完整 daemon 权限」在 docker 上互斥。**

**所以改的是「谁来执行重建」**：
- `navihive` 容器**不再挂 sock**，只挂一个 `upgrade-spool` 共享卷；
- 新增 `upgrader` 服务（`docker:27-cli`）持有 sock —— **不开端口、不跑业务代码、
  不渲染用户内容**，只从共享卷收指令；
- 应用侧进 **spool 模式**（`NAVIHIVE_UPGRADE_SPOOL`）：`POST /api/system/upgrade` 只写
  `/spool/request`（临时文件 + `rename` 原子替换，避免升级器读到半截 JSON），
  `GET` 读 `/spool/state.json` 并按**原有字段形状**返回 —— 前端 `upgradeWait.ts` 一行都不用改。

**顺带的收益**：原来那套「起 helper 容器 → 挂宿主 docker CLI + cli-plugins + 原路径 compose
目录 → 跑 compose」的机制被整个绕开了，`DOCKER_HOST` 协议转换、compose 标签坐标读取那些
踩过坑的地方都不再走。

⚠️ 升级器脚本里三条不能改的细节（都写在 compose 注释里）：
1. 只重建 navihive 自己（`up -d --force-recreate --no-deps navihive`）——
   不带服务名会连 upgrader 一起重建，那是让执行升级的进程自杀；
2. 挂载点必须是**宿主原路径**（`/home/docker/navihive` 挂到同名路径）——
   否则 compose 把运行时工作目录写进新容器的 `working_dir` 标签，下一轮升级就读歪了；
3. pull 用完整镜像名再 `tag` 成 compose 里的 `image` 名 —— 不同部署的 `image:` 写法不同
   （`navihive:latest` 或 `ghcr.io/...`），`pull navihive:latest` 会去 Hub 找、必失败。
4. **脚本里的 `$` 必须写成 `$$`** —— compose 会对 `command:` 做变量插值，`$IMAGE` / `$(date)`
   会被替换成空字符串，运行时变成 `docker pull ""` 直接失败，而 compose **只打 warning 不报错**
   （本轮就踩了，`config -q` 照样通过）。守卫里钉了这条。

**真机验收（两轮，这才是 4.5 一直缺的那步）**：
第一轮 3 秒完成（镜像已最新）；第二轮同样成功，且关键标签没有被写歪 ——
`project.config_files` 仍是 `/home/docker/navihive/docker-compose.yml`、
`project.working_dir` 仍是 `/home/docker/navihive`（4.4 那个「第一次成功后第二次必失败」
的坑依赖的正是这两个标签，没复现）。navihive 的挂载始终是 `/spool` + `/app/data`，
sock 只在 upgrader 里。

## 2026-10-22（九）· 工程：镜像发布从 QEMU 模拟改成双原生 runner（~13min → 预期 ~5min）

**为什么慢**：`docker-publish` 用 `--platform linux/amd64,linux/arm64` 单 job 构建，
buildx 会为**每个平台各跑一遍** builder 阶段。而 Dockerfile 的 builder 要
`npm ci` + `tsc -b` + `vite build` + `esbuild` —— 也就是说 arm64 那一遍是在
**QEMU 模拟的 CPU 上把类型检查和打包器完整重跑一次**，这是全流程最重的部分，
模拟下慢一个数量级。平时 13 分钟，2026-10-22 那天 cache 冷，跑过 35 分钟还没完。

**改法**：拆成「两个平台各自原生构建 → 合并 manifest」。
- amd64 上 `ubuntu-24.04`，arm64 上 **`ubuntu-24.04-arm`**（GitHub 原生 arm64 hosted
  runner，public 仓库免费 —— 本仓库确认是 public）。两边并行、都是原生编译，**没有 QEMU**。
- 构建 job 只按 digest 推送（`push-by-digest=true`，不打 tag —— 否则两个单平台
  manifest 会互相覆盖 `latest`）。
- 最后一个 `merge` job 用 `docker buildx imagetools create` 把两个 digest 合成
  multi-arch index，再打 `latest` 与 `$sha` 两个 tag。纯 registry 侧操作，秒级。
- 缓存 scope 按平台分开（`type=gha,scope=linux/amd64` / `linux/arm64`）：
  共用一个 scope 时两边互相覆盖条目，命中率反而下降。

**顺带记一笔**：本文件自身的改动不会触发构建（`paths` 里没有 `.github/workflows/**`），
所以改完要么手动 `workflow_dispatch`，要么随下一次源码改动一起生效。
若哪天 arm runner 不可用，回退方式是把 runner 换回 `ubuntu-24.04`、恢复
`docker/setup-qemu-action` + 单 job multi-platform（即旧做法）。

## 2026-10-22（八）· 结论：4.5 socket-proxy 不可行，已回滚（挂回 sock）

**结论先说：`deploy/docker-socket-proxy.yml` 跑不通网页一键升级，已从线上撤下，
navihive 继续挂 `/var/run/docker.sock`。** 那份文件顶部现在写清了原因，别再用。

**怎么发现的**：启用代理后点「更新」，先撞到 `DOCKER_HOST` 协议错（上一段修了），
修完再点仍然挂 —— 用 `tcp://` 形状直接跑一次 `docker compose up -d` 验证，
第一次就 `403 Forbidden`：
- 代理只开了 `CONTAINERS` / `IMAGES`，而 **compose 还要读 NETWORKS（并可能建
  project 网络）、读 VOLUMES**；`--force-recreate` 还要 `ALLOW_STOP`（停旧容器）。
- 这些原本是**刻意关掉**的 —— 放开它们不是「加个开关」，而是把权限面摊开。

**更根本的矛盾（这才是放弃的理由）**：只要保留「在容器里驱动 compose 重建自己」，
就必须允许 `POST /containers/create`；而这个端点一放开，**攻击者就能建一个把 `/`
挂进来（或 `--privileged`）的容器 —— 容器失守仍然是宿主机 root，加固等于零**。
换句话说，「网页一键升级」与「不给完整 daemon 权限」在 docker 上是互斥的。

**真要做隔离，得换升级形态**：让宿主机侧去拉镜像并重建（systemd timer / watchtower /
一个宿主机小 agent），容器里只写一个「请升级」的标记，根本不碰 daemon。
这是个独立设计，不在「加个 overlay 文件」的量级里。

**保留的成果**：`server/entry.ts` 的 `dockerCliHost()`（`http(s)://` → `tcp://`）
是对的也必须留着 —— 只要有人把 `NAVIHIVE_DOCKER_HOST` 指到真 daemon 的 TCP 端口，
helper 里的 CLI 就必须拿到 `tcp://` 形状，否则报 `invalid bind address format`。
另外「宿主 `/usr/bin/docker` 是 glibc 二进制，alpine 里跑不了，验证要用 navihive 镜像」
这条也记进了备忘。

**线上状态**：已回滚（`docker-compose.yml.bak-20261022` 恢复 → 单 `-f` 重建），
容器只挂 `/app/data` + `/var/run/docker.sock`，`config_files` 标签回到单文件，
站点 200 healthy。

## 2026-10-22（七）· 修复：4.5 启用后网页升级挂了（DOCKER_HOST 协议错）+ 3.3 第二批同源化

**先说那个 bug（我上一轮引入的）**：启用 socket-proxy 后点网页「更新」，helper 里报

```
Failed to initialize: unable to resolve docker endpoint:
invalid bind address format: http://docker-socket-proxy:2375
```

根因：**同一个地址，两种写法**。服务端自己读 Docker API 用 `http://host:2375`，
但 **docker CLI / compose 的 `DOCKER_HOST` 只接受 `unix://` 与 `tcp://`**，
`http://` 会被直接判非法。我把前者原样塞进了 helper 容器的 `DOCKER_HOST`。
修法：新增 `dockerCliHost()`，把 `http(s)://` 映射成 `tcp://` 再给 CLI，
服务端自己 fetch 仍然用 `http://`。两处派生，互不影响。
（`https://` 也映射成 `tcp://` 不带 TLS —— socket-proxy 只监听明文 2375。）

**3.3 mock 同源化第二批**：思路是「规则只准有一份实现」，不是把 1500 行 mock 删掉。
这轮清掉三处，**每一处都已经是分叉状态**，不只是重复：

1. **SQLite 时间格式**（新增 `utils/sqlTime.ts`）：原先 4 处手写、3 种写法。
   这些字符串是拿来做比较和排序的（墓碑游标、审计 `since` 过滤），
   秒级和毫秒级混进同一列，同一秒内的先后就分不出来 —— 而且不会报错。
   现在 `sqlNow()`（秒级，与 CURRENT_TIMESTAMP 一致）/ `sqlNowMs()`（墓碑要毫秒）/
   `toSqlTimeLoose()`（外部传入的 since 归一）。
2. **前端错误上报归并**（新增 `utils/clientErrorGroups.ts`）：真机版收集出错路径
   （最多 3 条），**mock 版压根没收集**，`paths` 永远是空数组 —— 本地看着一切正常，
   其实少了一整列信息。另外 source 的类型防御两边不一致（数字会被 mock 当成来源名）。
   现在两侧调同一个 `groupClientErrors()`。
3. **笔记规则值**（新增 `utils/noteLimits.ts`）：`REVISION_KEEP_PER_NOTE` 在 mock 里
   硬编码 `60`，只靠一句注释「与后端一致」维系；摘要截断一边 `>=` 一边 `>`，
   恰好等于 200 字时判断相反。现在常量与判定都只有一份。

**a11y / 对比度审计的端口改成自动挑**：原先各脚本写死一个 CDP 端口（9516/9517/9521…），
Windows 上被别的进程独占时，Chrome 直接 `bind() returned an error: 0x271D`，
脚本只会说「连不上调试端口」—— 于是**代码明明是好的，审计整条红**。
今天就被这么误判了一次（9516 被占，换 9633 立刻全过）。现在 `openBrowser` 自己从起点
往后找一个能 bind 的端口，各脚本不用改；被替换时会打一行
`[audit] 调试端口 9516 被占用，改用 9517`。

守卫 `tests/apiMockParity.test.ts`（12 条）：静态钉「两侧都引共享模块、没有内联手写」，
行为钉「毫秒能分先后 / paths 要收集 / 恰好等于上限算截断 / 数字 source 不算来源名」。

## 2026-10-22（六）· 修复：自托管「每次电脑开机第一次都要重新登录」

**现象**：自托管站点每次电脑开机后第一次打开都要求登录，之后关掉浏览器再打开就不用；
同样的账号在 Workers 站点上从来不掉。截图里账号名还记着（记住账号名生效），只是登录态没了。

**排查（全部在真机上量的，不是猜）**：
1. 先看服务端：容器今天 01:57 被重建过（是升级，不是崩溃），`AUTH_SECRET` 是 compose 里
   写死的固定值 → 密钥没变；VPS 时钟 chrony 同步误差 44 微秒 → `exp` 判定没问题。
2. 自己用 `AUTH_SECRET` 签一张合法令牌打 `/api/groups` → **HTTP 200**。
   结论：验签链路完全健康，问题在「浏览器带过来的那张令牌」本身。
3. 翻审计流水，看到每次 `login.success` 之前都有一条 `client-error`，
   detail 是「加载数据失败: 认证已过期或无效，请重新登录」→ 服务端真的在返 401。
   而且出现过 `登录 → 57 秒后 401 → 再登录 → 26 秒后 401` 的循环，登录 IP 在两三个值之间交替。
4. 查 `user_sessions` / `token_blacklist`：黑名单 13 条，每天稳定多一条 ——
   用户确实每天在重新登录，而且每次登录都把前一张令牌拉黑。

**根因**：`recordSession` 用**归一化 UA**（浏览器 + 系统，不计版本与 IP）判断
「是不是同一台设备」，命中就**拉黑并删除**旧会话（2026-10-17 修「登录设备重复显示」时加的）。
问题是 `Chrome|Windows` 这一把键被**所有**「Windows + Chrome」客户端共用 ——
另一台电脑、另一个 Chrome 配置文件、虚拟机里的系统，全都是同一把键。
于是后登录的那台把先登录的拉黑，先登录的那台下次一打开就 401 → 又要登录 →
再登录又把对方踢掉，两台机器**互相顶下线**。用户看到的就是「每次开机第一次都要登录」。
Workers 站点不受影响，是因为它的 `user_sessions` / `token_blacklist` 在另一个 D1 库里。

**修法**：设备身份改由**客户端持久 ID** 决定，UA 只用来在界面上描述设备。
- 前端 `utils/deviceId.ts`：localStorage 里存一个 UUID（`crypto.randomUUID()`），
  登录 / 注册请求体带上 `deviceId`；隐私模式拿不到就带 null。
- 服务端 `recordSession(token, ua, ip, deviceId)`：`user_sessions` 新增 `device_id` 列
  （迁移 `migrateSessionDeviceColumn`，SCHEMA_VERSION 22 → 23，老库 ALTER 补列）。
  `sameDevice()` 改成**只有两边都有 device_id 且相等**才算同一台设备 ——
  缺一边（老会话行、隐私模式）判**不同**。代价是列表里可能多一行（30 天内自然过期），
  收益是绝不误踢：被踢下线意味着「每次开机都要重新登录」，多一行只是界面多个条目。
  ⚠️ 刻意**不**回退到 UA：回退就等于把「一台旧版 + 一台新版」这个最常见的过渡组合
  继续留在互踢里，修了等于没修。
- 会话列表折叠（`listSessions`）也改成优先 `device_id` 做键 —— 否则「不同设备不折叠」
  这条会静默回退到 UA。（这也是本轮自己抓到的一个 bug：SQL 里漏了选 `device_id` 列，
  折叠永远走 UA 分支，互踢隐患还在。）
- 顺手修 `token_blacklist.created_at` 恒为 NULL：这一列没有 DEFAULT，插入时也没给值，
  于是「这条拉黑记录是什么时候写的」根本答不出来，排障时很碍事。

**用户需要做的**：**两台（或多台）设备各重新登录一次**。旧令牌里没有 device_id，
升级后第一次登录会给它补上；之后就不会再互相踢了。

⚠️ 两个坑（已写进守卫）：
1. `device_id` 落库会截断到 64 字符。拿整条 UA 拼 device_id 会超长，
   而两台不同设备的前 64 字符完全一样 → 又被判成同一台，白修。真实客户端用 36 字符 UUID。
2. 测试替身把 SQL 的**列名钉死**了（`SELECT jti, expires_at, user_agent ...`）：
   实现里多选一列之后，替身匹配不上、静默返回空数组，于是「同设备去重」在测试里失效、
   看起来像是实现坏了。替身改成一匹配「表 + 条件」不钉列名。

## 2026-10-22（五）· 收尾批次：两条用户实测反馈 + 后续计划第二批

一段是用户**直接报的两条**（都带截图），一段是 `docs/plan-2026-10-21-quality-followup.md`
里剩下的可选池。全部单独可回滚。

**一、分组上的长条去掉（A3 回滚）。**
第二批给分组面板顶部加的那条「取色渐变带 + 首字水印」经用户判定太丑，**整块删除**
（连带 `tests/groupBanner.dom.test.tsx`）。它本来就是纯 CSS 装饰、不存数据，
删掉不留残余，分组的辨识度回到原来的左角色条。

**二、编辑区光标统一成蓝色（用户复报）。**
上一轮把光标钉成「与正文同色（亮色近黑）」，用户复报：灰色渲染块内发浅、块外是蓝的，
**两边不一致**。现在按用户点名的方案来：文字插入光标两态都钉成显眼的蓝
（亮色 #1a73e8 / 暗色 #6cb2ff）；鼠标指针在编辑区内换成一支**自带白描边的蓝色 I 字**
（内联 SVG，无网络请求）—— 灰块上不再发白。
⚠️ 关键细节：子元素必须写 `cursor: inherit`；写成 `cursor: text` 会把自定义蓝针
打回系统黑针，等于没改。这条由 `tests/editorCursorGuard.test.ts` 钉住。

**三、C5 慢查询日志。**
自托管所有 SQL 都过 `server/sqlite-d1.ts` 一个出口，在那里打点：>50ms 记一条
（`NAVIHIVE_SLOW_QUERY_MS` 可覆盖，≤0 关闭）。**只记摘要**：字符串/数字字面量抹成 `?`、
绑定值一个都不落（慢查询日志是要留存的，漏进笔记正文就是事故）；同一摘要限流，
首次必打、之后每 20 次带累计次数再打；环形缓冲只留最近 50 条。
owner 可读 `GET /api/system/slow-queries`（含按摘要聚合的 Top 慢查询）。

**四、C2 elk 拆包：核实为「已实现」，补守卫。**
mermaid 12 自带按图表/布局引擎分包，elk（1.46MB）走 `registerLayoutLoaders` 的动态 import，
普通 `flowchart LR`（dagre）根本不会下载它 —— 这条属于「报告以为没做、其实已做」。
`tests/elkChunkGuard.test.ts` 钉住：elk 是独立块、只被动态引入。

**五、A6 动效规范化 / A7 暗色玻璃边界 / A10 图标线性。**
- A6：过渡收成三档 token（fast 130 / base 220 / slow 320ms）+ 两条曲线，
  index.css 里散落的 0.18s / 0.22s / 0.12s 全部收到 token 上；减弱动效仍走全局那条
  （用 token 的好处就是调档改一处）。
- A7：暗色下玻璃面板的边框单独一档（0.16 白）—— 玻璃压在未知背景上，定界全靠这根线，
  0.10 的白等于没有。
- A10：**只统一「同一概念摇摆」的那几个**（Delete / NoteAdd / Person / Visibility+Off，
  11 处）。⚠️ PushPin、Star **不动** —— 它们是「已置顶 / 未置顶」「已收藏 / 未收藏」
  的**状态对**，统一成一种风格等于让用户看不出状态。332 处全量换线性属于重做外观，
  不在这一批。

**六、B9 看板增强 / B4 标签层级 / 3.3 同源化第一刀。**
- B9：`utils/statsInsights.ts` —— 环比（近 7 天 vs 前 7 天）、占比、活跃度（活跃天数 /
  日均 / 峰值）三个视角，全部由现有数据派生、**不动服务端接口**。
  边界钉死：前一周为 0 不输出 Infinity%、总量为 0 不出 NaN%、乱序输入按日历切窗口。
- B4：`utils/tagTree.ts` —— 标签用 `/` 表达层级（工作/项目A），选父级即含全部子级；
  匹配按**段**比较（否则「工作」会命中「工作日晚高峰」）；隐式父节点自动补齐；
  全是一级标签时不按树排版。
- 3.3：先把「文件夹不能移入自身或子文件夹」这条**规则**同源化 —— 真机侧与 mock 侧
  原先各一份、连报错文案都不一样，现共用 `utils/folderTree.ts`。

**C1 首屏 <600KB：本轮结论是「当前 UI 栈下不可达」，已量清楚。**
实测 864.7KB 的构成：react-dom 202 + MUI/emotion 328 + 业务 237 + @dnd-kit 75 + CSS 19。
前两项 530KB 是框架地板；真要 <600KB 只能让首屏不背 MUI（纯 CSS 首屏壳 / 换 UI 栈），
那是独立项目不是一次打磨。本轮试过两刀都不成立：摘 `@dnd-kit/utilities` 的
`CSS.Transform`（0 收益，被 core 内部依赖，已回退）、MUI 色板（由 MUI 内部引入，动不了）。
唯一剩下的大刀是把 @dnd-kit 移出首屏（~61KB），但它牵动 App / SiteListBody /
GroupCard / SiteCard 四处、切换排序模式会整列表重挂载，**收益不抵风险**，留作专项。
**4.5 docker-socket-proxy 启用**同理：改的是升级链路本身，必须真机连跑两次验收，
本轮没有 SSH 凭据，**未在本次改动范围内**（下一轮带凭据做）。

⚠️ 本轮踩的两个坑（已写进守卫）：
1. `folder?.parent_id ?? undefined` 会把「存在但它是根」（null）也变成「不存在」——
   mock 侧建根文件夹直接报「目标文件夹不存在」。
2. 静态守卫在 Windows 上要先把 CRLF 归一成 LF，否则多行选择器 `indexOf` 永远 -1
   （选择器明明在文件里，守卫却在红）。

## 2026-10-21（四）· 体验：第二批后续计划落地

接 `docs/plan-2026-10-21-quality-followup.md` 的第二批（体验），四项全做完。
都是用户**直接看得见**的变化，全部可单独回滚。

**1. 记事本「真·专注模式」（A9）。**
标题行新增专注入口（也收在「更多操作」菜单里）：点一下，导航列、列表列、
格式工具栏、状态栏**整块从 DOM 卸载**（不是 display:none —— 卸载连副作用一起停：
图标批量请求、搜索防抖都不该在「只留正文」的时候还活着），只留标题、保存点和正文。
Esc 或标题行那颗退出键恢复，各列宽度/折叠态原样不动。
与设置里那个「专注模式」（淡化非当前行）是**两个独立开关**：那个在编辑器内部管注意力，
这个把页面外围的干扰收掉，可以同时开。
⚠️ Esc 让位给浮层：命令面板/设置/菜单开着时 Esc 先关手头那个，不掀页面布局。
⚠️ 侧边编辑器（分屏）在专注模式下也让位 ——「两篇对照改」与「只留一篇安静写」互斥，
`sideNote` 状态不动，退出专注自然回来。

**2. 笔记模板（B3）。**
新建时的三套内置骨架：**日报**（今日完成/进行中/明日计划/备注，标题带当天日期）、
**会议记录**（时间/参与人/议题/结论与待办，待办是任务复选框）、
**读书笔记**（书名/作者/摘要/摘录/想法）。「空白笔记」永远是第一项 ——
用模板是捷径，不该是门槛。纯前端字符串，不动任何数据结构。
三个入口（中栏头部、空态、左栏文件夹标题旁）都先弹选择；
右键「在此新建笔记」、命令面板、图谱保持一秒建空白（快捷通道不多一步）。

**3. 分享页增强（B5）。**
公开分享页（`/s/:token`）顶部加品牌头：图标 + 站点名 + 「记事本 · 只读分享」
—— 分享出去首先得让人知道这是谁家的东西，以及「这是分享给你的一篇，不是本站公开内容」。
新增「复制为 Markdown」：把**原始源码**写进剪贴板（收到分享的人最常见的动作就是
「抄走改改用」，给他原文比让他对着渲染结果手打强），空笔记不给按钮，
成败都有 aria-live 播报。阅读进度条按计划后置。
顺带把 `BrandMark`（站点图标三级回落）从 LoginForm 提取为共享组件 ——
登录页与分享页各写一份就会出现「登录页图标换了、分享页还是老的」这种分叉。

**4. 登录页品牌化（A8）+ 分组横幅（A3）。**
登录屏加了**静态**主色光斑背景（两个低透明度径向渐变，钉在视口上）和品牌区
一句话介绍（`BRAND.description`，可被上层覆盖）。刻意不用主界面那套 26 秒极光动画：
登录页是 lazy chunk，多挂一个 infinite 动画等于让没登录的人一进站就烧 GPU。
分组面板顶部新增取色横幅 + 组名首字水印：颜色优先用分组自己的强调色，
没设就按组名哈希（与站点图标占位块同一套 `toneForName`，同名同色）。
**纯 CSS、不存数据、不改接口** —— 以前整屏分组只有左角一根 3px 色条，扫过去一个样；
将来真想换真封面图，把那一块换成 `<img>` 就行，布局不用动。

门禁：`tsc -b --force` 0 错 / eslint 0 error / 单测 **2966 全绿**（新增 27 条）/
build / 体积预算 10 项 / 冒烟 / 无障碍 0 / 亮暗对比度 0 / 首屏体感
FCP 5004ms·LCP 6168ms（预算 ≤7157/≤8017，传输 874KB）/ npm audit 0 漏洞。

⚠️ 测试坑（记给后来人）：node:assert 失败时要 `util.inspect(actual)`，
**把 jsdom DOM 元素放进断言失败路径会把进程堆炸掉**（现象是「用例全过但进程
Array buffer allocation failed 死掉」，本项目 2026-10-07 踩过同款 heap OOM）。
本批所有新断言只比布尔与字符串，绝不 `assert.equal(el, null)`。

---

## 2026-10-21（三）· 安全 + 体感 + 体验：第一批后续计划落地

接 `docs/plan-2026-10-21-quality-followup.md` 的第一批（收尾与去风险），五项全做完。

**1. 凭据加密改用随机盐（质量评估 4.3）。**
`encryptSecret` 从「固定盐 + 单编号」改成「每条密文一个随机盐」。四个 keyId：

| keyId | 盐 | 源密钥 |
| --- | --- | --- |
| 0 | 固定 `navihive-aes-v1` | AUTH_SECRET（历史格式） |
| 1 | 固定 `navihive-aes-k1` | DATA_ENCRYPTION_KEY（历史格式） |
| 2 | **随机，随密文存** | AUTH_SECRET |
| 3 | **随机，随密文存** | DATA_ENCRYPTION_KEY |

为什么值得改：固定盐的盐是仓库里的常量，拿到一份密文就能**离线预计算**候选密钥。
随机盐把这条路断掉。为什么分 2/3 而不是一个编号：keyId 要能表达「用哪把源密钥派生的」——
否则以后配上 `DATA_ENCRYPTION_KEY`，之前用 AUTH_SECRET 写的随机盐密文会变成废数据。
⚠️ **备份文件（`encryptBytes`）刻意维持固定盐**：二进制格式里没地方写 keyId 与盐，
格式一变老备份再也导不回来。
⚠️ 降级提醒：新密文是 `enc$2$…`，跑回旧版本会解不开（`decryptSecret` 返回空串，不会崩）。

**2. Workers 侧漏配 `AUTH_SECRET` 也拒绝服务（4.4 的另一半）。**
原先只有自托管是「启动即中止」，Workers 侧只在登录与换钥两条路上 fail-closed，
其余路由照常跑 —— 最难察觉的是**凭据加密**：缺 AUTH_SECRET 时 keyring 会注册一把由
`PBKDF2("")` 派生的钥匙（历史行为，为了不让已有密文突然解不开），于是「加密」等于人人可算。
现在入口处直接 503 + 一句人话。判据**只看 AUTH_SECRET** —— 只配 JWT_SECRET 补不上这个洞。

**3. 首屏体感审计进 CI（C6 后半）。**
新增 `npm run audit:perf`：移动端 Slow-4G + CPU 4× 下用 `PerformanceObserver` 量真实
**FCP / LCP**，接在对比度审计之后。此前只有**体积**守卫，而「关键渲染路径上多一个阻塞块」
这种情况体积几乎不变、体感差一档 —— 体积守卫拦不住。
首次落地实测：**FCP 5112 ms / LCP 6028 ms / 872 KB / 79 个请求**。
这个数字本身就是「首屏 < 600 KB」（C1）值得做的理由。预算按实测 +35~40% 留余量给慢机器，
并在注释里写明「C1 做成后必须跟着收紧」，免得这条守卫一路放水。

**4. 两页文档。**
`docs/style-guide-2026-10-21.md`（样式该写哪儿：四层分工 + 判断顺序 + 5 条硬规矩）、
`docs/state-map-2026-10-21.md`（状态地图：4 个 Provider / 6 个 context / 全部本机键
「会不会同步」/ 37 个 hook 分域）。

**5. 卡片密度第三档「超紧凑」（A2）。**
三档的数值集中到 `utils/densityMetrics.ts`。顺带修掉一个结构问题：原来是十来处
`isCompact ? A : B`，加一档就得每处改成三元嵌套 —— 漏一处就会出现「某个角落还是旧档位」，
而且长得完全合法、review 和类型检查都拦不住。现在加了静态守卫
（`tests/densityMetrics.test.ts`：组件里不许再写 `density === "compact"`）。
⚠️ 两个坑：①`UIPrefsContext` 读取密度原来是 `=== "compact" ? … : …`，会把 "ultra"
悄悄压回舒适档（已改白名单）；②记事本自己有 `settings.density`（两档），**不是同一套**，
守卫用负向后顾把 `uiSettings.density` 放行。

门禁：tsc 0 错 / eslint 0 error / 单测全绿 / build / 体积预算 / 无障碍 0 / 对比度 0 /
**首屏体感 FCP 5056 ms · LCP 5980 ms（预算内）** / npm audit 0 漏洞。

## 2026-10-21（三）· 工程：接续质量评估的后续计划（纯文档，无功能变化）

新增 `docs/plan-2026-10-21-quality-followup.md`：把《质量评估（2026-10-20 独立审查版）》里
**还没做的部分**盘清楚并排成三批。

结论：那 10 条高优先级行动项已全部清完（i18n 按用户要求删除、移出待办）；
A/B/C/D 四组提案里还剩约 9 条值得做，排成「收尾去风险 → 体验 → 能力扩展」三批。

⚠️ 值得单说的一节：核对时**推翻了报告的三条判断** —— A2 卡片密度（已舒适/紧凑两档，
只缺第三档）、A4 首字母块按域名哈希取色（`toneForName` 已实现）、A5 空状态插画
（`EmptyArt.tsx` 已在用）。照报告排期会重复劳动。
教训写进文档：外部审查给的建议，落到排期前先 grep 一遍。

本提交**只有文档**，没有代码改动 —— 镜像会重建（含版本号），但功能与 5.1.2 完全一致，
可以不必升级。

## 2026-10-21（三）· 修复：点「更新」长时间没反应（版本号比镜像早到十几分钟）

用户报「点更新又长时间没反应」。**先查证据再动手**，三条事实拼出了根因：

1. 线上仍是原构建（`/precache-manifest.json` 的 version 与 `index-*.js` 的 hash 都没变）→
   升级**确实没生效**，不是「页面没刷新」的错觉。
2. GitHub Actions 记录：`6462edac`（v5.1.0）的 `docker-publish` **19:03:05 开始、19:16:10 结束**
   —— multi-arch 要模拟 arm64，一次构建 **13 分钟**。
3. 用户点「更新」的时间是 **19:13** —— 早了 3 分钟。

于是这条链路的问题就清楚了：**「发现新版本」比的是仓库里的 `package.json`，而镜像要在之后十几分钟才好**。
在那个空档里点「更新」，`docker pull` 拉回来的还是旧镜像，`compose up -d --force-recreate`
只是把同一个镜像又重建了一遍 —— 版本没变、站点白抖一次、页面干等满两分钟才说「没检测到新版本」。

三处改动：

**1. 服务端：拉完先比一次镜像 ID，没变就绝不动容器。** 读本容器当前在跑的 `Image`（sha256），
`pull` 之后用 `GET /images/{ref}/json` 取拉下来的镜像 ID；两者相同说明 registry 上还是这一版，
直接如实报「镜像没有更新，容器没重建，等 Actions 变绿再点」。这一条把「白等两分钟 + 站点抖一下」
换成了**几秒内的一句人话**。

**2. 服务端：成功判据从「helper 退出码 0」改成「容器现在跑的镜像真的变了」。**
`compose` 认为无须重建时会直接退 0，`wait` 拿不到结果也会被当成成功 —— 两种都曾让前端去等一个
永远不会变的版本号。现在 helper 结束后再读一次容器镜像 ID，没变就报失败并给出宿主机命令。

**3. 前端：「升级中」显示「已等 N 秒，最多 2 分钟会给结论」。** 以前只有一个静态的「升级中」，
超过预期的 10–30 秒后，用户除了「卡了」没有别的判断依据 —— 这正是「没反应」的体感来源。
超时文案也改成指向真正常见的原因（镜像还在构建）。

门禁：tsc 0 错 / eslint 0 error / 单测全绿 / build / 首屏体积预算 / 无障碍 / 对比度 / npm audit 0 漏洞。

> ⚠️ 记一笔给以后：**「推送完成」≠「可以点了」**。push 后要等 `docker-publish` 变绿
> （约 13 分钟）再去点「更新」，否则必然拉回旧镜像。这条以前只是隐约知道，现在是查过 Actions 记录的。

## 2026-10-21（三）· 修复：登录态不保持 / 附件卡片点不开 / 编辑区光标看不见；并**撤掉英文界面**

用户四条实测反馈，逐条处理。其中第 4 条按用户要求**直接撤掉**（原话：「去除英文这个方案，以后也不用提了」）。

**1. 「每次电脑开机后第一次打开还是要登录」。**
先把能查的都查了：①服务端登录响应实测是 `Max-Age=2592000`（30 天，`remember=true`），
两条 cookie 都不是会话 cookie；②本地起一套自托管、用**持久化 Chrome profile** 跑完整链路
（登录 → 杀掉浏览器 → 同 profile 重开 → 页面）—— **登录态确实保住了**，cookie 也活过重启。
所以不是 cookie 策略的问题，问题在**开机后第一次那个请求本身**：
`useAccountSession` 的启动检查拿 `bootstrap` 当「登录态探针」，**一次失败就下结论**，
而开机那一刻恰恰是网络最冷的（DNS 缓存空、TLS 要重握手、Cloudflare 边缘没握过手）。
两处改动：

- **启动检查加静默重试**：失败后再试两次（间隔 900ms），仍然拿不到才下结论。
  真的会话失效（401）不会因为重试变好，所以不影响「令牌过期该回登录页」这条正确路径。
- **失败后不再用「本地那个 JS 可读的登录标记在不在」判断登录态**：标记只是个附属 cookie
  （隐私工具常只清非 HttpOnly 的那条、两条 cookie 写入时机也会差一拍），真正的会话在
  httpOnly 的 `navihive_token` 里。改成问服务端：它还认就保持已登录（数据交给轮询与离线队列补），
  不认才是真该回登录页。⚠️ 加了个前提：只在**标记还在**时才多问这一次 —— 真 401 时
  client 的 `importError` 已经把标记清掉、`onAuthFail` 也已经把人送回登录页了，
  再问一次反而会把刚踢下去的会话又「捞」起来（这条是被 `App.dom` 那条用例挡下来的）。
- `checkAuthStatus()` 顺带修了个脆弱点：**本地标记没了也照样问一次服务端**，问得动就顺手把
  标记补回来 —— 用户根本看不到登录页。代价是「真的未登录」时多一个必然 401 的请求。

**2. 附件管理器：点缩略图那一大块没反应（只有文件名能点）。**
整张卡片都是预览入口了（`onClick` 挂到卡片外层 + `cursor: pointer`）。两个细节：
删除按钮与文件名按钮都 `stopPropagation` —— 前者避免「点删除先弹预览」，后者避免同一个动作调两次。
⚠️ 没有给卡片加 `tabIndex/role`：键盘可达性继续由里面那个**真 `<button>`** 负责，
加第二份只会让同一个动作在 Tab 序列里出现两次。配两条用例（点缩略图也开预览 /
点删除不顺手弹预览），**反向验证过**：把卡片上的 `onClick` 删掉，第一条当场红。

**3. 编辑区光标「有时候看不见」→ 查明是两个色，跟着语法高亮跑。**
用户补充得很关键：「鼠标在第八行里是白的，在外面是蓝的」。实测确认：编辑器装了
`@codemirror/lang-markdown` + `defaultHighlightStyle`，一个 span 被染成 `rgb(34,17,153)`
（蓝，链接 token）、另一个被染成 **`rgb(255,255,255)`（纯白）**；而原来的
`caret-color: currentColor` 是**可继承属性、`currentColor` 在光标所在的那个 token 元素上解析**
—— 于是光标跟着 token 变色，白 token 上就成了白底白字，等于消失。
改法：把光标色**钉死在编辑器这一层**（`index.css` 的 `.cm-editor .cm-content`，
亮色 `#1f2937` / 暗色 `#f4f4f5`，带 `!important` 压过 CM 注入的样式），任何 token 配色都影响不到它；
同时编辑器内部一律 `cursor: text`（CodeMirror 的装饰块与空白区会回落到系统箭头，
那套箭头在白底上几乎看不见），只有真正的可点元素（链接/按钮）保持指针。

**4. 撤掉英文界面（按用户要求）。**
2026-10-20 那套 i18n 骨架（`src/i18n/` 四个文件 + 设置里的「界面语言」小节 + 文案表）
**整套删除**，`main.tsx` 的 `LocaleProvider`、`SettingsDialog` 的挂载、相关用例一并移除，
全站只做中文。留了备忘：以后不再提议 i18n。

**顺带：`markdown-it` 14.3.2 → 14.3.3。** 推之前跑 `npm audit` 发现新公告
（两个高危：`html:true` 下内联 HTML 的二次时间 DoS、多行链接引用定义的二次时间渲染）。
本项目渲染层一直是 `html:false`，但公告同时覆盖默认选项，所以照规矩清零：
升到 `v14-legacy` 标签上的 14.3.3（同大版本补丁，不动 15.x 的破坏性变更），`npm audit` 归零。

门禁：tsc 0 错 / eslint 0 error / 单测 **2921** 全绿 / build 通过 / 首屏体积预算 10 项全绿
（撤掉 i18n 后主包回到 238 KB 量级）/ 无障碍 0 不合格 / 亮暗对比度 0 不合格 / npm audit 0 漏洞。


## 2026-10-21（三）· 优化：第二份质量评估的 10 条高优先级行动项全部落地

承接《全站质量评估与优化分析（第二份，独立重做）》（`docs/quality-review-2026-10-20-full.md`）
第 10 节那张表，**10 条一次做完**，含被列为 P1 的 `NotesPage.tsx` 拆分。

**1. `index.html` 内联纯 CSS 骨架（A1，全篇性价比最高的一条）。** 首屏 JS 到达前
（282 KB gzip 的下载窗口）原本是**纯白屏**——`SiteListSkeleton` 自己是懒加载的，
根本来不及占位。现在外壳里直接内联几十行 CSS 画骨架（顶栏 + 两列卡片，带 shimmer，
跟随亮/暗配色、`prefers-reduced-motion` 下不动），首帧就有东西看。
`main.tsx` 在 `requestAnimationFrame` 里摘掉它：React 19 的 `createRoot` 首次提交会清空
容器子节点（正常路径查到的是 null），留着是为兜住换成 `hydrateRoot`、
或挂载抛错被 ErrorBoundary 之外拦下这两种情况；放 rAF 里避免并发渲染首帧未提交就先闪一下底色。

**2. `NotesPage.tsx` 拆分：6675 → 3668 行。** 按职责拆成 7 个子组件
（`NotesNavPanel` 354 / `NotesTrashPane` 106 / `NotesListPane` 880 / `NotesEditorPane` 752 /
`NotesSidePane` 372 / `NotesOverlayLayer` 734 / `NotesConfirmLayer` 74），
共享入参抽成类型模块 `notes/notesPageCtx.ts`（用 TS 编译器 API 从真实代码**导出**出来的，
不是手抄的——手抄的接口一旦与实现漂移，报错会指向完全不着调的地方）。
⚠️ 迁移过程本身抓到一类**比不写守卫更糟**的问题：33 个静态守卫原本只读主文件，
代码一搬走就**假通过**（看着全绿其实没人盯）。现在守卫统一走 `tests/helpers/notesSource.ts`
**动态扫** `src/components/notes/` 全目录——以后再拆新文件守卫自动跟上，不用回来改清单；
跨文件切片的那几条（顶栏顺序、导航列自己滚、浮层不能包在中栏里）改按「锚点在哪个子组件」
分别钉，顺手把「搜索框在可滚区里、底部固定区在可滚区外」这条原始意图也补上了。

**3. 浏览器扩展（`extension/`，MV3，无构建步骤）。** 只申请 `activeTab` + `storage`
（不要 `<all_urls>`、不要 `cookies`），点一下把当前页标题/网址/备注编成
`?add-site=<base64url>` 深链打开本站并预填新增卡片弹窗（填完自己确认，扩展不持有任何凭据）。
判据在 `src/utils/addSiteDeepLink.ts`（5 例）；`App` 读一次参数就把 URL 里的参数抹掉，
避免刷新或前进后退时反复弹窗。

**4. PBKDF2 迭代数：Workers 上限 10 万 → 自托管 60 万。** 迭代数**写进哈希串**
（`pbkdf2$<iters>$salt$hash`），校验时按串里存的来——老库里 10 万的哈希照常能登，
不用改密。Workers 侧受平台硬上限（100 000）约束仍是 10 万；可用 `NAVIHIVE_PBKDF2_ITERS`
覆盖（10 万~100 万，只自托管生效），并加了 `isWeakPbkdf2Hash()` 认出弱哈希。
⚠️ 顺带挖出一个**真 bug**：迭代数变高后，多端并发首登的 owner 竞态从「几乎不会撞」
变成「必撞」——`claimIdempotency` 把「锁被别人拿着」和「表不可用」都压成 `false`，
于是首登会死锁。现在拆成三态（`acquired` / `busy` / `unavailable`），
`busy` 时**等到对方释放**而不是只偷看 120 ms。这个 bug 在改迭代数之前一直潜伏着。

**5. `AUTH_SECRET` 没配时拒绝启动。** 开了 `AUTH_ENABLED` 却没有 `AUTH_SECRET`
（或短于 16 字符）时：前者直接退出码 1 并打印怎么修，后者警告。
以前只是「启动后打一行日志」，部署漏配就等于凭据接近明文。

**6. 产物体积预算进 CI 硬门禁。** 新增 `npm run check:budget`，插在 CI 的 `build` **之后**
——`npm run test` 在 build 之前跑，而 `bundleBudget` 没有 `dist` 时会自己跳过，
也就是说这条守卫**此前在 CI 里从来没真正生效过**（本地全绿，CI 白跑）。
⚠️ 接上就立刻抓到本次改动的一个回归：站点索引从 `siteNoteLink` 引了 `findSiteByTarget`，
而 `siteNoteLink` 依赖 markdown-it → **首屏 852 → 971 KB（gzip +50 KB）**。
拆法：名字/网址匹配（不碰 Markdown）单独放 `utils/siteMatch.ts`，
需要解析 Markdown 的留在 `siteNoteLink.ts` 且**只能被懒加载组件引**。

**7. `deploy/docker-socket-proxy.yml`（可选叠加）。** 用 `tecnativa/docker-socket-proxy`
只放行 `CONTAINERS/IMAGES/POST` 且禁 `ALLOW_STOP/ALLOW_RESTARTS`，navihive 不再挂 sock、
改走 `NAVIHIVE_DOCKER_HOST`。容器失守的后果从「宿主机 root」压成「只能重建本容器」。

**8. i18n 骨架（zh/en）。** `src/i18n/`：`locale.ts`（认语言/存语言/取文案，纯函数）、
`messages.ts`（文案表，**zh 列与界面原文逐字一致**，接入不允许顺手改字）、
`localeStore.ts` + `LocaleProvider.tsx`（按项目既有约定拆成「只导出组件」+「只有 context/hook」，
避免热更新降级）。回落链是 当前语言 → zh → 兜底 → key：缺翻译最多是「这一处还是中文」，
不会显示 undefined 或空白。第一个接入口是设置里的「界面语言」——它本身就是语言开关，
自成闭环，接上之后 `t()` 这条链路才算真在跑。语言只存本机，不进 configs（换设备不该连界面语言一起换）。

**9. `.prettierrc` + `.editorconfig` + `.nvmrc`。** 4 空格 / 100 宽 / 单引号 / lf，
Node 22 锁版本，`yml|json` 单独 2 空格，`*.md` 不裁行尾空格（Markdown 行尾两空格是换行）。

**10. D2 站点 ↔ 笔记双向绑定。** 两边共用**同一套判据**（`utils/siteMatch.ts` + `siteNoteLink.ts`），
否则会出现「笔记里点得开、站点里列不出」这种两边单看都正常、合起来才是 bug 的情况。
  - 笔记 → 站点：预览里点 `[[GitHub]]`，没有同名笔记但有同名（或同网址）站点时，
    **打开那个站点**（新标签，`noopener,noreferrer`）并提示；`[[` 补全里一并给出站名候选
    （boost 比笔记低 5，同名时笔记优先——双链原本指的是笔记，不能被抢）。
    ⚠️ 这是**退化路径**：原本这类链接点了只会报「没找到」，现有笔记双链行为一字未改。
  - 站点 → 笔记：站点设置新增「相关笔记」小节，列出正文里写了 `[[站名]]` / 写了网址 /
    出现站名的笔记，点一下打开记事本并跳到那条（新增 `focusNoteId` 一次性跳转，
    用 ref 记住「已处理过哪个 id」，否则 3 秒自动保存一触发就会把用户自己选中的笔记抢回去）。
    判据剥掉代码块（示例代码里的网址不算「我提到了这个站」），单字站名不做名字子串匹配
    （叫「A」的站会把半本笔记都认领）。
  - 站点索引走**模块级**（`utils/siteIndex.ts`）：记事本的渲染链路已经有五层深，
    为一个点击把 props 全改一遍不划算；代价是没打开过首页时索引为空，
    那时 `[[站点]]` 退化成原来的死链提示（只是不认，不报错）。
    站点侧的两个能力（搜一下 / 跳过去）走 `AppConfigContext.notesBridge`——
    链路是 App → GroupCard → SiteCard → SiteSettingsModal，五层透传不划算；
    没接上时那一小节**整节不渲染**，而不是渲染出一个点了没反应的空壳。

⚠️ 顺带修掉一个因迭代数变高而暴露的**用例时序**问题：登录页「找回」那条原来
`await settle()` 等固定 6×10ms，PBKDF2 变慢 + 跑全量套件时 CPU 被抢会偶发不够用。
改成轮询等到条件成立——判据本身没错，只是不该靠猜时间。

门禁：tsc 0 错 / eslint 0 error / 单测 **2922** 全绿 / build 通过 / 首屏体积预算 10 项全绿
（实测首屏 863 KB / gzip 283 KB，在 900 KB 预算与 852 KB 基线内）/ 无障碍 0 不合格 /
亮暗对比度 0 不合格 / npm audit 0 vulnerabilities。
