# 更新日志 · 历史归档（2026-10-11 ~ 2026-10-20）

> 这是根目录 [`CHANGELOG.md`](../../CHANGELOG.md) 的历史归档，**最新记录见根目录那份**。
> 本文件内容为切分时原样搬运（未改写、未删减），按日期倒序，与原文一致。

## 2026-10-20（五）· 优化：质量评估 8 条行动项落地 6 条

承接同日发布的《全站质量评估报告》（`docs/quality-audit-2026-10-20.md`），逐条做完能做的。

**1. katex 重复打包 + 依赖漏洞，一次解决。** 原来 `npm ls katex` 有**两份不同版本**：
顶层 `katex@0.19.0`（公式用）+ mermaid 12.1.0 嵌套的 `katex@0.16.47`（它的范围 `^0.16.47` 不含 0.19，
而 mermaid 最高 12.2.0 也只要 `^0.18.0`）。用 `overrides` 强制 mermaid 也用 0.19.0 后只剩一份，
katex JS chunk 从两份 250KB 变成一份 259KB；且 0.19.0 不在 advisory 受影响范围（0.11.0–0.18.1）内，
`npm audit` 从 2 low 变成 **0 vulnerabilities**。

**2. 键盘焦点环：查明了是「判据假」不是「页面坏」，并把判据升真。** 老 a11y 脚本用 `el.focus()`
测量，而它**不触发 `:focus-visible`**，量出来恒为不可见——那一屏数字全是假数据。改用 CDP 发
**真 Tab 键**（`Input.dispatchKeyEvent`）后，全局 `:focus-visible` 对所有控件（含 Chip）一直有效。
第 4 节随之升为判据；输入框单独判「MUI 聚焦边框是否出现」（项目刻意不给输入框补 outline，
会与聚焦边框叠成双红圈）。过程中据此加过一个 MuiChip 补丁，**反向验证发现移除后审计照样绿**
（不可观测=没修复实际问题），已撤掉并在主题里写明不要再加。
⚠️ 顺带抓到判据本身的一个真问题：标签栏在无标签时整条不渲染，Chip 根本进不了 Tab 序列——
不塞数据的话「一片绿其实什么都没验」。现在用 `Page.addScriptToEvaluateOnNewDocument`
在文档加载前往 localStorage 塞两个标签。

**3. 给「升级后不白屏」那套逻辑补上单测（+16 例）。** 它原来住在 `main.tsx`，import 即执行副作用、
单测根本够不着，被评估列为「9 个从未被用例引入的源文件」之首。现在自愈逻辑抽成
`src/utils/staleRecovery.ts`（清缓存 / 闩锁 / 一次性令牌 / 离线判断），配 6 例：
只清本站缓存、两条路径共用闩只刷一次、令牌已存在不重复刷、真离线什么都不做、
拿不到在线状态按在线处理、清缓存抛错也照常重载。`ErrorBoundary` 补 4 例（含
「清理本机数据」**不动记住的账号名**这条越界防护）。同时修掉两个让单测够不着的原因：
单测环境补 `__NAVIHIVE_BUILD_VERSION__` 等 esbuild define、补 `sessionStorage` 全局。

**4. `NotesPage.tsx` 拆分第一期。** 6675 → 6649 行：快捷键弹窗外移成 `NotesShortcutsDialog.tsx`、
摘要生成外移成 `utils/noteSummary.ts`（配 6 例单测）。剩余侧栏 / 右键菜单 / 批量操作条 /
弹窗控制器群需要专门批次，报告里写了建议顺序。

**5. `deploy/selfhost.md` 新增 sock 风险独立小节。** 讲透「挂 docker.sock = 容器内 root 可控
宿主机 Docker」，给出三种选法（不挂最稳 / 挂+只绑回环 / 套 docker-socket-proxy 只放行必要端点），
连放行与禁用的端点清单都列了。**没有**真的上 proxy：那会改升级链路的连接方式，需真机验证，风险收益不成比例。

**6. 新增 `docs/pitfalls.md`。** 20 条线上真出过事的坑，按「症状 → 根因 → 现在怎么防」写
（routes 前缀顺序、immutable headers、rolldown importers、弹窗 fallback 禁 null、
`el.focus()` 量不出焦点环、jsdom 里 window≠globalThis、esbuild 提前执行常量路径的动态 import、
升级三种错误做法、回归必须连跑两次、静态守卫必须反向验证……）。

门禁：tsc 0 错 / eslint 0 error / 单测 **2896** 全绿 / build 通过 / 全站体检 28 项 0 问题 /
无障碍 0 不合格（焦点环新增为判据）/ 亮暗对比度 0 不合格 / npm audit 0 vulnerabilities。


## 2026-10-20（五）· 新增：全站质量评估报告

按视觉呈现 / 功能完整性 / 架构设计 / 安全性 / 运行速度五个维度做了一次**实测优先**的评估
（全站体检 28 项 0 问题、无障碍 0 不合格、亮/暗对比度 0 不合格、覆盖率扫描、产物与源码规模统计、
依赖漏洞扫描、安全头核对），报告在 `docs/quality-audit-2026-10-20.md`。

要点：门禁全绿的前提下仍找出 8 项可改进，其中两个是实打实的浪费/坏味道——
**katex 被打包成两份**（各 250KB、都含 render，两条 import 路径分别解析到 ESM/CJS 入口）、
**`NotesPage.tsx` 6675 行**（唯一的上帝组件）；另有 `main.tsx`/`ErrorBoundary` 等 9 个源文件
（924 行）从未被用例引入，而它们恰好承载「升级后不白屏」的自愈路径。
报告末尾按优先级给出 8 条行动项。

## 2026-10-20（五）· 工程：升级状态提到模块级 + 启动清理上一轮 helper

上一批（v4.3.0）交付后自查发现一个作用域 bug：整套「网页直接升级」代码（含 `upgradeStatus`）被写在 `createServer` 的请求回调里，等于**每个请求一份新对象**。表现是 POST 记下的 pulling / recreating / failed 状态，GET 永远读到初始的 idle —— 换镜像本身不受影响（那是 POST 那条链自己走完的），但「失败原因」这条通道是断的。整块（拉镜像 / helper / 兜底 / 状态）已提到模块级。

顺带收尾：升级成功后本进程会连同容器一起被换掉，helper 没机会自己清理，会在 daemon 里留下一个已退出的 `navihive-upgrader`。现在**启动时**按标签 `com.navihive.upgrader=1` 删掉「不在运行」的那些（正在跑的不动 —— 删它会弄丢升级现场）。

守卫：`tests/systemUpgradeGuard.test.ts` 新增一条静态检查 —— `upgradeStatus` 与 `dockerUpgradeSelf` 必须出现在 `const server = createServer(` 之前。反向验证过：v4.3.0 的 `entry.ts` 会被这条挡下（`createServer` 在 233 行、`upgradeStatus` 在 340 行）。

## 2026-10-20（五）· 修复：网页一键升级不换镜像（restart 不重新解析 :latest）

用户报「点击更新长时间无反应，刷新后还是原来版本」。上一版（10-19）为绕开「容器内 stop 自己 → 执行升级的进程当场死」，把升级做成了 `POST /containers/{name}/restart`。restart 是 stop+start，由 daemon 完成、不怕进程被杀，看着完美 —— 但它**按容器创建时记录的 ImageID 启动，不重新解析 `:latest` 标签**。于是 `docker pull` 明明拉到了新镜像、容器也确实重启了（`StartedAt` 变了），跑的还是旧代码。线上症状就是「版本号不动」。

**换镜像必须由容器外的进程做。** 现在拉完镜像后起一个一次性 helper 容器（复用刚拉到的新镜像，只借它的 `/bin/sh` + 宿主机挂进来的 `docker` CLI 与 cli-plugins），由它在容器外执行 `docker compose up -d --force-recreate`：既真正换了镜像，又不会把发起升级的本进程提前杀掉；顺带让 compose 里新增的配置项也一起生效（restart 做不到这点）。

**compose 坐标零配置。** 工程名 / 工作目录 / 配置文件全部从容器标签 `com.docker.compose.*` 读取，不再要求用户多配一个环境变量（上一版正是多要 `NAVIHIVE_UPGRADE_DIR`，写错就一律 501）。纯 `docker run` 起的容器读不到 → 明确报错并给出手动命令，不假装成功。可用 `NAVIHIVE_COMPOSE_DIR` / `NAVIHIVE_HOST_DOCKER` / `NAVIHIVE_HOST_DOCKER_PLUGINS` 覆盖。

**不再让用户对着「升级中」干等。** 新增 `GET /api/system/upgrade`（owner only）回报 phase（pulling / recreating / failed + 原因）；前端点完「更新」立刻跟进轮询：版本真换了就清掉 SW 缓存自动刷到新版，失败就把它给的原因摆出来，2 分钟没结论也会如实说「没等到」并给出手动命令，而不是转完圈什么也不说。升级中「更新」按钮禁用，避免重复触发第二次重建。

**留一份现场。** helper 会把每次升级的时间与 compose 输出追加到宿主机的 `<compose 目录>/.navihive-upgrade.log` —— 重建会把容器自身的日志一起换掉，出问题时这份文件是最后一份现场。helper 带 `Tty` 创建，失败时它的输出会原样带进给用户看的错误文案。

守卫：重写 `tests/systemUpgradeGuard.test.ts`（永久封死 `stop` / `restart` 两条历史根因，钉住「拉镜像先于动容器」「先响应再执行」「$? 不能走管道」），新增 `tests/upgradeWait.test.ts`（upgraded / failed / timeout 三个出口 + 清缓存重载）。单测 2879 全绿。

## 2026-10-20（五）· 优化：弹窗说明文案精简（版本升级区 + 各设置/账号/笔记弹窗）

用户反馈「弹窗里的提示词太多太乱」，逐处收敛：只留关键事实，砍掉解释性长句。

**版本与升级。** 发现新版本原来那条蓝框塞了 Docker 命令 + Workers 说明 + 发版页三段；既然一键「更新」已能自动拉取并重启，长指引没必要——精简为「发现新版本 X，点「更新」自动升级。更新内容见发版页。」。「升级中」与「命令已复制」两条提示也各缩成一句。

**网站设置。** 顶部说明两行压成一行（带「即时生效」的开关立即生效；其余为草稿，需点「保存设置」）；外观、背景、缩略图、图标隐私、拼音搜索、离线增强、数据同步、维护/沉睡治理等各节 hint 与 caption 一律收成一句，去掉「为什么会这样」的长解释。

**账号与安全 / 笔记设置 / 导入预览 / AI 助手。** 各节 hint 与设置行描述同样精简（账号密码 / 恢复密钥 / 登录设备 / 沉睡治理 / 附件管理与导出 / 覆盖导入与增量合并 / AI 模型与语义索引 等）。

守卫：随文案改动更新两处断言（账号弹窗改断言「站点所有者不提供注销入口」、AI 助手改断言「不会发出任何请求」），语义不变。单测 2873 全绿。

> 本次按用户要求**只推送代码、不部署 VPS**，留给用户测试网页「更新」按钮能否自行升级。

## 2026-10-20（五）· 修复：登录态跨重启保留；编辑区附件点击开弹窗；弹窗直接可编辑 + 复制按钮

用户三条一起提的修复，逐条落在这批里。

**1. 自托管登录态跨关机保留（用户报「每次开电脑第一次开网页都是登录页面」）。** 根因是 `LoginForm` 里 `remember` 默认 `false`，普通登录只拿到 24 小时的 `DEFAULT_TOKEN_TTL` cookie；关机过夜超过 24h cookie 就过期，开机进首页自然是登录页。现在默认勾选「记住我」，登录走 30 天的 `REMEMBER_TOKEN_TTL`——在保留期内（最长 30 天）再开网页，会话 cookie 仍有效，直接进已登录态，不再弹登录页。复选框文案本来就是「记住账号名（不保存密码，登录状态保留一个月）」，行为与文案现在一致。

**2. 笔记编辑区里的附件链接点了开弹窗（用户报「不是弹窗打开」）。** 两个入口都修：
　① **即时渲染块**：那块内容是 `LiveBlockWidget` 里 `createRoot` 起的**独立 React root**，`NotesPage` 顶层那个 `AttachmentPreviewProvider` 穿透不过去，于是块里的 `AttachmentLink` 读到的 `useAttachmentPreview()` 是 `null`，退回整页跳走的 `<a>`。现在 `NotesPage` 的 `liveRenderer` 把渲染结果整体用 `AttachmentPreviewProvider` 包一层，编辑器内的链接才接得上弹窗控制器。
　② **源码态**：链接是纯文本 `[名称](/api/notes/attachments/<id>)`，没有可点的 `<a>`。给 `NoteEditor` 的 `EditorView.domEventHandlers` 加了 `mousedown` 拦截：命中链接 URL 那段就 `preventDefault` + 开弹窗；方括号里的文字照常放光标可编辑（避免「想改名字却把弹窗点开」）；已渲染态的真 `<a data-attachment-link>` 交给 `AttachmentLink` 的 onClick 接手，不会重复打开。三个 `NoteEditor`（主栏 + 双分栏）共用同一个回调。

**3. 附件弹窗打开就是可编辑态，且文本框右上角加「复制内容」按钮（用户追加要求）。** `editing` 初始态从 `false` 改成「文本可编辑即 `true`」——只在 `onSaveContent` 存在 + 文本类型 + 不超 40 万字符阈值时进编辑态；图片 / 二进制 / 超大只读仍不进。文本框（`<pre>` 与 `<TextField>` 共用的容器）右上角加了带 `ContentCopy` 图标的按钮，`navigator.clipboard.writeText` 写全文 + 轻提示「已复制附件内容」；剪贴板被拒时提示失败。

守卫：改订 `tests/attachmentPreview.dom.test.tsx`（默认可编辑态下内容在 `[data-att-editor]` textarea、`data-att-body='text'` 不再出现；原「点编辑」步骤作废，避免断言抛错后没清场拖垮后面的重命名用例）、`tests/loginForm.dom.test.tsx`（默认 remember=true；取消勾选才变 false）。单测 2873 全绿。

**4. 顺带自查一处回归风险。** 第 2 条的 `mousedown` 拦截要识别 markdown 链接，正则与 `markdownToReact.tsx` 里 `AttachmentLink` 用的同一把尺子（`/api/notes/attachments/<id>`，带 query/hash 的分享链接不拦），避免两边口径漂移。

## 2026-10-19（四）· 新增：附件弹窗预览 / 原地编辑 / 重命名，左下角「待办」换成「附件」

用户四条一起提的改造，逐条落在这批里。

**16. 点正文里的 txt / json 链接 → 在弹窗里打开（不再是整页跳转）。** 以前点下去浏览器直接把附件当页面渲染：记事本被顶掉，回退要重新加载一遍列表；json 更是铺一屏没有换行的长串。现在正文渲染层（`markdownToReact`）认出 `/api/notes/attachments/<id>` 形态的链接就交给 `AttachmentLink` 组件，点了 `preventDefault` + 开弹窗。
　⚠️ 为什么必须做成**组件**而不是在渲染函数里挂 onClick：`renderMarkdownToReact` 是 async 的，它在 **React 渲染之外**把 token 树翻成元素树，在那里调 `useContext` 会踩「hooks 只能在组件渲染期调用」。所以 element 在那里创建，读 context 的动作留给组件自己。
　⚠️ 分享页没有 Provider，**自动退回原来的 `<a>`**：那边的附件走 `/api/public/...` 免鉴权通道，弹窗侧取不到字节，整页打开才是对的。

**17. 预览弹窗带编辑（用户追加要求）。** 弹窗按响应的 `Content-Type` 分三态：文本进 `<pre>`（可切「编辑」改完保存）、图片直接显示、其它给「下载」。保存走新端点 `PUT /api/notes/attachments/:id/content`：**覆盖同一个 object_key**，所以附件 id 与正文链接全都不变。
　安全边界两层：前端只对 txt / json 显示编辑按钮；**服务端仍要自己判一次**（编辑后的内容还要过 `sniffTextMime`），否则「文本附件只当纯文本出」这条约束能从后门绕开。配额按**增量**算（改大才检查），且**不占**「每小时 100 次上传」——编辑不是上传，改到第 101 次被拦谁都理解不了。
　未保存就关窗会先问一句（`window.confirm`）：这弹窗就是「看着看着顺手改两行」的场景，一个 Esc 丢掉改动太容易发生。

**18. 附件管理器点文件名 → 预览（不是下载）。** 文件名从 `<Typography>` 换成真 `<button>`（键盘能 Tab 到、回车打开）。没有 `onPreview` 时退回纯文本，不出现「看得见点不动」的死按钮。

**19. txt / json 重命名（完整方案：元数据 + 正文一起改）。** 新端点 `PATCH /api/notes/attachments/:id`，只改 D1 里 `filename`，**不动 object_key** —— 正文链接里是附件 id，所以改完一条链接都不会失效。紧接着扫正文，把 `[旧名字](…<id>…)` 的**方括号部分**换成新名字（只换 label，URL 一字不改），改过的笔记 `rev + 1` 让其它设备下一轮轮询能感知。
　⚠️ 扩展名**锁定**：类型是上传那一刻按内容嗅探定死的，允许把 `data.json` 改成 `data.txt` 只会让「名字说的」和「实际是」对不上。扩展名跟着 mime 走，用户只改主名。
　⚠️ 图片语法 `![alt](url)` 跳过：文本附件被当图片嵌进正文属于脏数据，别顺手把它改成链接。
　⚠️ 重命名后会**重拉笔记列表**（`onDatasetChanged`）：本地正文还是旧名字，用户在这条笔记里再存一次就会把服务端的新名字覆盖回去。

**20. 顺带修：下载时的文件名。** 附件响应头原来只有裸 `Content-Disposition: inline`，「另存为」拿到的是 uuid —— 重命名功能等于白做。现在按 RFC 6266 出 `inline; filename="…"; filename*=UTF-8''<编码>`，并手动补转义 `!'()*`（`encodeURIComponent` 不转它们，而 RFC 5987 的 attr-char 不允许，文件名带个括号就会让整个头被丢弃）。响应头里仍然只有文件名，不含 object_key。

**21. 记事本左下角「待办」彻底去掉，同位置换成「附件」（用户确认「彻底去掉」）。** 删掉 `NotesTodoDialog`、`noteTodoAgenda`（`collectTodos` / `todoCounts`）、左下角那行 `NavRow`、`todoOpen` 状态、命令面板里的「全库待办面板」条目。
　判断依据：待办清单的价值全在「勾一下回写原文」，而正文里的 `- [ ]` 本来就能点（预览 / 源码两处都支持），聚合面板是**重复入口**；反过来附件管理器一直缺一个随手可点的入口——它藏在「设置 → 数据」两级菜单后面。**正文勾选能力完全保留**。
　⚠️ 新入口刻意**不带 `data-view`**：它不是视图。原来那行待办挂了 `data-view="todo"`，于是 `button[data-view]` 的视图清单里混进一个非视图条目，测试也跟着一起写歪了。

**22. 清理未引用附件的提示补上「文档」。** 提示原来只写「图片」，但清理判据是 `corpus.includes(id)`，**与文件类型无关**（txt / json 一样会被清）。两处文案（`AttachmentManager` 与设置 → 数据）改成「图片、txt / json 文档等」，并把删除确认里那句「图片加载失败」也换成中性的「加载失败的占位」。

守卫：新增 `tests/attachmentRoutes.test.ts`（8 例：扩展名锁定 / 路径分隔符净化 / 空名拒 / 404 / 图片拒编辑 / 空内容拒 / 覆盖同一 key / 下载头带文件名）、`tests/attachmentRenameRealSql.test.ts`（4 例，**真实 SQLite**：正文同步 + rev 自增 + 图片语法跳过 + 孤儿附件 + 404）、`tests/attachmentPreview.dom.test.tsx`（7 例：链接拦截 / 无 Provider 退回 / 管理器点名字 / 编辑保存 / 重命名 / 空名不发请求 / 图片无编辑入口）；改订 `notes.dom.test.tsx` 两处视图清单断言（去掉 `todo`，加断言附件入口在）。

**23. 全站体检里自查出的三处补丁（同一批内修掉）。**
　① **登录过期时的假附件**：整条 `/api` 在会话失效后会回 SPA 登录页（`200` + `text/html`），弹窗按「文本附件」把它显示成一坨 HTML，看着像附件坏了。现在识别 `text/html` 并明确报「可能登录已过期」。
　② **超大文本的截断陷阱**：25MB 的日志塞进 `<pre>` 会卡死标签页；更糟的是「只显示前 N 个字符却还允许编辑保存」——打开 → 改一个字 → 保存，剩下全没了。现在超过 40 万字符就**截断预览 + 明说不支持在线编辑**（禁掉编辑入口，而不是让它保存一份残缺文件）。
　③ **两处管理器行为不一致**：设置 → 数据里的附件管理器点文件名没反应（只有左下角那个能点）。同一个组件不该有两种行为，设置页也接上了同一个预览弹窗（只读预览不需要任何写权限，老部署照样能用）。

守卫：新增 `script/verify-attachments.mjs`（**真实浏览器 + 真后端** 14 项：链接不整页跳 / 弹窗读到内容 / 保存后服务端字节真的变了 / 元数据改名 / 正文链文字同步而 URL 不动 / 390px 记事本与抽屉与弹窗都不横向溢出 / 管理器点文件名开预览）。

另：单测 **2873**（原 2866，+7）。

---

## 2026-10-19（一）· 修订：四项交互回归的二次根治（滚动条拖动 · 白圈 · TXT 附件可见 · AI 补全挂起）

上一批（v3.10.1）按用户原话做了六项修复，用户复测后明确回「**这四项还在**」。这批不是小修，是逐项在真实浏览器里复现后的根治；每一条后面都附了**实测数字**，不是「改了就算修好」。

**8. 渲染态代码块的横向滚动条点一下就跳回编辑、根本拖不动（用户第一报「一点就切换编辑状态，无法拖动」）。** 两条原因叠在一起：① `LiveBlockWidget` 对块内所有 `mousedown` 一律 `preventDefault()` + 派发选区，滚动条按下那一瞬 widget 就被卸载，拖动自然断；② 更隐蔽的是——即使放行了 `mousedown`，**浏览器在滚动条上按下时会把焦点交给最近的可聚焦祖先**，也就是编辑器的 `contenteditable`，`focusChanged` 效果一样把当前块拆回源码。修法三件套：`ignoreEvent()` 改回 `true`（CM 不拦这个 widget 的事件）；命中 `pre` 的横向滚动条区域时**放行**且 `stopPropagation`；给 widget 宿主加 `tabIndex=-1` 并在放行时把焦点拉到宿主上，让浏览器的默认聚焦落不到编辑器里。实测（`script/verify-fixes.mjs`，真 Chrome + 实体滚动条）：`scrollLeft` 0 → **963/972**，`<pre>` 仍在 `.note-live-block` 内（渲染态没被拆）。
　⚠️ 顺带修了**只在 headless 下才暴露的假象**：之前一版判定用 `offsetHeight - clientHeight > 0`，而 headless Chrome 默认开 `--hide-scrollbars` + overlay 滚动条，滚动条**不占布局高度**，于是判定恒为 false，看着像「没有滚动条可拖」。现在 overlay 分支单独走「底部按下不退出 + 横向 wheel」验收，实体滚动条分支才判几何。

**9. 右键菜单关闭瞬间在**右键点位**闪白圈（用户第二报，已是第**五**次上报）。** 前三轮分别试过 onExited blur、`disableRestoreFocus`、hover 抑制，都只堵住一条路径。这轮在真实浏览器里**逐帧采样**（36 帧 / 600ms）才看清还剩两条：① MUI Menu 关服时会把焦点**还原**给打开前的元素，而 Chromium 里被程序化还原的焦点也会命中 `:focus-visible`，行级 `:has(:focus-visible)` 随即把圆形「⋯」按钮点亮；② 关闭动画里按钮走的是 `opacity` 过渡，**淡出那几帧本身就是用户看到的「一闪而过」**。修法：右键菜单（锚点是 `anchorAtMouse` 造的虚拟元素）显式禁焦点还原，按钮菜单保留键盘返回路径；关闭窗口内按钮从「淡出」改成 **`visibility:hidden` 硬压**（`transition:none`），不再有可见帧。实测：36 帧全部 `visibility:hidden`、`opacity:0`、`document.activeElement` 不在按钮上，菜单确认已关闭。
　⚠️ 这里还翻了一个**文档坑**：`tests/syncNotifyGuard.test.ts` 里原本断言「MUI Menu 不转发 `disableRestoreFocus`（加了是死代码）」。核对当前 `@mui/material` 源码（Menu → Popover → Modal 一路 `...other` 透传）后确认**是转发的**，旧注释和守卫都改掉了——死守错的结论比没有结论更糟。

**10. 添加 TXT 附件后在笔记里看不到（用户第三报）。** 上一批把「添加附件」做成了只上传、只提示「去附件列表查看」，正文里什么都不留——用户当然看不到。现在上传成功后把下载链接**插进触发上传的那个编辑器正文**（主栏/侧栏分别绑，不串），并把文件名里的 `[` `]` 换行替换为空格（否则 Markdown 链接语法会被破坏）。三个此前没处理的坑一并补上：① 上传是异步的，期间切到别的笔记时**绝不能**把链接写进新笔记（按编辑器身份 + 当前 noteId 双重校验，不符则回写原笔记）；② 直接走 CM 句柄赋值而**不是** `insertAtCursor`——后者带「同工具再点一次撤销上次插入」的语义，连续加两个附件会把上一个链接撤掉；③ 预览态下没有编辑器，此时按钮置灰并给对应 tooltip。实测：真机选文件上传 → 正文渲染出 `[验收附件-一-.txt](/api/notes/attachments/…)` 且**已落库**（自动保存后从 `/api/notes` 读回）。
　⚠️ 验收时还踩过一次自己的坑：`.cm-content` 的 `textContent` 里看不到 `[` `]` `(` `)`——行内渲染把它们藏了，照 textContent 判会误判「没插进去」。终审改看渲染出的 `<a>` + 后端正文。

**11. 新增站点用站点 URL 补全 `game.maj-soul.com/1/` 时长时间无反应，关窗重开按钮还在转（用户第四报）。** 原逻辑直接 `await siteAi.siteMeta(...)`，没有 try/finally、没有超时、没有取消：请求一挂 `aiBusy` 永远是 `true`，关窗重开按钮就一直转。四件事一起补：① 30 秒 UI 超时（与底层 30 秒请求超时对齐，超时给人话提示）；② 请求序号，旧结果/旧错误**不回写**新表单；③ 定时器在成功/失败/关闭/换 URL 四条路径上都清；④ `useEffect` 依赖 `[openAddSite, newSite.url]`，**打开状态或 URL 一变就整体重置**——这就是「关窗重开还在转」的正根。顺手把「网站设置」弹窗里同款缺陷（`SiteSettingsModal` 的 `handleAiComplete` 连 `finally` 都没有）一起修了；`useAiAssistant.siteMeta` 也补了 try/catch 与缺协议 URL 补 `https://`（`game.maj-soul.com/1/` 原来会被后端以「需要一个 http(s) 网址」直接拒掉，这才是「长时间无反应」里最快的那种）。守卫：`tests/addSiteDialogAi.dom.test.tsx` 3 例（真实渲染 + 挂起请求 + 关闭重开 + 旧结果不污染）+ `tests/useAiAssistant.dom.test.tsx` +1（无协议规范化 + 网络异常转可见失败）。

**12. 新增 `script/verify-fixes.mjs`（工程）——四项回归的专用真实浏览器验收。** `site-audit` 跑全站一分多钟，改一处想复验一次太慢；而且它默认 `--hide-scrollbars`（headless 走 overlay 滚动条），**量不到实体滚动条的几何**。这个脚本只钉本批四项中最容易假绿的三项：实体滚动条**按住-拖动-松手**后 `scrollLeft` 真的变且 widget 没被拆、右键菜单关闭**逐帧采样**、TXT 附件**真走文件选择**后 DOM 与后端双重确认。另给 `auditEnv.mjs` 的 `openBrowser` 加了 `hideScrollbars` 开关（默认不变，a11y/contrast 那两个审计不受影响）。

守卫：本批新增 4 例行为/契约断言（`addSiteDialogAi` 3 + `useAiAssistant` 1），改订 2 例（`syncNotifyGuard` 的 `disableRestoreFocus` 判定、`textAttachmentGuard` 的插入契约与正则）。

另：单测 **2859**（原 2854，+5）。

---

## 2026-10-19（三）· 修复：网页升级把站点搞挂了（stop 杀掉执行升级的自己）

**15. 点「更新」后长时间无反应、刷新变 502（用户实测）。** 根因是一个**自指**的结构性错误：
执行升级的 Node 进程**就在被升级的那个容器里**，而实现按 recreate 写 ——
`POST /containers/navihive/stop` 一发出去，容器收到 SIGTERM，entry.ts 的优雅退出
（清 timer → 关库 → exit 0）跑完，**本进程立刻死**，后面的 DELETE / CREATE / START
一行都不会执行。线上症状完全对得上：容器停在 `Exited (0)`（干净退出，不是崩溃）、
没有任何 `[upgrade]` 日志、站点 502。
　修法：换成 `POST /containers/navihive/restart`。stop + start 都由 **Docker daemon**
完成，不依赖容器内进程活着；start 时 daemon 按 `Config.Image`（tag 形式）重新解析 ——
新镜像刚拉到本地、`latest` 已指向它，所以容器起来就是新代码。顺带把「先拉镜像再重启」
的顺序钉死（拉不动就绝不去碰容器，旧代码继续服务），并加一条 tag 形式校验
（digest 形式的 `repo@sha256:…` restart 后仍指向旧镜像，那种情况直接报错，不假装成功）。
　兜底也从「用存底的规格重建」改成「确认容器在跑，不在就 start」—— restart 失败时
旧容器只是停着，start 一下就好，比删了重建安全得多。
　⚠️ 代价写进文档：restart 保留原容器配置，所以**compose 里新增的配置项不会生效**，
那种升级仍需在宿主机 `docker compose up -d --force-recreate`。
　⚠️ 这个 bug 之前只在 VPS 上验到「sock 能连、规格读得到」就停了，没有真跑过一次升级。
**自指式操作（进程要修改自己所在的运行时）必须真跑一遍**，只读验证永远差最后一步。

守卫：`systemUpgradeGuard` 把「不得自己 stop / delete 本容器」立成**核心不变量**
（`doesNotMatch` + `restart` 必须存在 + 拉镜像必须在重启之前 + 失败要确保容器在跑）。

---

## 2026-10-19（二）· 修复：右键白圈第六报（退出过渡）+ 升级改为网页端一键直达

**13. 右键菜单关闭后，白圈仍会闪在「之前右键点击的地方」（用户第六报）。** 前五轮修的都是
「行内 ⋯ 按钮被焦点还原点亮」那条路径，而这一报的点位是**鼠标右键那个坐标** —— 是另一条
完全不同的路径。用 `script/probe-white-dot.mjs` 逐帧记录菜单 paper 的几何后才看清：右键菜单的
锚点是 `anchorAtMouse` 造的 **0×0 虚拟元素**，而 MUI Menu 的退出过渡是 **Grow（scale）**：
paper 从 161×329 一路缩到 12×9，`transform-origin` 又正好落在锚点上 —— 于是**鼠标点位置
始终被 paper 覆盖**，实测覆盖锚点的帧 12 个、宽度 16→12px、opacity 0.79→0，直到 207ms
才卸载。那十几帧就是用户看到的「一闪而过的白圈」。修法：`transitionDuration={{ enter: 225,
exit: 0 }}` —— 退出不缩放（进入动画保留，用户没有抱怨「出现」时难看）。
复测：**覆盖锚点的可见帧 7 → 0**。
　⚠️ 这条能报六次，本质是「同一个症状、两条路径」：前五轮把 ⋯ 按钮那条堵死了，用户再看，
剩下的就只有退出动画这条。两条都堵上才真的干净。

**14. 「检查更新 → 更新」改成点击后直接在网页端升级，不再复制命令去后台（用户再报）。**
上一批（v3.10.1）虽已把「更新」按钮写成网页触发，但**部署侧没挂 docker.sock、还要求
`NAVIHIVE_UPGRADE_DIR`**，于是端点一律 501，用户看到的仍是「复制命令去后台」。本轮两件事
一起改：① 实现从「容器内跑 docker CLI + compose」换成 **Docker Engine API（unix socket）** ——
镜像是 node:24-slim，里面没有 docker 二进制；挂宿主 CLI 还要连带挂 cli-plugins
（`docker compose` 是插件不是内建命令）与 compose 目录，链路长且动态库容易不兼容。
Node 原生 `http.request` 的 `socketPath` 就能打 sock，零额外依赖。序列：拉镜像 → 停 → 删 →
按**原容器规格**重建 → 启（env / 卷 / 端口 / 重启策略 / 健康检查原样保留，只换 Image，
等价于 `compose up -d --force-recreate` 对单服务的效果）。② 去掉 compose 目录那道闸
（只剩 owner + sock 两道），compose 模板补上 `/var/run/docker.sock` 挂载与
`NAVIHIVE_CONTAINER_NAME` / `NAVIHIVE_IMAGE`。
　另外补了两个此前没有的兜底：重建前先把容器规格存底（`lastKnownSpec`），失败时用它把原容器
**原样拉回来** —— 否则旧容器已停已删，站点会直接停摆（用户看到的就是「点完升级网站打不开了」）。
　⚠️ **部署侧还有一个只看 `ls` 发现不了的坑**：`docker.sock` 属 `root:docker(987)`，而镜像默认
以 `node(1000)` 运行 —— `ls` 看得见文件，真连是 `connect EACCES`。所以挂了 sock 还必须给权限，
二选一：`user: "0:0"`（模板默认，代价是容器内进程有 root 权限）或
`group_add: ["<宿主机 docker 组 GID>"]`（保留非 root）。这个坑是在 VPS 上**重建后跑一次容器内
只读 Docker API 调用**才暴露的，光看文件权限会以为已经通了。

守卫：`tests/systemUpgradeGuard.test.ts` 5 例（两道闸、不再要求 compose 目录、走 socket
不依赖 CLI、先响应后执行、失败自救）+ compose 挂载与容器名 + 前端回落路径。

---

## 2026-10-19（一）· 修复+性能：代码块横向滚动 · 白圈（右键点位）· 文件夹前/后移位 · 置顶卡顿 · 内联字号 · 添加附件按钮 · 全站体检脚本

> **同日二次修订（v3.10.2）——上一批四项修复的复报与根治，见文末「2026-10-19（一）· 修订」段。**
**1. 渲染态代码块超长没有横向滚动条（用户报「笔记编辑栏开启渲染后代码长度过长未出现横向滚轮」）。** 根因是 flex 子项的 `min-width:auto`：`.cm-content` 被超宽内容撑开后，内部 `<pre>` 跟着等宽，`overflow-x:auto` 永远不会触发，长代码最后被 `.cm-scroller` 的 `overflow-x:hidden` 直接裁掉。三处一起钳：`.cm-content` 加 `maxWidth:100%`、`PRE_STYLE` 加 `maxWidth:100%`、`index.css` 补 `.note-live-block pre { max-width:100%; overflow-x:auto }`。真机实测：`<pre>` 可视宽 499px、内容宽 2236px、`overflow-x: auto` —— 滚动条真的出来了。

**2. 右键菜单关闭瞬间在**右键点位**闪白圈（用户第五报，「还是有一闪而过的白圈」）。** 这一报的点位不是「⋯」按钮而是**右键的那个位置**：300ms 抑制窗口一过，鼠标还悬在这一行，行级 `&:hover` 规则又把「⋯」按钮顶出来——用户右键多半点在行右侧，那正是「⋯」的位置。改法是把 hover 显隐**按行抑制**：新增 `rowActionsSuppressed` 状态，所有关闭路径统一走 `closeRowMenu()`（置抑制行 + 置 `menuClosing`），hover 规则改成 `opacity: rowActionsSuppressed === note.id ? 0 : 1`（键盘 `:focus-visible` 那条规则保持独立，可达性不掉），鼠标离开该行即清除抑制。

**3. 文件夹「向前/向后移动」这次真的换位了（用户重报「实际位置没换」）。** 上一轮修的了索引换序与服务器持久化，漏了**渲染侧**：左栏文件夹树是**按 `folders` 数组顺序 DFS** 渲染的，`reorderFolder` 里 `setFolders(prev.map(...))` 只换了 `order_num`、数组顺序纹丝不动，界面自然没反应。现在 `map` 之后补 `.sort(sortFolders)`。

**4. 文件夹下方置顶等操作的卡顿修复（用户报「卡顿，优化速度」）。** `notes` 每变一次（置顶/保存/移动的乐观更新）就要全量重算一串派生值，其中最贵的三处：`tagCounts` 是「标签 × 笔记」双重循环且每条现开一个 `Set`；`attachmentRefCounts` 无条件对所有正文跑正则；`noteWordTotal` 对每条正文 `replace` 出一份新字符串。改法：①`folderCounts` / `tagCounts` 改成**单趟遍历**（`$O(f×n)$`、O(t×n) → O(n)）；②总字数与附件引用计数加 **`settingsOpen` 闸门**（只有数据面板真的打开才算），附件计数正则前再用 `includes` 兜一道；③左栏内联笔记从「每次调用 filter+sort」改成 `notesByFolder` 分组表（引用稳定，不再带着整棵树重渲）。真机实测置顶点击到 UI 反馈 **23-29ms**。

**5. 左栏文件夹下的笔记标题字号过大（用户报「字号过大」）。** 内联笔记原来是 `font: "inherit"`，会继承父级正文号；128px 窄列里明显比同级文件夹行大。现在显式 `fontSize: 12.5`（与同级一致）。真机实测量到 `12.5px`。

**6. 工具栏新增「添加附件」按键（用户报「工具栏上加上添加附件按键可以选择 txt 或 json」）。** 与已有的「上传图片」分成两条路：**上传图片**插 `![]()` 进正文；**添加附件**走 `notes/attachments` 进附件管理器、不插正文（附件是资源不是内容）。按钮 `data-tool='attach'`，隐藏 input 的 accept 为 `.txt,text/plain,.json,application/json`，上传后 toast 提示「已添加附件「X」，在笔记的附件列表里查看」；没给上传能力时不渲染这个按钮。真实后端端到端复测：txt / json 都能传（白名单按文件内容嗅探）、下载字节一致、文本补 `charset=utf-8`。

**7. 新增全站体检脚本 `script/site-audit.mjs`（工程）。** 之前的两个审计量的是**静态样式**（对比度 / 可访问名），这个跑**真实链路**：真后端（自托管服务）+ 真登录态 + 4 档视口（1440 / 864 / 768 / 390），逐页采集「控制台报错 / 未捕获异常 / 4xx-5xx 请求 / 横向溢出 / 越界元素」；路由覆盖 `/`、`/s/<token>`、`/sg/<token>`、未知路径（SPA 兜底）；交互上会真的去开设置 / 搜索 / 更多选项 / 账号弹窗，并复核本批六项修复（代码块滚动、内联字号、置顶耗时、添加附件按钮）。跑法见脚本头注释。⚠️ 本轮就靠它撞出一个陷阱：**`dist-server` 是旧产物**（没有 `build:server` 就直接起服务）会让接口层面全是假象——先看到「txt/json 415 不支持」，重build 后立刻正常，不是产品 bug。

守卫：本批新增 8 例静态/契约断言（`folderViewGuard` +3：单趟计数、settingsOpen 闸门、`notesByFolder` 分组表、reorder 排序、内联字号、代码块钳宽、行抑制；`textAttachmentGuard` +1：添加附件按钮链路）。另把一批 `useNotes.ts` 的 `useCallback` 依赖补严。

另：单测 **2854**（原 2846，+8）。

---

## 2026-10-18（日）· 修复+新增：网页直接升级 · 笔记上传 txt/json · 文件夹树贴附 · 即时渲染独立修复 · 白圈根治 · 前/后移动

**1. 「更新」按钮能在网页直接升级了（用户报「发现新版本能否加个升级按键直接在网页升级版本」）。** 自托管部署（Docker + docker.sock）下，「版本与升级」里的「更新」优先 POST `/api/system/upgrade`：服务端三道闸（owner / docker.sock 存在 / compose 目录），**先响应 200 再 detached 执行** `docker pull && docker compose up -d --force-recreate`——容器会把自己换掉，不先响应命令就发不出去，约 10-30 秒后服务短暂重启、页面自动恢复。Workers 部署没有该端点（404）/ 没挂 sock（501）→ 回落复制 `docker pull ghcr.io/zwjttztt/navihive:latest` 命令，复制失败命令原文可手动复制。守卫：`tests/systemUpgradeGuard.test.ts` 3 例（端点三道闸 + 先响应后执行 + 前端回落）。

**2. 笔记附件支持上传 txt / json（用户报「笔记上传 txt/json」）。** 后端附件路由按文件头嗅探，新增 `text/plain` 与 `application/json` 白名单（与图片同走内容嗅探、不看文件名，SVG 仍拒）；下载端对文本补 `Content-Type: text/plain; charset=utf-8`（防浏览器把上传的 html 当页渲染）。前端：上传 input 的 accept 增加 `text/plain,.txt,application/json,.json`；图片仍插 `![]()`，文本插 `[文件名](链接)` 下载链接（markdown 图片语法对文本无意义）；附件管理器里文本渲染成「文件图标 + 文件名 + 大小 + 下载」。守卫：`tests/textAttachmentSniff.test.ts`（嗅探 4 例）+ `tests/textAttachmentGuard.test.ts`（前端契约 6 例）。

**3. 文件夹树：选中文件夹的笔记紧贴文件夹行（用户报「123 笔记和 123 文件夹中间夹了 321 文件夹，应该贴着」）。** 原来选中文件夹的笔记渲染在整棵树末尾，子文件夹把笔记和它的文件夹隔开。现在渲染紧跟在该文件夹行之后（笔记 → 子文件夹），左栏里「123 文件夹 / 123 笔记 / 321 子文件夹」一眼成父子。点文件夹不强制展开中间栏（用户报「中间栏不需要出现」）：中栏显示与否交回用户自己的「收起列表」控制。守卫：`tests/folderViewGuard.test.ts` 3 例。

**4. 分栏「即时渲染」独立修复（用户重报「侧边打开后即时渲染还是同步的，左边开关对两边有效、右边开关全无效」）。** 上轮侧栏开关改了，但两个侧栏编辑器仍绑定主开关 `liveRender`，所以主开关联动两侧、侧开关没接上。本轮把两侧编辑器改成绑定独立状态 `sideLiveRender`（初值跟主设置、之后各管各），侧开关只动它。守卫随 `notes.dom` 与 `tests/syncNotifyGuard.test.ts`。

**5. 右键菜单关闭后的白圈：根治补完（用户第四报延续「弹窗消失的瞬间还是有白圈」）。** 前几轮加的 `disableRestoreFocus` 是死代码——MUI Menu 根本不转发这个 prop，还原焦点照旧发生。真正兜底是事件驱动：菜单关闭的 300ms 窗口内挂 `focusin` 捕获，任何落在「⋯」按钮上的焦点立即 `blur`（Chromium 里被还原的焦点会匹配 `:focus-visible`、行级 `:has(:focus-visible)` 显隐规则就把它顶出来）；配合退出动画期间的 `--closing` 类 `!important` 硬压。守卫：`tests/syncNotifyGuard.test.ts` 同步更新（去掉死代码断言、补 focusin 捕获断言）。

**6. 文件夹「向前/向后移动」可用（用户报「文件夹里向前移动向后移动也没用」）。** 根因两点：排序用存量 `order_num` 交换，存量有重复/空洞时交换完还是乱的；每层只有一个项时菜单项不置灰、点了静默无反应。本轮改用**同级索引**换序（索引必然不同），到头/到尾的菜单项按 inkstone 同款置灰。守卫：`notes.dom` 该用例钉住「第一项向前置灰、最后一项向后置灰 + 方向正确」。

另：单测 2846（原 2832，+14 含 txt/json 与升级端点）；修复一条因 txt/json 重构把 `handleImagePicked→handleFilePicked` 重命名、守卫锚点失配的用例。

---

## 2026-10-18（日）· 修复+新增：点文件夹切视图 · 更新按钮 · 分栏即时渲染独立 · 白圈根治

**1. 点文件夹不再「假切过去」（用户报「标题名为 123 的笔记属于 123 文件夹但不在 123 文件夹下方」）。** 截图里左栏「全部 3」与「📁123」同时高亮——原来点文件夹只设 `activeFolder`、不切 `view`，「全部 N」的计数与高亮都还在，中栏却只剩该文件夹的一条，视觉上像没切。现在 `NoteView` 加 `folder` 键：点文件夹 / 新建后选中都切到该文件夹视图，删当前文件夹时拉回「全部」，左栏高亮与中栏内容一致。

**2. 发现新版本时有「更新」按钮了（用户报「能否加上一个更新按键」）。** 「版本与升级」节在检查到新版本时，除文字指引外新增主操作按钮：一键复制 `docker pull ghcr.io/zwjttztt/navihive:latest` 到剪贴板（自托管部署到服务器粘贴执行即可——前端点不到你的服务器，这是最短路径）；复制失败时命令原文直接摆出来可手动复制。Workers 部署不用操作（推 main 即自动构建），文字指引里已说明。

**3. 分栏两侧的「即时渲染」不再同步（用户报「在侧边打开时两个笔记的即时渲染不要同步打开和关闭」）。** 侧边栏那颗开关原来写的是全局设置、与主栏联动；现在初值跟主设置，之后各管各——主栏开关仍写全局（设置面板可改、跨会话保留），侧边开关只动自己的状态。

**4. 右键菜单关闭后的白圈：根治（用户第四报「点击其他任意位置，弹窗消失后的瞬间还是会出现白圈」）。** 前三轮修了 CSS 显隐（`:has(:focus-visible)`）、开菜单前摘焦点、退出动画后摘还原焦点——都没断根，因为 Chromium 里**被还原的焦点会匹配 `:focus-visible`**（即便最后一次交互是鼠标），行级显隐规则随即把「⋯」顶出来。本轮三管齐下：①菜单 `disableRestoreFocus`——不还原就没有还原焦点这回事；②关闭一开始给按钮打 `--closing` 类（CSS `!important`）压掉退出动画 200ms 期间的显式 `opacity:1`——「弹窗消失瞬间冒圈」正是这一帧；③`onExited` 兜底 blur。守卫：`tests/syncNotifyGuard.test.ts` 补 3 条断言 + `tests/folderViewGuard.test.ts` 3 例（剥注释 + 反向验证）。

另：本地 git HEAD 已同步到远端（前两批因 HEAD 落后导致版本 bump 被跳过、两批共用 v3.6.0 的问题不再重演）；CI 轮询工具改为退避策略 + 完成汇总输出（`ci-watch.py`，本地工具不入库）。

---
## 2026-10-18（日）· 修复+新增：弹窗操作结果可见性排查修复 · 分享分组弹窗重排 · 白圈焦点兜底补强

**1. 弹窗内「操作结果」可见性排查（用户报「网站设置点检查更新后弹出的提示框还要往下移动很不方便，查看其它弹窗是否还存在这种问题并全部修复」）。** 全站弹窗的操作结果分两类：走全局 toast 的（SettingsDialog 维护节的失效检测、各弹窗保存/删除提示）永远可见，无此问题；**弹窗内 Alert**（带明细、不适合 toast 的）排查出三处，两处本次修复、一处早有兜底：

- 「版本与升级」的检查更新结果：原来 Alert 排在「检查更新」按钮正下方，网站设置是长得最长的弹窗、版本节又在最底部，结果停在内容折叠线下面要手动滚。现在结果 Alert 与按钮**同一行**（窄屏自动换行），并在出结果时把该行滚进可视区（`closest('.MuiDialogContent-root')` 滚到底，无容器时 `scrollIntoView` 兜底 —— 与 BackupDialog 的 WebDAV 测试结果同一模式）；
- AI 助手的「测试连接」结果：同样补滚动兜底（结果带两条模型明细，内容不短，不做同行布局，只补滚动）；
- WebDAV 测试连接结果（BackupDialog）：早有滚动兜底，本次用静态守卫钉住不许被删。

守卫：`tests/updateAlertVisibilityGuard.test.ts` 3 例（剥注释 + 反向验证）。

**2. 分享分组弹窗重新排列（用户报「排列太丑」）。** 原布局问题：复制按钮独占一行下方空一大块、有效期与口令挤在 xs（444px）窄弹窗里口令框只剩半截、按钮组左对齐裸挂内容底部且主次一样重。重排：弹窗放宽到 sm；链接框与「复制链接」同行；「链接」与「分享设置」之间加分隔线；有效期与口令改两列栅格（`5.5rem 1fr`）；按钮区收进 DialogActions 右对齐（「更新设置」主操作 + 「撤销分享」弱化）；读取中（配置没回来）不渲染按钮，避免点了没反应。全部 data-* 测试契约与 aria-label 保留，既有 14 例全过。

**3. 右键菜单关闭后白圈：焦点兜底补强（用户第三次报「仍然存在白圈残留」）。** 前两轮已修：行内「⋯」按钮显隐从 `:focus-within` 改为 `:has(:focus-visible)`（程序化还原的焦点不匹配、键盘可达性保留）、右键开菜单前摘掉活动焦点。本轮再补一层兜底——MUI Modal 关闭时把焦点**还原**给打开前的元素，且还原发生在退出动画**之后**（`onClose` 里 blur 太早）：给行菜单挂 `TransitionProps.onExited`，菜单彻底消失后若焦点还落在「⋯」按钮上就摘掉它。至此三条路径（CSS 显隐规则 / 开菜单前 / 关菜单后）全部覆盖。

---

## 2026-10-18（日）· 修复：跨设备同步提示四连误报 + 版本号显示收敛

四条用户实测报的提示噪音，同一个根：**「跨设备变更」没有区分「是别的设备改的」还是「本设备自己改的」**，外加两处焦点/显示残留。

1. **每次刷新弹「其它设备删除了 N 张卡片，已同步」**（`useSiteSync`）：轮询游标原来只存在内存 ref 里，刷新后第一次轮询 since 为空，后端把 site_tombstone **全量**倒回来，历史删除被当成刚发生的。现在游标持久化到 localStorage（按账号隔离，`utils/siteSync.ts`），刷新接着上次的位置增量；游标也为空（第一次用/清了存储）时只建基线不提示——与笔记侧 notesChanges 同口径。
2. **自己删的卡片也弹「其它设备删除了」**：删除会写墓碑，下一轮轮询命中自己的删除。`client.deleteSite/deleteSites` 成功后把 id 记入本设备删除集合（24h 过期自清，批删只记 items 里真删掉的），提示前过滤——自己删的不再弹，界面当时就挂着撤销提示条，再来一条「其它设备删除了」纯属误导。
3. **每次打开笔记弹「当前打开的笔记在其他设备被修改：保存时会提示冲突」**（`useNotes` 轮询）：本设备自己保存也会推 updated_at，下一轮轮询照样命中 `updated_at >= since` 窗口。现在 reload 前快照本设备已知 rev（revById，保存成功时回填的就是服务端新 rev），reload 后比对服务端 rev：相等 = 本设备已同步的写入，不算外部变更；只有 rev 真的变了的才进 `lastSyncChangedIds`、才弹「其他设备的笔记更新已同步到列表」。真正的外部变更照常提示，保存冲突守卫（409）不变。
4. **右键笔记菜单关闭后残留白色圆圈**（列表行 ⋯ 按钮）：菜单关闭时 MUI Modal 会把焦点**还原**给打开前的元素（之前点过 ⋯ 按钮就是它），行内 `:focus-within` 命中 → 22×22 的圆形按钮常显成一颗白点。显隐规则改用 `:has(.note-row-actions:focus-visible)`：程序化还原不匹配（最后交互是指针）、键盘 Tab 进按钮仍匹配（可达性不丢）；右键 handler 同步把行内活动焦点一并摘掉（之前点过 ⋯ 再右键时光 blur 行容器摘不掉按钮上的焦点）；左栏 rail 行右键补齐同款焦点摘除。

另：网站设置「版本与升级」的当前版本改为**只显示语义版本**（`v3.5.0`），`+短哈希/构建号`收进悬浮提示——与右下角徽标同口径。

守卫：`tests/siteSync.test.ts`（游标与删除记录 5 例）、`tests/siteSyncHook.dom.test.tsx`（挂闸逐轮驱动：首轮静默/游标持久化/本设备删除过滤 3 例）、`tests/useNotesSyncFilter.dom.test.tsx`（rev 比对：首轮建基线/自己保存不弹/外部变更照常弹/游标推进 4 例）、`tests/syncNotifyGuard.test.ts`（静态守卫 5 例，剥注释 + 反向验证）、`tests/versionUpgrade.dom.test.tsx` 更新 1 例（语义版本 + title 完整版）。

---

## 2026-10-18（日）· 修复+新增：分享口令框挡浏览器自动填充全站排查 · 移动抽屉新建文件夹 · 网站设置「版本与升级」

**1. 分享口令框不再被浏览器自动带入密码（全站排查 + 守卫）。** 「分享分组口令」输入框会被浏览器 formless 自动填充把保存的站点密码带进来——`autocomplete='off'` 对 password 类字段是规范级无效的，有效的是 `autoComplete='new-password'`。修复四处：`GroupShareDialog` 两处口令框、`PublicGroupPage`、`PublicNotePage` 公开口令框，以及 `NotesSettingsDialog` 恢复备份口令框（off → new-password）。全站排查结论：站点密码/备份相关字段本就走 secretInput 方案（type=text + CSS 遮蔽），无同类问题；登录表单刻意保留 `username/current-password` 语义让密码管理器正常工作。新增全站守卫 `tests/passwordFieldGuard.test.ts`：递归扫 `src/**/*.tsx`，每个裸 `type='password'` 必须就近带 `autoComplete='new-password' | 'current-password'`（LoginForm 白名单），含反向验证。

**2. 「移动到文件夹」抽屉支持新建文件夹。** 右键笔记 → 移动到文件夹的侧栏底部新增「新建文件夹」：搜索无命中时提示可就地新建（搜索词自动带入当初始名）；创建成功自动选中并把笔记移入新文件夹、关闭抽屉；失败（如重名）时抽屉不关、错误可见、笔记不动。入口是新增的 `onCreateFolder` 可选 prop，不传不显示（其它调用方零影响）。焦点管理用 ref + useEffect 手动聚焦（autoFocus 与 MUI Modal 焦点陷阱在 jsdom 下行为不稳）。守卫：`tests/notes.dom.test.tsx` 新增 2 例（创建后自动移入并关抽屉 / 失败时不动且错误可见）。

**3. 网站设置新增「版本与升级」一节。** 显示当前运行版本（与右下角徽标同源，`v{semver}+短哈希`），提供「检查更新」按钮：从 GitHub raw 取仓库 main 分支 package.json 比对语义版本（raw 域名 CORS 友好、不吃 api.github.com 匿名配额；本站 CSP `connect-src 'self' https:` 放行），发现新版本时给出两种部署形态的升级指引（Docker：`docker pull ghcr.io/zwjttztt/navihive:latest` 后重建容器；Workers：推送 main 自动构建）+ 发版页链接；拉不到或版本号解析失败落成可见错误文案，失败后可重试。自包含组件 `VersionUpgradeSection`（不碰本站 API、无必填 props），Docker 构建号兜底（无 `X.Y.Z` 三段）时不瞎比、直接引导去发版页。守卫：`tests/versionUpgrade.dom.test.tsx` 8 例（parseSemver 边界 / raw 域名 / 5xx 与缺版本号抛错 / 发现新版含双形态指引 / 已是最新 / 失败可重试）。

---

## 2026-10-18（日）· 工程：分享链路补充面 E2E 进 CI（46 断言）+ 公开页 UI 实测 + 回收站节流守卫

**分享链路从未被浏览器级实测的欠账补上了。** 原有 `e2e:share`（workerd）只覆盖「创建 → 401 needPassword → 口令错/对 → 撤销后 404」主干；本次新增 `script/share-e2e-extra.mjs`，跑在**自托管 server/**（Node + SQLite，与 home 部署形态同构）上，补三块没人测过的面（46 断言全绿）：

- **浏览次数防刷**：同浏览器当天重复访问不重复计数（cookie 当日戳），新访客正常 +1；笔记与分组两条链路都验；
- **附件公开取图**：无口令分享的图匿名可取（`?share=` 可省）；受口令分享的图必须先验对口令拿到 `nh_share_<token>` 会话 cookie 且**必须带 `?share=<token>`**（有会话不带 share、指错分享、无会话一律 404，不区分「没分享」与「没权限」）；
- **分组分享口令流程与脱敏**：`need-password` 走 200 + `status` 字段（与笔记分享的 401 形状不同，公开页按此分支）；口令对后 sites 只回 `name/url/description/icon` 四字段，站点账号密码绝不出门；PUT 清除口令后匿名直读 ok。
- 边界：PUT 改口令 token 不变、旧口令立即失效；撤销后公开读取 404 / `not-found`；非法 token 形状。

CI 新增步骤「分享补充面端到端」（`npm run e2e:share-extra`，自建 server 一次性实例 + 临时库，跑完即焚）。另有浏览器级 UI 实测（本地 CDP，9 项全过）：`/s/<token>`、`/sg/<token>` 渲染、口令框错口令不解锁/对口令出内容、撤销后提示不存在，与 API 层结论互相印证。

**回收站节流勘误 + 守卫**：待办「回收站节流（刻意未动）」实际已在 2026-10-13 性能批次落地（列表 `LIMIT 200`、过期清理按保留期参数化、cron 链路在跑）——本次核对确认后补 `tests/recycleThrottleGuard.test.ts` 4 例守卫（剥注释 + 反向验证），防止重构时被静默删掉。

---

## 2026-10-18（日）· 修复：超长分组名把头部撑出视口，「整个分组不能编辑」

用一长串连续字符（如 XXXX…）当分组名时，`GroupCard` 头部标题不可断行（flex 子项默认 `min-width:auto` 拒绝收缩），整条头部连同右侧「编辑 / 分享」工具条一起被挤出视口——分组工具永远点不到，表现为「整个分组不能编辑」。

修复：
- 标题 `Typography` 加 `wordBreak: break-all` + `overflowWrap: anywhere` + `minWidth: 0`，超长名在标题处断行；
- 标题外层容器加 `minWidth: 0` + `flex: 1 1 auto`，允许被压缩，右侧工具条不再被推出视口；
- `EditGroupDialog` 删除确认里的分组名同样断行（长名不再撑破弹窗）。
后端本就 `slice(0, 80)` 封顶，纯前端渲染问题。守卫：`tests/groupCardLongName.test.ts` 静态扫源码 4 例（剥注释 + 反向验证）。

---

## 2026-10-18（日）· 修复：筛选空态误导 + 只看失效计数自洽 + 所有者不显示停用倒计时

1. **筛选空态不再谎报「还没有任何分组」**（`SiteListEmptyState`）：以前空态文案只看搜索关键词——开着「只看星标 / 只看失效」筛到 0 时，界面显示「还没有任何分组 / 点击左上角新增分组」，让人以为分组丢了。现在空态三分：搜索没命中 / **筛选没命中（新文案「没有符合筛选条件的网站」）** / 真的还没建分组。
2. **「只看失效 N」与筛选结果自洽**（`useSiteSearch`）：`deadCount` 原来按 `deadLinks` 的键数计，探测结果里留着已删除 / 已改址站点的陈旧条目时，会出现「只看失效 1」点进去却筛出 0 的矛盾。改为按「当前站点里被标失效的数量」计，与筛选完全同一判据（`normalizeKey(url)` 查表）。
3. **账号与沉睡治理：站点所有者不再显示「约 N 天后停用」**（`AccountDialog`）：owner 不参与沉睡治理（v3.1.0 定稿），行上历史残留的 `willDisableAt` 不再外显；普通账号照常显示。

另附排查结论：某环境「只看星标」筛出 0 属数据态（服务端 `pref.starred=[]`，迁移换域名后本地星标不随行、服务端名单为空），筛选功能本身无缺陷；重新点星标即可（`pref.sync` 开启会自动同步）。守卫：siteSearch/siteListBody/accountDialog 三处 DOM 用例各 +1。

---

## 2026-10-18（日）· 修复：myhp 全站 500（1101）——withSecurityHeaders 改 immutable headers 响应

v3.2.7 经 Workers Builds 于当日 01:45 UTC 自动部署 myhp 后**全站 500**（`/`、`/s/<token>`、`/assets/*`、`/favicon.ico` 全中，API 路径正常）——Workers Observability 里真实异常：

```
TypeError: Can't modify immutable headers.
    at withSecurityHeaders (index.js:8532)
    at Object.fetch (index.js:11913)
```

根因：Workers 运行时里 `env.ASSETS.fetch()` 返回的 Response **headers 是 immutable 的**，而 `worker/index.ts` 的 fetch 出口统一包 `withSecurityHeaders(...)`，`headers.set()` 直接抛 TypeError → 平台级 1101。API 分支的响应是 Worker 自己 `new Response()`（可变）所以幸免；**本地单测 mock 的 ASSETS 也返回可变 Response，真机语义从未被测到**；自托管（home）不经 ASSETS 绑定所以正常——这就是门禁全绿但真机全炸的原因。

修复（`worker/httpUtils.ts`）：`withSecurityHeaders` 先 `new Response(response.body, response)` 重建一份**可变副本**再补安全头——对普通 Response 无害（幂等透传 status/headers/body），对 immutable 救命。`tests/workerSpaFallback.test.ts` 的 ASSETS mock 改为模拟真机 immutable 语义（set/append/delete 抛 TypeError），并新增守卫用例：immutable 响应不炸、安全头补齐、body 原样透传。

门禁（tsc -b --force / lint / 单测 / build / smoke / 双审计）全绿。教训：**mock 必须模拟真机运行时语义**（immutable headers、可变/不可变边界），而不是「恰好能编译的最小桩」。

---

## 2026-10-18（日）· 修复：myhp 分享页 1101 / 真实静态资源 MIME 不符（扩展名路由 + /index.html 回退）

v3.2.4/3.2.5 给 `assets` 显式 `binding: "ASSETS"` + `run_worker_first: true`，但 v3.2.6 在非 API 分支对**所有** GET/HEAD 一律取 `/index.html` 转发——在 `run_worker_first` 下，真实静态资源（如 `/assets/xxx.js`）也被改写成整页 HTML 回吐，浏览器按脚本加载却拿到 `text/html` → MIME 不符白屏；同时 SPA 路由（无扩展名 `/s/<token>`）转发「原始路径」会在 Cloudflare 触发 SPA 回退再入保护、抛平台级 **1101**（Worker 未处理异常→500），非导航客户端仍 404。

修复（`worker/index.ts` 非 API 分支改扩展名路由）：
- 真实静态资产（路径带扩展名，`/\.[a-z0-9]{1,8}$/i`，与 `server/static.ts` 的 `ASSET_EXT_RE` 一致）→ 原样转发 `assets.fetch(request)`，资产层直出，不触发回退/再入；
- SPA 路由（无扩展名）→ 显式取确定存在的入口 `/index.html` 转发，由资产层直接吐出、规避 1101；SPA 靠 `window.location` 自行路由、路径无关，故非导航 `/s/<token>`、`/sg/<token>` 在非浏览器客户端也 200，与 home 一致；
- 非 GET/HEAD 非 API（如 `POST /`）→ Worker 直接 404，与自托管 `server/entry.ts` 对齐。
`wrangler.jsonc` 维持 `run_worker_first: true`。`tests/workerSpaFallback.test.ts` 7 例改为断言 SPA 路由取 `/index.html`、真实资产原样转发、POST / 回 404、非法/空 JSON 回 400。

门禁（tsc -b --force / lint / 单测 2781 / build / smoke / 双审计）全绿。复测对照：非导航 `/s/<token>`=200、导航=200、真实 `/assets/*` 不串 HTML、非法 JSON=400、`POST /`=404，两环境行为一致。

---

## 2026-10-18（日）· 修复：myhp 分享页仍 404 / POST / 仍 405（ASSETS 绑定 + run_worker_first）

v3.2.4/3.2.5 把 Worker 非 API 分支改成转发 `env.ASSETS` 做 SPA 回退，但部署后实测
myhp 上 `/s/<token>` 非导航请求**仍 404**、`POST /` **仍 405**——单测因为 mock 了
`env.ASSETS` 没暴露这个缺口。根因两点：

1. `wrangler.jsonc` 的 `assets` 没显式写 `binding`，生产 `env.ASSETS` 实际未绑定，
   非 API 分支的 `if (assets && …)` 恒为 false → 直接走 404；
2. `run_worker_first` 默认 false：资产层先接管，`POST /` 命中 `index.html` 被当成
   静态资源回 **405**、非导航的 `/s/<token>` 被资产层按 404 打回后 Worker 又没有
   ASSETS 可转发，于是两处都修不上。

修复：`assets` 显式 `binding: "ASSETS"` + `run_worker_first: true`，让**所有请求先进
Worker** 统一路由——非 API 的 GET/HEAD 全部转发 `env.ASSETS.fetch()` 做 SPA 回退，
`POST /` 等非 GET/HEAD 非 API 路径回 404。`worker/index.ts` 相应去掉「带扩展名不转发」
的守卫（run_worker_first 下静态资源 GET/HEAD 都进 Worker 再转发，资产层对带扩展名未命中
按 not_found_handling 回 404，MIME 不符白屏由资产层兜底，无需 Worker 侧再判）。
复测 myhp：非导航 `/s/<token>` 与导航请求均 200、非法 JSON 400、`POST /` 404，与 home 一致。

---

## 2026-10-18（日）· 工程：修正 workerSpaFallback 单测类型错误（阻断 tsc -b 与 CI verify）

`tests/workerSpaFallback.test.ts` 初版用 `delegated!.method` 断言 Worker 转发给 ASSETS 的
请求，`assert.ok` 配合闭包里的 `delegated = req` 让 TypeScript 把 `delegated` 收窄成
`never`，`tsc -b` 直接报 `Property 'method' does not exist on type 'never'`——
既挡住 `npm run build`（myhp 手动部署走这条），也导致 `docker-publish.yml` 的 `verify`
阶段类型检查失败、home 的镜像因此没发出来。改成在闭包里直接记录 `method` / `url` 字符串
再断言，消除收窄歧义；`tsc -b --force` 与全部门禁（lint / test / build / smoke / 双审计）
重新全绿。版本随之 bump 到 v3.2.5。

---

## 2026-10-18（日）· 修复：分享页 404 真正根因 + 非法 JSON 回 400（续两环境对照测试）

**背景**：上一节把 myhp 误判成 Pages 形态、又用违法的 `_redirects` 把 Workers 部署卡死，
分享页 404 其实一直没修。撤回 `_redirects` 恢复部署后，重新定位根因：

myhp 是 **Workers Builds**，`worker/index.ts` 的 `fetch` 对非 `/api/` 路径**一律返回 404**。
Cloudflare Workers + Assets 在 `compatibility_date >= 2025-04-01` 下启用
`assets_navigation_prefers_asset_serving`：浏览器「导航请求」（带 `Sec-Fetch-Mode: navigate`）
由资产层直接回 `index.html`、不进 Worker —— 所以**真人点开分享链接其实能正常显示**；
但 `fetch` / `curl` / 爬虫 / 探针这类「非导航请求」会进 Worker，被那句 404 拦死，
表现为 `/s/<token>`、`/sg/<token>` 在非浏览器客户端一律 404（与 home 的 200 不一致）。

**修复**：`worker/index.ts` 非 `/api/` 分支改为——对「无扩展名」的 GET/HEAD 请求转发给
`env.ASSETS.fetch()`，由 `assets.not_found_handling=single-page-application` 回退到 `index.html`；
「带扩展名」的未命中静态路径（旧 chunk / 误拼的 `.js`）与 POST / 等非 GET/HEAD 路径保持 404。
逻辑对齐 `server/static.ts` 的 `looksLikeAsset`：带扩展名的未命中绝不能回 HTML（否则 MIME 不符、
模块脚本被拒、发版白屏）。自托管没有 `ASSETS` 绑定，且 `server/entry.ts` 已先用 `serveStatic`
兜住 GET/HEAD 非 API 路径，所以 Worker 侧分支对自托管无副作用。

顺带修了两处同批次发现的接口问题：
- 请求体非法 / 空 JSON 时 `request.json()` 抛 `SyntaxError`，原本漏到顶层 catch 变 500；
  统一改成回 **400 bad_request**（覆盖所有写接口，不再逐个包 try/catch）。
- `POST /` 在两环境响应码不一致（404 vs 405）：修完 `env.ASSETS` 分支后，非导航的 `POST /`
  走 404 分支，两环境一致回 **404**。

**守卫**：`tests/workerSpaFallback.test.ts` 7 例——无扩展名 GET 转发 ASSETS 且 URL 透传、
根路径走回退、带扩展名未命中不转发且 404、POST / 不转发且 404、无 ASSETS 绑定时回 404、
非法 JSON 与空 body 均回 400（非 500）。全量 2774 单测 + tsc -b --force + lint + build +
smoke + 双审计全绿；两环境对照 e2e 复测 `/s/` 两环境均 200、非法 JSON 均 400。

---

## 2026-10-18（日）· 修复：公开分享页在 Cloudflare(Pages) 形态下 404（两环境首次对照测试发现）

**背景**：对 <your-host>（VPS 自托管 / SQLite）与 <cf-host>（Cloudflare / D1）
做逐项对照测试时发现：**home 上 `/s/<token>` 与 `/sg/<token>` 回 index.html（200），myhp 上一律 404**。
进一步探明 myhp 是 **Pages 形态的静态托管**——它不读 wrangler.jsonc 的
`assets.not_found_handling`（那是 Workers 的配置），且所有无扩展名路径（` /random-no-ext-xyz`
等）都 404、`/index.html` 被 307 到 `/`，均是 Pages 缺 `_redirects` 的典型表现。
后果是**别人点开分享链接直接 404**，而自己从首页进站点一切正常，所以极难被发现。

**⚠️ 上述"Pages 形态"的判断是错的，对应的修复已撤回。** 我据「无扩展名路径 404、
`/index.html` 被 307」判定为 Pages，于是加了 `public/_redirects`（`/s/*`、`/sg/*` →
`/index.html 200`）。结果 Workers Builds 直接拒绝部署，构建日志给出：

    Invalid _redirects configuration:
      Line 15/16: Infinite loop detected in this rule.  [code: 100324]

—— Workers 静态资产会把 `/index.html` 的 `.html` / `/index` 剥掉后再次触发同一规则，
构成死循环。更根本的是**这个文件本就多余**：myhp 实际是 **Workers Builds**（日志里是
`npx wrangler deploy` + `dist/cloudflare_navihive1/wrangler.json` + D1 绑定 `navigation-db`），
而那份生成的配置里**一直有** `"not_found_handling": "single-page-application"`（自 2025-04 起）。
推论随之修正：**myhp 一直在随推送自动部署；v3.2.1 之后之所以"没更新"，是被这个非法文件卡死。**
处置：删除 `public/_redirects` 先恢复部署通道；分享页 404 另案排查，不再靠 _redirects 兜。

（同批次测试还确认了两处待修行为：非法/空 JSON body 返回 500 而非 400；
`POST /` 在两环境的响应码不一致 404 vs 405。）

---

## 2026-10-17（日）· 修正：复活站点所有者的沉睡治理可见性与阈值配置（v3.1.0 误读续）

**背景**：v3.1.0 把「沉睡治理界面只对所有者不开放」理解成了「owner 完全看不到治理」。
用户澄清：**站点所有者应当看得到其它账号的沉睡状态（只读）、并能在网站设置里配置停用 /
清除阈值**；只是 owner 自己永不参与治理，也不能在账号弹窗里改阈值（改阈值入口统一在
「网站设置 → 数据保留」）。本条目把这部分救回来（与 v3.1.0「注销账号仅对普通账号开放」
的口径互不冲突，是正交的两件事）：

1. **账号弹窗恢复「账号与沉睡治理」一节（仅 owner 可见）**：AccountDialog 加回账号清单
   （按 willDisableAt / willDeleteAt 倒计时，停用账号临清 7 天内显红、否则黄）、已停用账号
   的「重新启用」按钮（调 `POST /api/users/{id}/status {status:"active"}`，服务端顺带刷新
   活跃时间）、只读的阈值展示（多久没登录就停用 / 停用后保留多久再清除），以及「立即扫描」
   按钮（调 `POST /api/users/sweep`，回显「停用 N 个、清除 M 个」）。
   普通账号依旧看不到这一节——App 只在 `role === "owner"` 时传 `accounts`。
   数据来自 useAccountSession 的 `fetchAccountList / handleExemptUser / handleSweepInactive`，
   其中 `fetchAccountList` 内部按角色拦截，普通账号不发 `/api/users` 请求。
2. **网站设置恢复两个沉睡阈值输入框**：SettingsDialog 加回 `inactive-disable-days` /
   `inactive-grace-days`，仅 owner 可编辑（非 owner 的框 `disabled`），与「数据保留」阈值入口一致。
3. **纯函数回归**：authFlow.ts 加回 `resolveInactivePolicy`（读不到阈值回落服务端默认）/
   `readSweepResult`（4xx/5xx 响应体里带 `success:true` 也不算成功，避免假绿）。
4. **命令面板开账号管理时一并拉治理清单**：useAppCommands 的「打开账号管理」额外调
   `fetchAccountList`（owner 才真正发请求）。

守卫：accountDialog 3 例（非 owner 看不到 / owner 清单只给停用账号「重新启用」/ 阈值只读且在此不改）、
accountSession 4 例（扫描成功报条数 / 500 带 success 仍失败 / 重新启用失败转述原因 / 清单仅 owner 拉得到）、
appCommands 补 Harness 的 `fetchAccountList`；全量 2774 单测 + `tsc -b --force` + lint + build + smoke + 双审计全绿。

---

## 2026-10-17（日）· 修正：两个功能改为「仅对站点所有者不开放」（用户澄清需求）

**背景**：v3.0.0 把「不活跃停用」和「注销当前账号」按「整体关闭」实现（入口全删 + cron 停扫）。
用户当天澄清：**不是要关掉功能，只是站点所有者本人不能用**——普通账号照样能注销、
照样被沉睡治理。本次按正确口径改正：

1. **「注销当前账号」恢复，按角色门控**：DeleteAccountDialog 组件、App 接线、
   useAccountSession 的注销状态/处理器、dialogChunks 预取入口全部恢复；入口只在
   `role !== "owner"` 时传给 AccountDialog（所有者的「账号与安全」里没有这一节，
   并有一行说明为什么）。**后端同步兜底**：`deleteAccount` 对 owner 一律拒绝
   （原来只挡「最后一个 owner」，多 owner 时能删）—— 只藏入口的话，脚本照样能调
   API 把站点唯一的管理者删掉。随之删除只剩这一个调用方的 `countOwners`。
2. **沉睡治理 cron 恢复**：`runInactiveSweep` 任务块、`CRON_TASK_TIMEOUT_MS.inactiveSweep`
   加回，普通账号继续被自动停用/清除（后端 `sweepInactiveUsers` 本就 `role != 'owner'`，
   所有者永不被治理这一点无需改动）。所有者的治理界面（账号清单 / 手动扫描 /
   阈值配置）保持不开放——它本来就是 owner-only 的界面，对所有者不开放即等同下线。
   （注：同日后续条目修正了这半句——站点所有者恢复**可见**沉睡治理清单与阈值配置，只是仍不能在本节改阈值、自己也不参与治理。）
3. **README 第 7/8 项重写**为角色边界口径。

---

## 2026-10-17（日）· 五项修改：设备去重根治 + 两项功能关闭 + 三处体验调整（用户反馈）

1. **登录设备重复问题根治（v2.0.0 修复的回归）**：上一轮按「UA + IP」判重被两种漂移
   绕过 —— Chrome 大版本升级 UA 就变（141 → 142）、家庭宽带 IPv4/IPv6 双栈与重拨
   让同一台设备记到不同 IP，两种撞任何一个，列表里就多出一行看着一模一样的
   「Chrome · Windows」。判据改为**归一化设备键**（`deviceKeyOf`：浏览器家族 + 系统
   家族，版本号与 IP 一概不计）：登录时同设备旧会话直接拉黑 + 删行，列表再按设备键
   折叠自愈（当前会话永不折叠，陈行比当前行新也吃不到它）。顺带修了 `clientIp`：
   X-Forwarded-For 是链式头，以前整条存库会把设备 IP 显示成「1.2.3.4, 5.6.7.8」。
   已知取舍：同一台电脑上的 Chrome 稳定版与 Canary 共用一把键，后登录的会顶掉先登录的 ——
   对「一台设备一个活跃会话」的定位这是期望行为。
2. **「不活跃停用」与「注销当前账号」按站点所有者要求整体关闭**：入口全删
   （「账号与安全」里的「账号与沉睡治理」与「注销账号」两节、「网站设置 → 数据保留」
   里的两个沉睡阈值输入框），DeleteAccountDialog 组件、dialogChunks 预取入口、
   每小时定时任务里的沉睡扫描（`runInactiveSweep`）一并移除 —— 只删界面不删 cron
   的话，功能只是「看不见了」而不是「关了」。服务端接口保留但无任何可达路径
   （账号体系与登录 403 拦截依赖它们，恢复那天把任务块加回来即可）。
3. **卡片右下角操作条去掉「复制链接」**：点卡片本身就是打开链接，这个按钮最赘余，
   去掉后右下角只剩「复制账号 / 复制密码」（右键菜单里的复制项不动，那是另一个入口）。
   同日补丁（v3.0.1）：没存账号也没存密码的卡片，悬停时不再渲染一个空的玻璃条
   （复制链接曾是「永远非空」的那一个，移除后补了内容守卫）。
   冒烟种子卡补上凭据（v3.0.2）：CI 冒烟量的正是「快捷条悬停显隐 / 触屏常显」，
   无凭据卡整条不渲染后量到 null 会假红 —— 种子带凭据才能测到真实行为。
4. **排序模式的「保存 / 取消编辑」移到页面右侧、滚动固定跟随**：排序是「边走边看」的
   动作，按钮留在顶栏滚两屏就得滚回顶部才能保存。改成右缘居中的 fixed 竖排小工具条
   （玻璃底，压得住多色多图的列表；`data-sort-dock` 便于测试与检索），
   顶栏在排序模式下不再占位。
5. **记事本标签右键菜单的「删除文件夹」改为「删除标签」**：该菜单组件被文件夹 / 标签
   两节共用，删除项文案以前写死；新增 `removeLabel` prop 按节区分（文件夹节默认不变）。

---

## 2026-10-17（日）· 修复：六项体验问题批量处理（用户反馈）

1. **统计不再包含已删除的网站**：访问统计的汇总/热力图/Top 榜按当前站点清单过滤
   （此前删站后 localStorage 访问记录残留，Top 榜一直挂着「已删除的网站 #N」）；
   运营看板的服务端计数本就是硬删后统计，无需改。
2. **高频动作名称改中文**：动作名映射抽成共享模块 `auditActionLabels.ts`，
   审计流水与运营看板共用；补齐 `note.delete`/`group.delete`/`logout` 等，
   并兼容历史下划线变体（`login_success`/`data.import` 等老数据仍躺在审计表里）。
3. **「分组排序」挪进显示面板的排序区**：排序类操作归拢一处，「更多选项」菜单
   变 9 项；菜单结构守卫同步更新。
4. **修复登录设备列表重复**：同设备重登时自动拉黑并删掉同（UA+IP）的旧会话；
   列表按设备折叠、遗留重复行自愈清理（当前会话永不折叠）。
5. **导航回收站与记事本回收站分家**：`/api/recycle` 支持 `?kind=nav|note`，
   列表与**清空**都按类隔离 —— 此前记事本里「清空回收站」会把导航站待恢复的
   卡片/分组一起抹掉。导航站回收站只管站点/分组，笔记删除归记事本自己的回收站。
6. **精简笔记右键菜单**（14 项 → 8 项 + 子菜单）：去掉复制标题/复制 ID/复制直链/
   创建副本四个低频项；导出 Markdown/HTML/PDF 收进「导出…」二级菜单；
   保留侧边打开/置顶/收藏/归档/移动到文件夹/编辑标签/移到回收站。

---

## 2026-10-17（日）· 性能：记事本列表 SWR 缓存 —— 第二次打开秒开

**要点**：记事本是「关掉即卸载」的，此前每次点开都要等列表请求回来（慢链路 1 个
RTT）才显示内容。现在把最近一次的真实列表（笔记/文件夹/标签/标签关联 + 摘要档位）
镜像进模块级缓存（按账号分桶、只在内存）：第二次打开**第一帧就用缓存渲染**，
挂载后的 reload 照常在后台校准、新数据静默替换 —— 语义仍是「每次都向服务端对表」，
只是不再让用户干等。校准失败（断网）时保留缓存列表、不弹「加载失败」（有数据可见
时吓人没意义）；无缓存的首次打开失败仍弹错误，空态绝不写缓存。守卫
`tests/useNotesSwr.dom.test.tsx`（4 用例：秒显+校准照发 / 失败保列表 / 旧行为 /
账号隔离）。导航页首开不受任何影响（缓存只在打开记事本后才有内容）。

---

## 2026-10-17（日）· 性能：第二轮懒加载排查 —— 小件补预取

**要点**：全站懒加载盘点（对照三层预取覆盖面）发现一批「块本体 1~10 KB、但首次
触发要现场等 1 个 RTT」的小件：删除二次确认（ConfirmDialog）、首个操作提示条
（SnackbarHost）、批量操作条（BulkActionBar）、AI 建议弹窗、注销账号弹窗、标签栏
（TagBar）、列表骨架屏（SiteListSkeleton）。慢链路上的表现就是「点了删除没反应/
操作成功了提示条不出来」。全部补进登录后的空闲预取清单（18 → 25 块），首次触发
0 请求。**不做转静态**：这三件若转静态合计 +~12 KB 及其 MUI 依赖，会击穿首屏预算
的 5% 余量红线（852.4 KB 基线 / 900 KB 预算 / 余量 ≥5% 守卫）；idle 预取在登录后
数秒内完成，稳赢绝大多数首次触发。

- **维持 lazy 不动（去除会伤首屏或本就按需）**：note-editor（564 KB）/ markdown
  （108 KB）/ mermaid 全家桶（elk 1.4 MB + cytoscape 434 KB + 各图型，仅笔记真含
  图时才经沙箱 iframe 下载）/ katex（518 KB，仅含公式时）/ NotesOverlay（299 KB，
  已悬停预取入口）/ LoginForm（访客态已有预 import）/ 分享公开页路由。

---

## 2026-10-17（日）· 修复：去除弹窗加载转圈（用户反馈）

**要点**：预取落地后正常路径首开已是 0 请求，`ChunkBoundary` 的 LazyFallback 转圈
只在网络抖动时闪现，但用户不希望看到任何转圈。按反馈去除：fallback 回退为
`null`，删除 `LazyFallback` 组件与其守卫用例；三层预取保持不变（首开延迟修复
不受影响）。极端弱网下点开弹窗宁可短暂空窗，也不显示加载指示。

---

## 2026-10-17（日）· 修复：弹窗/菜单首次点击反馈延迟 —— 三层预取 + 加载反馈

**要点**：用户报告「卡片设置-更多选项里各按键首次点击后反馈延迟很久、关闭后再次打开
才恢复正常」。根因实锤：全部弹窗/菜单都是「条件挂载 + lazy」（`ChunkBoundary when=`、
`menuOpen ? <Suspense fallback={null}><MoreMenu/> : null`），首次点击要**现场下载**
弹窗块 + MUI 依赖块（1 跳并行瀑布），且 fallback 为 null —— 弱网下表现就是
「点了没反应」；第二次打开命中模块缓存瞬时恢复。真实 Chrome + CDP 弱网模拟
（300ms RTT / 1.5Mbps）实测：更多选项首开 394ms / 3 请求，统计首开 602ms / 6 请求，
二开 10ms / 0 请求；用户真实链路每请求 1~3 秒 → 数秒空窗零反馈。

修复（三层预取，把「点击时下载」提前到「点击前」）：

- **悬停预取**（`HeaderActions.tsx` / `SiteCard.tsx`）：「新增」「更多选项」「⚙ 设置」
  按钮 `onPointerEnter` / `onFocus` 即预取目标块 —— 手移到按钮的几百毫秒足够下载完成。
- **展开预取**（`MoreMenu.tsx` / `SiteCard.tsx`）：菜单/右键菜单 mount 时并行预取全部
  目标弹窗块（设置/统计/备份/回收站/审计/AI/账号/快捷键/编辑分组），菜单本身加载的
  时间就够把子项全预热。
- **空闲预取**（`App.tsx`）：登录后 `requestIdleCallback` 错峰逐个预取 18 个常用块，
  不抢首屏带宽（idle + timeout 3s 兜底）。
- 预取入口集中在 `src/utils/dialogChunks.ts`（18 个动态 import，与各处 `lazy()` 指向
  同一模块 → 同一 chunk，不重复下载）；`src/utils/lazyPrefetch.ts` 做幂等（Set 去重、
  失败摘出允许重试）。
- **加载反馈兜底**（`LazyFallback.tsx`）：即使预取失败（如网络抖动），`ChunkBoundary`
  的 fallback 从 `null` 换成 200ms 延迟显示的纯 DOM spinner —— 不用 MUI（不抬首屏）、
  `pointer-events:none`（不挡点击）、只在真等待超过 200ms 才出现，避免闪烁。

验证：修复后同条件弱网探针 —— 全部弹窗/菜单**首开 0 网络请求、9~337ms**（残余为
MUI 开启动画）；守卫 `tests/lazyPrefetch.dom.test.tsx`（9 用例：幂等/失败重试/idle
调度/LazyFallback 时序，加上静态守卫钉住 ChunkBoundary fallback、App 预取清单、
HeaderActions/MoreMenu/SiteCard 三处预取挂点、dialogChunks 无静态 import），
反向验证（删掉预取挂点）守卫可红。

- **工程**：`docker-publish.yml` 补 arm64 —— QEMU + `platforms: linux/amd64,linux/arm64`，
  GHCR 镜像从此双架构（ARM VPS 部署从「本地构建」退化为 `docker pull`）。

---

## 2026-10-17（日）· 性能：全站性能排查落地 —— 笔记首拉摘要阀门提前生效 / 首屏 preload 拆分

**要点**：全站性能排查（34 个 API 端点计时 + SQLite EXPLAIN + 前端产物盘点）确认两处
真瓶颈并全部落地。① 数据库侧：`listNotes` 的真实排序是 `ORDER BY pinned DESC, order_num, id`，
旧索引差 `id` 一列，万条级每次列表都要 `USE TEMP B-TREE FOR ORDER BY`（EXPLAIN 实测），
补 `idx_notes_user_order` 复合索引（SCHEMA_VERSION 21→22，首次打开自动迁移）。
② 前端侧：`index.html` 此前 modulepreload 整个 417KB 的 mui-lazy 大块（内含大量弹窗
专用组件，Button/Typography 这类首屏组件被 rolldown 未定型的 importers 图误判进去了），
现在改为在**配置期从 main.tsx 沿静态 import 源码扫描**出「首屏真正会执行的 @mui/material
文件闭包」，归并成单一 mui-core 块（328KB）—— 首屏关键路径 **945.7 → 852.4 KB（-10%）**、
请求数保持 6 个，弹窗专用 MUI（Slider/Modal/Popover…）只被动态 import，不再出现在
preload 列表里。③ 笔记首拉：原来「首屏永远拉全文、下一轮才切摘要」，万条级首拉白拖
几 MB；现在先探 `notes/count`（实测 ~1ms），超过 200 条首拉就带 `?fields=list` 走摘要，
老部署没有 count 端点时优雅退回旧行为。

- **P1-1 列表排序覆盖索引**（`src/API/methods/internals.ts` / `migration.ts`）：
  `CREATE INDEX IF NOT EXISTS idx_notes_user_order ON notes(user_id, pinned, order_num, id)`。
  EXPLAIN 实测：加索引前多账号路径 `USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY`，
  之后消失。⚠️ 排查时曾把排序误判成 `updated_at DESC`，回查 `notes.ts` 真实 SQL 后修正
  —— 性能结论必须回查代码。守卫 `tests/noteSql.test.ts`：索引语句与版本号缺一即红。
- **P2-2 首屏 preload 拆分**（`vite.config.ts` / `tests/precacheManifest.test.ts` /
  `tests/bundleBudget.test.ts`）：
  - 废弃「沿 rolldown importers 上溯判首屏」的启发式 —— manualChunks 回调期 importers
    混着动态导入边（图未定型），Button 这类「首屏 + 弹窗都用」的组件必被误判。
  - 新增 `scanFirstScreenMui()`：配置期从 `src/main.tsx` 只沿静态 import（`from` 与副作用
    import；动态 `import()` 天然不跟）走源码图，@mui/material 按文件级记录闭包（按目录段
    标会把 tree-shake 掉的兄弟文件拖进 preload，实测多背 40KB）；解析走 exports 的
    **import 条件**（`.mjs`，`.js` 是 CJS 抓不到 re-export）；barrel 转发导出
    （如 useTheme 实际在 styles/ 下）从包根 index.mjs 反查。归桶判错无害：集合外的
    首屏模块 rolldown 本来就会并进它的静态导入者。
  - mui-lazy / mui-confirm 块与 precacheManifest 的按名特判一并移除；ConfirmDialog 的
    离线可用性改由核心清单沿 imports 行走自然覆盖（双向对齐测试守着）。
  - 实测（同机 A/B）：首屏 raw 945.7 → 852.4 KB / gzip 307.5 → 280.1 KB，请求 6 → 6；
    全部 JS 7287.7 → 7293.5 KB（+0.08%，无重复打包代价）。
  - 守卫：`precacheManifest.test.ts` 新增「首屏 modulepreload 的块里没有懒加载专用组件
    标记」（MuiSlider-root / MuiModal-root / MuiPopover-root，改回强制大块必红）；
    bundleBudget 基线更新为 852.4 / 280.1，预算同步收紧到 900 / 300（余量 ≥5%）。
- **P2-1 笔记首拉先 count 再决定摘要**（`src/hooks/useNotes.ts` / `tests/notes.dom.test.tsx`）：
  `reload()` 首拉前先调可选的 `countNotes()`（只探一次，失败/缺失都标记已探），
  count > 200 直接带 `?summary` 拉摘要列表；之后仍按「上次拉到的条数」动态切档。
  守卫三条：count>200 首拉即摘要 / 无 countNotes 退回全文 / 探测 404 不炸首拉也不弹
  「加载记事本失败」。

---

## 2026-10-17（日）· 修复：从网盘恢复仍报 this.request / 笔记页版本号压住正文

**要点**：昨天那版修完 `zipBase64` 透传后，ZIP 备份终于能进「解包 → 导入」链路了；
但这条链路在 `NotesPage.tsx` 的 `importNotesFile` 里把 `importNotes` 抽成**裸引用**再调用，
`this` 丢失，真实 client 的 `importNotes` 内部 `this.request` 直接抛
`Cannot read properties of undefined (reading 'request')`。等于「漏传字段」修好了，
「调导入时丢了 this」又冒出来 —— 用户实测恢复还是报错。顺手把右下角部署版本徽标在
记事本整屏页里藏起来（之前压在正文上）。

- **从网盘恢复（ZIP）报 `this.request` 错误**（`NotesPage.tsx` 的 `importNotesFile`）：
  旧写法 `const importNotes = shareApi?.importNotes; … importNotes(payload)` 把方法从对象上
  **摘下来当独立函数调**，`this` 变 `undefined` → 真实 client 的 `importNotes` 一进
  `this.request<NoteImportStats>(...)` 就抛。JSON 备份走 `importNotes(parsed)`、Markdown
  目录 ZIP 走 `importNotes({...})`、附件 ZIP 走 `importNotes(payload)` —— 三条分支全中招
  （数据页「导入笔记」文件的 JSON / ZIP 入口同理），所以这是**通用的导入崩溃**，不只网盘恢复。
  改法：不再摘引用，直接 `shareApi.importNotes(...)`，调用时 `this` 自然绑回 api 实例。
  守卫 `tests/notes.dom.test.tsx` 新增「ZIP 恢复调 importNotes 必须保留 this」——
  `importNotes` 用方法简写、内部断言 `this === shareApi`，改回裸引用必红（已反向验证）。
- **笔记页版本号与文字重叠**（`BuildBadge.tsx` / `App.tsx` / `main.tsx`）：
  右下角部署版本徽标是 `position: fixed` 常驻，记事本是整屏覆盖，正文右下角被压住。
  把 `<BuildBadge />` 从 `main.tsx` 根部挪进 `App.tsx`，`notesOpen` 时**不渲染**；
  公开分享页仍在 `main.tsx` 渲染（方便核对分享页跑的是哪一版）。仅隐藏、不删组件。

---

## 2026-10-17（日）· 新增：笔记导入 / 恢复进度条（用户反馈「恢复太慢没提示」）

**要点**：从网盘恢复、或数据页导入带附件的 ZIP 备份，要走「解包 → 逐个回传附件 → 写入笔记」
三段，附件一多十几秒没有任何反馈，用户以为卡死。现在 `importNotesFile`（`NotesPage.tsx`）
在这三个分支里上报 `onProgress` 回调（阶段：下载备份 / 解包备份 / 上传附件 / 写入笔记），
`NotesSettingsDialog` 的「数据页导入」和「从网盘恢复」两处各挂一条 `LinearProgress`
（带 `data-import-progress` / `data-backup-progress` 属性；附件回传按 `current/total` 走
**确定**百分比，无法估算比例的阶段走**不确定**条）。恢复 / 导入完成后进度条自动消失。

- **进度回调接口**（`src/API/types.ts`）：新增 `NoteImportProgress { phase; current; total }`。
  注意：站点导入用的 `ImportProgress` 是 `{ stage; done; total }` 形状，两个接口**重名会被
  TS 合并**成必须同时满足两套字段、两边调用点全红 —— 所以笔记这边特意叫 `NoteImportProgress`，
  避免和 `BackupDialog` / `client.ts` / `useBackupController` / `transfer.ts` 那套撞名。
- **三处阶段上报**（`NotesPage.tsx` 的 `importNotesFile`）：非 zip JSON 直接「写入笔记」；
  Markdown 目录 ZIP 与 notes.json ZIP 都先「解包备份」→ 循环回传附件时逐个报「上传附件
  （已传/总数）」→ 收尾「写入笔记」。`onImportFile` 的签名加 `onProgress?` 可选参数。
- **两处 UI 进度条**（`NotesSettingsDialog.tsx`）：新增 `importProgress` / `restoreProgress`
  两个 state，分别驱动数据页导入区与网盘恢复区的 `LinearProgress`；`handleImportFile` 与
  `doRestore` 在 `finally` 里清掉进度（成功 / 失败都清，含需要口令时弹框的中途）。
- 守卫 `tests/notes.dom.test.tsx` 新增两条：数据页导入带附件 ZIP、从网盘恢复带附件 ZIP，
  都断言进度条（DOM）出现过「上传附件」阶段且完成后消失。用 **2 个附件**制造约 60ms 可视窗口——
  单附件会因「上传附件」与紧随的「写入笔记」在同一次同步 tick 里被后者覆盖、永不落 DOM，抓不到。
- **同日追加（用户实测「还是太慢、没看到进度条」）**：没看到多半是浏览器里开着的还是旧页面
  （SPA 不自动刷新，刷新即见）；「太慢」是真问题 —— 附件回传原本是**串行逐个上传**
  （N 个附件 = N 次串行 HTTP 往返），现在改成**并发 6 路**（附件互不依赖：Markdown 分支
  路径→url、notes.json 分支旧 id→新 id 都是各写各的键），附件多时提速数倍。
  另外「下载备份」阶段前端拿不到百分比（服务端从 WebDAV 整包下完才一次性返回），挂了个
  **秒表文案**（「下载备份…（N 秒）」），比一根纹丝不动的不确定条强。测试的上传桩改成
  递增延迟（60ms/120ms），并发下「上传附件」窗口依旧稳抓。
- **同日再追加（用户实测「成功提示出现后还要很久才能恢复完」，附截图）**：真根因是
  `onDatasetChanged` 原实现**只 postMessage 广播给其它标签页**，当前标签页自己根本不重拉，
  要等「跨设备变更轮询」的下个周期（几十秒）列表才更新 —— 于是成功提示先弹、内容后到。
  现在 `NotesOverlay` 传下去的是「广播 + `await reload()`」：导入/恢复完成后**当前页立刻重拉**，
  成功提示推迟到列表真正刷新完才弹（提示弹出 = 内容已可见），进度条相应多出一个
  「刷新列表」阶段（`onDatasetChanged` 类型放宽为可返回 Promise，`onImportNotes` 加可选
  onProgress 参数）。数据页 JSON 直导 / 网盘恢复旧格式同样受益。恢复成功文案改为
  「已从网盘恢复「xx」，列表已刷新」，不再有误导的「请留意后续提示」。
  守卫新增时序用例：假重拉 120ms，断言「刷新列表」阶段出现且提示时刻 ≥ 重拉完成时刻
  （改回「提示先弹」必红）。

---

## 2026-10-16（六）· 修复：AI 弹窗反复闪加载条 / 笔记网盘恢复失败（用户实测反馈）

**要点**：用户在新部署的 https://<your-host> 上实测反馈的两条，都不是「看着别扭」，
而是真的影响使用：一个把背景页面的一次滚动放大成上百次配置请求，一个让备份只能出不进。

- **AI 助手弹窗滚动到底/顶会冒加载条**（`App.tsx` / `AiAssistantDialog.tsx`）：
  链路是三件事叠在一起 —— ① 弹窗不锁背景滚动（`MuiDialog` 默认 `disableScrollLock: true`），
  内容滚到两头时滚动链穿透到背景页面；② 背景一滚 App 就重渲染（`useViewportUi` 更新当前分组）；
  ③ App 传给弹窗的 `api` 是**每次渲染新建的对象字面量**，而弹窗「打开时读一次配置」的
  effect 把 `api` 放进依赖数组 —— 于是每重渲染一次就重读一遍配置、闪一次加载条。
  实测背景滚动 3.5 秒发了 **157 次** `/api/configs`。现在 `api` 用 `useMemo` 固定，
  弹窗那边的 effect 也只认 `open`（`api` 走 ref），双保险。
  守卫 `tests/aiAssistantDialog.dom.test.tsx` 最后一条（父组件换 api 引用重渲染不得再读配置、
  不得再冒加载条、不得冲掉用户填的内容；关掉再打开仍要重读）。
- **笔记 WebDAV 恢复失败**（`NotesOverlay.tsx`）：服务端对 ZIP 备份（2026-10-11 起默认格式，
  含附件）不解包，回的是顶层 `zipBase64`；NotesOverlay 把返回值换算成 NotesPage 要的
  形状时**漏了这一个字段**，导致 `payload` / `zipBase64` 双空，界面只能把 `message`
  （服务端那里放的是文件名）当错误亮出来 —— 红框里一行文件名，看起来像下载失败。
  换算逻辑抽到 `src/utils/notesBackupAdapter.ts`，补了纯函数用例
  `tests/notesBackupFetch.test.ts`（去掉 `zipBase64` 一行必红），并在
  `tests/notes.dom.test.tsx` 补了「ZIP 恢复要真的走一次导入」的端到端用例。

---

## 2026-10-16（五）· 修复：弹窗排查报告的问题清单（P1 ×1 / P2 ×2 / P3 ×3）

**要点**：按 `docs/dialogs-audit-2026-10-16.md` 的问题清单逐条落地，修完用同一套
真浏览器工具在 375 / 768 / 1440 三档复测：全表零溢出、零裁切、零按钮行换行、零页面横滚。

- **P1 记事本入口在 <900px 完全不可达**（功能缺失，不是样式问题）：顶栏按钮 md 以下隐藏，
  而底部导航 / 更多菜单 / 命令面板都没有入口 —— 手机和窄窗口完全打不开记事本。
  现在**底部胶囊导航加「笔记」项**（带条数角标，挨着「新增」），窄屏有了真正的入口；
  宽屏（>=900px）底栏照旧不渲染，不与顶栏重复。守卫 `tests/mobileTabBar.dom.test.tsx`。
- **P2-1 帮助文字长 URL 伸出输入框**（375 下实测溢出 16px）：长 URL token 不断行。
  `dialogShell` 的公共正文样式统一给 `FormHelperText` 加 `overflow-wrap: anywhere`，
  SettingsDialog 两个带占位符示例的字段显式再写一份（它不用公共外壳）。
  守卫 `tests/dialogHelperTextWrap.test.ts`（含反向验证：规则只写在注释里必须测不出来）。
- **P2-2 卡片设置窄屏操作区 116px 高**：三个按钮在 301px 里换行成两排，吃掉小屏六分之一。
  xs 断点下「删除」收成标题行的图标钮（操作区只留取消/保存一行 36px），sm 以上维持原样。
- **P3-2 单卡删除撤销窗口 8 秒偏短**：延长到 15 秒（单卡与批量删除两处）。删错往往不是
  当场发现的；提示条消失后 Ctrl+Z 仍可撤销（操作栈不受时长影响），回收站继续兜底。
- **P3-3 两处 maxWidth 与内容不匹配**：AI 设置 xs→sm（四组设置在 444px 里太挤）；
  记事本版本历史 md→sm（内容只是列表，900px 让行宽浪费）。
- **P3-1（网站设置内容总高 3230px）未动**：信息架构调整需单独排期，报告原话如此。

---

## 2026-10-16（四）· 工程：VPS 重装重建部署件（kPanel compose + 镜像流水线 + 数据搬运单）

**要点**：VPS 重装后 20 分钟内可完整重建。补三件东西：
① kPanel「部署 Docker 应用」直接粘贴即用的 compose（端口只绑回环、密钥字面量不玩插值、
日志轮转、命名卷）；② 把一直躺在本地的 `docker-publish.yml` 提交进仓库 ——
自托管镜像改由 GitHub Actions 构建推到 `ghcr.io/zwjttztt/navihive:latest`，
VPS 不再需要本地编译（小内存机器编译正是 OOM 高发区）；③ 一份重建 Runbook，
含「从 Cloudflare 端把数据搬到自托管」的完整步骤与坑位。

- **新增** `deploy/kpanel-compose.yaml`：kPanel 粘贴即用。两个无声坑写在了注释里 ——
  端口写成 `8787:8787` 会直接暴露公网，而 `NAVIHIVE_HOST=127.0.0.1` 会让端口映射整个废掉；
  compose 里出现 `${VAR}` 在 kPanel 的部署目录里必然起不来（没有 .env）。
- **工程** `.github/workflows/docker-publish.yml` 入库：push 到 main 且动了
  Dockerfile / server / worker / src/API / shared / 依赖清单时自动重发镜像，
  也支持 Actions 页手动 Run workflow。镜像推 GHCR，包默认 private，
  要匿名 `docker pull` 需在 Package settings 里改一次 Public（Runbook 第一节有写）。
- **新增** `deploy/vps-redeploy-runbook-2026-10-16.md`：IP/DNS 核对 → 镜像两条路 →
  kPanel 部署 → 反代与证书 → **Cloudflare → 自托管数据搬运**（导航备份 + 笔记 zip 两条线，
  星标/标签依赖「下载备份的那台浏览器」这个坑单独标了）→ 验证清单 → 不会自动跟过来的
  配置（WebDAV、AI 凭据需重填）→ 故障速查表。

---

## 2026-10-16（三）· 修复：备份密码框被浏览器自动填入 + 加回「覆盖导入」选项

**要点**：两件事。其一，恢复页 / 备份页的「备份密码」框被浏览器当成登录表单，
自动填入已保存的站点密码，还会连带把顶栏搜索框当用户名框填上登录账号 ——
`autoComplete="off"` / `new-password` 都拦不住 Chrome 的「用户名+密码」配对，
改用项目里已验证有效的「`type=text` + `-webkit-text-security` 视觉遮蔽」方案
（与卡片凭据输入同一套，见 `utils/secretInput.ts`），搜索框再加「挂载只读、
聚焦解锁」保险（浏览器不对 readonly 输入框做任何填充）。
其二，把 10-16（一）里拿掉的「覆盖导入」选项**加了回来**，但换了个安全得多的实现。

- **自动填充**：`RestoreTab` / `BackupTab` 共 6 个口令类输入框改为 text + CSS 遮蔽，
  name/id 一并去 password 化；`HeaderSearchBox` 挂载时只读、mousedown/touch/key/focus
  任一交互即解锁（解锁抢在 focus 之前，移动端键盘才弹得出来）。
  守卫 `tests/headerSearchBox.dom.test.tsx`。
- **覆盖导入回归**：语义与老的「先清空再重建」不同 —— 现在是「合并 upsert +
  删掉备份里没有的行」：认得出是同一条的照常保 id（星标 / 访问统计不掉线）、
  内容仍按谁新谁赢（备份没带账号密码时不会把已有卡片的凭据清空）；
  删除（分组 / 卡片 / 笔记）与写入在**同一个事务**里，失败整批回滚；
  空备份拒绝覆盖；被删卡片写墓碑（其它设备同步可见）。
  界面三道闸：恢复页开关默认关 + 红色警示 → 预览列出「将删除」清单（跟随勾选实时变）
  → 勾「我已确认删除」才放行。模式经 `?mode=overwrite` 传递（不进 body，
  免得弄坏备份文件的内容摘要），未知值一律按合并处理。

---

## 2026-10-16（二）· 修复：自托管全模块走查（撤销分享删分组 / 静态回退 MIME / 静默降级 LIKE）

**要点**：按模块走查了一遍自托管（方案 B）的全部功能链路，其中**最严重的一条是数据破坏**：
在分组分享弹窗里点「撤销分享」，会把**整个分组连同里面的卡片一起删进回收站**。
原因是路由顺序：`worker/routes/data.ts` 里 `path.startsWith("groups/")` 的三条
（GET/PUT/DELETE）排在更具体的 `/^groups\/\d+\/share$/` 之前，而 id 取
`parseInt("7/share")` 得 `7` 且不报 NaN —— 冲突**一声不响**，只是静默走错分支。
另修了两条只在自托管暴露的缺陷，以及一条两端共有、静默降级的搜索性能问题。
完整清单（问题描述 / 根因 / 改动位置 / 验证方式）见 `docs/selfhost-audit-2026-10-16.md`。

- **P0 阻断性**：撤销分享 = 删除分组。现在分享分支排到前缀分支之前；
  顺带修好另外两条：查分享配置原先返回分组对象（前端看不到 `token`，以为没分享过）、
  更新有效期/口令原先变成改分组。守卫在 `tests/dataRoutes.test.ts`（反向验证过：
  把分支挪回去 3 条用例立刻变红）+ `script/selfhost-smoke.mjs` 端到端。
  注：这是 Worker 路由代码，**两端都受影响**，不是自托管独有。
- **P1 功能性**：缺失的静态资源原先回 `200 + text/html` 的 index.html。
  浏览器按缓存里的旧 index.html 请求一条早被删掉的 chunk 时，会因 MIME 不匹配拒绝执行
  （`Expected a JavaScript module script but the server responded with a MIME type of text/html`），
  表现为发版后随机白屏。现在带扩展名的未命中请求一律 404 —— 这也才是 Cloudflare
  对 `single-page-application` 的真语义（「只为**导航请求**回退 index.html」）。
  守卫 `tests/serverStatic.test.ts` + 冒烟回归钉。
- **P1 功能性**：直连（没挡反代）时所有人的客户端 IP 都是 `unknown` ——
  审计日志记不到来源，且登录爆破限速全场共用一个桶（一个人输错密码，所有人跟着被锁）。
  自托管入口现在在缺 `X-Forwarded-For` 时补上 socket 对端地址（已有的不覆盖）。
- **P1 功能性**：笔记全文检索只有冷启动后**第一个**请求用得上 FTS5。
  `notesFtsReady` 原先是 api 实例字段，而迁移是模块级缓存的（只跑一次）、
  api 是每个请求 new 一个 —— 于是之后所有搜索静默退化成 LIKE 全表扫（无 bm25 排序）。
  改为模块级 `migrationState.ftsReady`，两端都修。守卫 `tests/noteFtsRealSql.test.ts`。
- **P2 体验性**：随仓库发布的 nginx 配置把 `proxy_set_header` 只写在了 `location /` 里。
  按 nginx 的继承规则（当前级别一条 `proxy_set_header` 都没有才继承上级），
  那几行对 `/api/login`、`/api/webdav/`、`/assets/` **一律无效** ——
  登录接口拿不到 XFF，应用层的失败限速照样是全场一个桶。已提到 `server` 级。
- **P2 体验性**：启动自检补两条提醒 —— `NAVIHIVE_CRON=0` 且没配
  `NAVIHIVE_CRON_TOKEN`（定时任务彻底没有触发来源）、监听非回环地址却开着 XFF 信任。
- 新增 `tests/serverNet.test.ts`（IP 归一化 / 回环判定），`server/net.ts` 抽出两个纯函数
  （`server/entry.ts` 一被 import 就会起服务，没法单测）。单测 2701 → 2716。

---

## 2026-10-16（一）· 修复：数据导入改为纯增量合并（不再清空 / 覆盖 / 删除任何现有数据）

**要点**：以前「导入备份」的语义含混，写入路径里带着**先删后建**的分支——重复导入、
跨账号导入、异常中断等场景下，现有数据可能被清掉或停在半截。现在导入**只有一条路径**：
严格增量 upsert，导入链路里一行 `DELETE` 都没有，且整套写入落在**一个事务**里
（`db.batch()`，要么全成要么全滚）。

- 匹配口径：分组按**名称**，卡片按**分组 + URL 归一**（无 URL 时退回分组 + 名称），
  笔记按 **uuid**，配置按 **key**。命中就地更新，冲突时 `updated_at` **新的赢**
  （时间相同 / 解析不出来 → 保留本地）。孤儿卡片落进「导入的站点」分组（已存在就复用）。
- 幂等：同一份备份连导两次，第二次**一行都不新增**（之前会翻倍）。
- 失败安全：校验失败/加密失败在写库**之前**抛出，一个字节都不落；
  写库中途失败由事务整体回滚，本地那条数据原封不动。
- 配置写入补 `WHERE excluded.value <> ''`：备份里的空串配置（「这一项没设置」的合法形态）
  不会把线上已配好的值抹掉。
- 界面同步：去掉「覆盖恢复」开关，改为固定说明「增量合并（不会删除任何现有数据）」；
  预览里**不再有「将删除」**这一档，也就不存在「必须全选否则丢数据」的压力；
  完成后提示一句人话的账目（新增 / 更新 / 已存在各多少）。
- 守卫：`tests/restoreAtomicity.test.ts`、`tests/crossAccountRestore.test.ts`、
  `tests/noteTransfer.test.ts` 等按新语义重写；新增 `tests/importUpsertRealSql.test.ts`
  （真 SQLite 6 条：幂等 / 只覆盖更新的 / 孤儿分组复用 / 空配置不抹 / 失败零写入）。
  ⚠️ 顺带修了测试替身 `tests/helpers/realSqliteD1.ts` 的两处失真：`run()` 没给
  `meta.rows_written`（幂等锁永远抢不到）、`batch()` 不是真事务（「回滚」断言是假的）。

---

## 2026-10-15（十）· 修复：搜索框被浏览器自动填入登录账号名

**要点**：顶栏搜索框没关浏览器自动填充，而这个源同时是登录页所在源（浏览器存了登录凭据），
Chrome 就把页面上第一个文本框当成用户名输入框，把你保存的账号名自动填进搜索框。
现在搜索框显式 `autocomplete="off"`，并给它一个不像用户名的字段名。

---

## 2026-10-15（九）· 修复：合并导入恢复必报 400「配置值不能为空且必须是字符串」

**要点**：从备份恢复（合并导入模式）时，写配置那一步逐条走单键接口，而备份里
「未设置」的配置就是**空字符串**（如 `site.iconApi: ""`）——单键接口按设计拒绝空值，
于是撞上第一个空配置就 400，整个恢复报废（覆盖恢复走服务端批量，不受影响）。
修复：合并导入的配置写入改走**批量接口**（允许空串，语义与覆盖恢复完全一致），
顺带 N 个请求变 1 个。

- 空串是「这一项没设置」的合法语义，不是脏数据：覆盖恢复的服务端批量写入本来就收空串，
  两条路径现在一致了。`auth.*` / `webdav.*` 仍被 `pickImportConfigEntries` 滤掉，
  批量接口的 `auth.` 禁写不会被触发。
- `tests/configRoutes.test.ts` 新增两条契约用例钉住差异：batch 收空串、单键 PUT 空值 400。
  防以后有人把两条路由「统一」成同一种校验，把这个 bug 放回来。

---

## 2026-10-15（八）· 修复：WebDAV 恢复被「跨源重定向」一刀切挡住

**要点**：从 WebDAV 备份恢复时，服务器返回 302（典型形态：openlist/Alist 挂了云存储，
GET 备份文件会 302 到签名直链），旧逻辑报「不允许跨源重定向，请保存最终服务器地址」并中止恢复。
现在只读请求（GET / HEAD / PROPFIND / OPTIONS）跨源**可以跟随**，凭据仍然绝不出自己域。

- 放宽的范围刻意只有**只读方法**：GET/HEAD/PROPFIND/OPTIONS 跟随跨源跳转。
  带 body 或有副作用的方法（PUT / MKCOL / DELETE…）跨源仍然拒绝 ——
  301/302/303 的标准语义会丢掉 body（静默丢备份），DELETE 被重定向则可能删到别的服务器。
- 跨源那一跳剥掉 `Authorization`：Basic 凭据只属于用户配置的那台服务器；
  签名直链本来也不需要它。这样既跟上了网盘的常见行为，安全不变式没动。
- 跨源跟随之后如果目标自己要登录（401/403），报可操作的指路错误
  （「重定向目标要求登录（跨源跟随按安全规则不带凭据）：请把重定向后的最终地址直接填进 WebDAV 配置”），
  而不是让人对着 401 猜。

---

## 2026-10-15（七）· 性能 + 工程：首屏交互组件懒化；读屏播报区常驻化

**要点**：「更多选项」菜单、卡片右键菜单、全局提示条三个**点了才出现**的组件改为
**条件挂载 + 懒加载**——entry chunk 243→225KB，首屏少解析一份菜单/提示条代码；
读屏播报区拆成常驻小组件（live region 必须先于内容存在，读屏才会念）。

- 新组件：`SiteCardContextMenu`（从 SiteCard 抽出的右键菜单）、`AriaLiveRegion`（无依赖 div）。
- `MoreMenu` 在 HeaderActionsSlot 里改为 `lazy` + 仅 `menuOpen` 时挂载（关闭动画让位于首屏字节）。
- **背景**：全站审查（`docs/site-audit-2026-10-15.md` P1）曾尝试把弹窗族 MUI 从首屏 preload 里
  拆出去——两案皆止步：rolldown 的 manualChunks 回调期 `importers` 图既污染又缺失
  （连 react.production.js 都会被并进按名分出的块），give-back 方案又把 preload 碎成 22 个
  不可合并的小请求（minChunkSize 不生效）且 index 超 252KB 预算。结论：**维持
  mui-lazy 块 preload 的既定权衡**（425KB raw / 128KB gzip，首访一次、SW 预缓存后为零，
  预算 1000KB 内全绿），解封条件见审计报告。这三个懒化是与该权衡无关的卫生改进。
- `tests/siteCard.dom.test.tsx`：右键菜单用例改为轮询等懒 chunk（菜单出现是异步的了）。

---

## 2026-10-15（六）· 工程：App.tsx 启动门控有了单测（补测试清单收尾）

**要点**：补测试清单上最后一个文件——App.tsx（2056 行）的启动门控现在有 3 条 DOM 用例。
同时修了 runner 的一个共享缺陷：`import.meta.env` 在单测里未定义，一读就炸
（以前只是没人 import 到读它的模块，App 一进测试就暴露）。

### 用例守的三条启动路径（坏了分别是白屏 / 死登录页 / 闪主界面）

- 未登录 + bootstrap 401 → 登录界面（表单真的渲染出来，不是空白）
- 检查中（bootstrap 悬挂）→ 转圈，不提前闪登录框
- 已登录 + bootstrap 200 → 主界面，分组和站点卡片都渲染出来

这些路由此前只有仓库外的 ui-smoke 盯着；App 里任何一次「提前 return / 门控顺序调整 /
onAuthFail 接线改动」都可能把登录页吃掉，本地还不报错。

### 落地件与两个坑

- `tests/App.dom.test.tsx`：fetch 桩按 URL 路由（含 401 分支），cookie 控制登录态
  （`isLoggedIn` 认 `navihive_session=1`），轮询等懒加载块。
- **坑 1**：`import.meta.env.DEV` 在 esbuild 打包的测试里是 undefined →
  `script/unit-tests.mjs` 的共享配置补了 define（DEV=false / PROD=true /
  `VITE_USE_REAL_API=""`），语义对齐「被测的就是构建产物」。
- **坑 2**：GroupCard 正常模式下站点默认不挂载，等 IntersectionObserver 命中才挂
  （入场动画的分帧懒挂载）——jsdom 的 IO 桩不触发，站点永远不渲染。
  测试里装「一 observe 就触发」的 IO 替身（只在本文件生效，不碰共享 banner）。
- 单测 2684 → **2687**。

---

## 2026-10-15（五）· 安全 + 工程：8787 端口收进回环；方案 B 切流定型

**要点**：自托管生产的 8787 端口原来绑在 `0.0.0.0`（裸 HTTP 直连公网，绕过 TLS 与 Nginx），
已改为只绑宿主机回环，站点经 Nginx 反代正常。同时把方案 B 的收尾决策写定：
**对外暴露走 Nginx 反代、自托管即主站、不重导 CF 端数据**。

### 端口修复（生产已生效）

- VPS 上 `docker-proxy` 把 `0.0.0.0:8787` 直接暴露——知道 IP 的人能用裸 HTTP 访问应用。
  部署目录 compose 的端口映射改为 `127.0.0.1:8787:8787`。
- ⚠️ **发卡陷阱**：该站 Nginx 上游原来写的是 VPS **公网 IP**（`server <vps-ip>:8787`，
  面板类工具的默认习惯），只改绑定会全站 502。上游一并改成 `127.0.0.1:8787` 后才恢复。
  验证：`ss` 只剩回环监听、`https://<域名>/` 200、空体 DELETE 探针 401（修复保持）。
- 仓库的 `docker-compose.yml` 本来就只绑回环且有守卫测试（`tests/dockerDeploy.test.ts`），
  问题只在 kPanel 管理的部署副本——这次的坑与两步解法写进了 `deploy/selfhost.md`
  第九节（切流状态）与排障表。

### 方案 B 收尾（决策记录）

- **③ 暴露方式定型：Nginx 反代**（不用 Cloudflare Tunnel）。形态：域名 → Cloudflare →
  VPS 443 → Nginx → `127.0.0.1:8787` → 容器。
- **自托管转为主站**；Cloudflare 那套保留作回滚目标，但数据停留此刻状态——
  **已决定不把 CF 端数据再重导同步**（两端各自独立；将来搬数据用备份文件手工导入）。
- 回滚路径与「回滚前要先把 VPS 新写的数据用备份搬回去」写进手册——没有自动同步，别以为有。

---

## 2026-10-15（四）· v0.2.0 修复 + 工程：语义搜索提示不再显示两遍；版本号随部署自动跳变

**要点**：① 修掉「点击语义搜索，那句『要先建索引』出现两遍」；② 版本号从本次起
**每次推送自动跳变**——小改末位（v0.2.1）、中改中位（v0.3.0）、大改首位（v1.0.0），
右下角徽标跟着变。本次改动定为 minor，版本来到 **v0.2.0**。

### 修复：语义搜索提示渲染两遍

`SearchStatusLine` 从 App.tsx「纯搬迁」时，App 里那份旧 JSX 没删 —— 组件渲染一遍、
App 又渲染一遍，两处条件完全相同，所以任何时候都是成对出现。删掉 App.tsx 里的旧副本，
并加双层防线：源码守卫（这句文案在整个 `src/` 只允许有一个出处）+ 组件用例
（提示只出现一次、「现在生成」触发回调）。

### 工程：版本号随部署自动跳变

- 每次推送前 `script/bump-version.mjs` 按**本次改动规模**给 package.json 的 version 跳档：
  ≤5 文件且 ≤200 行 → patch（末位）；≤20 文件且 ≤1200 行 → minor（中位，末位归零）；
  超出 → major（首位，其余归零）。参照真实提交定档：undici 修复（4 文件/163 行）→ patch，
  版本徽标（6 文件/~285 行）→ minor，菜单瘦身（20 文件/~1500 行）→ major。
- 为什么在**推送时**算而不是构建时：版本要落在 commit 里（package.json 的 diff 就是审计轨迹）；
  且 Docker 构建上下文没有 `.git`（.dockerignore 排除），构建时根本算不了改动规模。
  Cloudflare 自动部署与 VPS docker build 从同一 commit 构建，读到同一个版本。
- 幂等：一轮里重复调用跳过（推送失败重跑不会跳两档）；基数取 `HEAD` 里已提交的版本，
  上次失败留下的 bump 会自动复位。
- 右下角徽标可见文字仍是语义版本（`v0.2.0`）；`+commit/构建号` 与构建时间在悬浮提示里。
- 落地件：`script/bump-version.mjs`（git 逻辑）+ `script/bump-version-lib.mjs`（纯函数，
  拆开是为了防止被 esbuild 内联进测试 bundle 时主流程被误触发）+ `.d.mts` 类型声明 +
  `tests/bumpVersion.test.ts` 7 条。所有 `rest-push-*.py` 已批量接入（29 个）。
- ⚠️ Windows 坑：node 的 `execSync` 走 cmd.exe，git 路径规格必须用**双引号**
  （`":(exclude)package.json"`）——单引号会被原样传给 git 报 exit 128，Git Bash 里手动跑反而正常。

---

## 2026-10-15（三）· 重构：「更多选项」菜单瘦身；版本徽标只显示语义版本

**要点**：顶栏「更多选项」从 11~12 项收敛到 10 项，两个最容易混淆的「统计」入口合并成一个；
「安装到桌面」并入帮助弹窗。右下角版本号只显示 `v0.1.0`，完整版本（+commit/构建号）与
构建时间收进悬浮提示——常驻要短，较真时悬浮可见。

### 菜单合并（功能一个没少）

- **访问统计 + 统计看板 → 「统计」**：原先两项分列，名字都叫「统计」，用户得逐个点开才知道
  哪个是哪个。现在是一个弹窗两个标签页（`StatsHubDialog`）：访问统计（本机热力图，人人都有）、
  运营看板（服务端审计 / 分享浏览 / 链接健康，仅 owner）。**非 owner 看不到第二个标签，
  标签栏整个不渲染，也不会白发 `/api/stats`**（未选中的面板不挂载，切过去才请求）。
- **快捷键与操作帮助 + 安装到桌面 → 「帮助」区**：安装入口移到帮助弹窗底部
  （只有浏览器真的给了安装事件时才出现），菜单不再为这个一次性动作单占一项。
- 落地件：新增 `StatsHubDialog` / `VisitsPanel` / `StatsPanel`（从旧的两个弹窗抽面板，
  `VisitsDialog`、`StatsDashboardDialog` 已删）、改 `MoreMenu.tsx`、`ShortcutsDialog.tsx`、
  `useAppDialogs`（`openVisits` → `openStatsHub`）；命令面板「查看访问统计」→「查看统计」。

### 版本徽标

- `BuildBadge` 可见文字只保留语义版本（`v0.1.0`）；`+hash/构建号` 与构建时间进 title 提示。
  「每一次部署可区分」的能力没丢——悬浮就能看到完整部署版本。

### 测试

- `tests/moreMenu.dom.test.tsx`：跟着改标签（统计 / 快捷键与操作帮助），新增「菜单结构固定」
  整表断言；`tests/statsHub.dom.test.tsx` 3 条（标签页显隐、懒请求）；
  `tests/shortcutsHelp.dom.test.tsx` 3 条（安装入口按条件出现、点击真的触发）；
  `tests/statsDashboard.dom.test.tsx` 搬到 `StatsPanel` 上；`BuildBadge` / `hooks` /
  `appCommands` 同步更新。

---

## 2026-10-15（二）· 新增：右下角部署版本号徽标

**要点**：每个页面右下角现在有一个极低调的版本号（形如 `v0.1.0+c49c59f`），
悬浮可见构建时间。以后「线上跑的是哪一版」一眼可查，不用再猜「修没修、部署没部署」。

- 版本号在**构建时**生成：语义版本（package.json）+ commit 短哈希。每次部署
  （Cloudflare 从 GitHub 自动部署、自托管 `docker build`）都会重新计算，
  天然做到「每一次部署一个版本号」。
- Docker 构建上下文刻意不含 `.git`（.dockerignore），取不到哈希时兜底用构建号
  （毫秒时间戳，同样每次构建必不同）——任何构建方式下版本号都存在且逐次可区分。
- 徽标 `pointer-events: none`：永不挡右下角点击；`zIndex 1`：任何弹窗都盖过它；
  颜色走 `--text-muted`，亮暗主题自动跟随；开发模式没烘版本号就不渲染。
- 落地件：`vite.config.ts`（define 注入 `__NAVIHIVE_APP_VERSION__` / `__NAVIHIVE_BUILD_TIME__`）、
  `src/utils/appVersion.ts`、`src/components/BuildBadge.tsx`（挂 `src/main.tsx` 根部，
  主页面与公开分享页都显示）、`tests/BuildBadge.dom.test.tsx`（4 条）。

---

## 2026-10-15（一）· 修复：自托管空体 DELETE 一律 500（undici Request 重建）

自托管（方案 B）上保存 WebDAV 备份配置时报 **「保存 WebDAV 配置失败: 服务器内部错误 (HTTP 500)」**，
服务端日志是 `TypeError: Cannot construct a Request with a Request object that has already been used.`。

### 根因

`worker/index.ts` 的 `handleRequest` 为了限速，先用 `readBoundedBytes` 把请求体读成字节，
再重建一个 `Request` 往下传。旧写法拿**已被消费的旧 Request 当模板**：

```ts
request = new Request(request, { body: bytes.byteLength ? bytes : null });
```

Node 的 undici 在 `init.body` 为 `null` 时会去**从模板继承 body**，而此时模板的 body 流已经被
`readBoundedBytes` 消费掉 → 抛上面的错。**带 body 的 PUT/POST 没事**（init.body 非空时 undici
不碰模板的 body），所以 CRUD 大多正常，唯独**空体删除**炸——而 WebDAV 配置保存会在清空密码时发一条
`DELETE /api/configs/webdav.backupPassword`，正好踩中。Cloudflare 的 runtime 没有这条检查，
所以线上（Workers）从不出错，**只在自托管（Node）暴露**。

### 修复

改成用 **url + method + headers** 重建，两个 runtime 行为一致：

```ts
request = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes.byteLength ? bytes : null,
});
```

### 落地的件

- `worker/index.ts`：上面那行重建逻辑；
- `tests/workerRequestRebuild.test.ts`：2 条源码守卫（禁止 `new Request(request|req)[,)]` 模板写法、
  必须出现 `new Request(request.url,` + `method: request.method`；并反向验证 `server/entry.ts` 仍保留
  `hasBody = method !== "GET" && method !== "HEAD"`）；
- `script/selfhost-smoke.mjs`：第 11 节新增「无 body 的 DELETE 不再 500」回归检查
  （`DELETE /api/groups/99999999`，断言 `status < 500`）。

### 验证

自托管冒烟全链路 **27/27 通过**；该空体 DELETE 之前回 500，现在回 200（不存在的分组删除是幂等的），
崩溃路径已消失。

---

## 2026-10-15（一）· 回退：单向镜像同步（同日新增、同日回退）

上午落地过一版「主站 → 只读备站」的单向镜像同步（`6399599`，含
`script/sync-mirror.mjs`、`GET /api/notes/export`、`deploy/mirror-sync.md` 与 11 条守卫）。
当天决定**不做了**，整批回退，代码回到 `3148c0b` 的状态：

- 删 `script/sync-mirror.mjs`、`tests/mirrorSync.test.ts`、`deploy/mirror-sync.md`；
- `worker/routes/data.ts` 去掉 `GET /api/notes/export`；
- `package.json` 去掉 `sync:mirror`；`.gitignore`、`deploy/selfhost.md` 还原。

**原因**：两端不再做自动同步，改为**各自独立运行**。
需要搬数据时用备份文件手工搬运——导出的备份本来就能在任意一端导入
（`exportData` 里的站点密码是解密后的明文，导入时由目标库用自己的密钥重新加密，
所以两端 `AUTH_SECRET` 不同也无所谓）。

这条记录留着是为了将来翻到「手册里提过的 `sync:mirror` 怎么没了」时不至于困惑。

---

## 2026-10-14（五）· 修复：自托管首页空白——batch 里的 SELECT 会被丢掉行

自托管（方案 B）上线后第一次真机使用就撞上：**首页一个分组、一张卡片都没有，但记事本正常**，
单独 `GET /api/groups` 却又返回 5 个分组。没有任何报错，就是一个空首页。

### 根因

`data.ts` 的 `queryBootstrap` 把「分组 + 站点 + 配置」三条语句塞进一个 `db.batch()`
直接读每个结果的 `.results`——前两条是 **SELECT**。而适配器 `server/sqlite-d1.ts`
的 `batch()` 对每条语句统一调 `runSync()`，后者只在 SQL 命中 `RETURNING` 时才走 `all()`
拿行，其余一律 `run()`：**`run()` 不回行，于是两条 SELECT 的行整批丢失**。
D1 的 batch 会回每条语句的行，所以这条在 Cloudflare 上从不出问题，只在自托管路径上暴露。

### 修法

`runSync()` 的派发条件从「带 RETURNING」扩成「会返回行」：新增
`RETURNS_ROWS_RE = /^\s*(select|with|values)\b/i`（CTE 也算），命中的走 `all()` 拿行，
写语句照旧 `run()`，meta 不受影响。

### 为什么这条必须钉死

它的失败形态是**静默**的：HTTP 200、日志干净、接口数据都在，只有一个空首页。
新加两条回归用例（`tests/serverSqliteD1.test.ts`：batch 里混 SELECT、batch 里的 CTE），
并做了反向验证——改回旧写法两条立刻变红。

### 验证

`tsc -b --force` / `eslint`（0 error）/ 单测 **2658**（2656 + 2，0 失败 0 跳过）/
`check:brand` / `build` / `smoke` / `audit:a11y` / `audit:contrast` 全绿；
新服务器重建镜像后首页 `GET /api/bootstrap` 由 0 分组 0 站点恢复为 5 分组 13 站点。

---

## 2026-10-14（四）· 工程：Docker 部署件——镜像真机构建真机跑通，29 项端到端验证全过

给方案 B 补容器化路径：`docker compose up -d --build` 一把起，与 systemd 接法二选一。
**没有止步于写文件**——在一台 1 核 / 464MB 内存的 Debian 13 VPS（Docker 29.9.0）上
真构建、真运行、真压测了一遍，并把踩到的坑修在了交付物里。

### 一、新增部署件

- **`Dockerfile`**（多阶段）：builder 跑 `npm ci` + `npm run build` + `build:server`，
  runtime 只带 `dist/client` 与 `dist-server/entry.mjs`（自包含单文件，无 node_modules、无源码）。
  要点：`NAVIHIVE_HOST=0.0.0.0`（默认 127.0.0.1 在容器里等于端口映射全废，且无任何报错）、
  `USER node` 最小权限、`VOLUME /app/data`、`HEALTHCHECK` 打 `/api/init`
  （公开路由且真读一次库，比 TCP 探活强）、`--disable-warning=ExperimentalWarning` 与
  `start:selfhost` 一致。
- **`docker-compose.yml`**：命名卷 `navihive-data`、端口**只绑宿主机回环**（TLS 交给反代）、
  `${AUTH_SECRET:?…}` 强制要求密钥（宁可不启动，不给一个「登不进去」的服务）、
  json-file 日志轮转（API 访问日志每请求一行，不轮转会写满小盘）、锁定单副本
  （SQLite 单写者）。
- **`.dockerignore`**：排除 `node_modules`/`dist`/`dist-server`/`data`/`.env`
  ——本地库与密钥绝不进镜像层。
- **`.env.example`** + `.gitignore` 补 `.env`。
- **`.gitattributes`** 给四个部署件钉 `eol=lf`：`core.autocrlf=true` 的 Windows 检出会把
  `.env` 变 CRLF，`\r` 会被读进 `AUTH_SECRET`（令牌签名静默错）。

### 二、17 条漂移守卫（`tests/dockerDeploy.test.ts`）

镜像和 compose 都是「改坏了没有任何东西会报错」的文件，按仓库惯例钉死：
两个 Stage 都是 `node:24`、runtime 的 `NAVIHIVE_HOST=0.0.0.0`、COPY 路径与真实产物一致、
EXPOSE 与 `entry.ts` 的 `NAVIHIVE_PORT` 默认值互锁、HEALTHCHECK 打 `/api/init` 且只打
127.0.0.1、`.dockerignore` 排除敏感项、compose 的卷/密钥/回环绑定/日志轮转/单副本、
`.gitattributes` 的 LF 钉。**反向验证**：四处逐个改回旧写法全部如期变红，还原后 17/17 绿。

### 三、VPS 实测（1 核 / 464MB / Debian 13）

- **构建 8 分 26 秒成功**（镜像 356MB）。第一轮直接 OOM（exit 134）：Node 按物理内存把
  堆上限收到 ~257MB，`tsc -b` 全量编译不够用——修法是 builder 阶段
  `NODE_OPTIONS=--max-old-space-size=3072`（只是上限不是预分配，大机器无影响）+ 机器加 swap。
  这条已写进 Dockerfile 注释与手册排障表。
- **端到端 29 项全过**：登录 → 首登强制改密（种子账号既定行为）→ 重新登录 → bootstrap →
  建分组 → 读回 → CSP 三头（`trusted-types navihive-sw` / XFO / XCTO）→ SPA fallback →
  未知路由 404 → `POST /__cron` 无 token 404 → healthcheck healthy → 容器以 node(1000) 运行 →
  重启后数据还在 → **删容器重建后数据还在**（升级路径）→ 旧种子密码已失效。
- **compose 实测**：不配 `AUTH_SECRET` 时按预期直接拒绝启动；`.env` 正确贯通；
  端口只绑回环。踩到一个 Docker 行为：`up` 因端口冲突失败后会留**半成品容器**
  （PortBindings 有、实际映射没建立，再 `up` 显示 Up 但宿主连不上）——`down` 再 `up` 即恢复，
  已进手册排障表。

### 四、验证

`tsc -b --force` / `eslint`（0 error，19 warnings 为既有）/ 单测 **2656**（2639 + 17，
0 失败 0 跳过）/ `check:brand` / `build` / `smoke` / `audit:a11y` / `audit:contrast` 全绿；
Docker 侧见第三节。VPS 现状：无容器无卷，`navihive:test` 镜像与 `/opt/navihive` 源码保留，
4G swap 已入 fstab。Workers 部署路径未受影响。

---

## 2026-10-14（三）· 工程：方案 B 自托管落地件 —— server/ 三件套，26 项端到端冒烟全绿

按 `docs/selfhost-plan-2026-10-14.md` 把整站搬到 VPS 自托管所需要的代码全部落地。
**业务代码一行没改**：`worker/` 与 `src/API/` 原本就只依赖 Web 标准 API，
这里只是把 Cloudflare 平台替我们做的四件事在 `server/` 里重新长出来。

### 一、新增 `server/` 三个文件

- **`sqlite-d1.ts`** —— `node:sqlite` → D1 形状适配器，核心件。与仓库自带的测试替身
  （`tests/helpers/realSqliteD1.ts`）有六处实质差异，每处都对应一种线上事故形状：
  ① `batch()` 是**真事务**（替身是 `Promise.all`，而全仓 29 处 `db.batch()` 里有
  「删站点 + 写回收站 + 写墓碑 + 写审计」这类组合，半提交就是数据半删）；
  ② `run()` 同时给 meta 和 RETURNING 的行（node:sqlite 的 `run()` 会把行丢掉，
  而 `notes.ts` 改笔记换标签直接读 batch 第一个结果的 `.results`）；
  ③ `exec()` 补回 `{count, duration}`；④ 外键默认开启（对齐 D1 官方文档，
  否则「线上拦得住、本地拦不住」）；⑤ 错误走 **rejection** 通道而不是同步抛出
  （同步抛会绕过调用方的 `.catch` / `Promise.all`，这条是补单测时抓出来的真缺陷）；
  ⑥ 行对象拍平成普通对象（node:sqlite 给的是 null-prototype）。
  外加四个 PRAGMA（WAL / busy_timeout / synchronous=NORMAL / foreign_keys=ON）、
  `bind(undefined)` 归一成 NULL、batch 重入用 SAVEPOINT 兜底。
- **`file-kv.ts`** —— 本地目录 → `KVNamespaceLike`，顶掉 KV 装笔记图片附件
  （全仓只有 `attachments.ts` 四个调用）。路径穿越防护用 `path.relative` 判而不是
  `startsWith`（Windows 上 resolve 回反斜杠，那样写等于防护失效）；
  写入拷贝、读回切字节区间（Buffer 底层池可能比它自己大）。
- **`entry.ts`** —— Node 入口：HTTP 桥接（逐跳头剔除、多条 Set-Cookie 展开、
  `duplex:"half"`、无正文状态码）+ 静态资源（解析 `dist/client/_headers`，
  含 SPA fallback）+ 定时任务（进程内对齐 UTC 整点，或 `POST /__cron` 外部触发，
  未配 token 恒 404）+ 优雅退出（清 timer → 关库 checkpoint WAL → 强制退兜底）。
  配置全走环境变量，见 `deploy/selfhost.md` 的全表。

`server/static.ts` 是从 entry.ts 抽出来的静态资源与 `_headers` 解析（import entry.ts
会把整个 HTTP 服务拉起来，单测只要那段纯逻辑）。

### 二、工程配套

- `script/build-server.mjs`：esbuild 打成自包含单文件（752KB，无 npm 依赖）。
- `script/selfhost-smoke.mjs`：26 项端到端冒烟 —— 登录 → 改密 → 重登 → bootstrap →
  建分组/站点 → **PUT 站点（403 事故同款请求）** → 读回 → 静态响应头（CSP /
  X-Frame-Options / 缓存）→ SPA fallback → POST / 由 worker 回 404 →
  附件上传按 id 读回字节 → cron 端点 → 结构化 404。新库上 26/26 通过。
- 35 条单测（`tests/server*.test.ts`）：batch 原子性与显式回滚、RETURNING 行与 meta、
  外键开启与批内推迟校验、`bind(undefined)`、exec 形状、文件 KV 往返与拷贝语义、
  `_headers` 解析与覆盖/删除语义、SPA fallback、穿越 403，外加一条**真 `_headers`
  漂移守卫**（CSP 的 `require-trusted-types-for 'script'` 与 `trusted-types navihive-sw`
  少任何一条都不报错，只能钉住）。
- `deploy/selfhost.md` 落地手册 + `deploy/nginx/sites-available/navihive-selfhost.conf`
  （与方案 A 的反代配置同目录，区别只是上游指向本机 Node）。
- 新脚本：`npm run build:server` / `start:selfhost` / `smoke:selfhost`；
  `dist-server/`、`data/`、`.smoke-data/` 进 .gitignore；`dist-server` 进 eslint 忽略
  （产物里带着源码的 eslint-disable 注释，会报一堆「规则未定义」的假错误）。

### 三、几个探针才量出来的 node:sqlite 行为（已写成注释留在代码里）

- 事务内失败后 **COMMIT 仍会提交之前的语句** ⇒ 显式 ROLLBACK 不是摆设。
- `all()` 跑普通 INSERT 回 `[]` 且不抛 ⇒ RETURNING 正则被字符串字面量里的
  "returning" 骗到时不会炸，且 `changes` 不能拿行数顶替。
- 批内开 `PRAGMA defer_foreign_keys = ON` 可精确复刻 D1 batch 的外键校验时机
  （官方文档：推迟不阻止级联删除）。

### 四、验证

`tsc -b --force` / `eslint`（0 error）/ 单测 **2639 项全过** / `check:brand` /
`build` / `smoke` / `audit:a11y` / `audit:contrast` 全绿；自托管服务真实起过
（真 SQLite + 真文件 KV + 真静态资源），冒烟 26/26。Workers 部署路径未受影响。

---

## 2026-10-14 · 修复：写操作 403 无人话 —— 同源判据改用 Sec-Fetch-Site，拒绝改回结构化 JSON

线上「修改卡片保存后弹 `API错误: 403`」的第二次定位。第一轮归因于反代的
Host 改写（已落 `proxy_set_header Origin "";`），但用户反馈**反代之前就有**，
且加了那行之后仍然报错 —— 说明归因不完整，于是把整条链路的 403 出口重新穷举了一遍。

### 一、排查：全链路只有一处会吐「没有人话的 403」

- 客户端 `request()` 的格式是 `reason ? "${reason} (HTTP ${status})" : "API错误: ${status}"`，
  `reason` 来自 `parseApiError()`。⇒ **看到光秃秃的「API错误: N」，只可能是响应体不是 JSON**。
- Worker 内逐个 `new Response(` / `Response.json(` 数过去：所有 403 出口都带 message
  （`errorResponse(ApiError.forbidden(...))`、账号停用、强制改密闸门…），
  **唯一**的纯文本 403 是 `middleware.ts` 的 CSRF 分支「跨站请求已被拒绝」。
- 排除了：Cloudflare 边缘拦截（用完整浏览器指纹发 PUT，请求确实到了 Worker）、
  跨域（`baseUrl="/api"` + `credentials:"same-origin"`，源码与线上 bundle 双重确认）、
  线上是旧版（`/api/note-shares` 已是新错误形状、`/api/init` 带 `maintenance` 字段）。
- ⇒ 只能是 CSRF 分支。而它只在 `Origin` 的 host ≠ `request.url` 的 host 时触发。

### 二、根因：同源判据问错了对象

反代方案**必须**把回源 `Host` 改写成源站域名（否则 DNS 指向 VPS 自己会死循环），
于是 Worker 眼里 `request.url` 的主机名永远和浏览器看到的不一样：

```
浏览器  Origin: https://<cf-host>
Worker   request.url = https://<WORKERS_DEV_HOST>/api/sites/1   ← Host 被改写过
```

原来 `isSameOrigin()` 拿这两个 host 相比，**所有写请求**（保存卡片 / 增删改 / 改设置）
一律判跨站；读请求不走这个分支，所以现象是「页面能看、一保存就报错」。
第一轮让 nginx 别转发 `Origin` 是对的，但它要求每一层反代都记得配这一行 ——
漏一层（或像这次一样，用户手里是另一套 nginx 配置）就复发。

### 三、修复：判据换成浏览器自己算的那个头

`isSameOrigin()` 改成 **`Sec-Fetch-Site` 优先**：

1. `Sec-Fetch-Site` —— 浏览器按「发起页面 vs 目标」算出来的，禁伪造头，JS 改不了。
   关键是它**与中间经过几层反代无关**：不管回源 Host 被改成什么，它回答的都是
   「浏览器眼里这次请求是不是同源发的」—— 正是这道校验想问的问题。
2. `Origin` —— 只在没有 `Sec-Fetch-Site` 时才用（老浏览器 / curl），行为与之前完全一致。
3. 两个都没有：放行，交给 `SameSite=Strict` cookie 兜底。

安全性不降：跨站页面发来的请求 `Sec-Fetch-Site` 是 `cross-site`，照样拦；
`same-site`（同站不同源，如子域名）也照样拦；伪造的 `Origin` 骗不过它
（`Sec-Fetch-*` 是禁伪造头，而 `Origin` 非浏览器客户端可以随手加）。

配套把这次拒绝从**纯文本**改成 `errorResponse(ApiError.forbidden(...))`：
纯文本 403 客户端解析不出 message，用户只看到一句「API错误: 403」，
既不知道发生了什么、也没法排查是反代、CDN 还是应用层 —— 这次线上就是卡在这一步。

### 四、测试与文档

- `tests/httpUtils.test.ts`：新增「Sec-Fetch-Site 优先于 Origin」与
  「没有 Sec-Fetch-Site 时才退回 Origin」两组用例（含反代场景与伪造 Origin 两个方向）。
- `tests/authMiddleware.test.ts`：CSRF 拒绝必须回结构化 JSON；
  新增「反代改了回源 Host → Origin 对不上但 Sec-Fetch-Site 是同源 → 放行」。
- `deploy/nginx/README.md`：403 专节补上「Worker 侧已自适应，`Origin ""` 变为可选」。
- `tests/bundleBudget.test.ts`：基线 237.25 → 238.44、预算 250 → 252。
  这是**构建产物漂移**不是新代码（`git diff dc46173..HEAD -- src/` 为空），
  rolldown-vite 换版本后 index 块多 1.19 KB；按用例自己写的出口连同理由一起上调。

单测 2604 全绿；`tsc -b --force` / lint / check:brand / build / smoke /
audit:a11y / audit:contrast 全过。

---

## 2026-10-14 · 工程：VPS 反代方案落地件 + 修掉反代下的写操作 403

起因：`<cf-host>` 实测命中 Cloudflare 欧洲节点（MAN/MAD），RTT≈300ms、
带宽仅 53 KB/s，首屏 4.5s。给出四档加速方案，选定「方案 A：VPS 反向代理」
（回源仍走 Cloudflare Worker + D1，数据不动、可秒级回滚）。

### 一、`deploy/nginx/`：一套可直接部署的反代配置

- `snippets/navi-proxy.conf` —— 公共回源片段（SNI / keepalive / 头处理）
- `sites-available/navihive.conf` —— upstream + 静态缓存 + 登录限速 + 分路径策略
- `README.md` —— 9 步落地手册、10 项验证清单、坑速查表

针对本项目的三处专项处理：
- **登录限速退化**：`loginGuard.ts` 的 `clientBucket()` 优先读 `CF-Connecting-IP`，
  反代后所有请求落进同一个桶（= VPS IP）—— 必须在 Nginx 层用 `limit_req` 补限速。
- **导入进度条**：备份导入是 NDJSON 流式响应，`/api/` 必须 `proxy_buffering off`。
- **回源 Host**：必须是 `*.workers.dev`，写自定义域名会解析回自己形成死循环。

### 二、修复：反代后一切写操作报「API错误: 403」

**现象**：反代上线后页面、列表、详情都正常，但保存卡片等一切写操作失败，
提示光秃秃的 `API错误: 403`（没有后半句人话）。

**根因**：`worker/httpUtils.ts` 的 `isSameOrigin()` 要求「`Origin` 头的 host 等于
`request.url` 的 host」。反代为防回源死循环必须把 `Host` 改写成 `*.workers.dev`
⇒ Worker 眼里 `request.url` 是源站主机，而浏览器发来的 `Origin` 仍是本站域名，
两者不相等 ⇒ `middleware.ts` 返回**纯文本** 403「跨站请求已被拒绝」。
前端 `parseApiError()` 只认 JSON，解析不出 message，就只剩 `API错误: 403`。
读请求（GET/HEAD）不走这个分支，所以表现为「能看不能写」。

**修复**：`deploy/nginx/snippets/navi-proxy.conf` 增加一行，回源时不转发 `Origin` 头：

```nginx
proxy_set_header Origin "";
```

（nginx 规则：`proxy_set_header` 的值为空字符串 = 不发送该头。）
Worker 因此退回 `Sec-Fetch-Site` 判据 —— 同站 fetch 是 `same-origin` 放行，
跨站伪造是 `cross-site` 照样拦，防护不减弱；老浏览器没有该头时由
`SameSite=Strict` cookie 兜底。**改 VPS 上的 nginx 即可，不需要重新部署 Worker。**

README 里补了「API错误: 403」专节，并把它加进验证清单第 4 条。

### 三、三份方案文档（docs/）

- `docs/vps-reverse-proxy-2026-10-14.md` —— 方案 A 详解：收益分段、A1/A2/A3 变体、
  Nginx 要点、五个坑、VPS 选型、灰度与回滚
- `docs/selfhost-plan-2026-10-14.md` —— 方案 B（整站搬到 VPS 自托管）完整落地：
  可行性逐项回查、SQLite 适配器含 4 个坑、可直接运行的桥接代码、数据迁移、工作量估算
- `docs/dual-deploy-arch-2026-10-14.md` —— CF + 甲骨文东京双部署四方案 × 六维度对比

**方案 A vs B 的结论**（延迟模型 `TTFB ≈ 3×RTT + 处理`）：两者只差 55ms，
方案 A 拿到总收益的约 85%，剩下 15% 要付 3 倍工作量 + 数据迁移风险 + 失去秒级回滚
⇒ 先做 A，够用就停。B 真正的优势不在更快，而在不受 Worker CPU/时长配额限制。

---

## 2026-10-13 · 修复：性能报告剩余项全落完（含三处结论更正）

`docs/perf-status-2026-10-13.md` 里 P1/P2/P3 六项全部落地。**先说更正**：那份报告有
三条结论是我照抄更早的分析、没回查代码写错的 —— 已在报告文首标注：

- `sites.password` **早就加密落库**（`insertSite`/`updateSiteRow` 都走 `encryptSecret`），
  不是明文列；真正剩下的是升级前写入的明文行。
- 站点侧**真懒挂载早已有**（GroupCard 的 IntersectionObserver + 分页递增），
  我之前只看到 CSS `content-visibility` 就误判成缺失。
- 因此「加密列」与「移植懒挂载」两条不是新增项。教训记下了：性能结论也要回查代码。

### 一、历史明文站点凭据一次性加密回填（schema 20）

新增迁移 `encryptLegacySitePasswords`：把「升级前落库、之后没再编辑过」的明文密码
加密写回。**先探密钥再动笔** —— `encryptSecret` 拿不到密钥时返回**空串**，照写就是把
老凭据清空（比留明文更糟）。整批失败只记日志，不影响启动；已密文的行不动、空密码不动。

### 二、笔记列表摘要阀门（?fields=list）

列表超过 200 条后自动切摘要（只回开头 200 字），并补齐两件让它安全的事：
① 打开哪条补哪条全文（`ensureFullNote` + NotesPage 里挂在 activeId/sideId 上的一条
effect，覆盖所有打开入口）；② **保存安全闸** —— 正文还是摘要时拒绝写回，先把全文取回来
再让用户保存一次（否则自动保存会把 200 字摘要当成正文写进库）。

### 三、其余三项

- **回收站列表 LIMIT 200**（长期不清理时不再每次打开全表扫 + 逐行 JSON.parse）。
- **FTS 降级可见**：搜索框下方提示「当前数据库不支持全文索引，搜索已降级为逐条匹配」
  ——以前只写在服务端日志里，用户只觉得「搜得慢 / 搜不到」。
- **卡片侧跨设备增量同步**：`site_tombstone`（schema 21）+ `GET /api/sites/changes?since=`
  + `useSiteSync` 轮询（默认 60s，失败静默）。删除是物理删行，只看 updated_at 的轮询
  永远看不见「少了哪张卡」—— 与笔记墓碑同一个解法。墓碑时间戳**带毫秒**：同秒内的
  两次删除靠秒级时间戳分不出先后，会被上一轮游标挡住。
- **App.tsx**：`GroupNavRail` 的数据改用 useMemo（原来每次渲染 map 出新数组，整列跟着
  重渲染）；整块拆域留给 App.tsx 补测试那批。

测试 2591 → **2600**：新增 `sitePasswordBackfill`（4 条真库）、`siteTombstone`（4 条真库，
含「墓碑表缺失退化为空而非 500」）、`dataRoutes` 的 sites/changes 游标透传。
八项校验（tsc / lint / 单测 / check:brand / build / smoke / a11y / contrast）全绿。

---

## 2026-10-13 · 修复：CRUD 审查的全部缺陷一次落完（越权 / 校验 / 往返合并 / 分批）

上一条报告（`docs/crud-audit-2026-10-13.md`）所列问题全部修复。分四组：

### 一、越权与校验（两个 P0）

- **单条编辑/新增站点的 `group_id` 属主校验**：`PUT /api/sites/{id}` 与 `POST /api/sites`
  现在过 `filterOwnedGroupIds`——目标分组不是自己的直接 400「目标分组不存在」。
  批量排序路径早修过同一个洞，这是补齐单条路径。
- **`PUT` sites/groups 与 POST 同一套清洗**：新增 `validateSitePatch` / `validateGroupPatch`
  （PATCH 化：只校验传了的字段），PUT 现在也做 trim、截断（name≤100/description≤500/
  notes≤1000/密码≤500）、URL 规范化、图标危险协议清洗。以前 name 能改成空串、
  备注能写 MB 级、`javascript:` 图标能经编辑入库。凭据字段非字符串**报错**而不是
  静默转空串——手滑传错类型不该变成清空已存的账号密码。
- **前端编辑卡片拦空名称**（`useSiteActions`），与新增对话框对齐。

### 二、D1 往返合并（性能大头）

- **删一条笔记 8 次串行往返 → 3 次**：两个 SELECT 并行；回收站写入、清标签关联、
  吊销分享、删真身、删全文索引、写墓碑、审计全部合进**同一个 `db.batch`**（一次往返 +
  事务），顺带消掉「行删了但墓碑/索引没跟上」的中间态。
- **存一条笔记 5 次 → 3 次**：UPDATE 加 `RETURNING` 省掉回读；并发冲突改按
  「RETURNING 空结果」判定，不再依赖 `meta.changes`（旧写法在拿不到 changes 的环境里
  会把冲突当「改到了」，乐观锁静默失效）；版本快照 + 裁剪 + FTS 同步合进一个 batch。
- **删除分组/站点 3 次 → 2 次**：回收站写入 + 删真身 + 审计进同一 batch（分组场景两个
  SELECT 并行）。**批量删除**的回收站写入从「N 条并发 INSERT」改为按 200 条/批的 batch。
- **审计并入删除事务**（site.delete / site.batchDelete），并**补齐删除类留痕**：
  `group.delete` / `note.delete` 现在也写审计（以前数据域只有卡片删除两条）。

### 三、健壮性

- **笔记导入提交批按 250 条/批切片**：以前整批一次性 batch，大导入（几百条笔记+标签+关联）
  会撞 D1 单次 batch 语句数上限 → 整个导入 500。中途失败已提交的批保留，
  `stats.warning` 如实提示（重新导入按 uuid 续传，不会重复建）；FTS 重建批同样切片。
- **`note-orders` PUT 逐项校验**元素形状（缺 id/order_num 现在回 400，以前 undefined 进
  bind 变 500）。
- **单查 sites/groups/{id} 不存在回 404**（以前 200 + null，与笔记的 404 不一致）。
- **`GET /api/sites?groupId=非数字` 回 400**（以前 NaN 进 bind，行为未定义）。

### 四、索引

- 新增 `idx_sites_user_group`（`sites(user_id, group_id)` 复合索引），**SCHEMA_VERSION
  18 → 19**（索引步骤同样吃版本快路径，不升号老库永远建不上）。

守卫同步升级：`noteRecycle.test.ts` 的 deleteNote 形状守卫改为「全副作用进同一 batch」；
`dataRoutes.test.ts` 新增 8 条（越权 400 ×2、PUT 清洗 ×3、note-orders 400、单查 404、
groupId 400）。真 SQLite 用例（含乐观并发冲突、删后还原、FTS 清理）全绿。

---

## 2026-10-13 · 工程：CRUD 全面审查 + 性能瓶颈分析（报告，不含行为变更）

`docs/crud-audit-2026-10-13.md`。静态审查了站点/分组/笔记（文件夹/标签/版本/附件/分享）、
配置、回收站、备份导入导出的增删改查全链路（路由层 + 实现层 + 前端表单）。要点：

- **两个 P0**：① 单条 `PUT /api/sites/{id}` 与 `POST /api/sites` 的 `group_id` 没有属主校验
  ——批量排序路径修过同一个洞（`filterOwnedGroupIds`），单条路径漏修，多账号下可把卡片
  塞进别人分组；② `PUT` sites/groups 不走 POST 那套校验清洗（无截断/不拦空名/icon 不过
  `sanitizeIconUrl`），MB 级脏数据会经全量 bootstrap 拖垮首屏。
- **性能两处大头**：删一条笔记 8 次串行 D1 往返（可合并到 3 次，batch 顺带消中间态）；
  存一条笔记 5 次串行往返（`RETURNING` 省回读、快照并入 FTS batch → 3 次，顺带把
  乐观并发对 `meta.changes` 的依赖换成 RETURNING 空结果判定）。
- 其余：笔记导入提交批不切片（大导入整批回滚）、`note-orders` 不验元素形状（500 应为
  400）、单查 sites/groups 不存在回 200+null 与笔记 404 不一致、数据域审计只留卡片删除等。
- 已确认没问题的：scopeSql 隔离、软删除收口、幂等/限速/乐观并发、索引覆盖、
  前端请求模式（两轮性能批次成果都在位）。

---

## 2026-10-13 · 测试：AI 三件套渲染用例（33 条），覆盖率清单只剩 App.tsx

覆盖率体检清单的第三名（`useAiAssistant` 181 行 / `AiAssistantDialog` 480 行 / `AiSuggestDialog` 288 行，合计 949 行）全部补完。
这三个文件是所有 AI 按钮的公共闸门（ready/reason）、私密凭据唯一的编辑入口、以及 AI 建议落地前「不自动应用」的勾选闸门。

### 一、新增三个测试文件（33 条，单测 2549 → 2582）

- **`tests/useAiAssistant.dom.test.tsx`（12 条）**：ready/reason 三态推导（状态未知 / 没开 / 缺配置 / 齐全）、
  **返回对象跨渲染稳定**（App 把它传给几百张 memo 的 SiteCard，这是硬契约）、五个动作的失败包装
  （一律 `{ok:false, message}` 不抛异常，含四处兜底文案）、`refresh()` 失败把状态打回「未知」。
- **`tests/aiAssistantDialog.dom.test.tsx`（14 条）**：打开即重读配置、**读配置失败也能编辑**（落空配置不卡「读取中」）、
  两种 provider 的字段切换、**「测试连接」用当前填的这份（不必先保存）**、测试失败保留分项结果、
  改字段清掉旧测试结果、保存全量写 8 个键且先 `onSaved` 再 `onClose`、保存失败不关弹窗。
- **`tests/aiSuggestDialog.dom.test.tsx`（7 条）**：打开先问一次 AI（参数原样）、名字回退
  （空名字用 URL、未知 id 用「站点 N」）、空标签给「建议分组」、**应用只带勾选的**（分组字段不进 onApply，
  分组不自动挪）、全不选禁用应用、失败与空建议的兜底文案。

### 二、这轮没有抓到产品 bug —— 但抓到了两个「测试会怎么被骗」的坑

与前两批不同，这次 AI 三件套的产品代码无恙（异步失败路径都收口了）。真正的收获是两条测试基建经验：

- **假体形状错了会被弹窗「吞掉」**：`AiAssistantDialog` 的 `ai.test()` 拿到的是 hook 转换后的
  `AiTestOutcome`（`{ok, message, ...}`），不是 POST ai/test 的原始 `AiTestResponse`。假体照原始响应做的话，
  组件读 `.ok` 全是 undefined，**Alert 照样渲染但内容是空的** —— 断言失败时看不出是测试错了还是产品错了。
- **这套 MUI 的 warning 警示条类名是 `MuiAlert-colorWarning`**，不是惯常的 `MuiAlert-standardWarning`；
  另外 `Collapse` 收起时子节点仍在 DOM（见第 4 条老坑），「收起时元素不在」的断言要改判 `aria-expanded`。

### 三、覆盖率推进

触及 247 → **250** / 286 个源文件；零覆盖 39 → **36 个（7723 → 6774 行）**。
补测试顺序清单只剩最后一项：**`App.tsx`（2076 行）**。详见 `docs/coverage-checkup-2026-10-13.md`。

---

## 2026-10-13 · 修复 + 测试：书签导入弹窗渲染用例（14 条），再抓一个自相矛盾的计数

覆盖率体检清单上「坏了最难发现」的第一名（`BookmarkImportDialog` 380 行，备份恢复导入 UI）。
它做的是**导入前的体检**（新增 / 重复 / 无效三类），判错的后果不是报错，而是把库里已有的
卡片再复制一份、或者把 `javascript:` 书签脚本导成点不动的卡。

### 一、新增 `tests/bookmarkImportDialog.dom.test.tsx`（14 条）

夹具是**真的 Netscape 书签 HTML**（`collectRaw` 走 `DOMParser`），覆盖了两种文件夹写法：
- **嵌套**（`<DT><H3>名</H3><DL>…</DL>`，Chrome/Edge/Firefox 导出用的）
- **并列**（`<DT><H3>名</H3></DT><DL>…</DL>`，手写或老导出）
—— `folderOf` 的注释里写着：只认并列写法时，浏览器导出会**整份落进兜底分组**。两条都钉住。

覆盖：三类统计 chips、文件夹行的「将导入 / 跳过」数、重复链接展开预览（含「已存在于哪个分组」）、
「连重复一起导入」开关重算、取消某个文件夹后 `onImport` 只收选中的、无可导入时按钮禁用、
导入中进度条 + 防重复点击、成功/取消/关闭三条路径都 reset。

### 二、修掉一个自相矛盾的计数显示

打开「连重复一起导入」后，文件夹行的「跳过数」仍把重复项算进去 —— 同一行同时显示
「**2 个将导入 · 跳过 1 个**」，而 `items.length` 里那条重复本来就已经算进将导入了。
用户看到的是「到底导不导？」。修法：`includeDuplicates` 打开时跳过数不再计重复项
（无效项不受开关影响，仍然跳过）。

### 三、测试基建的两个坑（记下来省得再撞）

- **React 对 checkbox/radio 的 `onChange` 监听的是 `click`，不是 `change`** ——
  用「原生 setter 翻 `checked` 再派发 change」的标准文本框手法对复选框完全无效；
  要用原生 `.click()`（它会跑激活行为把 `checked` 真翻过来）。
- **`mount` 里 `void` 掉的异步准备动作会与调用方随后的 `act` 交叠**，实测第二次挂载
  整个渲染不出来（`document.body` 只剩一个空 div）。改成 `await mount(...)`，一条不落。

### 四、校验与覆盖率

`tsc -b --force` 0；lint 0 error；单测 2535 → **2549**（新增 14，0 失败）；
`check:brand` 一致；build 通过；smoke 全 PASS；`audit:a11y` / `audit:contrast` 0 处不合格。
覆盖率：触及 246 → **247**，零覆盖 40 → **39** 个（8103 → 7723 行），目标文件脱离名单。
关键守卫（跳过数不计重复）已反向验证。

## 2026-10-13 · 修复 + 测试：补分享 UI 三件套渲染用例，顺手抓出两个「卡在加载态」的真 bug

覆盖率体检（`docs/coverage-checkup-2026-10-13.md`）的结论是「风险全在前端，最突出的是分享 UI」——
后端有单测和 `e2e:share` 守着，前端三个文件却是零覆盖。本轮把这三件套补上，共 **32 条**用例。

### 一、新增三个直测文件

- `tests/groupShareDialog.dom.test.tsx`（14 条）
- `tests/publicNotePage.dom.test.tsx`（9 条）
- `tests/publicGroupPage.dom.test.tsx`（9 条）

写法照 `addSiteDialog.dom.test.tsx` / `BackupDialog.dom.test.tsx`：`createRoot` + `act` 直接挂载单组件，
props 摆好就能钉界面行为。等待一律用**轮询**（`waitFor`）而不是固定 sleep —— CI 慢机上固定睡眠会偶发不够用，
而偶发红的测试比没有测试更糟。

### 二、修掉两个「卡在加载态」的真 bug

两个都是「异步读失败时，标志位在 await 之后才置位」这一类：

1. **`GroupShareDialog` 读配置失败 → 永远停在「读取中…」**
   `setLoadedOnce(true)` 放在 `await api.getGroupShareConfig()` 之后，一抛错就永远执行不到。
   用户只看到一条错误提示，弹窗里却连创建按钮都没有，没有任何出路。改成 `finally` 里置位。
2. **`PublicGroupPage` 网络失败 → 永远停在「正在加载分享…」**
   `catch` 里只 `setNotFound(true)` 没改 `state`，而渲染分支第一条就是
   `if (state === "loading")` —— 访客看到一个转不完的加载态。改成同时 `setState("not-found")`。

⚠️ 这两个 bug 有一个共同点：**都不报错，只是让人干等**。静态守卫和类型检查都抓不到，
只有真把组件拉起来跑一遍才会暴露 —— 这正是这三个文件零覆盖的代价。

### 三、钉住的几条关键契约

- **口令的三种语义**（`GroupShareDialog`）：创建时空串要归一成 **null**（不设口令）；
  更新时**没动过必须传 `undefined`**（保持原口令）。谁把后者「顺手简化」成 `password || null`，
  用户只想改有效期、口令却静默被清掉，界面上没有任何提示。
- **两处 need-password 形状不同**（`PublicNotePage` vs `PublicGroupPage`）：笔记分享在 worker 里转成
  **HTTP 401 + 顶层 `needPassword`**；分组分享是 `Response.json(result)` 直出，**恒 200**，
  需要口令时 body 是 `{status:"need-password"}`。给分组分享也加个 HTTP 状态判断，
  访客在该看到口令框的时候会看到一片空白 —— 专门有一条用例用「反常 HTTP 状态 + 正常 body」钉住它。
- **两种错误形状都要认**（`PublicNotePage`）：迁移后是 `{error:{code,message}}`，老服务端是
  `{error:"字符串"}`。直接读 `data.error` 会显示 `[object Object]`（迁移时在这个组件里踩过）。
- **公开页脱敏是纵深防御**（`PublicGroupPage`）：服务端 SELECT 就不带 username/password，
  用例仍然在响应里塞这两个字段，断言页面上一个都不出现。
- 附件路径改写（访客没有 cookie，`/api/notes/attachments/` 会 401）、`/sg/<token>` 路由、
  撤销必须两次点击、标签页标题随笔记标题变化。

### 四、校验与覆盖率变化

`tsc -b --force` 0；lint 0 error（19 条既有 react-refresh 类噪音）；
单测 2503 → **2535**（新增 32，0 失败）；`check:brand` 一致；build 通过；smoke 全 PASS；
`audit:a11y` / `audit:contrast` 0 处不合格。

覆盖率：触及 243 → **246** 个，零覆盖 43 → **40** 个（8635 → 8103 行）。
三个目标文件全部脱离零覆盖名单。每条关键守卫都做了**双向反向验证**
（把组件改回旧写法，确认对应用例会红）。

## 2026-10-13 · 工程：覆盖率体检 + 修好覆盖率脚本（`npm run coverage` 原来是崩的）

完整报告：`docs/coverage-checkup-2026-10-13.md`。

### 一、顺手修掉一件事：覆盖率脚本本身是坏的

`npm run coverage` 一跑就崩 —— esbuild 报 60 个
`No loader is configured for ".woff" files`。原因：`script/coverage.mjs` 的 esbuild
配置少了字体/样式 loader，而某些用例会连带引入 `katex.min.css`（里面 `url()` 指向
十几张 woff2/ttf）。`script/unit-tests.mjs` 早就配了同一套，覆盖率脚本漏抄。
补上即好。⚠️ 值得记一笔：**覆盖率工具坏了比没有覆盖率更糟** —— 它让人以为「没数据」而不是「工具坏了」。

### 二、数据

| 口径 | 数值 |
|---|---|
| 源文件（src/ + worker/，排除 .d.ts） | 286 个 |
| 被任何用例间接引入 | 243 个（85%） |
| **从未被引入** | **43 个（15%），合计 8635 行** |

口径是**文件触及率**（被任何用例 import 到就算触及），不是行覆盖率。

### 三、结论：风险不在后端

43 个未触及文件里 `worker/` 只占 2 个，而且两个都是**纯类型声明**
（`worker/types.ts` 181 行、`worker/routes/types.ts` 32 行，运行时可执行声明数实测为 0）。
**所有带逻辑的 worker 模块都至少被一个用例引入过** —— 分享、备份、WebDAV、图标代理、
迁移、登录守卫这些高风险路径的后端实现没有一个是零覆盖的。

### 四、风险集中在分享 UI（本次最该注意的一处）

| 文件 | 行数 | 状态 |
|---|---|---|
| `src/components/GroupShareDialog.tsx` | 243 | ❌ 零覆盖 |
| `src/components/PublicGroupPage.tsx` | 158 | ❌ 零覆盖 |
| `src/components/PublicNotePage.tsx` | 131 | ❌ 零覆盖 |
| `src/components/NoteShareDialog.tsx` | — | ✅ 有真渲染用例 |

- **一个不对称**：笔记分享对话框有真用例，分组分享对话框没有 —— 两者同一天
  （2026-10-11 阶段④）按同一套语义加的，测试只跟着前一批写了。
- ⚠️ **「有测试提到」≠「有测试覆盖」**：这三个文件都有守卫提到，但那是**读源码字符串**的
  文本守卫（`readSrcFile`），不是把组件拉起来跑。文本守卫钉得住「挂载条件写在哪儿」，
  钉不住「口令错了提示什么、撤销之后界面怎么变」—— 而分享的坑全在交互侧。
- 分享因此成为**唯一「后端有覆盖（单测 + 本轮新增的 `e2e:share`）、前端零覆盖」的成片功能**。

其次是 `BookmarkImportDialog.tsx`（380 行，备份恢复的导入 UI —— worker 侧有覆盖，
用户实际点的那条路没有）与 AI 三件套（949 行，但坏了好发现，优先级低）。
`src/App.tsx` 2076 行是全仓最大零覆盖文件。

### 五、明确不做

不设覆盖率门槛、不卡 CI（覆盖率是导航用的，先有数据再谈数字）；
不装 c8（新增 devDependency 会影响 CI 安装步骤，而第 1 层清单已够回答「下一个该补谁」）。

## 2026-10-13 · 工程：错误码第二批 —— `{ success: false }` 那副老面孔，70 处迁完

第一批（`17149bf` 之前）盯的是 `Response.json({ error: "..." })`。这一批是另一副更隐蔽的面孔：
`Response.json({ success: false, message })` —— 它看起来像个正常响应体，只是 `success` 是假的，
客户端只能把 `message` 显示出来，照样拿不到机器可读的 code。

### 一、先清点：98 处不是 98 个错误

拿保行剥注释的扫描器把 `worker/` 下所有 `{ success: false }` 数出来，**按形状分成三类**，
只迁该迁的那类：

| 形状 | 处数 | 处置 |
|---|---|---|
| 真正的失败出口（HTTP 4xx/5xx + `{success:false, message}`） | **70** | 全部迁到 `ApiError` + `errorResponse` |
| 内部辅助函数的**返回值**（`webdav/index.ts` 22、`notesBackup.ts` 2） | 24 | 不迁：调用方（`backup.ts`）拿它决定下一步、自己挑状态码，迁了就把两层揉成一层 |
| **结果对象**而非错误 | 4 | 不迁：`ai.ts` 1 处带 `done`/`total` 是「做到第几笔失败了」的部分成功；`backup.ts` 3 处是 **HTTP 200** + `{success, code?, message}`（`webdav/notes` 的 list/download，客户端查 `.success` 和 `.code`，`code='encrypted'` 时弹口令框）——迁成 4xx 会同时改状态码和分流方式 |

⚠️ 这 4 处是这次清点**最重要的发现**：它们和失败出口长得一模一样，只看 `{success:false}`
会一并迁错，而迁错的表现是「恢复备份弹个错误框但其实成功了」。

### 二、迁移 70 处

`index.ts` 1、`loginGuard.ts` 2、`idempotency.ts` 1、`account.ts` 14、`backup.ts` 12、
`config.ts` 9、`data.ts` 15、`middleware.ts` 2、`ops.ts` 7、`public.ts` 6、`ai.ts` 1（改 `bad()` 一个函数，覆盖 18 个调用点）。
**状态码与文案一字未改**，只是多一个 machine-readable 的 code；带 `Retry-After` 的出口头也一并保住。

`ai.ts` 那个 `bad(message, status)` 是全模块唯一出口，改法是查表：状态号 → 工厂，
表外的号（上游模型可能回任何东西）原样带回状态码、code 归 `internal` —— 保状态码优先于给个漂亮的码。

`config.ts` 有一处原来只有 `{ success: false }`、**连 message 都没有**（客户端只能显示「API错误: 403」）。
迁移时补了「管理员凭据不可删除」，这是本次唯一新增文案的地方。

### 三、客户端：19 处不走 `request()` 的裸 fetch

迁移对走 `request()` 的 54 处是透明的（它本来就用 `parseApiError` 认两种形状）。
但登录 / 注册 / 邀请码 / 注销账号 / 恢复密码 / 导入 / 账号清单 / 沉睡扫描这几条是**裸 fetch**，
原来直接读 `data.message` —— 服务端换成新形状后 `data.message` 就没了，界面会显示一句空话。
统一改成走 `parseApiError`（`client.ts` 加了一个 `rawError` 助手；`authFlow.ts` 的
`readSweepResult` 多收一个 `status` 参数）。新增 6 条用例钉住「新形状下文案不丢」。

### 四、守卫：`tests/errorCodeMigration2.test.ts`（5 条）

白名单制而非「一处都不许有」：把每处保留的数量**写死**，多一处会红（又写了旧形状），
少一处也会红（白名单里那处被顺手迁掉了，回来更新口径）。另钉住 92 处
`errorResponse(ApiError.…)` 只增不减、12 条文案没被改掉、以及「守卫自身没跑空」。
已**双向反向验证**：把 `ops.ts` 一处改回旧形状 → 2 条红；删掉 `backup.ts` 一处白名单 → 2 条红。

### 五、校验

`tsc -b --force` 0；lint 0 error（19 条 warning 均为既有 react-refresh 类噪音）；
单测 **2503**（2492 → 2503，新增 **11** 条：守卫 5、裸 fetch 形状 6）；
`check:brand` 一致；build 通过；smoke 全 PASS；`audit:a11y` / `audit:contrast` 0 处不合格。

## 2026-10-13 · 工程：分享功能端到端（CI 新增 `e2e:share`，补上唯一「线上从未实测、零 e2e 覆盖」的成片功能）

分享是整套系统里唯一一块**从来没在真后端上跑过一遍**的成片功能 —— 而它坏了是静默的：
链接打不开，只是别人收不到内容，控制台里一片安静。所以这条不是「再加几条断言」，
是把「建分享 → 访客访问 → 口令校验 → 更新 → 撤销」整条链按**匿名访客**的顺序真打一遍。

### 一、新增 `script/share-e2e.mjs`（约 313 行）

复用 `e2eEnv.mjs` 的 `resolveWorkerConfig` / `pickPort` / `startWrangler` / `waitReady` / `createChecker`，
起一个 wrangler dev（本地 D1、每次一套全新持久化目录与全新凭据）。分两段：

**笔记分享**（`notes/<id>/share` + 公开端点 `note-shares/<token>`）：
新库首登要求改密 → 改密后令牌当场失效、重新登录 → 建分组/站点/笔记 →
非法有效期 `days:3` 回 **400 + `bad_request`** → 建带口令分享 →
匿名 GET 回 **401 + 顶层 `needPassword`**（公开页靠这个弹框）、**不带正文**、带 `no-store` + `noindex` →
口令错也 401 且不漏正文 → 口令对拿到正文 + `Set-Cookie` 打上防刷当日戳 →
`PUT` 更新有效期** token 不变** → `PATCH` 回 **405 + `method_not_allowed`** →
`DELETE` 撤销 → 同一 token 立刻 **404 + `not_found`**（带正确口令也是）→ `GET` 配置为 `null` → 不存在的 id 404。

**分组分享**（`groups/<id>/share` + `group-shares/<token>`）：匿名读成功且**脱敏**
（建站点时刻意带上 `username`/`password`，断言公开响应里这两个值一个都不出现）、
带口令时匿名 GET 回 `need-password`、口令对拿到内容、口令错仍是 `need-password`、撤销后 `not-found`。

⚠️ 两处的错误码形状**不一样**，脚本按实际契约分别断言：笔记分享的 `need-password` 在
`public.ts` 里被转成 **401 + `extra: { needPassword: true }`**；分组分享那条分支是
`Response.json(result)` 直出，**恒 200 + `{status:"need-password"}`**。照抄笔记那套断言会假红。

### 二、接线

- `package.json`：新增 `"e2e:share": "node script/share-e2e.mjs"`，插入 `ci` 链的 `e2e` 之后。
- `.github/workflows/ci.yml`：在「后端 API 端到端」之后加「分享功能端到端」步骤（必须排在构建之后，跑的是 `dist/` 里的产物）。

### 三、校验

`tsc -b --force` 0；lint 0 error；单测 **2492**（2492 通过 / 0 失败，本轮无新增用例）；
`check:brand` 一致；build 通过；smoke 全 PASS；`audit:a11y` / `audit:contrast` 0 处不合格。
⚠️ `e2e:share` **本机跑不了**（workerd 0xc0000005，上游 workerd#4668，最小 worker 同样崩），
与 `e2e` / `e2e:cron` / `e2e:webdav` 一样由 CI（ubuntu）覆盖。

脚本是照着 worker 源码逐条核对写出来的，核出并修掉三处契约偏差（都是脚本侧写错，不是产品 bug）：
登录路径写成 `auth/login`（实际是 `/api/login`，客户端 `client.ts` 就是这么调的）；
建分组/建站点漏了 `order_num`（`validateGroup`/`validateSite` 都要求它是安全整数，漏了会 400）；
防刷 cookie 名写成 `note-view-<数字>`（实际是 `nh_noteview_<token>`，来自 `shareViewCookieName`）。

**第一轮 CI 抓出第四处，也是唯一一处「契约比代码严」的**：`hasPassword` 我按 `=== true` 断言，
过网实际是 **1/0** —— SQL 里写的是 `(password IS NOT NULL) AS hasPassword`，SQLite 没有布尔类型，
D1 原样回整数。既有真库测试（`groupSharesRealSql.test.ts:38` 用 `!!created!.hasPassword`）与前端
（`NoteShareDialog.tsx:112` 用 `!!value?.hasPassword`、`GroupShareDialog.tsx:137` 用三元）都按真值判，
所以这不是产品 bug，是断言写严了。改成 `!!` 真值判断。⚠️ 顺带记一笔：`src/API/types.ts` 把
`hasPassword` 声明成 `boolean`，与过网的 1/0 不符 —— 所有调用方都按真值用所以没出事，
但要改就得同步动前端与一批测试，收益为零，本轮不动。

## 2026-10-13 · 性能：首屏请求 20 → 15、打开记事本 1218 → 965 KB；错误码迁移收尾（30 处 → 0）

接着上一轮「78 → 20」往下挖的两块，加上欠了很久的工程债。

### 一、首屏：JS 请求 10 → 5，总请求 20 → 15

- **`GroupCard` 里那个「假 lazy」残留**：`EditGroupDialog` 外面只是 `<Suspense>`、整段无条件渲染 —— 而 `React.lazy` 只要被**渲染**就会立刻下载那个块，`open={false}` 拦不住。首页有几个分组就白下几次（实测一个 3.9 KB 的请求）。改成 `<ChunkBoundary when={editDialogOpen}>`：只有真点开才挂载，关闭后延迟 320ms 卸载（MUI 退出过渡约 195ms）。⚠️ 上一轮那一批改的是 App / OverlayHost，这一处是漏网的。
- **`MaintenanceBanner` 改回静态 import**：它必须常驻（自己每 60 秒轮询维护状态），lazy 省不掉下载、只剩一个 790 字节的独立请求 —— 而这条链路上一次往返比这 790 字节贵得多。并进入口块后 index 236.63 → **237.25 KB**（余量 5.4%，仍守得住 5% 那条线），换来少一次往返。
- **试了并回退的一刀**：把 `preload-helper`（3.2 KB）并进 `vendor`。块确实消失了，但 rolldown 立刻自己冒出一个 `rolldown-runtime` 块（1.1 KB）顶上 —— 它是 rolldown 内部发的运行时块，`manualChunks` 管不到（调试打印确认 manualChunks 回调里根本见不到这个模块 id）。净收益为零，回退。⚠️ 同理，`modulepreload-polyfill` 也别关：老一点的 Safari 认不出 `<link rel=modulepreload>`，关掉会让那些机器上的块晚一步才被发现，在这条链路上那是更贵的代价。

### 二、打开记事本：1218.7 → 965.2 KB（少 253 KB，请求 16 → 15）

- **katex 被硬并进 `markdown` 块，于是每篇笔记都要下它**。用 sourcemap 反推块构成：markdown 块 345 KB 里 **234.9 KB（71%）是 katex**，而 `MathNode` 里那句 `import("katex")` 只在真渲染公式时才跑 —— 块却已经提前下来了。根因在 `vite.config.ts` 的 manualChunks 把 `markdown-it` 与 `katex` 钉进了同一个块。拆成独立块后：没公式的笔记少下 235 KB JS + 29 KB CSS，有公式的笔记多一个请求。
  双向验证过（新探针 `harness/katex-on-demand-probe.mjs`，给桩加了 `STUB_MATH` 开关）：**无公式时 katex 块与样式 0 请求；有公式时必须请求到且页面出现 `.katex` 元素**。
- **CodeMirror 那 552 KB —— 结案为「依赖链拿不掉」**：用 sourcemap 拆开是 `@codemirror/view` 169 KB、`@lezer/javascript` **76 KB**、`@codemirror/state` 46 KB、`@lezer/markdown` 35 KB…… 其中约 136 KB（JS / CSS / HTML 三个语法包）来自 `@codemirror/lang-markdown → lang-html → lang-css + lang-javascript` 这条**强制传递依赖**（查了 package.json，lang-html 是 lang-markdown 的 dependencies，不是可选项）。要拿掉就得放弃 markdown 里嵌 HTML/JS/CSS 代码块的语法高亮，而改成按需会把「打开笔记到能打字」这段卡住 —— 在这条链路上不划算。
- **NotesOverlay 274 KB 里的「点开才用」那批（设置对话框 33 KB、图谱 8.8、附件管理 6.7、zip 6.5 …）—— 不做**：合计约 62 KB，拆出去意味着每次用到都要多一次请求，对「打开笔记就顺手改个设置」的人是把 62 KB 换成 1~3 秒，来回相抵；而 NotesPage 那些弹窗的 props 都不轻，为这点收益动它不值。

### 三、错误码迁移收尾：剩余 30 处 → 0

- **先补能力**：`errorResponse(err, { headers, extra })`。卡住的那批出口正是**带响应头**的（分享与图标端点的 `no-store` / `Referrer-Policy` / `X-Robots-Tag` —— 错误响应被中间缓存留下来、或者把「这条分享存在」泄露给搜索引擎，都是实打实的问题）。`extra` 是为了公开笔记那个 401：它要在**顶层**多带 `needPassword`，塞进 error 对象里客户端就得往下钻一层。顺带把 405 / 410 / 501 / 502 四个状态号与对应 code 补齐（原来这几个出口因为「联合类型里没有」只能继续写裸 `Response.json`）。
- **迁移 31 处**：`data.ts` 25、`public.ts` 5、`icon.ts` 3，外加静态守卫扫出来的 `config.ts` 1 处（「管理员凭据不可读取」那条 403，我原先的清点漏了它 —— 守卫视而不见的正是这种）。含 4 处藏在成功响应里的 `share ?? { error: "..." }`。**状态码与文案一字未改**，只是多一个机器可读的 code；配额那条（501/400/409/413/429 五种状态号）按号挑 code，状态号照原样回。
- **客户端唯一需要跟着改的一处**：`PublicNotePage` 那条 401 不走 `client.request`（公开页没有登录态），原来直接读 `data.error` 当字符串 —— 新形状下会拿到对象、界面上显示 `[object Object]`。改成走 `parseApiError`，新旧两种形状都认（老服务端不受影响）。
- **新增守卫 `tests/errorCodeMigration.test.ts`**：扫 `worker/` 下所有源码（剥注释后）不许再出现 `Response.json({ error: ... })`，并钉住六条文案没被改掉。⚠️ 剥注释是必须的：`worker/lib/apiError.ts` 的文件头注释里就写着 `Response.json({ error: "密码强度不足" })` 这个示例，不剥会永远红在它自己要说明的那段文字上。
- **跟手修的一处测试基建**：`configRoutes.test.ts` 的 dispatch 没套 `errorResponse`（`dataRoutes.test.ts` 早就套了），于是那条 403 在测试里变成抛异常。补上同一层兜底。

- **校验**：`tsc -b --force` 0；lint 0 error（19 条 warning 均为既有 react-refresh 类噪音）；单测 **2492**（2491 通过 / 1 跳过 / 0 失败，本轮新增 **8** 条：errorResponse 附加头 4、迁移守卫 3，另有 lazyBoundary 与 bundleBudget 各补 1 条防回归）；build 通过；smoke 全 PASS；`check:brand` 一致；`audit:a11y` / `audit:contrast` 0 处不合格。真机探针：首屏清单 5 个 JS / 15 个请求、katex 双向 4 PASS / 0 FAIL。⚠️ `e2e` / `e2e:cron` / `e2e:webdav` 本机跑不了（workerd 0xc0000005，上游 workerd#4668），由 CI（ubuntu）覆盖。

## 2026-10-13 · 性能：首屏请求数 78 → 20（性能优化方案里的 P0 / P1 / P2 一次做完）

10-12 那份《性能优化方案》待办清单的全部条目。这条链路上**每个请求要付 1~3 秒的固定往返**
（实测一个 10 字节的接口 TTFB 3.85 秒），所以衡量口径是「请求数 × 固定往返 + 字节 / 吞吐」，
**请求数比字节贵得多** —— 下面几处「多下几 KB 换少十几个请求」都是按这笔账做的。

**总账**（本地探针，绕过 Service Worker、首屏 + 打开记事本两阶段合计）：
请求 **94 → 37**、其中 JS **67 → 16**、字节 2457 → 2276 KB。
首屏单独看：78 → **20** 个请求、JS 61 → **10** 个、1160.7 → **998 KB**。

- **P0-1 分块合并，以及比碎片更值钱的「假 lazy」**：`React.lazy` 只要被**渲染**就立刻发请求下载 chunk，和 `open={false}` 无关 —— 所有弹窗都无条件挂着，于是首屏一下就是 61 个 JS 请求。给 `ChunkBoundary` 加 `when` 按需挂载（App 11 处 + OverlayHost 5 处，卸载留 320ms 给退出动画），再把 `@mui/@emotion/@popperjs/@floating-ui` 按**反向判定**（只被动态边界引用的）合并成 `mui-lazy` 一块，首屏真正要用的那部分交回 Rollup。chunk 总数 169 → 134、<10KB 的 109 → 79、首屏文件 18 → 6。⚠️ rolldown 下 `minChunkSize` 不生效（加了完全没变化），`getModuleInfo().isEntry` 在 manualChunks 回调期间也不可靠（实测命中 0 次），别再往这两条路上试。
- **P0-2 图标批量接口（`/api/icons?u=a&u=b&u=c`）**：首屏十几个 `<img>` 各发一次 `/api/icon`，在这条链路上就是十几次固定往返。服务端一次最多 30 条、并发抓取、按**条数**限速、单条失败不影响其它；响应 `Cache-Control: private, max-age=86400` + `Vary: Cookie`（带凭据的结果不能进共享缓存）。客户端 `utils/iconBatch.ts` 负责 key 对齐（服务端按**原始地址**回、卡片按**代理地址**读）。实测单条 `/api/icon` **6 次 → 0 次**，批量 1 次。
- **P0-3 首页 HTML 短缓存**：`/` 与 `/index.html` 从 `max-age=0, must-revalidate` 改成 `public, max-age=60`。回源一次要 2~4.6 秒而入口 HTML 只有几 KB，用户不该为一个几乎不变的文件每次付一次跨境往返。代价写在 `_headers` 的注释里：缓存期内发版，用户最多拿到 60 秒前的旧 HTML（它引用的是旧 chunk，CDN 上还在，**不会白屏**），要立刻生效就部署后 purge 一次。
- **P1-1 启动请求合并**：`bootstrap?full=1` 把「当前账号身份 + 恢复密钥是否已配置」一起带回来，省掉 `auth/me` 与 `auth/recovery-status` 两次请求。用可选字段 + `identityFromBootstrap` / `recoveryFromBootstrap` 两个 ref，老服务端（不带这两个字段）与老前端双向兼容。实测首屏 API 9 → **5** 次，其中图标批量 1 次、`bootstrap` / `init` / `ai/status` 各 1 次。
- **P1-2 公式与高亮**：现状已经是「渲染到公式才 dynamic import katex」，高亮也没有第三方语言包 —— 没有可改的，改为补静态守卫钉住（`tests/markdownMath.test.ts`），防止哪天被改回同步 import。
- **P1-3 笔记列表字段裁剪**：`/api/notes?fields=list` 用 SQL `substr(content,1,200)` 取摘要、被截短的打 `content_truncated`。⚠️ **前端暂不启用**：列表要全文才能渲染摘要与搜索，启用反而多一次「点开再取正文」的往返。只落服务端能力与开关，用真 SQLite 测试钉住（3 条），等哪天出现「只显示标题的极简列表」再接。
- **P1-4 迁移缓存**：模块级 `migrationState.promise` 本来就有，补真 SQLite 计数测试（2 条）钉住「换实例第二次 migrate 一条 SQL 都不发」—— 导航 API 每次请求 new 一个实例，实例字段是跨不了请求的，这个前提被改动时测试要红。
- **P2-1 自动保存**：3 秒 → **失焦 / 停止输入 5 秒**。3 秒的定时器在这条链路上意味着「一直在打字就一直在发请求」，改成 5 秒 + 窗口失焦 / 切后台立即落盘（`blur` + `visibilitychange`），省下的往返更多而数据一样安全。
- **P2-2 图标 IndexedDB 持久化**：现状已具备（`icon-blob` store，上限 300 条 / TTL 7 天），无需改动。
- **P2-3 关键 CSS 内联 —— 不做，三条理据**：① 这是无 SSR 的 SPA，`index.html` 的 body 基本是空的，**不存在「首屏关键 CSS」这个子集**；② CSS 只有 18.1 KB（gzip 4.6 KB）且在 `/assets/*` 下是 `immutable` 一年强缓存，内联会把它拖进刚改成 60 秒 TTL 的 HTML，重复访问反而每次重下这 4.6 KB；③ CSS 与 5 个 JS **并行**下发，不额外占用串行往返。
- **P2-4 字体 —— 无事项**：全仓零 woff/ttf/otf、无 `@font-face`、无 Google Fonts 外链（Roboto 此前已删，产物少 144 KB）。
- **P2-5 记事本入口预取**：记事本按钮 hover / 聚焦时预取入口块 `NotesOverlay`，**只预取入口**（编辑器 + 预览那 912 KB 不预取 —— hover 一下就下这么些太贵），模块级标记保证只做一次。
- **顺手一刀：恢复密钥挪出首屏**：`useAccountSession` 静态 import 了 `utils/recoveryKey`（约 3 KB），而它只有「账号管理 → 生成恢复密钥」这一条路径用得到（登录页那份本来就是 lazy）。改成调用时才 dynamic import 之后 index 块 238.77 → **235.84 KB**（余量从 4.7% 回到 5.7%），而 rolldown 把它并进了 LoginForm 那个块（9589 → 9690 字节），**没有多出任何请求**。顺带排除了另一个候选 `methods/transfer`（2.29 KB）：它的 `filterOwnedGroupIds` 在**拖拽排序**路径上，动态化会让每次排序多等一个 chunk，那笔账是亏的。

**修复的两个真 bug**（都是本地探针量出来的，不是猜的）：

1. **图标批量「取回来了却一张都没进缓存」** —— 解 data URL 用的是 `fetch(dataUrl)`，而本站 CSP 的 `connect-src` 是 `'self' https:`、**不含 `data:`**，请求被直接拒掉。最要命的是它**静默**：批量接口 200，控制台一条 `Failed to fetch`，从外面看只像「批量没生效」，卡片照常各发各的。改成纯 JS 解 base64（`atob`），既不经过网络栈也不受 CSP 管。
2. **登记晚了一步，批量形同虚设** —— 图标的「在途登记」原本放在 `useEffect` 里，而 `<img>` 的 src 是在**渲染时**就定下来的，effect 跑的时候浏览器已经把请求发出去了，结果同一批图标下两遍。改成渲染期同步登记（`queueIconWarmup`：同步占住「在途」，微任务里把这一帧所有卡片的候选合成**一个**请求），卡片看到在途就把 src 留空等着（`<img>` 的 src 必须是 `undefined` 才代表不发请求 —— 写成 `src=""` 会被浏览器当成「当前文档 URL」）。另外加了「本次会话已取过」的记忆：数据是分阶段到达的（init → bootstrap → 各域数据），每批落地都会让卡片重渲染，实测首屏因此问了 3 次 `/api/icons`。

- **校验**：`tsc -b --force` 0；lint 0 error（19 条 warning 均为 react-refresh 类既有噪音）；单测 **2483**（2482 通过 / 1 跳过 / 0 失败，本轮新增 **27** 条：批量接口 6、iconBatch 12、启动合并 3、katex 守卫 1、列表摘要 3、迁移缓存 2、恢复密钥与自动保存的守卫更新的另计）；build 通过；smoke 36 项全 PASS；`check:brand` 一致；`audit:a11y` / `audit:contrast` 明暗两态 0 处不合格。真机探针：`lazy-open-probe` 13 PASS / 0 FAIL（16 个改成按需挂载的弹窗逐个点开都能挂载，控制台 0 错）、`notes-live-preview-probe` 5/5（记事本编辑 / 行内渲染 / 分栏拖拽缝都正常，其中「分隔线可见」那条判据原本在量伪元素、而实现早就改成子元素 `span`，一并修正）。⚠️ `e2e` / `e2e:cron` / `e2e:webdav` 本机跑不了（workerd 0xc0000005 崩溃，上游 workerd#4668，与本项目配置无关），只能由 CI（ubuntu）覆盖。

## 2026-10-12 · 修复：过时的备份失败提示骚扰 + 弹窗加「忽略一周」

线上已部署备份超时修复后，用户仍每次打开页面都被弹「每周自动备份未成功：…（英文 timeout）」。

- **根因是「旧代码留下的失败留痕」而不是 bug 复发**：cron 备份失败会把错误写到服务端 `cron.lastError.backup`（设计目的就是「失败了要让页面知道」），前端每次启动读到它就弹一条，**直到下一次 cron 备份成功才会清**。备份一周才跑一次，而部署前最后一次失败是旧代码写的（英文原始 message 就是旧代码指纹）——新代码部署后这条留痕还挂着，但备份要等下周一的窗口才有机会成功并清掉它，期间用户每天都被弹。
- **手动备份成功立即清留痕（`worker/routes/backup.ts`）**：`webdav/upload` / `webdav/notes/upload` 成功后分别清掉 `cron.lastError.backup` / `.notesBackup` —— 手动成功就证明备份链路是好的，那条「自动备份失败」的提示已经过时。⚠️ 必须 `await`：Workers 里响应发出后 `void promise` 会被掐掉。失败时不清（链路还是坏的，提示该留着）。
- **弹窗加「忽略一周」（`src/utils/cronErrorDismiss.ts`）**：提示条带「忽略一周」按钮，点了把这条 message 在本机消音 7 天（localStorage）。为什么存本机不存服务端：这是「别烦我」的本地偏好，不值得为它开 system config 的写入口；⚠️ localStorage 访问必须 try/catch 兜底（隐私模式下一访问就抛，抛在启动路径会拖崩页面）。忽略的只是全局弹窗，备份弹窗里的留痕仍可见。顺手修了任务名文案：记事本自动备份（notesBackup）之前落进 else 分支被标成「死链巡检」。
- **排查附带结论**：用户控制台里的红色报错全部来自浏览器扩展（沉浸式翻译等）与 Cloudflare 统计脚本被站点 CSP 拦截（`cloudflareinsights.com` 不在 `script-src` 白名单），没有任何一条是站点自身的错误。
- **校验**：`tsc -b --force` 0；lint 0 error；单测 2456（新增 7：忽略工具 5 + 路由清留痕 2 —— 手动成功清键 / 失败不清）；build、smoke 见下。

## 2026-10-12 · 性能/重构：列表组级懒挂载 + NotesPage 第二批拆分 + 错误码迁移第一批

上一批（cron 韧性/错误码/维护模式）的三个遗留项。逐条对照排查报告编号。

- **列表组级懒挂载（B1 接入，`notes/lazyGroup.tsx`）**：上一批做的定高窗口虚拟化（`virtualWindow.ts`）**没有直接接入** —— 真看代码才发现笔记列表是**时间桶分组**结构，行高还随标签徽章浮动，定高窗口的 padTop/totalHeight 会算错（滚动条跳动、组标题被跳过）。硬塞就是「基建做了一半，接入时发现假设不成立」，老老实实换成与 GroupCard 对站点同一套、且已在生产验证过的**组级懒挂载**：视口外的组不建 React 元素 / DOM（只留一个估计高度的占位），IntersectionObserver 进圈 600px 就分帧挂上，挂上不收回。123 条笔记的 stub 实测：首屏只建 27 行 DOM（少 78%），逐段滚动后全部挂上，控制台零错误；条数低于 60 时 `enabled=false` 在**渲染期**短路成全量渲染，小列表的 DOM 结构与从前逐字节一致（292 条既有用例零改动全过）。`computeWindow` 纯函数留着 —— 哪天真出现「无分组 + 定高行」的列表（比如未来的回收站分页），它还是对的。真机探针 `harness/virtual-list-probe.mjs`（STUB_NOTES=120）钉住行为；顺带踩清一个误区：**跳滚跳过的组不挂载是正确行为**（从未与视口相交），探针第一版拿「直接跳底」当判据差点误报。
- **拆 `NotesPage.tsx` 第二批（B2）**：7287 → **6219 行**。左栏导航（`notes/sidebarSection.tsx`，NavRow/FolderTagSection/标签工具/右键锚点，约 800 行）与分栏 chrome（`notes/paneChrome.tsx`，列宽拖拽/ColResizeHandle/SaveDot/比例持久化，约 350 行）原文搬出、只加 export，逻辑零改动。守卫的合并源码同步加进两个新文件 + lazyGroup —— 没这一步，`NAV_COL_W` 那条正则守卫在代码搬走后就**假通过**了。
- **错误码迁移第一批（C1，`worker/routes/data.ts` + `worker/index.ts`）**：data.ts 里 23 处规整的错误出口从 `Response.json({error}, {status})` 换成 `throw ApiError.xxx(...)`（无效 ID ×17、文件夹三类、FTS 降级 503、附件类型 415）—— message 一字不差（客户端按它显示），新增的只是机器可读 code。真正让这些 throw 生效的是外层那一处：`index.ts` 的兜底 catch 接上 `errorResponse` —— ApiError 按 code/status 翻成结构化 JSON，未预料的错误打日志 + 回 500 但**不透内部细节**（以前回纯文本，客户端连结构化错误都解析不出）。带 `headers` 的分享类错误出口（405/410/4xx+headers）这批没动：`errorResponse` 还不支持附加头，硬迁会把缓存语义弄丢。
- **校验**：`tsc -b --force` 0；lint 0 error（19 条 warning 均为 react-refresh 类既有噪音）；单测 **2449**（2448 通过 / 1 跳过 / 0 失败，新增 1 条：unsupportedMedia 工厂；连带把两个路由测试的 dispatch 包上与 index.ts 一致的 errorResponse 兜底 —— 迁移后路由抛 ApiError，测试环境不包这层的话「抛错变 500」根本测不出来）；build 通过；smoke 全 PASS；真机探针 5 项全 PASS（123 条 stub：首屏 27 行 / 滚完全挂 / 打开正常 / 控制台 0 错）。

## 2026-10-12 · 工程：cron 韧性 / 统一错误码 / 请求超时 / 拆 NotesPage / 维护模式

对 10-12《系统排查与 inkstone 对比》报告里 A/B/C 三档的落实。逐条对照报告编号。

- **cron 单任务耗时上限 + 进度日志（A1/A2，`worker/cron.ts`）**：五个任务是串行的，而备份上传最长可占 10 分钟 —— 某一项卡住会让当次 cron 整体超时，后面四项（死链巡检 / 笔记备份 / 沉睡扫描 / 保留清理）整周都不执行，尽管它们各自都有 try/catch。新增 `withDeadline`：单任务超时就地记失败并继续下一项；每项开始/结束各打一行耗时。上限按任务分开：备份 12 分钟、其余 5 分钟。
- **备份上限按账号数放宽（A4）**：多账号备份是串行的，而且**必须是**串行的 —— `setCurrentUser` 是 API 实例上的状态，并发共享同一个实例会**串账号**（把 A 的数据传进 B 的网盘），那比「备份慢」严重得多；要并发就得每个账号一个独立 API 实例，收益远小于风险，所以不做并发，改为按账号数给时间（每多一个账号 +10 分钟，自身封顶 30 分钟）。
- **D1 读操作抖动重试（A3）**：`listUsers` / `readAllConfigs` / `getSites` / `getConfig` 这几个 cron 入口读包一层 `withD1Retry`（2 次、500ms 退避）。只包读 —— 写操作重试可能重复写，而备份上传本身已有 `putWithRetry`。
- **上次备份详情（A2）**：备份成功后写 `webdav.lastBackupInfo`（文件名 / 体积 / 自动或手动 / 耗时），备份页从只显示时间变成能看出「这次备份多大、花了多久」。详情 JSON 是服务端写进来的用户配置，解析失败一律退化成只显示时间 —— 老库没这个键 / 写入被截断都不能把备份对话框搞崩。
- **统一错误码（C1，`worker/lib/apiError.ts` + `src/API/apiError.ts`）**：新增 `ApiError`（status + 机器可读 code + message + details）与 `errorResponse`。客户端 `parseApiError` 同时认**新旧两种形状**（新 `{error:{code,message,details}}` / 旧 `{error:"字符串"}`），所以 84 个端点可以慢慢迁移，迁移到一半也不会红；抛出的错误从裸 `Error` 换成带 `code` 的 `ApiError`，UI 分流（409 → 冲突弹框、429 → 提示太频繁）不再靠 message 做 includes 匹配。已迁两个样板：笔记保存冲突（409 conflict，details 带对方那版）、`auth/me` 账号不存在（401）。
- **错误码收敛到 shared（C1 配套，`shared/apiErrorCodes.ts`）**：错误码常量原本两侧各一份手动同步 —— 服务端加了个码、客户端不知道只会静默失效，测试钉得住「两边相等」、钉不住「新增时两边一起加」。抽到零依赖的 `shared/`（会被打进 worker 与首屏两条产物链，所以不 import 任何东西），两侧 re-export：既有 import 路径一行不用改，加码只有一处改动。维护开关键名同理收敛到 `shared/maintenance.ts`（middleware 拦写、`/api/init` 报状态两处共用，字面量改名漏一处就是「拦下了但用户不知道为什么」）。⚠️ 坑：`export { X } from "..."` 只转发、**不引入本地绑定**，文件内部还要用这些名字的话得 import + re-export 分开写。
- **客户端请求统一超时（C4）**：普通请求 30 秒。以前**完全没有超时**，弱网下请求能挂几分钟，界面看着像卡死；上传 / 下载 / 导入导出这类天然慢的端点不吃默认超时（要限时由调用方显式传）。超时抛 `request_timeout`，与断网分开 —— 断网进离线队列重放，超时说明网络通但服务端不响应，该告诉用户「稍后再试」。
- **拆 `NotesPage.tsx`（B2，第一批）**：8595 行 → **7287 行**，Markdown 工具栏与预览渲染搬到 `src/components/notes/markdownToolbar.tsx`（约 1300 行）。先拆文件、不改逻辑：两个组件本来就是纯 props 驱动。⚠️ 连带修了 15 个静态守卫用例 —— 它们读的是 `NotesPage.tsx` 源码，代码搬走后会**假通过**（看着全绿其实没人盯着，比不写守卫更糟）；现在统一读「主组件 + 拆出文件」的合并源码，且**不剥注释**（一部分守卫是拿 JSX 注释当锚点的，剥了切片就空了）。剩余通用件区块（约 1150 行）留待下一批。
- **维护模式 + 通知（`worker/routes/middleware.ts` + `MaintenanceBanner.tsx`）**：备份恢复 / 迁库这类运维动作进行时，用户照常点按钮会写到一半的库上。新增 `maintenance.enabled` 全站开关：开着时**写操作一律 503**、读操作放行（维护中也要能看数据，不然用户以为站挂了）、认证三件套放行（不能把人锁在门外进不来也退不出去）、**owner 放行**（否则开了维护连关的地方都没有）。`/api/init` 带 `maintenance` 字段，前端 `MaintenanceBanner` 60 秒轮询挂横幅（「能看不能改」），轮询在卸载时停掉。
- **列表虚拟化基建（B1，`src/utils/virtualWindow.ts`）**：纯函数算可见区间（含底部收敛、脏输入兜底）+ 7 条单测；`shouldVirtualize` 阈值 60 条，低于它全量渲染（不改变 DOM 结构与滚动行为）。接入留待下一轮 —— 那需要真机验证滚动行为，不适合和这批改动混在一起。
- **校验**：`tsc -b --force` 0；lint 0 error（warnings 为既有 + 拆分文件带来的 2 条 react-refresh 提示，组件与纯函数同文件导出属预期形状）；单测 **2448**（2447 通过 / 1 跳过 / 0 失败，较上轮新增 39 条：cron 韧性 9、apiError 8、维护模式 8、横幅 4、虚拟窗口 7、备份详情 3）；build 通过；smoke 全 PASS。

## 2026-10-12 · 修复：每周自动备份上传超时（按体积给时间 + 重试 + 错误可读）

- **现象（线上）**：每周自动备份一次都没成功过，错误只有一句 `账号 1：The operation was aborted due timeout`。
- **根因是三件事叠在一起**：①上传用的是 `davFetch` 默认 **60 秒**超时，而备份是「全部笔记 + 附件」打成的 gzip，几 MB 到几十 MB 都正常，坚果云/群晖这类网盘还有单连接限速 —— 大备份**必然**在上传中途被 `AbortSignal` 掐断；②`webdavPutBytes` 的 catch 走的是 `errorMessage()` 而不是 `describeWebDavError()`，所以超时的原始英文 message 直接透传给用户，文案里连「超时」两个字都没有；③**没有重试** —— 每周一次、无人盯守的任务，一次网络抖动就等于这一周没有备份，而备份的意义恰恰在于出事时有得恢复。
- **修复**：①上传超时改成按体积算（`uploadTimeoutMs`：60 秒基线 + 每 MB 30 秒，按比例、封顶 10 分钟）—— 真到上限还传不完，该做的是分卷而不是继续等；②上传路径改走 `describeWebDavError(error, timeoutMs)`，并按**实际超时**分文案：探测（≤20s）仍是「连接超时」，上传说「上传超时（N 秒内没有传完）+ 该怎么做」，不再拿 15 秒的探测文案去描述一个几分钟的任务；③新增 `putWithRetry`：超时 / 429 限流 / 5xx 重试两次（2s、8s 退避），地址校验类错误（内网、跨源、降级）与 401/403/404/409 一律不重试 —— 重试一万次也不会变。PUT 同 URL 幂等，重试不会产生重复文件。
- **可观测**：上传成功后打一行日志（文件名、体积、实际耗时、超时上限）—— 下次再有人报「备份失败」，先看这里是不是真慢，而不是靠猜。
- **校验**：单测 2409（2408 通过 / 1 跳过 / 0 失败，新增 6 条：超时按体积算的边界、两种超时文案、重试成功/三次仍失败/429 重试/校验类不重试）；`tsc -b --force` 0；lint 0 error（8 条既有 warning）；build、smoke 通过。手动备份与自动备份共用同一条上传路径，一并修好。

## 2026-10-12 · 卫生与质量：本地 HEAD 对齐、a11y 审计进 CI、首屏分块瘦身

- **本地 HEAD 与远端对齐（工程）**：REST 推送**不回写本地**，本地 HEAD 长期停在 `9ac51dd`，远端已到 `7b214a1` —— 而且两条链的 sha 完全不同（REST 重建提交对象会换 sha），于是任何「基于本地 git 的校验」都在算错对象。已按提交元数据重建本地缺失对象：递归取远端提交 → 缺的 tree 用 `git mktree` 补 → commit 手工序列化后 `git hash-object -t commit --stdin --literally`（两个坑：**tz 要写 +0800**，**message 尾部得枚举 0~3 个换行**才能对上 sha；先干跑命中再落盘，免得写进一堆失败变体）→ `update-ref`。因为 `core.autocrlf=true`，569 个 blob 一个都不缺，只补了 8 个 tree + 18 个 commit。`git fetch/push` 在这台机器上都不通（代理 502、直连超时），这条路得留着。
- **分组圆点触控尺寸（修复）**：左栏分组栏折叠后的圆点只有 10×10（实测 14×14 与 10×10），不达 WCAG 2.5.8 的 24px 底线。改成按钮本体 24×24 透明、可见圆点仍是 10px 画在 `::before` 上 —— 视觉不变、命中区达标。为什么不是「只把命中区撑到 24 但间距不动」：那样相邻命中区中心距仍只有 18px，会互相压住，按标准的 spacing 例外**仍算不合规**；现在中心距 = 24 + 容器 gap 4 = 28px。圆点的缩放/变色动效同步挂到 `.nav-rail-dot::before`（动效在伪元素上，写在按钮上不会生效）。
- **a11y / 对比度审计进 CI（工程）**：这两个脚本原先放在仓库外的 `harness/`，只能人工实跑 —— 上面那条圆点缺陷就是这么躺到这次专项排查才发现的。现已进仓库 `script/`（`npm run audit:a11y` / `npm run audit:contrast`）并接进 CI。判据：无名控件 / 触控目标 <24px / 破图 → 失败；对比度亮暗两态不达 AA → 失败。三处防假绿：①**页面自己报错就判失败**（页面是坏的时，尺寸和对比度照样能量出「全绿」）；②**主题切换没生效就判失败**（否则两态测的都是亮色，暗色态等于没测 —— 第一次跑就抓到了：顶栏压根没有单独的主题按钮，它在「显示设置」菜单里）；③就绪判据轮询全页按钮数，不写固定 sleep。
- **首屏分块瘦身（性能）**：`manualChunks` 原先把 `@mui/@emotion/@popperjs/@floating-ui` 强制塞进同一个块，而入口 HTML 会 `modulepreload` **整块** —— 弹窗 / 抽屉 / 记事本专用的 MUI 也被首屏白下载白执行。交回 Rollup 按动态边界切分后：首屏 raw 943.3 → **843.4 KB**、gzip 304.0 → **282.7 KB**（-10.6% / -7.0%），全部 js 合计只从 7271.7 变到 7289.5 KB（+0.24%，基本没有「重复打进多个 lazy 块」的代价）。副作用：index 单块 225.8 → 348.3 KB（首屏真用到的 MUI 并进了入口块），所以预算按新口径重定 —— raw/gzip 下调到 890/300，index 块抬到 370 并写明「**判断首屏该看总字节，不是单个块**」。「首屏必须含 mui 块」那条断言同步改掉：它不是首屏缺东西，是口径的前提变了。
- **e2e 在本机跑不起来（结论，不再重复排查）**：不是配置问题 —— 最小 worker 同样崩、崩溃堆栈地址逐字节一致；`workerd --version` 却正常，说明二进制能启动、崩在 `serve` 阶段。上游 `cloudflare/workerd#4668` 仍 open，报告者重装系统才解决，与 VC++ Redist / 代理 / 杀软都无关；本机也没有可用替代（wsl 被安全策略禁、无 Docker）。顺手修掉一个体感问题：原先要干等满 120s 才报错，现在 wrangler 进程一退出就立刻失败（10s）并打印这段结论。
- **审计脚本自身的四个坑（修复）**：①顶层 await 抛错时没人收尾，Chrome 与本地服务会变成**孤儿进程**占着 CDP 端口 → 加 `uncaughtException` / `unhandledRejection` 兜底，异常也走清理再退出；②固定端口撞车就是一次 `EADDRINUSE` 崩溃 → 改成系统分配；③Chrome 临时 profile 每次留几十 MB → 退出时清掉；④桩没实现 `/api/icon`（返回了 JSON），被「破图」判据判红 —— 是桩的锅不是页面的锅，补成真 PNG 字节。另外 `findChrome` 从 ci-smoke 抽出来共用，免得两处各自漂移。
- **校验**：`tsc -b --force` 0 错；lint 0 error / 8 warning（既有，与本轮无关）；单测 2403（2402 通过 / 1 跳过 / 0 失败 —— 本轮只调预算常量与判据、未新增用例）；build 通过；smoke 全 PASS；两条审计脚本本机通过（触控 0 项 <24px、对比度亮暗各 0 处不合格）；新增真机探针把 12 个 lazy 入口 + 记事本逐个打开一遍 —— 13 PASS / 0 FAIL、控制台 0 错误（换切法会改变模块求值顺序，这条专门盯「换个切法才炸」的循环依赖问题）。

## 2026-10-12 · 链接健康：纠偏可逆 + 探测键归一化（前后端同一口径）

- **纠偏可逆（修复）**：右键「标记为可访问」此前是**单行道**——它把链接加进白名单，白名单使该链接**永远免探测**，界面上再没有出口。链接只是当时被扩展/风控/超时误判，加进去就永久脱离巡检，反而比误判更糟。现在标过的链接右键会出现**「重新检测该站」**：移出白名单 → 立刻真探一次 → 结果照老规则走（第一次失败只记疑似）。**关键陷阱**：只移白名单不够 —— probe 时间戳还在「近期探测过」的窗口里，批量检测会被 fresh 窗口直接跳过，点了等于没点，所以撤销时**同时清掉 probe / suspect 两张表**。
- **探测键归一化（修复）**：三张表都拿 URL 字符串当键。「带尾斜杠 / 带锚点 / 大写 host」的写法会被当成一条新链接——白名单与失效记录全部命中不上，用户标过的「可访问」静默失效。新增 `normalizeKey`（去空白、丢 #hash、host/scheme 小写、仅根路径去尾斜杠；**刻意不动**查询串、路径大小写、端口），写入与读取统一走它；`mergeLinkHealth` 连**入站键**也归一化，否则老客户端同步过来的原始 URL 与本机键对不上，跨设备同步等于白同步。
- **两端共用同一实现（重构）**：`normalizeKey` 与新的 `deriveDeadLinks` 放在零依赖的 `src/utils/linkKey.ts`。为什么不在 `linkHealth.ts`：worker 侧没有 DOM lib，`linkHealth` 里的 `localStorage` 引用会让 worker **编译不过**（实测 `tsc -b` 报 TS2304）；也不塞进 `utils/url`，免得把整个模块拖进 worker。前端与 `worker/cronLogic.ts` 巡检共用，巡检手里是 sites 表的原始 URL，口径必须一致。
- **看板失效数口径订正（修复）**：统计看板原先直接数 `dead` 表行数，会把「之后又探测成功」和「用户标过可访问」的链接也算成失效——看板数字与卡片上的「失效」标记自相矛盾。现改走与卡片同一套 `deriveDeadLinks` 推导。
- **存储访问兜底（修复）**：①`useThemeController` 在 `useState` 初始化里**裸读** `localStorage`——这是首次渲染的同步路径，浏览器在阻止站点数据/无痕模式下属性存在但**一访问就抛**，抛在渲染期就是整页白屏；②`localAppData.listLocalAppKeys` 遍历 `localStorage.length` 未兜底，存储被禁用时会把**崩溃恢复界面**一起拖挂（越是要靠它自救的时候越用不了）。两处都包了 try/catch 退化成默认值。
- **看板兼容老部署（修复）**：服务端没更新时兜底回 `{success:true}` 而没有 `stats`，界面会是一个**空对话框**——既没数据也没报错。现在显式提示「当前部署还没有统计接口」。
- **工程**：首屏包预算 236 → 238 KB（本批进首屏的是更多菜单入口项+图标、卡片右键一项、键归一化与撤销纠偏；看板弹窗本身 lazy、聚合 SQL 留在 worker）。补 stub 的 `/api/stats` 与 `/api/auth/me` —— 缺桩会让更多菜单里的 owner 入口被守卫藏掉，探针变假红。
- **校验**：`tsc -b --force` 通过；全量 2403（2402 通过 / 1 跳过 / 0 失败，新增 7 条：归一化与撤销 4、cron 巡检口径 2、静态守卫 1）；lint 0 error（8 条既有 warning 无关）；build 通过；smoke 全 PASS（含「页面无控制台 error」）；统计看板与链接纠偏各跑了一条真机 CDP 探针，四块渲染 + 30 根柱 + 撤销后确实发出探测请求，均通过。`npm run e2e` 在本机起不来（workerd 在这台 Windows 上 access violation，既定环境限制），由 CI 覆盖。

## 2026-10-11 · 统计看板（仅 owner）+ AVIF 尺寸解析

- **统计看板（新增）**：「更多」菜单新增**统计看板**入口（与审计日志同一把 owner 守卫，后端 403 挡非 owner），一块仪表盘看全站运营状态，四个区块：①**内容概览**——站点/分组/笔记/附件数量与附件占用（按账号 scope 计数）；②**审计活跃**——近 30 天按日聚合的手写 SVG 柱状图（缺日补零，悬停出「日期：次数」）；③**高频动作**——近 30 天 Top 8 动作条形榜；④**分享浏览 Top**——笔记+分组分享按浏览次数合并排序 Top 8；外加**链接健康**——来自 link.health 快照的疑似失效数与最近失效列表。服务端一次拉全：新端点 `GET /api/stats`（owner only），聚合在 worker 侧做（计数/两条 GROUP BY/两条 JOIN），前端零依赖画图——**刻意不引入图表库**（首屏 304KB gzip 预算只剩 5% 余量）。组件懒加载独立 chunk，不进首屏。
- **实现要点**：①JOIN 里 `user_id` 必须限表名（`n.user_id`/`g.user_id`，note_share 同名列裸写=ambiguous column 500，FTS 老坑），所以浏览 Top 两条查询不走 scopeSql、按账号手工拼限定名条件；②四块各自独立容错——看板是观测工具，一块挂了不能整页 500；③链接健康读 `user_configs` 的 link.health 快照（开启健康同步才有数据，否则显示开启引导）；④mock 按 mock 状态返回同构数据，apiContract 守卫钉死两侧形状。
- **AVIF 尺寸解析（新增）**：上传链路此前对 `image/avif` 不读尺寸（正文渲染靠浏览器加载后回填）。补上 ISO-BMFF 盒子树解析——`meta`（FullBox）→ `iprp` → `ipco` → `ispe`（version/flags 后两个 uint32），多 `ispe` 取第一个，任何越界/截断都安全返回 null 绝不抛。上传时与 png/jpeg/gif/webp 同一条路存元数据，正文图片位从首帧就占好。inkstone 的图片尺寸探测同样不含 AVIF，此为超越项。
- **校验**：`tsc -b --force` 通过；全量 2393（2392 通过 / 1 跳过 / 0 失败，新增：opsStatsRealSql 真库 2（含多账号隔离）、statsDashboard DOM 2、imageSize AVIF 1）；lint 0 error（8 条既有 warning 与本改动无关）；build、smoke 通过。

## 2026-10-11 · 订正：5 个 P3 运维小件核实已在 723db4d 全部交付

- **应用户要求逐项源码复核四维评估中的「5 个 P3 低频小件」，全部已在 `723db4d` 交付，无一真缺**：①备份互斥租约（`worker/notesBackup.ts:330-444`，15 分钟 TTL + renewLease + token 条件删除）；②欢迎笔记（⌘K 命令 + 空状态按钮，`NotesPage.tsx:3350/4631`）；③服务端图片尺寸（`worker/imageSize.ts`，png/jpeg/gif/webp 与 inkstone 同范围，AVIF 两侧均不解析）；④附件删除重试队列（gc 记账 + `retryAttachmentDeletions`，`cron.ts:451` 已接线）；⑤Obsidian 导入三级回退（相对路径→解码路径→全局同名唯一匹配带歧义守卫，`NotesPage.tsx:3176`）。
- **订正**：`docs/inkstone-gap-assessment-2026-10-11.md` v2——1.2 节改写为「已全部交付」附逐项证据，整体评估改为「功能 ~100% 对齐、无剩余已知缺项」。初稿误判原因：未把原对比报告第 127 行实施更新订正块应用到 P3 条目（方法教训已留档：未做清单必须逐项 grep 源码核实）。
- **结论**：对照 inkstone 的追赶工作全部收口，无代码改动；优先级完全转向产品新方向。

## 2026-10-11 · 四维差距评估：功能/架构/性能/代码质量（对照 inkstone）

- **文档**：`docs/inkstone-gap-assessment-2026-10-11.md`——按用户要求的四个维度（功能特性 / 架构设计 / 性能表现 / 代码质量）重新结构化的差距评估，全部「已交付」结论已源码级核对（非按记忆）。基线本地 `9ac51dd`（含 `723db4d` P1–P3 补齐、`2d1155c` 浏览防刷、`9ac51dd` 触屏 Pointer）。
- **核心结论**：①记事本功能面与平台运维层均 ≈ 100% 追平（图谱交互与 5 个 P3 运维小件均已在 `723db4d` 关闭，后经同日晚间逐项源码复核确认，见上条订正）；②剩余差距全部为有意取舍（DO 实时同步/多目标备份/力导向图谱/AVIF 尺寸）；③跨设备实时同步与多目标备份为「有意不做」，已用 BroadcastChannel + cursor 轮询 + 单目标备份覆盖；④架构/性能/代码质量无缺陷级差距，多账号隔离、Trusted Types、SVG 不收、Mermaid 沙箱、口令附件会话等护栏反而优于 inkstone 单用户假设；⑤无安全级缺口（原 4.1 口令附件暴露已关、AI 向量跨账号误删已关）。**整体：功能 ~100% 对齐、无剩余已知缺项、架构/性能/代码质量达标或超、无安全级缺口**；追赶工作收口，优先级转向产品新方向。
- **8 项不做维持**：MCP / TOTP / Realtime DO / i18n / S3 多目标 / 头像 / PWA 更新 / demo。

## 2026-10-11 · 触屏支持：面板/列宽分隔条改用 Pointer Events

- **触屏修复**：笔记页四处分隔条（左栏导航列/列表列、主栏↔侧栏比例、编辑器源码↔预览、侧栏源码↔预览）此前挂在 `mousedown/mousemove/mouseup` 上——触屏不会派发等价的连续鼠标事件，等于触屏用户**根本拖不动**分隔条。统一改成 Pointer Events（`pointerdown/pointermove/pointerup`），鼠标/触屏/笔同源，拖拽行为不变；拖动手柄已带 `touch-action:none`（之前主栏两处已加，ColResizeHandle 本就有），触屏手势不再被滚动吃掉。dnd-kit 的站点/分组卡片排序本就配了 PointerSensor+TouchSensor，无需改。
- **剩余待办复核结论**：①「生产分享创建/撤销实测」——受硬规则限制（不验证 CF 部署、缺线上凭据），改走本地等价保障：分享创建/轮换/过期/撤销/口令访问/防刷计数已由 `noteFolderTagRealSql` + `groupSharesRealSql` + `shareAssetRoutes` 真库/路由用例覆盖，无需线上手动点测。②「8 项不做清单」维持不动。③密码管理器扩展（#88）按用户要求本批不做。
- **校验**：见本轮检查记录。

## 2026-10-11 · 浏览次数防刷 + 对比报告滞后信息订正

- **防刷（新增）**：笔记分享与分组分享的「浏览 N 次」此前是**每次成功打开 +1**——F5 一次计一次，脚本刷一晚能刷出几万次，计数失去参考意义。现在用 **HttpOnly cookie 当日戳**去重：首访签发（活到 UTC 换天），同一天同一浏览器的后续打开跳过计数，跨天/清 cookie 自然重计。方法层 `getPublicNote` / `getPublicGroupShare` 增加 `countView` 参数（缺省 true 兼容），去重判定在 worker 路由层做（读 cookie → 传参 → 成功后签戳）。顺带修一处隐患：口令成功签 asset-session cookie 从 `headers.set` 改 `append`，否则会把当日戳覆盖掉。无表无迁移，成本为零；这是尽力而为的防刷（cookie 可清），对展示用计数足够。
- **订正**：`docs/inkstone-full-compare-2026-10-11.md` 第三节的 P1×2 / P2×3 / P3×1 共六项**实际已在 `723db4d`（P1–P3 补齐批次）全部交付**（share-asset-session / 导出内联图片 / 图谱平移缩放着色 / BroadcastChannel 多标签同步 / 手动重建 FTS / 过期会话清理），报告原文滞后，已加订正说明。
- **校验**：`tsc -b`（build 内）通过；全量 2388（2387 通过 / 1 跳过 / 0 失败，新增：shareAssetRoutes 防刷 2 + noteShare/groupShare 真库防刷 2）；lint 0 error（8 条既有 warning 与本改动无关）；build、smoke 通过。

## 2026-10-11 · 导航站侧源码级自查：修 AI 向量跨账号误删 + 两处体验修正 + 两遗留项复核

- **安全（P1，自查揪出）**：AI 语义搜索的向量维护有**跨账号数据丢失级缺陷**——`replaceEmbeddings` 换模型补向量时 `DELETE FROM site_embeddings WHERE model != ?` 没带账号 scope，多账号部署下 B 账号换 embedModel 会把**其他账号全部其它模型的向量静默清光**（语义搜索悄悄退化成普通搜索，无任何报错）。修复：stale 删除与写入都加 site 归属过滤（`site_id IN (SELECT id FROM sites WHERE ... user_id scope)`），`deleteEmbeddings` 同样加 scope 纵深防御；真实 SQLite 双账号用例钉死（root 换模型后 root 的旧向量完好、alice 不受影响；跨账号写入被过滤）。
- **体验**：①分组分享撤销确认从 `window.confirm` 改站内 ConfirmDialog（danger、标明不可撤销，与全站弹窗风格一致）；②书签导入同名文件夹复用分组时补 resolved Map——含本次循环内新建的分组，此前同名文件夹出现多次会重复建组。
- **遗留项复核（两个）**：①大纲预览跳转——真机探针全绿（40 条大纲断言齐全；预览点中间条目 gap=0；scroll-spy 顶/底高亮正常，滚到底停在上一个标题属标准行为；编辑器侧跳转滚动到位），此前挂账仅因 jsdom 量不了布局，**结论：无缺陷，销账**。②导出未保存草稿——确认为真实体验缺陷并已修：编辑器内导出（头部三格式 + ⌘K export-md/html）dirty 时导出**当前草稿**并顺手触发保存，clean 时导已存版本，两入口口径统一走 `exportTarget()`。
- **自查报告**：`docs/nav-site-audit-2026-10-11.md`——P1 向量 scope（已修）；P2 两项（已修）；复核无问题清单（linkHealth / bookmarks / recycle / groupShares / 公开分组页 / 图标代理 / 监听器卫生 / ai 其余方法）。
- **校验**：`tsc -b`（build 内）通过；全量 2384（2383 通过 / 1 跳过 / 0 失败，新增 aiEmbeddingsRealSql 2）；lint 0 error（8 条既有 warning 与本改动无关）；build、smoke 通过。

## 2026-10-11 · GUI 验收收口：修「分享分组」弹不出的真缺陷

- **修复（真产品缺陷，GUI 点测揪出）**：「分享分组」对话框的挂载 JSX 在 #272 落地时被误嵌进 `{showOfflineBanner && <ChunkBoundary>}` 条件里——在线时断网横幅恒不渲染，点「分享分组」就永远弹不出框（按钮、接口、对话框本体全都没问题，纯挂载位置错误；类型/lint/单测全绿放行，只有真机点击才暴露）。已移到与横幅平级的顶层，并新增源码级静态守卫 `tests/groupShareMount.test.ts` 两条钉死挂载位置。
- **GUI 复测（本地 stub + agent-browser batch，两轮）**：T5 分享分组对话框弹出且字段齐全（链接/有效期/口令/更新/撤销）；T9 笔记搜索过滤命中（全量 5 行过滤后 1 行，命中的正是新建笔记）。配合此前 T0–T8，GUI 账面 10/10。
- **顺手**：harness stub 补 `POST /api/notes`（建笔记返回完整 note）——此前 POST 落兜底 `{success:true}`，前端拿到没有 id 的假 note，编辑器打不开（GUI 假红真因之一，又一例「stub 缺接口引爆真问题」）。
- **校验**：`tsc -b`（build 内）通过；全量 2382（2381 通过 / 1 跳过 / 0 失败，新增 groupShareMount 2）；lint 0 error（8 条既有 warning 与本改动无关）；build、smoke 通过；GUI 复测见上。

## 2026-10-11 · 五个新方向一次落地：分组分享 / 待办聚合 / 服务端图片尺寸 / 备份自检 / 同步深化（#272–#276）

- **④ 公开分组分享（新增）**：分组卡片头部新增「分享」入口——创建后得到公开链接 `/sg/<token>`（64 位十六进制令牌），访客无需登录即可查看组内链接卡片（图标+名称+链接+描述），并显示浏览次数。**脱敏在 SELECT 列表级完成**：公开查询只回 name/url/description/icon 四列，站点用户名与密码结构上就不出门，不是「前端不显示」。支持口令（PBKDF2 哈希，公开页弹口令框）、有效期（1/7/30 天或永久）、浏览计数；更新设置**保留令牌**（链接不换），撤销后链接即失效，分组删除后公开页返回 404 语义。`group_share` 表一 组一份（group_id 主键），schema 升到 18。真实 SQLite 用例钉死：令牌轮换/保留、need-password、组删 not-found、假 token 拒绝。
- **② 待办聚合面板（新增）**：左栏新增「待办 N」入口（含未完成计数）+ ⌘K 命令——聚合全部笔记正文里的 `- [ ]` / `- [x]` 任务（纯文本扫描，**围栏代码块 ``` / ~~~ 里的假任务行不误收**），按笔记分组展示；预览页勾选过的那套「只改方括号一个字符」回写链路在面板里同样可用（走 onUpdate，进 3s 自动保存）。
- **⑤ 服务端图片尺寸接通正文（修复体验）**：正文里的附件图片此前渲染高度靠浏览器加载后回填，长文首开会出现图片塌缩→跳动。现在笔记页挂载时拉一次附件元数据，把服务端已存的宽高**预种**进渲染种子（只补缺失条目，绝不覆盖运行时状态），配合既有的 width/height 属性与 imageCache，图片位从一开始就占好。
- **③ 备份预上传自检（可靠性）**：记事本 WebDAV 备份在 PUT 之前新增 `verifyBackupZipBytes`——把刚生成的 ZIP 完整读回、核对笔记与附件条数与预算记录一致，自检失败这次运行直接标记未验证（run.verified=false）并计入 runs，宁可不传坏包。
- **① 同步深化（收尾）**：`GET notes/changes` 增加 changedNoteIds（≤50，按更新时间倒序）；客户端轮询发现变更后，除整表 reload 外把命中的笔记 id 定向提示，当前正打开的笔记由 rev 守卫兜底不覆盖草稿。
- **校验**：`tsc -b --force` 通过；全量 2380（2379 通过 / 1 跳过 / 0 失败，新增：groupSharesRealSql 2、noteTodoAgenda + notesTodoDialog 6、markdown seed 2、notesBackupZip 自检 1、notesSync/changedNoteIds 3 等）；lint 0 error；build、smoke 通过。

## 2026-10-11 · 命令面板拼音分组 + 架构瘦身 + 假绿加固 + 性能排查（#30/#85/#86/#87）

- **命令面板**：拼音匹配（面板打开时按需加载词典，「sz → 设置」命中，打分居关键词与跳字之间）+ 分组展示（按 section 首现顺序分组、组内保持打分序、键盘导航仍按扁平顺序）。搜索高级语法（`tag:`/`group:`/`url:`/`is:`/排除）此前已上线，复核覆盖完整。
- **架构瘦身**：App.tsx 2046→1972（渐显/锚点/分组色/失效巡检四块抽到 hooks/useNavSceneEffects.ts，可独立测试）；SiteCard 1024→975（删除与 utils/clipboard 重复实现的 copyText——顺带消掉一处少 setSelectionRange 的行为分叉；头像配色抽 utils/siteAvatar.ts）；GroupCard 914→892（挂载调度队列抽 utils/mountQueue.ts，模块级单例保持整屏摊平语义）。
- **测试质量（假绿体检）**：全库扫描三类反模式；加固 3 条——iconCache「没借过就还」从 assert.ok(true) 改为断言不创建/不 revoke；usePrefSync 失败路径断言「真的尝试过上传且不清空本机偏好」；SiteSettingsModal 固定 350ms 睡眠改轮询等待（消除 CI 慢机偶发假红）。
- **性能排查**：报告在 docs/perf-audit-2026-10-11.md——首屏 304KB gzip 预算内余量 5%+；最大可改进项是 mermaid 传递的 elk(438KB gz)/cytoscape(133KB gz) 懒加载布局引擎（场景窄、动作在上游，不动）；运行期热点全部已有治理与用例把守。
- **校验**：`tsc -b --force` 通过；全量 2368（2367 通过 / 1 跳过 / 0 失败，新增 mountQueue 2 条 + commandMatch 3 条）；lint 0 error；build、smoke 通过。

## 2026-10-11 · 命令面板拼音与分组（#30 收尾）

- **命令面板**：①**拼音匹配**——面板打开时按需加载拼音词典（与首页搜索共用同一份模块缓存），「sz → 设置」这类首字母输入也能命中，打分排在关键词之后、跳字之前，词典未就位时行为不变；②**分组展示**——结果按「打开网站 / 命令」等 section 分组显示（组按首次出现顺序、组内保持打分序），替代原来的平铺+角标；键盘导航仍按扁平顺序，↑↓ 不受分组影响。
- 搜索高级语法（`tag:`/`group:`/`url:`/`is:`/`-排除`/`#标签`）此前已上线（utils/advancedSearch.ts + HeaderSearchBox），本次复核确认覆盖完整，测试 12/12 通过。
- **校验**：`tsc -b --force` 通过；全量 2366（2365 通过 / 1 跳过 / 0 失败，新增 3 条）；lint 0 error；build、smoke 通过。

## 2026-10-11 · 任务清单收口 + 依赖例行升级

- **工程：依赖例行升级（semver 范围内 `npm update`）**：MUI 9.4→9.5、vite 8.3.2→8.3.4、wrangler 4.147→4.149、CodeMirror minor、@cloudflare/* 等；首屏实测 943.3 KB / gzip 304.0 KB（较升级前 +1.5/+0.6 KB），首屏预算按测试自带的机制抬到 995/322 并更新基线。README 的 MUI 徽章同步 9.5。
- **工程：任务清单全面收口**：61 条历史遗留待办逐项核对后关闭——绝大多数已被后续工作覆盖（分享体系、文件夹/标签、FTS5、rev 并发、图谱/分屏/附件、书签导入去重等均有代码与测试为证），11 条零散复查/扫描项收敛为「全面复查与扫描（合并批）」；「核验线上部署」按既定铁律移除，「关机」属用户本机操作。当前仅剩 6 条真实待办（见交付回复的后续计划）。
- **扫描结论（合并批首轮）**：`npm audit --omit=dev` 仅 2 条低危（mermaid 内嵌 katex 原型污染，修复需降级 mermaid 主版本——我们的 Mermaid 跑在独立沙箱 iframe，风险受控，等上游修复）；`src` 零 `any` 残留；主版本落后项（markdown-it 15、typescript 7、@types/node 26）按惯例单独批次处理。
- **校验**：`tsc -b --force` 通过；全量 2363（2362 通过 / 1 跳过 / 0 失败）；build、smoke 通过。

## 2026-10-11 · 复核报告阶段 0–5：备份附件闭环 / 数据集广播 / 跨设备轮询同步

- **备份（最重要）**：记事本自动/手动 WebDAV 备份升级为 **ZIP 格式（notes.json + 正文引用的附件）**——此前自动备份只含笔记 JSON，附件二进制不在其中，「手动 ZIP 能带附件」不等于自动灾备能独立恢复附件。单次附件总量预算 24MB，超出的跳过并计入运行记录（宁缺勿失败）；未配置附件存储的部署保持旧 gzip JSON 格式。恢复端按文件头（PK）分流：ZIP 备份走与「数据页导入 zip」完全同一条「解包 → 附件回传 → 引用改写」链路，旧格式备份照旧可恢复。备份租约在攒附件后追加续期。
- **同步（新增）**：跨设备变更轮询 `GET notes/changes`——自游标以来的笔记变更计数（含删除墓碑表 note_tombstone，schema 17）+ 文件夹/标签全量快照；客户端默认每 120s（可调 30–600s，设置→同步可关）由「主标签页」发一次轻量查询，发现变更走既有 reload() 整表重拉并提示，**编辑器草稿永不自动覆盖**，真并发保存冲突仍由 rev 守卫兜底。墓碑按回收站保留期随每周清理回收。首次轮询只建基线不刷新；页面隐藏时跳过；老部署无该端点时自动空转。
- **广播（补齐）**：JSON/ZIP 导入、网盘恢复、笔记拖拽排序成功后统一发出数据集变更广播——此前只有单条 CRUD 走广播，导入/恢复对其它标签页不可见。
- **校验**：`tsc -b --force` 通过；全量单测见本次交付回复（新增 10 条：ZIP 备份布局/预算/账号隔离 4 条、notes/changes 真库语义 3 条、轮询客户端语义 2 条等）；lint 与 build/smoke 结果见交付回复。
- **边界**：图谱移动端手感、多图首开布局收益属「已实现待真机验收」，不在本批；跨设备同步不包含离线队列与自动合并（见 docs/notes-sync-backup-phase-2026-10-11.md 的验收清单与不做的部分）。

## 2026-10-11 · inkstone 对比报告 P1–P3 补齐

- **安全**：口令分享附件需口令验证后的 30 分钟 HttpOnly 会话；签名绑定分享 token 与当前口令摘要，轮换口令自动失效，撤销/过期仍拒绝。无口令分享保持兼容。
- **导出**：HTML/PDF 将私有图片内联为 dataURL，重复引用去重；读取失败明确报错，不导出破图文件；打印前等待图片解码。
- **图谱**：背景平移、节点拖拽、滚轮/按钮/双指缩放、复位、文件夹/标签过滤与着色；范围、深度与分组过滤偏好按账号保存。保留确定性布局，不引入力导向动画。
- **多标签**：同账号 BroadcastChannel 通知笔记及分类/标签/回收站变更，提示后由用户确认刷新，不自动替换未保存草稿；不实现跨设备实时服务。
- **维护**：数据页新增重建全文索引入口，账号隔离、限批提交，rev 条件保护并发保存的新索引；FTS 不支持时明确提示。过期会话清理原已实现，本次补计数日志并纠正报告。
- **可靠性**：笔记网盘备份增加账号租约、阶段续期和 TTL 回收；附件元数据删除与对象清理任务原子入队，对象删除失败由现有每小时 cron 重试（每批最多 100）。内部任务键不下发配置、不进备份。
- **体验**：空状态/命令面板可主动创建欢迎示例，不自动重种；PNG/JPEG/GIF/WebP 上传读取尺寸并存库，附件管理器显示尺寸（AVIF 暂无尺寸）；schema 升到 16。ZIP 导入增加唯一文件名回退，歧义同名不猜。

- **校验**：`tsc -b --force` 通过；lint 0 error / 7 条既有 warning；全量单测 2353（2352 通过 / 1 跳过 / 0 失败）；build、smoke 全部通过。

## 2026-10-11 · 记事本对齐 inkstone（五）：折叠轨道两键换位 / 编辑器补全 / 任务勾选回写 / 标签颜色 / 快捷多选 / 列表性能

- **工程：全项目 × inkstone 逐模块对比报告**（`docs/inkstone-full-compare-2026-10-11.md`）：复查确认记事本功能面已基本追平（前四轮 G1–G4/G6/G7 全关闭）；新发现 2 个 P1——**口令分享的附件不受口令保护**（`getPublicAttachment` 只验分享存在未验口令，inkstone 用 share-asset-session 把附件绑到口令验证后的短时会话）与 **HTML/PDF 导出不内联私有图片**（离开登录态图全裂）；P2 有图谱平移缩放/分组着色余项、BroadcastChannel 多标签轻同步、手动重建 FTS 索引入口；P3 运维件（过期会话清理/备份租约/欢迎笔记/服务端图片尺寸）。8 项「明确不做」复核维持（MCP/TOTP/Realtime DO/i18n/S3 多目标/头像/PWA 更新检查/demo）。

- **折叠后的 44px 轨道：两键换位**：原来「返回导航站」在上、「展开笔记列表」在下，现在**展开在上、返回在下**（用户要求）。样式、尺寸（均 30×30）、间距与点击行为都不变，桌面与窄屏都验过（真机探针：1440px 下列宽 44、展开 top=8 / 返回 top=822、不重叠不溢出、点展开回到导航列、点返回退出记事本；从宽屏收起再缩到 1100px 同样成立）。
- **编辑器自动补全（inkstone 的 `editor/completion.ts`）**：新增 `utils/noteCompletion.ts`，接 `@codemirror/autocomplete`，三个 source —— `[[` 后按标题模糊补全（含一条 boost -20 的「新建笔记」，接受时**连 `]]` 一起写**并停在闭合符之后）、`#` 后补标签（带「多少篇笔记」、用得多的排前面，**标题行开头的 `#` 不弹面板**）、行首 ``` 后补 30 种语言。三个都设 `filter: false`（内部已用 fuzzyMatch 排好序，再让 CM 过滤会把模糊命中的候选吞掉）；数据源走 getter + ref，不进 extensions 依赖，否则补全会重建编辑器、丢撤销历史。
- **预览里点任务复选框直接回写正文（inkstone 同款）**：新增 `utils/noteTasks.ts` 的 `toggleTaskLine` —— 只改方括号里那**一个**字符，缩进与列表标记原样保留；不是任务行 / 行号越界 / 已是目标状态一律返回 `null`（调用方据此放弃写回，绝不把旧文本盖回去）。只有**顶层文档**的复选框可点，块嵌入与标签页内只读（同 inkstone `.note-embed-body`）；行号按 front-matter 偏移校正。写完进 draft，与手打字符共用 3s 自动保存链路，不会被自动保存覆盖回滚。
- **标签颜色（左栏圆点 + 列表徽章）**：`note_tag.color` 列一直存在但没在界面露出，现在补齐 —— 左栏标签行菜单加「设置颜色」（`TagColorDialog`，复用文件夹那套调色板），列表里的标签徽章按本色描边 + 12% 薄涂底；脏颜色（不在调色板里）一律回落默认。只在后端有 `updateTag` 时才挂这个入口。
- **列表快捷多选**：⌘/Ctrl + 点 = 切换该条并自动进入多选态；Shift + 点 = 按**渲染顺序**从锚点选到当前（含两端）；普通点刷新锚点并打开笔记。
- **图片灯箱无障碍**：`+` / `-` 键盘缩放（兼容多种键盘布局的 key）、`0` 复位、Esc 关闭；容器可聚焦、Tab 收口在灯箱内循环、关闭后把焦点还给打开它的那个元素；打开时锁背景滚动、关闭时还原。
- **列表渲染性能（inkstone 的 NoteList）**：行加 `content-visibility: auto` + `containIntrinsicSize`（紧凑 56px / 舒适 96px，比 inkstone 放宽一点——我们的行多一行标签徽章），长列表滚动不再为屏外行付布局成本。
- **修复（真 bug）编辑器打 `#` 时 CodeMirror 补全面板抛异常、把整个补全扩展打挂**：收尾巡检里抓到控制台 `CodeMirror plugin crashed: Cannot read properties of undefined (reading 'length')`。根因是后端/缓存里混进一条**没有 name 的标签**时，`tagSource` 会把 `label: undefined` 交给 CM，默认候选渲染里的 `off < label.length` 当场抛 `TypeError`；而 CM 捕获插件异常后会 `destroy()` + `deactivate()` —— **补全扩展当场下线，之后按 Ctrl-Space 也没反应**。现在名字缺失的标签在 source 里就被拦掉（顺带兜住 `count` 缺失：不再显示「undefined 篇笔记」、boost 不会变成 NaN 搅乱排序）；`useNotes.sortTags` 也补了空串兜底（否则一条脏记录会让左栏整栏渲染崩掉）。新增 2 条用例钉死，摘掉守卫必红。
- **修复（真 bug）连点两下「置顶」会误弹「这条笔记在别处被修改过了」冲突框**：根因是同一条笔记在极短时间内连续两次 `updateNote`（第一笔保存请求还在飞），第二笔按调用那一刻的 `before.rev` 带着**同一个旧版本号**发出去；服务端第一笔已经把 `rev +1`，第二笔命中 `AND rev = 旧值` 一条都改不到 → 回 409 → 弹框。那个框本意是防**别的设备 / 标签页**抢写，结果自己把自己撞下去了。修法：`useNotes` 给每条笔记加 `revById`（服务端一回就**同步**记下新 rev，不走要等渲染 + effect 才落地的 `notesRef`）；同一条笔记的写入走 `writeQueue` 串行化（第二笔等第一笔落地并把新 rev 回填后再发，带的是新版本号，不会误判）；`togglePin / toggleStar / toggleArchive` 取反按 `notesRef` 里的**最新状态**算（连点第二下若按传进来的快照取反会算出和第一下一样的值——既没翻对又白发一笔旧 rev 的写入，正是冲突框的来源）。新增 3 条用例钉死：连点置顶第二笔带第一笔返回的新 rev、不弹框；连点收藏按最新状态取反（两下落到未收藏）；真有别的设备抢写时守卫**仍**弹框（不为消除误报就关掉守卫）。同一条笔记所有会短时并发的写——置顶 / 收藏 / 归档连点，以及「内容自动保存」与「切笔记 / ⌘S / 关闭兜底 flush」的竞发——都走这唯一的 `updateNote` 入口、`writeQueue` 一并串行化；服务端侧写（`restoreNoteRevision` / `importNotes`）走 worker 内 `updateNote`，不经过前端 hook，不受影响。
- **顺手订正**：`syncScroll` 的 `editorLineAtScroll` 口径写成 0 基（原注释写 1 基、内部又多减一次 1，双向同步会滞后一行，补了 2 条回归用例）；删掉 `editorShortcuts` 里没人用的死字段；几处照抄 inkstone 时写歪的注释改正。
- 测试桩补齐建/改/删标签接口（以前 `POST /api/notes/tags` 落到兜底回 `{"success":true}`，于是「新建标签」拿回来的对象既没 name 也没 id —— 上面的崩溃正是被这个假数据引爆的；现在按真后端的 `RETURNING *, 0 AS count` 返回）。
- 校验：`tsc -b --force` 通过；lint 0 error / 7 warning（既有：useNotes 的 runUpdate↔updateNote 循环依赖告警，冲突重试有意引用）；全量单测 **2343 项（2342 通过 / 1 跳过）**；build 通过；smoke 全绿。
