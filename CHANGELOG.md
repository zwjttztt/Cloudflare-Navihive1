# 更新日志

个人导航站 NaviHive 的变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
按日期倒序；因为项目还没有打版本 tag，这里以「天」为单位归档。

分类沿用提交前缀：`安全` / `新增` / `修复` / `重构` / `性能` / `工程`。
只看「这次上线会有什么不一样」的话，读每段的**要点**即可。---

## 2026-10-18（日）· 修复：公开分享页在 Cloudflare(Pages) 形态下 404（两环境首次对照测试发现）

**背景**：对 home.zwjttzt.com（VPS 自托管 / SQLite）与 myhp.zwjttzt.com（Cloudflare / D1）
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

**要点**：用户在新部署的 https://home.zwjttzt.com 上实测反馈的两条，都不是「看着别扭」，
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
- ⚠️ **发卡陷阱**：该站 Nginx 上游原来写的是 VPS **公网 IP**（`server 131.186.58.86:8787`，
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
浏览器  Origin: https://myhp.zwjttzt.com
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

起因：`myhp.zwjttzt.com` 实测命中 Cloudflare 欧洲节点（MAN/MAD），RTT≈300ms、
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

## 2026-10-10 · 记事本界面三处调整：导航备份去笔记开关 / 备份记录可删 / 左栏顶栏重排

- **导航站「数据备份与恢复」移除「备份包含记事本」开关**：导航备份与记事本备份本就是两套独立备份，导航备份文件一律不含笔记（`transfer.exportData` 不再读 `backup.includeNotes`，导出时连笔记表都不查了），开关连同配置读写一起删除；恢复旧版带笔记字段的备份不受影响（导入按字段缺失语义处理）。
- **记事本「设置 → 备份 → 最近备份」加删除**：每条记录带删除按钮 + 二次确认。有对应网盘文件的先删文件（新增 `webdav/notes/delete` 路由，文件名强制 `navihive-notes-backup-` 前缀，同目录的导航备份删不掉），文件删不掉就整单不删——不留「记录没了、文件还躺在网盘上」的孤儿备份；失败的记录直接移除。删除后 `notesBackup.runs` 全量写回。
- **左栏顶栏重排**：返回箭头贴左侧栏最左边、箭头朝左；「记事本」标题居中；「收起笔记列表」从左下角账号行挪到顶栏右侧（返回箭头原来的位置）。折叠 44px 轨道的「返回 + 展开」保留不变。
- 新增 4 条用例（开关移除、删除成功/失败两路、顶栏顺序），全量 2307 项测试（2306 通过 / 1 跳过）、tsc、lint、build、smoke 通过。
- 第四轮 inkstone 对比报告见 `docs/notes-inkstone-gap-2026-10-10-r4.md`（剩余差距：编辑器补全、预览任务勾选回写、标签颜色、快捷多选等，附批次计划）。

## 2026-10-10 · 记事本第三轮改进：粘贴链路、双向同步与阅读增强

- 真浏览器定位并修复严格 Trusted Types 下 DOMParser 静默失败：改为惰性节点树解析，不放宽 CSP、不注入 HTML。修复同时含 HTML/纯文本的富文本粘贴触发；链接协议白名单、嵌套列表、语言代码块与自适应 fence；选区粘贴 URL 转链接。
- 上传占位符整段替换、失败注释、真实文件名；支持非图片文件，侧栏附件归属独立，未提供上传能力时不拦截文件，销毁编辑器后按原笔记归属回写占位符，失败明确提示附件找回。
- 命令面板切笔记走保存后跳转；全局 Ctrl/⌘K 尊重编辑器已处理事件；输入法 Enter 守卫、旧查询结果隔离、仅命令空查询、选中范围校正和自动滚动。
- 双向行锚点滚动同步，修正源码边界判定；任务勾选、移动行、删除行、缩进快捷键；新增快捷键帮助入口。
- 反链摘要复用 wiki token 上下文；灯箱缩放、下载与失败态；大纲预览定位与当前章节标记；图谱标题过滤、350 节点上限、未解析目标创建入口。
- 数据页 ZIP 支持 Markdown 目录导入与附件引用重写、正文标签提取；已有 notes.json 备份恢复保持原流程。
- 复核修正：反链原本随 notes 更新重算，撤销/重做原本已有默认绑定，不再视为缺失。

## 2026-10-10 · 记事本对齐 inkstone（四）：⌘K 命令面板 / 编辑器内查找替换 / 粘贴图片与 HTML / 反链常驻面板 / wiki 别名等

- **⌘K 记事本命令面板（inkstone 的 CommandPalette）**：以前 ⌘K 只是聚焦搜索框。现在打开一个命令面板：一个输入框同时搜**笔记**（本地模糊匹配）+ **文件夹** + **标签** + **命令**（新建 / 查找替换 / 插入 front-matter / 插入双链 / 三档布局 / 置顶 / 收藏 / 归档 / 分享 / 版本历史 / 图谱 / 导出 md·html / 删除），配了服务端检索时远端 FTS 命中还会带摘要并上浮；空查询给「最近打开」；`>` 前缀只搜命令；没有任何命中时给「用输入新建笔记」这条退路。方向键选择、回车执行。
- **编辑器内查找 / 替换（inkstone 的 mod+f）**：接 `@codemirror/search` —— ⌘F 开查找面板（支持替换、大小写开关、正则）、⌘G/F3 跳命中、⌘D 选中下一个相同词、⌘Shift-L 全选相同词、选区自动高亮全部匹配。面板走毛玻璃样式、文字色跟随亮/暗主题；「更多操作」菜单里补了「查找 / 替换…」的鼠标入口。⌘F 从此不再落到浏览器整页查找。
- **粘贴 / 拖拽图片直接进正文（inkstone 的 paste 扩展）**：截图后直接 ⌘V（或把图拖进编辑器）—— 先插「上传中…」占位符，上传完成自动把占位符换成 `![](url)`（小图仍走「≤1MB 内嵌 data URI」的既有策略），上传失败占位符变成「上传失败」而不是凭空消失；多张图各带独立占位符互不干扰。后端没配存储时保持原生行为。上传链路与工具栏「上传图片」按钮共用同一个模块级 `resolveImageUpload`，两处行为不会跑偏。
- **富文本粘贴转 Markdown（inkstone 的 htmlToMarkdown）**：从网页 / 微信 / 文档拷内容直接粘 —— 标题、加粗斜体删除线、行内代码与代码块、链接、图片、有序无序列表、引用、表格、分隔线都转成对应 Markdown 语法，`script`/`style` 剥掉不进正文。没有图片且剪贴板带 HTML 时自动启用；这项**不依赖**图片存储配置。
- **反向链接改成右侧常驻面板（inkstone 的 BacklinksPanel）**：桌面端头部反链按钮从「点一下弹个菜单」改为开关常驻面板（与大纲面板同一列位置）：每条反链带**上下文摘要**（引用所在的那一行，压掉 Markdown 符号）+ 数量角标，点击直接跳到来源笔记；没有反链时给一句说明。窄屏仍走「⋯」菜单。
- **双链别名 `[[目标|显示名]]`（inkstone 同款语法）**：渲染用显示名，跳转 / 反链 / 图谱 / 全文统计仍按目标名判据 —— 写别名的引用以前会被当成一个叫「目标|显示名」的死链，现在能正确命中。`![[目标|显示]]` 嵌入同样剥掉别名再匹配。多个 `|` 只按第一个切。
- **块引用支持标题锚点 `![[笔记#某标题]]`（inkstone 同款）**：嵌入该标题的区段（到下一个同级或更高级标题为止，含下级子标题）；`#^块ID` 语法照旧，判据照 inkstone（`#` 后以 `^` 开头是块 ID，否则按标题找）。找不到标题退回整篇。
- **图谱邻域跳数（1/2/3 跳）**：「只看本文」模式下多了 1/2/3 跳选择，沿双链 BFS 往外多走几跳（默认 1 跳 = 原有行为）；全站模式不变（孤岛灰点照画）。
- **front-matter 插入入口复核**：工具栏「插入 → 笔记属性（YAML）」与命令面板「插入 front-matter」两条入口本就已具备，本轮复核确认无需新增。
- 全部纯前端、零 `SCHEMA_VERSION` 改动；新增/更新 20 条用例钉死（命令面板项生成与远端命中合并、查找面板开关与 ⌘F、粘贴占位符→回写、HTML→MD 转换、反链面板摘要、wiki 别名解析与渲染、标题锚点裁切、图谱 depth）。

## 2026-10-10 · 记事本备份三处修正：导航备份默认不含笔记 / 删网盘地址速查 / 修「从网盘恢复」列不出也恢复不了

- **修复（真 bug，线上才炸）从网盘恢复列不出文件、点恢复报失败**：根因是前端取数写错了层级。后端 `webdav/notes/list`、`webdav/notes/download` 走 `request()`，它直接 `return response.json()`，后端返回的是**顶层** `{ success, files }` / `{ success, payload }`；但 `NotesOverlay` 里写成了 `r.data?.files` / `r.data?.payload` —— 根本没有 `data` 这层，恒为 `undefined`。后果：列目录永远空（选不了文件）、下载拿不到 `payload`（导入收不到数据），表现就是「备份的文件无法恢复」。已改正为读 `r.files` / `r.payload`（client/mock/useNotes 的返回类型同步改成顶层对象，去掉 `WebDavResult<{...}>` 那层误导）。⚠️ 这类 bug 本机测不出、线上才炸：测试桩本来就返回顶层对象，与真实后端同构，但旧代码读 `r.data?.` 把两者一起读空——已补一条**回归用例**钉死「列目录出文件行 + 顶层 payload 原样送达 importNotes」，谁改回 `r.data?.` 此用例必红。
- **导航页备份默认不再包含记事本**：导航备份与记事本备份是两套独立备份（`worker/notesBackup.ts` 那套才是笔记的），之前导航备份默认把笔记也塞进去（`backup.includeNotes` 默认 `true`）。现在改成默认**不含**（`configs[BACKUP_NOTES_CONFIG] === "true"` 才带），「备份包含记事本」开关保留、想带要主动开；导出时仍为「字段缺失」语义（不含时是空字段而非空数组，避免导入把本地笔记清空）。`BackupTab` 文案同步说明默认不含。
- **备份设置页删掉「网盘地址速查」区块**：之前在记事本「备份」页放了一块坚果云 / Nextcloud / Koofr 等 WebDAV 服务商预设地址 + 一键复制 + 去注册。`WEBDAV_PRESETS` 常量、对应 `presetId` state 与整块渲染一并移除，相关 DOM 用例删除。地址只在导航页「数据备份」里填，这里不再重复给。

## 2026-10-10 · 记事本：分屏时主栏头部与侧栏头部同构（即时渲染 + 三档 + 保存点 + 更多）

- **修复**：上一轮把分屏（侧边打开）时主栏的「即时渲染」开关和三档模式键（编辑/分栏/预览）也收进了「更多」菜单，结果左右两侧头部不对称——侧栏头部是「即时渲染 + 三档 + 保存点 + 更多 + 关闭」，主栏只剩「保存点 + 更多」。用户明确：**主栏头部要和侧栏一模一样，只是没有关闭键**。现在分屏时主栏头部常驻「即时渲染」开关与三档模式键，与侧栏逐键对齐；收藏/置顶/大纲/反链/版本/导出/分享这排仍收进「更多」菜单（与侧栏一致，它们本来就不在侧栏头部）。「更多」菜单里分屏时补的三档项与即时渲染项随之撤掉（头部常驻后不再重复摆一遍）；窄屏收纳行为不变。

## 2026-10-10 · 记事本对齐 inkstone（三）：版本历史行级 diff / 服务端全文检索 / 备份闭环 / 收藏与置顶分离

- **版本历史能看见改了什么（inkstone 的 VersionsPanel）**：以前版本历史只是一个下拉菜单，点一下直接恢复，用户根本不知道那一版改了什么。现在是一个左右分栏的对话框：左列快照列表（时间、字符数），右栏是**行级 diff**（`+N` / `-N` 汇总，逐行标绿/红，超长文本自动降级为「整段删 + 整段加」并提示，渲染行数封顶 4000 行）。「恢复此版本」前自动把当前内容再存一份快照，所以恢复本身也能撤回。算法照 inkstone：前后缀剥离 + LCS（我们用 `Uint32Array` 存 LCS 表，不用它的 `Uint16Array` —— 65535 以上会溢出回绕）。
- **图片灯箱**：预览里点任意图片放大到全屏（Esc / 点空白 / 关闭键都能关）。灯箱不是 MUI Dialog，自己挂 `keydown` 听 Esc。
- **搜索换成模糊匹配 + 命中高亮**：原来只有 `includes`，打错一个字就一条都搜不到。现在照 inkstone 的 `fuzzy.ts` 走评分（直接子串高分、词首加成、分散命中连击、按长度扣分），标题里的命中段打 `<mark>` 高亮。
- **服务端全文检索（FTS5）**：新增 `POST /api/notes/search` 与 `notes_fts` 虚拟表。⚠️ 分词器选的是 **unicode61 + 两侧统一 segmentCJK**，不是 trigram —— trigram 要求查询串 ≥3 个字符，中文最常见的两字词（「设计」）会一条都搜不到（实测 `MATCH '设计'` 返回 0 行，且不报错）。写入（create/update/delete/导入/回收站还原）与查询走同一套分词；有索引时按 bm25 排序（标题权重 10）并给出命中片段；**索引建不出来就自动退回 LIKE 全表扫**，结果一致，只是没有相关度排序 —— FTS5 是加速件不是功能本体，任何一步失败都降级，绝不让搜索这个动作本身报错。
- **备份闭环：能出也能进**：新增「从网盘恢复」—— 列出备份目录里的文件 → 选一份 → 加密的就地弹出令框 → 下载解密 → 走数据页那条导入。后端新增 `webdav/notes/list` 与 `webdav/notes/download`（只认 `navihive-notes-backup-` 前缀，解密失败回 `encrypted`/`badPassword` 让前端区分「要口令」和「口令错」）。
- **导出 ZIP 含图片附件，也能导回来**：以前导出的 JSON 里图片只是一个 `/api/notes/attachments/<id>` 引用，迁移/删站后正文还在、图全没了。现在能导出 ZIP（notes.json + attachments/），导入时把附件逐个回传服务端、记下「旧 id → 新 id」再重写正文里的引用（服务端给的 uuid 是新的，不换就是满屏裂图）。ZIP 是**零依赖自实现**（`utils/zip.ts`：手写 crc32 + deflate 解压/inflate，打包不压缩），顺带挡住 zip slip 与 zip 炸弹。
- **收藏与置顶分离**：以前「收藏」视图判的是 `pinned`，两个其实是同一个开关 —— 想把一条临时置顶的笔记标成常用，一点就把排序也改了。现在 `notes.starred` 独立成列：置顶管排序、收藏管筛选，头部两颗键、菜单两项互不影响。
- **乐观并发（rev）**：`notes.rev` 每次写入 +1，客户端保存时带上「我改的是哪一版」；服务端发现版本对不上就回 409 + 库里当前那版，前端弹框让用户选「用我的覆盖 / 看别人的版本」，不再静默盖掉另一个设备的改动。不传 rev 就是老行为（老客户端不受影响）。
- **顺手做的三件**：列表**多选批量条**（开了多选才出现勾选框，批量归档/删除，删除前二次确认并写出条数与可撤销性；只作用于当前列表，不误伤列表外的笔记）、**双链关系图谱**（本文邻域 / 全站两种范围，确定性圆环布局、点节点就跳过去）、**网盘地址速查**（备份页给常见 WebDAV 服务商的地址与「用什么当密码」的提示，可一键复制 —— 地址填错的症状只是「测试连接失败」，没有对照表用户不知道该怪地址还是怪密码）。
- **排查中修掉的真 bug**（都是「本机点不出来、线上才炸」那类）：① 全文检索那条 JOIN 查询里 `user_id` **没限定表名**，两张表都有该列 → SQLite `ambiguous column name`，登录用户一搜就 500（单账号部署时那句片段是空串，本机永远测不出；已回滚验证：改回旧写法新用例转红）；② 批量归档的判据写反（`!==` 应为 `===`），结果是点了「归档」一条都没动；③ 冲突回调传的是首次渲染的空闭包（useNotes 把它放进依赖数组），冲突会变成「什么都不发生」；④ 全文索引的写入用 `void` 丢出去，Workers 在响应返回后会掐掉未完成的 Promise（本地正常、线上索引缺一片），全部改成 `await`；⑤ 导入与「删了再还原」都会把**收藏**弄丢（INSERT 按白名单逐列写，漏一列就丢）；⑥ 老行的 `rev` 是 NULL（DEFAULT 只作用于新行），并发守卫在 NULL 上永远不成立 → 那几行会变成「怎么都保存不了」，迁移里回填成 1。
- **SCHEMA_VERSION 13 → 14 → 15**（14 = notes_fts，15 = notes.starred + notes.rev）。这两个号是唯一能让「已部署的库」重跑迁移的保险丝，前面那个分享列表 500 就是忘了 +1 的翻版 —— 两个补列用例都按「伪造已部署老库（版本号 12）」的方式钉死。
- 验证：tsc `-b --force` / eslint（0 error）/ **全量单测 2256 条全绿** / build / smoke。新增 40+ 条用例，其中真实 SQLite 用例钉死：中文两字词必须能搜到（trigram 会搜不到）、标题命中排在正文命中前、删/改/还原后索引跟着变、登录态与 LIKE 回退都通、老库补列、rev +1 与冲突语义、收藏与置顶互不影响。

## 2026-10-09 · 分屏时主栏右上角按键收进「更多」（照 inkstone 的 grouped 头部）

- **问题**：侧边打开（分屏）后，主栏右上角还是单栏态的那一整排（即时渲染开关 / 收藏 / 大纲 / 反向链接 / 版本历史 / 导出 / 分享），半宽的栏里标题被挤没了。inkstone 分屏（grouped）时每栏头部只留「三档模式键 + 更多」，其余全收进菜单（Workspace.tsx:424-441）。
- **改法**：分屏态（侧边打开时）主栏的即时渲染开关、收藏、大纲常驻键与桌面平铺组**条件渲染卸掉**（不是 display:none —— 元素要真的从 DOM 里消失），对应菜单项（分享/版本历史/大纲/反向链接/即时渲染/导出三件套/收藏）在分屏时重新出现在「更多操作」里；头部只留三档模式键 + 保存状态 + 「⋯」。关掉侧边后全部恢复。侧栏头部本来就是 inkstone 分屏同款（即时渲染 + 三档 + 更多 + 关闭），不动。
- 验证：tsc / eslint / **2204 单测全绿** / build / smoke；新增 2 条 DOM 用例（分屏时平铺组消失 + 菜单项齐全 + 侧栏四件套保留；关掉侧边后平铺组恢复）。⚠️ 断言写法教训：`assert.equal(domElement, null)` 失败时 node:test 要 inspect 整棵 jsdom 节点树，会直接 OOM（Array buffer allocation failed），判空一律写 `assert.ok(el === null, msg)`。

## 2026-10-09 · 记事本设置新增「备份」页（照 inkstone 的 BackupSettings，与导航页的分开）

- **备份与导航页的分开（物理隔离，不是口头分开）**：独立目录（默认 `navihive-notes-backup`，导航页是 `navihive-backup`）、独立文件名前缀（`navihive-notes-backup-auto-` / `-manual-`，列目录与清理各认各的前缀，互不误删）、独立的频率与保留策略、独立的运行记录（`notesBackup.*` 配置键，按账号私有、不进导航备份文件、口令加密落库）。备份内容只含记事本（笔记/文件夹/标签/关联），形状与「数据页导入」的入参一致 —— **备份 → 下载 → 数据页导入天然闭环**，不需要另一套恢复代码。
- **WebDAV 地址/账号/密码自动带入**：网盘凭据不重复存 —— 服务端直接回落到导航页已保存的 `webdav.*`（导航页保存后记事本备份开箱即用，连加密口令也跟着带入）；记事本这边只存自己的差异项（目录、口令、频率、保留）。没配过网盘时「立即备份/测试连接」直接给出指引而不是报一个看不懂的错误。
- **功能照 inkstone 一模一样（单 WebDAV 目标的部分）**：概览 + 「立即备份」；备份目标卡（地址/账号展示 + 备份目录 + 备份口令 + 测试连接）；自动备份的**频率**（关闭/每小时/每 6 小时/每天/每周/每月/每年 —— 由每小时 cron 触发器调度、按「距上次自动备份 ≥ 间隔」判定到点，任何触发频率下行为都正确）与**保留份数**（全部/最近 7/14/30/90/365 份，含本次刚上传那份；只清自动备份，手动备份永远是存档）；**最近备份记录**（最多 12 条，成功显示条数·体积·用时，失败可展开看原因）。
- **与导航页每周备份的兼容（及免费版 cron 触发器上限）**：Workers 免费版的 cron 触发器**全账号总共只有 5 个**，加第二个触发器会把部署的 triggers 更新直接打挂（CI 实测）。所以 wrangler 只保留**唯一**的每小时触发器 `0 * * * *`，所有定时任务共用、代码里各判到点：记事本备份按各账号的频率配置判定；导航页每周备份改为代码判「UTC 周一 02 点」窗口（与原来的北京时间周一 10:00 是同一场）；cron 表达式缺省或不是每小时那条时（验证脚本直调、cron-e2e 的通配表达式）保持老行为全量照跑。
- 验证：tsc `-b --force` / eslint（0 error）/ 全量单测 / build 全绿；新增 8 条用例——纯逻辑钉死调度判定（off 不跑、间隔到点、坏时间戳容错）、保留清理（只动自动备份、手动与导航备份一份不碰、retention=0 不删）、配置回落（`webdav.*` 带入 + 差异项优先）、运行记录封顶；真实 SQLite 用例钉死 `exportNotesData` 导出形状与「导出 → 导入」闭环（不产生重复、账号隔离、坏 JSON 容错）；DOM 用例钉死备份页出现/消失（老部署无能力时整页不出现）、自动带入显示、立即备份与测试连接调用、运行记录渲染与展开、目录失焦保存。

## 2026-10-09 · 附件管理器照 inkstone 重做（抽屉 + 四档筛选 + 引用计数）

- **方案一模一样（对着 inkstone `AttachmentManager.tsx` 抄的）**：右侧抽屉 420px（`zIndex` 顶到 modal 一档，可与设置弹窗叠开），顶部「全部 / 图片 / 文档 / 其他」四档筛选（文档 = 非 image 且非 `application/octet-stream`），两列卡片网格（4:3 缩略图、悬停浮出删除按钮），文件名 + `大小 · 引用 N 次 / 未引用`。缩略图用带凭据的 fetch 拉 `/api/notes/attachments/<id>` → 校验 `image/*` → objectURL，卸载时 revoke；非图片或加载失败显示虚线占位。
- **引用计数与后端 prune 同源**：前端扫已加载正文里的 `/api/notes/attachments/<id>` 出现次数，**按笔记去重**（同一条笔记里写两次算 1 个引用）；0 引用的条目用警示色标出，「清理未引用附件」按钮与列表删除都走二次确认，确认后失败抽屉保持打开。
- **性能口径照抄**：一次拉全量元数据、前端每页 50 条切片展示，底部「已显示 N 个 / 共 M 个」+ 加载更多；删除/清理后局部刷新统计不整页重拉。
- **替换旧实现**：设置→数据里的旧「管理附件」弹窗整体替换为这个抽屉；删除入口、确认措辞、测试钉子全部对齐。
- 验证：tsc `-b` / eslint（0 error）/ 全量单测 / build 全绿；新增 DOM 用例钉死四档筛选口径、跨笔记引用计数（两条笔记各引 1 次 = 「引用 2 次」）、底部计数与「加载更多」、清理按钮二次确认与 prune 调用、删除确认失败保持打开。

## 2026-10-09 · 修复：分享列表「API错误: 500」—— 补列代码写了，版本号忘了 +1

- **真因**：上一轮给 `note_share` 补 `password`/`views` 两列时，`runMigrations` 的 6.7 步（`migrateNoteShareColumns`）写了，但 **`SCHEMA_VERSION` 忘了从 "12" 升到 "13"**。`migrateIfNeeded` 读到相同版本号会**整段跳过迁移**（这是省冷启动开销的快路径），于是**已经部署过的实例**上两列永远补不上 —— `listNoteShares` 的 `SELECT s.views` 一执行就 500。本地、新库都是全新迁移必然跑，所以单测全绿、本机复现不了；这正是这个版本号机制注释里写过的同一个坑（2026-10-06 文件夹 parent_id 500 的翻版）。
- **修复**：`SCHEMA_VERSION` 升到 "13"。老库下一次冷启动版本号不匹配 → 重跑全量迁移 → `hasColumn` 守卫补出两列 → 分享列表恢复。已有分享的浏览次数从 0 计起，口令为空（全部保持公开，直到主人在分享弹窗里设置）。
- **验证**：新增一条**伪造已部署状态**的真实 SQLite 用例 —— 手工建旧结构 `note_share` + 往 configs 写入 `schema.version = "12"`，再跑 `migrate()`，断言两列补出、版本号写到新值、分享全链路（建分享/列表/浏览数）真的能跑。回滚验证：把版本号退回 "12" 该用例转红，恢复 "13" 转绿。另把测试替身 D1 的 `all()/first()/run()` 补成返回 Promise（真 D1 如此；业务里有 `.all().then(...)` 链式用法，替身不返回 Promise 会在「分享列表」这条路径上假失败）。

## 2026-10-09 · 记事本数据页对齐 inkstone（二）：「双链」「版本历史」两格 + 笔记 JSON 导入

- **「双链」「版本历史」两格补上（inkstone 数据页概览的 8 格现在齐了）**：新增后端全站计数端点 `GET /api/notes/stats`，返回 `versions`（note_revision 快照总行数，按账号隔离）与 `links`（全站正文里 `[[双链]]` 的出现次数，不含 `![[嵌入]]`，按当前正文现扫）。前端不持有全量正文，这两项没法像「笔记/文件夹/标签/总字数」那样在本地现算，必须后端算。数据页打开时拉一次；老部署没有这个端点时两格显示「—」不报错（与 uploadApi 可选方法同一套路）。
- **笔记 JSON 导入（把导出补成闭环）**：上一轮做的「导出全部笔记（JSON）」只出不进，导出的文件没人认领。新增 `POST /api/notes/import`：**只动记事本**，按 uuid 识别同一条、比 updated_at 取较新者（本地较新就保留，绝不冒险覆盖），文件夹按「父路径+名称」、标签按「名称」去重重建，标签关联经 uuid 翻译到新 id；形状不完整的条目丢弃不拖垮整批；所有写入进**同一个 D1 batch 事务**，任何一条失败全部回滚。刻意不复用 transfer.importData —— 那条路径会先清空再重建分组/站点，对「只导笔记」来说空数组等于清光导航站。数据页新增「导入笔记（JSON）」行（隐藏 file input，读文件后整包交给后端），老部署没有端点时整行不出现。
- **明确不做的两项（宁缺勿假）**：① zip 导出/导入 —— 价值在把图片附件一起打包，需要引入 zip 依赖（新依赖不能进首屏 vendor）+ 附件二进制的打包与回传链路，留作独立一批；② 重建索引 —— 本站笔记搜索是前端对已加载内容现算的，**没有服务端搜索索引**，reindex 按钮就是假开关，做了也没有任何行为差异。
- 验证：tsc `-b --force` / eslint（0 error）/ **2186 单测（2185 pass + 1 本地跳过）** / build 全绿；新增 2 条真实 SQLite 用例（notesStats 计数口径与账号隔离、importNotesData 三态合并 + 文件夹/标签重映射 + 脏数据容错 + 账号隔离）+ 4 条 DOM 用例（双链/版本历史两格有值与「—」占位、导入入口有/无能力时的出现与消失、选文件后整包上交与结果提示）。

## 2026-10-09 · 记事本数据页对齐 inkstone（一）：SharePanel 访问口令 + 浏览次数

- **访问口令（后端无能力 → 补上）**：分享表 `note_share` 新增 `password TEXT`（PBKDF2-SHA256，复用 `hashPassword` / `verifyPassword`，与登录口令同一套哈希）与 `views INTEGER NOT NULL DEFAULT 0`（浏览计数）。`createNoteShare` / `updateNoteShare` 支持 `password` 参数（string=重设、null=清除、不传=保持）；`getPublicNote` 受口令保护时返回 `need-password`，公开页弹出口令框、POST `/api/note-shares/<token>` 带口令重试，校验失败/没给都拦下（401）。
- **浏览次数**：每次公开页**成功打开** +1（被口令拦下不计），`listNoteShares` / `getNoteShare` / 公开接口都带 `views`；设置页「分享列表」与分享弹窗状态行显示「浏览 N 次」。
- **迁移幂等**：`migrateNoteShareColumns` 用 `hasColumn` 判定后 `ALTER TABLE` 补两列，老库升级不崩、重复跑不报错（真 SQLite 用例钉死）。
- **类型与链路**：`NoteShare` / `NoteShareListItem` / `PublicNote` 加 `views` / `hasPassword`；新增判别联合 `PublicNoteAccess`（`ok` / `need-password` / `not-found`）让路由与公开页按 status 分支，不再靠「null 到底是不是没找到」猜。顺手修了一个真 bug：SELECT 别名原先写成 `has_password`，而 TS 类型与前端读的是 `hasPassword` —— D1 返回的是 snake_case 键、前端永远读不到，开关永远不亮；已统一成 `hasPassword`。
- 验证：tsc `-b --force` / eslint（0 error）/ **2179 单测（2178 pass + 1 本地跳过）** / build / smoke 全绿；新增 3 条真实 SQLite 用例（口令 need-password / 对错口令 / 浏览次数只在成功打开时自增 / 迁移 ALTER 幂等，其中「访问口令→need-password」与「浏览次数自增」都做过回滚验证转红）+ 1 条 DOM 用例（弹窗读到 hasPassword=true 默认勾上开关、显示口令输入框与「浏览 N 次」）。

## 2026-10-09 · 记事本第四轮（续）：编辑区「刚出上下滚动条就抖」的关门一脚（scrollbar-gutter: stable）

- **修「拖到刚出现上下滚动条还是抖」—— 滚动条来去改了内容宽度，图片被等比重算高度**：上一轮修了渲染块高度变化要通知 CM（ResizeObserver）+ 图片结论/尺寸缓存，但用户反馈「拖到刚出上下滚轮时还是抖」。真因还有一层：`.cm-scroller` 是 `overflow:auto`，滚动条「出现/消失」让**内容宽度变 ~10px**，而图片是 `max-width:100%; height:auto`，宽度一变就等比重算高度 → 总高越过临界 → 滚动条又消失 → 宽度回来 → 高度回来 → 滚动条又出现……死循环（文字行也会因换行数变化改总高，同源）。修法：给 `.cm-scroller` 主题加 `scrollbar-gutter: stable`，让滚动条槽位**恒定预留**，出不出滚动条内容宽度都不变，回路直接断开；同时 `overflow-x` 固定成 `hidden`，横向滚动条同理不挤宽度。
- 验证：真机探针 `probe-b24-edge`（`SHOW_SCROLLBARS=1`，贴着临界点逐像素扫 21 档视口高度）重跑 —— 滚动条宽度（sbw）**恒定 10**（即便 `ovf` 从 10 降到 0 也不变，说明槽位常驻）、图片宽恒定 476、图高恒定 298、`imgAdd=0`、全部 flips=0 → 「没复现」。用户此前看到的「还是抖」是 `802276b` 那次推送还没带这条修复、线上是旧构建所致。
- 工程（harness）：`dist/client` 里 `scrollbarGutter` 会被 CM 的 style-mod 在运行时序列化成 `scrollbar-gutter`（所以 `grep` 字面量找不到），已在构建产物 `NotesOverlay-*.js` 里确认 `.cm-scroller":{overflowX:"hidden",overflowY:"auto",scrollbarGutter:"stable"` 落地。

## 2026-10-09 · 记事本第四轮：编辑区图片「不停抽动」的真因（CM 高度表没更新）/ 窄屏返回箭头朝左

- **修「编辑区图片不停抽动」—— 渲染块高度变了没通知 CodeMirror**：编辑区的「即时渲染」把整块 Markdown 换成 widget，而 widget 的高度**会变**（图片加载完把这一块从 20px 撑到 300px）。以前只在 `render()` 的 promise 完成后 `requestMeasure()` 一次 —— 那一刻 React 连 `<img>` 都还没插进 DOM，CM 量到的是「图还没来」的空高度，**之后没有任何人再告诉它高度变了**。于是「CM 以为的高度」与「浏览器真实布局」长期不一致，而 CM 正是靠这张高度表决定视口范围、要不要出滚动条、虚拟化哪些行；编辑区大小拖到**刚好要出上下滚动条的临界点**时，两边互相推翻（按旧高度重排 → 真实高度变 → 滚动条加/去 → 内容宽度变 → 图片等比变高变矮 → 又一次重排），看上去就是图片连着整块内容不停地抖。修法对齐 inkstone 的 `RenderedBlock`（它 `toDOM` 里就挂了 `new ResizeObserver(() => view.requestMeasure())`）：给渲染块的 host 挂 ResizeObserver，高度一变就让 CM 重测，`destroy()` 里 disconnect。用户给的定位线索（「拖到刚出现上下滚轮时才会抖」）正好是这个回路的特征。
- **图片结论与尺寸进模块级缓存（抖动的第二半）**：widget 会随视口进出被反复销毁重建，没有缓存时**每重建一次就重走一遍**「直连 `<img>` → 失败 → 带凭据 fetch → createObjectURL → 卸载时 revoke」，图就没了又来；而且每次都从 0 高度开始撑。现在 `imageCache`（LRU 64 条）记下结论与**自然尺寸**，重挂时直接用缓存地址、并把 `width`/`height` 属性带上让浏览器按 aspect-ratio 预留正确高度 —— 塌缩再撑开的幅度消失。真机量到：打字期间（下游 widget 本就会随位置漂移重建 8 次）图片高度恒定 304、附件请求 0 次、objectURL 创建/回收 0 次。
- **窄屏返回箭头朝左**：tablet 顶栏与 mobile 列表头部的「返回导航站」图标去掉了 `scaleX(-1)`（`ArrowBackIcon` 本身就是朝左的，之前被翻成了朝右）。真机断言图标的实际 `transform` 不能是带负 x 缩放的矩阵。
- 验证：tsc `-b --force` / eslint（0 error）/ **2177 单测（2176 pass + 1 本地跳过）** / build / smoke 全绿；两条新用例都做过**回滚验证**（把 `new ResizeObserver` 去掉、把 `rememberImage` 改成不写缓存，用例分别转红）；真机探针 3 组全过 —— `probe-b24-flicker`（静置/打字/点图片/滚动/悬停五场景：高度 0 次跳变、0 次重复请求）、`probe-b24-edge`（贴着「刚出滚动条」的临界点逐像素扫 21 档视口高度，滚动条宽度与图片宽度均无横跳）、`probe-b23-narrow`（新增箭头朝左断言）22 项。
- 工程（harness）：附件上传桩改成**存真实上传字节**（以前固定回 1×1 红点，凡「跟图片尺寸有关」的 bug 本地都复现不出来）；`run-probe.sh` 新增 `SHOW_SCROLLBARS=1`（去掉 `--hide-scrollbars`）—— 滚动条不占宽度时，「滚动条出现↔内容宽度」这类回路根本不会发生，默认参数会把真因掩盖掉。

## 2026-10-09 · 记事本第三轮：图片线上 500 的最后一条真因（漏绑账号参数）/ 抽屉不再自动弹 / 返回箭头贴整页右上角

- **修「图片还是显示不出（服务器返回 500）」—— 附件查询漏绑账号参数**：上一轮把取图失败显示成了带状态码的占位，用户截图终于把真因暴露出来 —— **500 不是 401**。`getAttachment` / `deleteAttachment` 的 SQL 里 `scopeSql(true)` 会追加 ` AND user_id = ?`（第二个占位符），但代码直接 `.bind(id)` 只绑了一个参数；`listAttachments` / `pruneAttachments` 的 `scopeSql(false)` 更是完全没 bind。D1 对「占位符数量 ≠ 参数数量」直接抛错 → 附件的查/列/删/清理四个接口在**登录用户**下全部 500。单账号部署（无登录）下 `scopeSql` 返回空串，所以本机测试与 stub 探针从来没红过 —— 这正是 FakeD1 不校验 bind 数量的盲区。修复：四处全部改走 `scopeParams`（与全库其它方法同一姿势）；并在真 SQLite 用例（node:sqlite 会校验 bind 数量）里新增**登录态（uid=123）下附件四方法全链路**用例把这类错钉死 —— 回滚修复验证该用例确实转红。
- **窄屏抽屉不再自动弹（2026-10-09 用户明确推翻 b20 行为）**：桌面关着中栏拖窄、tablet 里点「收起列表」，两条路径都不该自动弹最左栏 —— 左区让位给编辑区就好，要导航时用户自己点顶部 44px 栏的「导航栏」按钮。删掉 `bp==="tablet" && middleHidden → 开抽屉` 的 effect。
- **返回导航站的箭头贴整页右上角（不是最左栏的右上角）**：tablet 在顶部 44px 栏**最右端**（真机量到箭头右缘 988 / 视口 1000，且是顶栏最后一个按钮）；mobile 在列表屏头部行最右端（顺带补上了 mobile 一直没有的返回入口）；抽屉（navInner）里的那份只在**桌面**导航列保留。
- 验证：tsc `-b --force` / eslint（0 error）/ **2174 单测（2173 pass + 1 本地跳过）** / build / smoke 全绿；真机探针 2 组全过 —— 新增 `probe-b23-narrow`（两条路径抽屉都不自动弹、顶栏按钮手动开、箭头贴顶栏右端、抽屉内无箭头、纸面 alpha=1 回归）22 项，`probe-b20-resize` 更新为新语义后全过（旧行为断言「抽屉自动展开」已按用户要求反转）。

## 2026-10-09 · 记事本第二轮：图片「传上去了却看不见」三条真因 / 窄屏虚化与返回箭头 / 分享管理与数据页照抄 inkstone

上一批之后的四条回访，全部照 inkstone 源码（github.com/zwjttztt/inkstone）逐段核对。

- **修「上传图片后预览窗还是看不见」（三条真因，一条比一条隐蔽）**：
  1. **通用 body 额度把图片挡在门外**：worker 里所有非 GET 请求统一按 256KB 限流（`readBoundedBytes`），而上传送的是**原始图片字节** —— 一张普通手机截图就超限，`readBoundedBytes` 直接抛 413，请求压根没进路由。现在附件上传单独走 `ATTACHMENT_MAX_BYTES`（25MB，与后端单文件上限一致）；前端也先本地挡一道（>25MB 直接提示，不用等传完才收到拒收）。
  2. **预览模式下上传是「静默丢失」**：编辑区不挂载时 `insertAtCursor` 直接 return —— 图传上了、正文没变，用户看到的就是「预览窗里没有这张图」。现在工具栏按 `pane` 收 `canInsert`（预览模式 false）：菜单项置灰 + tooltip 说明，真的触发了也明确提示，不再让人白传一次。
  3. **取图挂在鉴权后面**：`/api/notes/attachments/<id>` 需要登录，某些部署下 `<img>` 那次请求带不上会话就是 401。现在 `NoteImage` 失败后**带凭据 fetch 一次**（`credentials: "same-origin"`）转 objectURL 再显示；仍然失败就显示虚线占位并写出原因（HTTP 状态码 / 不是图片 / 网络失败），不再是一片空白或一行 alt。
  - 附带：上传成功给一句「已插入图片「xxx」」反馈（以前一点动静都没有）；413 在 client 层翻译成人话（worker 回的是纯文本，解析不出 message，以前只剩「API错误: 413」）。
- **窄屏（tablet）抽屉不再透明虚化**：纸面原来用 `--bg-sunken`（`rgba(15,23,42,0.035)` 近透明），做内嵌列背景没事、做浮层纸面就是半透明，再叠上全局 `backdrop-filter` 整个糊掉。现在纸面用实底色（亮 `#eef1f5` / 暗 `#171b26`），遮罩用 `rgba(15,23,42,0.45)` 且显式 `backdrop-filter: none`。**返回导航站的箭头挪到右上角**（原来紧贴左上角，与折叠按钮两个无文字箭头挨着容易误按）。
- **分享管理照 inkstone SharePanel 重写**：链接盒（只读链接 + 复制 + 打开）→ 状态行（永久有效 / 已过期 / 到期于 + 创建于）→ 有效期分段（已有到期时多一档「保持当前」）→ 只读说明 → 底部「撤销链接（左，危险）/ 完成 / 更新设置」。新增 `PUT /api/notes/<id>/share` 改有效期（**保留 token**，与创建时的令牌轮换区分）；弹窗标题带上笔记名（inkstone 的 Modal description）。分享列表行也照 inkstone SharedNotes：标题 +「生效中/已过期」徽章、可复制的只读链接 input、到期与创建时间、复制/打开链接/管理/撤销链接；**撤销加了二次确认**（inkstone 也走 confirm，手滑点掉一条正在用的链接很难受）。
- **数据页照 inkstone DataSettings 补齐**：概览加「总字数」（与状态栏同一算法，两处不许各算各的）；新增「附件」区与**附件管理器**（列文件名/大小/类型，逐条删除走二次确认，删除后条数与占用同步刷新，清理未引用附件后列表也一起刷 —— 只刷统计会留下死链接）。inkstone 的双链/版本历史两格后端没有全站计数端点、zip 导出与导入/重建索引后端没有对应能力，按「不放假开关」的惯例不渲染。
- **补上公开分享页的图片通道**：访客没有登录 cookie，`/api/notes/attachments/<id>` 必然 401，分享出去的笔记里图片全是裂的。新增免鉴权通道 `GET /api/note-shares/attachments/<id>`，后端只放行「属于一条当前有效分享」的附件（一律 404，不区分「没有」与「没分享」，避免帮人枚举 uuid）；公开页渲染时把正文里的附件路径改写过去。
- 验证：tsc `-b --force` / eslint（0 error）/ **2172 单测（2171 pass + 1 本地跳过）** / build / smoke 全绿；真机探针 4 组全过 —— 图片端到端（上传→内嵌 data URI 显示、附件相对路径渲染成 `<img>` 且真加载出来）、窄屏（纸面 alpha=1、遮罩深色无毛玻璃、返回箭头 x=234 在右上角、抽屉入口可用）、设置页（数据页七格含总字数、附件管理器列出文件名与大小、分享列表徽章与链接 input、管理弹窗三区齐全）、b20 窄屏回归。

## 2026-10-08 · 记事本对齐 inkstone：图片预览 / 窄屏抽屉 / 分享管理 / 数据页 / 头部按钮

用户报了五项，三处直接参照 inkstone 源码（github.com/zwjttztt/inkstone）实现。

- **修「上传图片后预览窗看不见图片」**：上传落进正文的是相对路径 `/api/notes/attachments/<uuid>.png`，而渲染层的图片白名单只放行 http(s)/data:/blob:，整张图被降级成一行 alt 文本。放行本站附件前缀（同源 `<img>` 自动带登录 cookie，GET 无 CSRF 面），并给图片加了 max-width/圆角；其他相对路径（含 `//evil.com/x.png`）仍然挡掉。
- **窄屏（tablet 768~1180）改成 inkstone AppShell 模式**（此前「复位桌面态」「导航列顶上」两版方案都废弃）：
  - 顶部 44px 全宽栏：左「导航栏」按钮（开/关 272px 左侧抽屉）、右搜索框；
  - 导航列在 tablet **不再内联挂载**，内容抽成 `navInner` 与抽屉共用（互斥挂载，`data-view`/searchRef 不会出现两份）；
  - 关掉列表列后左区整个让位给编辑区，导航抽屉**自动展开**（effect：bp 变 tablet 且 middleHidden 时开抽屉；手动关掉后不会被抓回来）；
  - 「收起列表」按钮 mobile 不再提供（mobile 没有抽屉可回，关了就没有导航入口）；mobile（<768）维持两屏切换不变。
- **分享列表「管理」改成打开该笔记的分享设置**（inkstone 的管理 → SharePanel 同语义）：弹 NoteShareDialog（有效期/重生成/撤销），关掉自动刷新列表；点笔记**标题**才是跳回编辑器。之前「管理」只是跳转。
- **设置新增「数据」页**（照 inkstone DataSettings，精简到现有端点）：概览六格（笔记/文件夹/标签/回收站/分享/附件 + 附件占用）、导出全部笔记（JSON，前端内存生成，不含附件二进制）、维护（清空回收站；**清理未引用附件** —— 新增 `POST /api/notes/attachments/prune`：扫全部笔记正文，id 没出现过的附件删记录+删对象；回收站/归档的正文也算引用，还原后图片仍可用）。导入留待后续批次。
- **编辑器头部高频操作直接平铺**（照 inkstone Workspace 头部）：桌面端 反链 / 版本历史 / 导出（三格式下拉）/ 分享 直接显示，「⋯」菜单不再重复这几项（只剩复制标题/直链、收藏、归档、移动、删除）；窄屏标题行放不下，平铺组不渲染、仍走「⋯」。
- 验证：tsc `-b` / eslint / **2165 单测（2164 pass + 1 本地跳过）** / build / smoke 全绿。新增用例：附件图片渲染 2 条、「数据」页 1 条、「管理」弹窗 1 条、头部平铺/窄屏菜单 2 条；30 条既有桌面语义用例补 `setWide()`（导航列 tablet 起不再挂载，jsdom 默认 1024px 的用例全受影响）。真机探针 23 项全过（顶栏出现 / 抽屉自动展开 / 贴左 272px / 无图标轨 / 背景点关 / 顶栏按钮重开 / 视图切回 / 拉宽无残留）。

## 2026-10-08 · 窄屏关掉列表列 → 左侧显示导航栏（用户复访调整）

上一段「复位桌面态」方案落地后的后续：用户复访提出，窄屏里「收起列表」应该和桌面**同一语义 —— 关闭后左侧是导航栏**，不要自动收成 44px 图标轨。

- 规则从「跨进窄布局复位桌面态」改成「**二选一常驻**」：窄布局里 `listHidden`（关中栏/聚焦文件夹）→ 导航列显示、列表列不渲染；否则导航列藏、列表列显示。导航列 `display: narrowLayout && !listHidden ? "none" : "flex"`；tablet 宽度 `listHidden ? navW+5 : listW+5`。
- 好处：不再需要复位 effect —— 桌面关着中栏拖窄，导航列直接顶上，语义连续；任何状态都自带出口（导航列里的视图按钮都带 `setMiddleHidden(false)`），永远不会有空白带。
- 「收起列表」按钮恢复 `setMiddleHidden(true)`（上一版在窄屏改成了收图标轨，已回退）。
- 守卫：3 条回归改写为新语义（桌面关中栏→拖窄→导航栏顶上且非 display:none→点视图按钮回列表列；聚焦文件夹→拖窄→导航栏+内联笔记仍在；窄屏收起→导航栏而非图标轨）。单测 2160（2159+1skip）/ tsc / eslint / build / smoke 全绿；真机 `harness/probe-b20-resize.mjs` **20/20**（导航栏 w=128 贴左边缘、无图标轨、视图按钮可切回、拉宽无残留）。

## 2026-10-08 · 修「调整窗口后最左侧栏显示不出」：窄布局自动复位桌面态

用户截图：窗口拖窄后左边是一条**空白带**，搜索框和笔记列表全没了，编辑区从空白带右边才开始；同宽度的另一张截图一切正常 —— 说明不是断点本身，而是**桌面态被带进了窄布局**。

- **根因**：tablet/mobile（CSS 视口 <1180）下导航列整列 `display:none`，而两个会把列表列藏掉的状态都是「导航列存在」才成立的桌面态 ——「关中栏」(`middleHidden`) 和「聚焦文件夹」(`folderFocus`，笔记内联在导航列里)。带着它们跨进窄布局：列表列被 `{!listHidden}` 整列藏掉、搜索框（窄屏时就住在列表列里）跟着消失，但 listPane 宽度仍按 `listW` 预留 → 屏幕左边一条空白带，且窄布局里**没有任何入口**能把状态翻回来（恢复按钮全在藏掉的列里）。空白带宽 ≈ `listW+5`，与截图量到的位置吻合。
- **修法（三层）**：
  1. 跨进窄布局的一瞬间复位两个桌面态（`useEffect [narrowLayout]` 里清 `middleHidden` / `activeFolder`）；回到桌面后重新选一次即可，不算丢状态。
  2. 列表列渲染门改成 `{(!listHidden || narrowLayout)` —— 窄屏唯一的导航入口永远渲染，将来任何状态漏网也藏不掉它。
  3. 窄屏里的「收起列表」按钮改收成 **44px 图标轨**（`listCollapsed`，轨上常驻「展开」按钮）—— 窄屏没有「关中栏」语义，原先直接 `setMiddleHidden(true)` 在窄屏里就会复现同一条空白带。
- 守卫：新增 3 条 DOM 回归（桌面收中栏→拖窄→列表列回来；聚焦文件夹→拖窄→列表列回来且内联区不再渲染；窄屏点收起→图标轨+展开按钮在）。真机探针 `harness/probe-b20-resize.mjs` **16/16**（关中栏→拖窄→列表列贴左边缘、与编辑区间隙 21px、窄屏搜索框可见；拉宽不残留关中栏态；窄屏收起→30px 图标轨→可展开）。

## 2026-10-08 · 记事本五连修：侧栏分栏缝可拖 / 关中栏后左栏可拖 / 分享链接打通 / 布局与编辑器排查

用户报了 5 个问题，3 个是真 bug 已修，2 个排查后不是代码缺陷（见末尾）。

- **修「侧边打开 → 分栏，中间那条缝拖不动」**：侧栏分栏的分隔条只有 `role='separator'` 与发丝线，**没挂任何拖动 handler**，左右两栏还写死 `flex:1`（永远 50/50）。补上 `startSideSplitDrag`（与主栏 `startSplitDrag` 同一套「窗口级 mousemove/mouseup + ref 跟最新比例」），源码栏按 `sideSplitRatio` 定宽，比例存 `notes.sideSplitRatio`（独立键，不蹭主栏），**双击回到对半**，比例夹在 0.2–0.8 防止把一边拖没。
- **修「中间栏关闭时，左边栏不能拖宽」**：导航列↔列表列的拖缝条件写成了 `!listHidden`，而 `listHidden = folderFocus || middleHidden` —— 选中文件夹或关掉中栏都会把拖缝一起收掉，导航列从此定死 128px。改成 `!listCollapsed`：只有「导航列本身不显示」（tablet 整列 display:none / 收起成 44px 轨道）时才收缝。
- **修「设置里分享列表的链接打开是导航主页」**：公开页路径前缀三处各说各话 —— 路由正则认 `/n/<token>`、分享弹窗生成 `/s/<token>`、设置列表拼 `/note/<token>`。除路由那一处外全都打不开公开页（SPA 回退把陌生路径兜成导航主页）。统一成 `/s/<64 位 hex>`（与 `PublicNotePage` 注释一致），真机端到端验证 `/s/<token>` 直接渲染「只读分享」页。
- **「缩放时左边两栏消失」是响应式设计不是 bug**：三栏断点 1180/768（照 inkstone `useBreakpoint`）。浏览器放大（如 1080px 窗口 ×125%）时 **CSS 视口**缩到 864px，落进 tablet 档 → 导航列收起、列表+编辑两栏保留；再小到 <768 进单栏。与缩小窗口是同一条路径。若希望导航列在更窄也保留，需另定断点（会压缩编辑区），待定。
- **「鼠标放在编辑器后变白看不清」未能复现**：真机在浅色/深色两主题 × 源码/即时渲染/分栏/预览四模式 × 标题/代码块/表格/内容块逐层量 computed `background-color`/`color`，全部对比度正常（浅色 `rgba(0,0,0,.87)` 字 × `rgba(255,255,255,.72)` 底；深色白字 × `rgba(255,255,255,.055)` 底），hover/聚焦前后无变化，截图肉眼核对无白底白字。需要用户提供截图/主题/操作路径再定位。
- 验证：全量单测 **2157** 通过（2156 pass / 1 本地跳过，本批新增 3 条守卫：侧栏缝拖动+持久化、拖缝条件用 `listCollapsed`、`/s/` 前缀三处一致），tsc `-b` / eslint / build / smoke 全绿；真机探针 `harness/probe-b19g-verify.mjs` **12/12**（分隔条拖动 1162→1283 且比例落库、双击归 0.5、关中栏后导航列 128→188、`/s/<token>` 标题与正文均为公开页）。
- 附带修正：守卫「侧栏分栏是左右排」的 3200 字符取样窗口扩到 4400 —— 分隔条补上拖动逻辑后，`left:"50%"` 被推到约 4050 字符处，旧窗口量不到（守卫意图不变）。


## 2026-10-08 · 图片上传（KV 落地，R2 接口预留）+ 修 Windows 上的 smoke

三点：**工具栏「上传图片」真的能用了**（此前一直是置灰的）、**存储按 inkstone 的方案做**（R2 优先、KV 降级，都没配就禁用入口）、**`npm run smoke` 在 Windows 上不再找不到 Chrome**。

- **修 `npm run smoke` 在 Windows 上报「Chrome: /usr/bin/google-chrome / 连不上调试端口」**：`script/ci-smoke.mjs` 的 `findChrome()` 只列了 darwin / linux 两组候选，Windows 落进 linux 那一档去查 `/usr/bin/google-chrome` —— 被 PATH 里的包装脚本骗到，拿了个不存在的路径。现在 win32 走自己的候选清单（`AppData/Local/Google/Chrome`、`Program Files (x86)`…），并用 `where` 兜底；**兜底结果也会再验一次 `fs.existsSync`**（不验的话一样会被 PATH 里的假路径骗）。
- **图片上传**（对齐 inkstone `src/worker/attachments/`）：
  - **存储选择**：有 `env.FILES`(R2) 用 R2，否则有 `env.FILES_KV` 用 KV，都没有就返回 null —— 上传入口自动禁用并说明原因。R2 未开通，所以**接口留着、绑定注释掉**（`wrangler.jsonc` 里 `r2_buckets` 整段注释）；开通只要建 bucket + 取消注释，**代码与前端都不用改**。
  - **不用 D1 存二进制**：D1 单行上限约 2MB，一张图就顶满（inkstone 同样不用 D1）。
  - **配额**：单文件 25MB（正好是 KV 单条上限，超出在写入前就被拒）、每账号 1GB、每小时 100 张 —— 与 inkstone `shared/constants.ts` 一致。
  - **租约（lease）**：并发下「都读到已用 900MB、都觉得还能塞 100MB」会实际写 1.1GB，所以同一用户的上传要串行化，抢不到锁返回 409。
  - **类型按文件头嗅探**，不信客户端给的 Content-Type；**SVG 不在白名单里**（它是 XML，能内嵌脚本）。
  - 对象写失败**不写 D1 记录** —— 否则留下一条指向不存在对象的元数据，用户刷新后图裂了却删不掉。
  - `attachments` 表随迁移建出来（schema 11 → 12）。⚠️ 和当初 `migrateFolderTagTables` 那个 500 是同一个坑：「版本号读得到就整段跳过迁移」的快路径会让新表永远建不出来，所以必须显式调用。
- **修「上传后正文里出现 `![undefined](data:text/html;base64,…)`」**（真机实测抓到）：后端回了「200 但不是预期 JSON」时（错误页、代理拦截，或 SPA 兜底把接口回落成 index.html），前端拿到的响应没有 `url` 与 `filename`，而 `fetch(undefined)` 会去请求**当前页面**、拿到 HTML 还当成图片内嵌。现在两道闸：① 响应缺 `url`/`filename` 直接报人话错误；② `blob.type` 不是 `image/*` 就不内嵌、改插链接。
- 验证：全量单测 **2154** 通过（2153 pass / 1 本地跳过，本批新增 4 条守卫），tsc `-b --force` / eslint / build / smoke 全绿；真机探针 `harness/verify-b18-upload.mjs` 通过（菜单顺序与文案对齐 inkstone、隐藏 file input 的 accept、塞文件后正文出现 `![probe.png](data:image/png;base64,…)`）。
- 部署前置：已建 KV 命名空间 `navihive-files-kv` 并把 id 写进 `wrangler.jsonc`（换环境部署要另建一个再换 id —— KV 不跨账号）。
- 收尾：图片按钮的 Tooltip 还写着「本地图片还没开放」（上线时漏同步）—— 用户悬停会照着提示以为是坏的。改成与现状一致：「点图标直接传本地图，点箭头选网络图片」。

## 2026-10-07 · 记事本第九批：两栏之间可见分隔线 + 编辑区内即时渲染（对齐 inkstone）

- **两篇笔记之间有可见分隔线**：`ColResizeHandle` 之前整条透明、hover 才变色，静态看两篇是「粘在一起」的。现在常驻 1px 发丝线（`::after`），命中区加宽到 9px，hover/拖动时变强调色并加粗。
- **去掉独立的「编辑区实时渲染」窗口，改成编辑区内即时渲染**（inkstone 同款）：新增 `src/components/NoteEditorLivePreview.ts`——按空行切块（围栏代码块内部不切）、**光标所在块保持源码、其余块用 `Decoration.replace` 换成渲染 widget**、点渲染块回到源码行接着改字、打字 90ms 防抖后重解析。开关用 `Compartment` 热插拔，不重建编辑器（撤销历史保留）。
  - ⚠️ 与 inkstone 的关键差异：它用 `innerHTML`，我们挂 React root 走「token→React」（全项目禁止字符串 HTML sink），单测有守卫盯着。
- 「编辑区实时渲染」原先生成的是「光标段落预览块 + 页面级缓存」，随之移除（那套缓存曾导致切笔记后渲染上一篇）。
- 验证：全量单测 **2103** 通过（2102 pass / 1 本地跳过，本批改写 4 条守卫），tsc / lint / build / smoke 全绿；真机探针 `harness/notes-live-preview-probe.mjs` **5/5**（编辑区出现渲染块、渲染结果是真正的标题/列表元素、独立窗口已消失、点渲染块回到源码、分隔线常驻可见）。
- 另附交付物：`deliverables/inkstone差异对照与下一步计划.md` —— 直接研读 inkstone 源码后整理的差异清单（A 类小改动 / B 类大功能 / C 类实现参考）与三批排期。

## 2026-10-07 · 记事本第八批：内联笔记左对齐 / 两栏可拖 / 即时渲染改为作用于编辑区 / 专注模式 / 窄屏收进更多操作

- **文件夹内笔记标题靠左**：真因是内联笔记的左缩进写成了 MUI **间距单位**（`pl: 1.25 + (depth+1)*10` → 实际 90px），128px 宽的左栏里文字只剩 25px，看起来就像「居中」。改成像素字符串（22px 起步、每深一层 +12px），与「未归类」那组齐平。
- **两栏之间恢复可拖动**（上一批按「固定 50/50」做，这批按用户新要求改为可拖）：默认 50/50，中间那条缝能拖，比例记在 `notes.paneRatio`，双击回到对半。
- **「即时渲染」改为作用于编辑区**：预览区**始终**渲染编辑区内容，不再受这个开关影响；开关现在控制的是「编辑区里实时渲染光标所在段落」（编辑器通过 `onCursorParagraph` 上报段落，页面渲染成一个小预览块）。换笔记时会清空缓存段落 —— 不清的话编辑区上方还渲染着上一篇，点里面的双链会跳错笔记（实测踩过）。
- **专注模式**（inkstone 编辑器页同名功能）：设置 →「编辑器」新增「专注模式」，淡化光标所在段落之外的行（CodeMirror `Decoration.line` + `.cm-focus-dimmed`）。实现踩了两个坑：① 必须用 `Decoration.set(...)` 造 `DecorationSet`，用 `RangeSetBuilder` 得到的 `RangeSet` 塞进 facet 不会给任何行加 class；② 编辑器是**先建后灌内容**的，只在挂载时算一次永远算在空文档上（`total=1`），必须在 doc 变化时重算。
- **窄屏（<900px）把即时渲染开关收进「更多操作」**：标题行已经有「三档 + 更多 + 关闭」，窄窗口塞不下；同一个状态在菜单里有入口（`data-active-op='live-render'`）。设置里的两个新开关也上移到「显示工具栏」旁边 —— 埋在长列表底下要滚动才看见，实测点不到。
- 新增/改写 6 条 DOM 回归；全量单测 **2103** 通过（2102 pass / 1 本地跳过），tsc / lint / build / smoke 全绿；真机探针 `harness/notes-ui-probe-2026-10-07d.mjs` **12/12** 通过（含真实拖动改变两栏宽度、双击回中、专注模式淡化行数、窄屏入口）。

## 2026-10-07 · 记事本第七批：即时渲染有反馈、模式键分段控件、左下角跟随背景、侧栏左右分栏、两栏头部对齐、侧栏状态栏对齐

- **即时渲染不再「打开后无效果」**：这个开关默认就是开的，打开当然看不出差别；关掉后预览停在旧内容却毫无提示，用户以为坏了。现在关掉时预览区顶部出现「预览已暂停 + 立即刷新」提示条（主栏与侧栏各一条），一键即可恢复随打字刷新。
- **模式键改成 inkstone 那种「框起来的一组图标」**：主栏与侧栏的 编辑/分栏/预览 都是纯图标 + 外框 + 分隔线，选中项填强调色（之前主栏宽屏是三个文字按钮，把标题行撑得很宽）。aria-label 保持中文。
- **左下角那块跟随背景色**：归档/回收站/账号/设置整块与文件夹行的「⋯」按钮原先写死 `background.paper`，而页面背景色（暖白/纯白）是算出来的 —— 于是暖白底上留着一块纯白（用户报「颜色不会变」）。改成透明继承。
- **侧栏「分栏」改成左右排**（源码在左、预览在右），与主栏一致，不再上下排。
- **两栏头部对齐**：抽出 `PANE_HEADER_H` 统一高度，主栏与侧栏的标题行/头部容器都用它（此前主栏靠 `pt:1.5` 自然撑高、侧栏多了两个按钮各自撑高，差 5~8px，标题与工具栏整排错位）。真机实测标题 top/高度差 0、工具栏 top 差 0。
- **侧栏状态栏与左侧同款**：模式 + 字数 + 字符数 + 创建于 + 保存状态（新增 `sideSaveState/sideSavedAt/sideTick`，自动保存过程也对外汇报），不再只写「侧边」两个字。
- 新增 5 条 DOM 回归；全量单测 **2101** 通过（2100 pass / 1 本地跳过），tsc / lint / build / smoke 全绿；真机探针 `harness/notes-ui-probe-2026-10-07c.mjs` **11/11** 通过。

## 2026-10-07 · 记事本第六批：修右键残留与文件夹内笔记右键 / 分屏等高 / 即时渲染 / 分享列表 / 工具栏白话

- **修「右键菜单消失后留一颗白色圆点」**：行是 `tabIndex=0` 的 role=button，右键会让它拿到焦点，行内那个 hover 才现形的「⋯」按钮被 `:focus-within` 顶出来常驻（真机差分定位：22×22 的圆形 IconButton）。现在右键先 `blur()` 再开菜单。
- **修「文件夹里已归属某文件夹的笔记右键不弹出、点别处才出现还错位」**（真机查出的根因）：`{!listHidden && …}` 那一大块把**行菜单、排序菜单、移动到文件夹抽屉、文件夹外观弹窗、标签菜单全裹了进去** —— 选中文件夹时中栏整列不渲染，这些浮层跟着一起卸载，左栏内联笔记右键设了状态却无处可显示。现在浮层整体移到根层（`data-pane-divider` 旁的注释写了原因），真机实测菜单立即出现在指针处（dx=0/dy=0）。
- 折叠态 44px 轨道：**展开箭头移到左下角**，顶部只留「返回」（`data-collapsed-rail`）。
- 分屏：**两侧高度一致**（主栏内容区去掉 `py:1`，此前主栏状态栏比侧栏高 16px）；两栏之间**固定 50/50、不可拖动**（`data-pane-divider='fixed'`，无 separator 角色、cursor 不是 col-resize）。
- **即时渲染开关**（inkstone 同名）：每栏标题行各一个，关掉后预览停在**已存库的内容**，打字不再触发整篇重解析。
- 侧边栏与主栏对齐：右上角也是**编辑 / 分栏 / 预览**三档（窄栏的「分栏」是源码在上、预览在下），另有自己的即时渲染开关、更多操作与常显关闭键。
- 设置新增**「分享列表」页**（参考 inkstone）：列出全部已分享笔记的链接、有效期与更新时间，支持搜索、复制、打开、管理、撤销；新增接口 `GET /api/notes/shares`（`listNoteShares`，JOIN notes 取标题并按 user_id 判归属）。「自动保存延迟」确认在编辑器页（上一批已加）。
- 工具栏改成说人话：每个下拉/图标都加了「会发生什么」的白话提示（如「把这一行变成标题：一级/二级/三级/正文」「插入网址，或引用另一篇笔记」），「插入 / 块」下拉里的术语改成白话（「块 ID：给这一段加个锚点，别处能引用它」等）。
- 演示数据留一条**在文件夹里**的笔记（否则文件夹树在演示模式下永远是空的，这条路径也测不到）。
- 新增 8 条 DOM 回归；全量单测 **2096** 通过（2095 pass / 1 本地跳过），tsc / lint / build / smoke 全绿；真机探针 `harness/notes-ui-probe-2026-10-07b.mjs` **20/20** 通过。

## 2026-10-07 · 记事本第五批：右键跟随鼠标、顶栏只压左栏、各栏自己的按键栏、设置扩容

- **右键菜单跟随鼠标**：文件夹与笔记的右键菜单改成用「鼠标坐标虚拟锚点」（MUI Popover 认任何带 `getBoundingClientRect` 的对象），菜单精确弹在指针处（真机量 dx=0/dy=0）。原来锚整行左上角 —— 位置与指针无关，且行在重渲染后锚点会失效，就是「点其他地方菜单位才冒出来还错位」的来源。
- **布局改为 inkstone 三栏各自到顶**：全宽顶栏拆掉，只保留在最左导航列上方（返回 + 「记事本」）；中栏列表与编辑区直达页面顶部。顶栏那排按钮（收起 / 分享 / 版本 / 大纲 / 反链）分别去了左下角与编辑区右上角的「更多操作」——它们只对当前编辑的这篇有意义，摆在页首纯属浪费纵深。
- **每个笔记栏有自己的按键栏**：主栏标题行右端是「编辑 / 分栏 / 预览 + ⋯」；侧边栏右端是「编辑/预览 + ⋯ + ✕」，侧边的更多操作直接复用列表行那套全量菜单、作用于侧边这条。分屏时两栏互不干扰（此前顶栏那套只对左边生效）。
- **侧边栏**：新增常显关闭键与编辑/预览切换（预览复用主编辑区那套 Markdown 渲染）。
- **工具栏防拥挤**：改为可换行铺开、高度自适应，去掉 `overflowX:auto` + 定高 —— 那两样凑在一起会让分屏时工具栏出现**竖向滚动条**并盖住标题。
- **设置扩容（参考 inkstone）**：外观新增背景色（暖白/纯白）、界面密度（舒适/紧凑）、正文字体（无衬线/衬线）；编辑器新增滚动同步（源码↔预览按比例联动）、数学公式开关、Mermaid 图表开关、折叠较长代码块 + 行数阈值、默认显示大纲、自动保存延迟（0.5–8s）、缩进宽度（2/4）。每项都接了真实行为，没有「存了没用」的假开关。
- 修掉的连带问题：折叠左栏后「返回导航站」会消失（已补进 44px 轨道）；中栏顶部残留 8px 内边距导致看着仍像被压着（去掉）。
- 新增 7 条 DOM 回归（右键锚点静态守卫、顶栏归属、收起按钮位置与折叠态返回、侧边栏按键、设置项与落盘生效、自动保存延迟生效、工具栏换行）；全量单测 **2087** 通过（2086 pass / 1 本地跳过），tsc / lint / build / smoke 全绿。
- 真机探针 `harness/notes-ui-probe-2026-10-07.mjs`：**24/24** 通过（三栏到页顶、右键贴指针 x2、工具栏无竖向滚动、侧边栏按键、设置项、紧凑密度生效），0 页面错误。

## 2026-10-07 · 记事本真机排查修复：打开后自动选中第一条等四处

- **打开记事本后编辑器整块空着**（真机 CDP 实测）：`activeId` 只在首次渲染用 `notes[0]` 初始化，而真实环境里笔记是异步拉回来的 —— 挂载那一刻还是空数组，等数据到位选中态已经定型为 null。现在数据到位后自动选中第一条（用户刚把当前这条移到回收站的「空状态」不抢）。新增 2 条「先空后到」的 DOM 回归。
- 归档 / 回收站入口没把收起的中栏放出来（收起后点它们屏幕一片空白）。
- 「移动到文件夹」改成右侧抽屉后，原来的锚点小菜单已无入口（死代码，删除）。
- 抽屉搜索框的 `aria-label` 挂在 MUI TextField 上会落到外层 div（读屏读不到，已移到 input）。
- 真机 25 项布局探针（三栏宽度 / 大纲面板 / 设置弹窗 / 外观弹窗 / 移动抽屉 / 侧边分屏 / 溢出与滚动条）全部通过，页面 0 控制台错误。
- 修 CI 上的两条红：①「按标题排序」用例原来用中文标题，而 CI runner 的 Node 是 **small-icu**（没有中文排序数据），`localeCompare` 退化成按码点比，顺序「没变」就红了 —— 浏览器是 full-icu、中文按拼音排是对的，所以把断言换成不受 ICU 影响的字母标题（钉的是「排序真的生效」）。②CHANGELOG 最新一段的日期按**提交者本地时区**判（本机 +0800 已是 10-07），段首日期跟着改。

## 2026-10-06 · 记事本第四轮 inkstone 对齐：文件夹外观 / 中栏 / 大纲 / 右键 / 设置 / 侧边分屏

- 文件夹外观：`note_folder` 新增 `icon` / `color` 两列（**schema 11**）。左栏按存的图标名渲染、颜色只上在图标上；脏数据（不在清单里的图标名 / 非十六进制色值）回落到默认样式，不会把左栏画崩。文件夹右键菜单新增「文件夹外观」（图标网格 + 8 色圆点）。
- 左栏不再有「搜索」导航行：顶部那个输入框本身就是全文搜索入口（聚焦即打开中栏结果）。中栏头部新增**排序 / 新建笔记 / 收起**（inkstone 布局）；收起后点顶部四个入口或底部归档 / 回收站都能把中栏放回来。
- 未归类的笔记直接列在左栏文件夹树下（不占中栏），右键「移动到文件夹…」在**屏幕右侧**滑出带搜索的抽屉（原来是锚点小菜单，文件夹一多挤得没法看）；搜索时左栏这一组也跟着过滤。
- 大纲：顶栏按钮改成**开关**，点开后大纲面板常驻在预览窗右侧（可点条目跳转）；没有标题时给一句说明而不是一块空白。
- 右键菜单：中栏列表行右键给完整菜单（复制标题 / ID / 直链、在侧边打开、收藏、创建副本、归档、移动到文件夹、编辑标签、导出 Markdown / HTML / PDF、移到回收站），左栏内联笔记右键给精简版。状态栏右下角那排「删除 / 置顶 / 归档」按键移除，功能全部收进右键菜单与顶栏「⋯」。
- 设置改成**记事本自己的**对话框（不再复用导航站配置）：左栏分「外观 / 编辑器」两页 —— 强调色（作为 `--accent` 只作用于记事本这一页）、正文字号、行高、内容宽度；编辑器字体 / 字号 / 行号 / 工具栏 / 拼写检查。落 `notes.uiSettings`（逐字段清洗，脏数据不会进运行时）。
- 新增「在侧边打开」：第二台完整编辑器（自己的标题框 / 工具栏 / 3 秒自动保存），两篇可同时编辑。插入逻辑抽成 `useEditorTools`，主 / 侧各持一份，**撤销状态互相隔离**（主编辑器连点取消不会撤掉侧边刚插的内容）；侧边那条笔记被删掉时自动收起，不留半屏空白。
- 顺带修的缺陷：`folderPick` 二级菜单在改成抽屉后已无入口（死代码，删除）；底部归档 / 回收站没把中栏放出来（收起后点它们屏幕一片空白）；移动抽屉搜索框的 `aria-label` 挂在 MUI TextField 上会落到外层 div（读屏读不到，已移到 input）。
- 新增 17 条 DOM 回归（含外观脏数据、抽屉搜索过滤、排序真的改顺序、大纲开关、两套右键菜单、设置落盘、侧边自动保存与自动收起）；全量单测 2078 通过（2077 pass / 1 本地跳过），tsc / lint / build / smoke 全绿。

## 2026-10-06 · 登录两边实测对比 inkstone 后的修复（第三轮）

- 方法：真机分别登录 inkstone 与本项目的记事本逐项清点（`harness/ink-vs-ours{3,4,5}.mjs`，原始数据 `harness/ink-vs-ours-raw.json`）。结论是**工具栏、左栏、顶栏、编辑器内核已基本对齐**，剩下的差距集中在状态栏与文件夹操作这两处。
- 状态栏：修「字 / 字符」是同一个数（实测原文「297 字 297 字符」，同一个 `charCount` 渲染了两遍，inkstone 是「1字 67字符」两个不同的量）。字数改按**去空白**计、字符数按含空白计；并补上「当前笔记所在文件夹」这个位置指示（inkstone 状态栏也有）。
- 文件夹「⋯」菜单从 4 项补到 8 项（inkstone「更多操作」是 9 项）：新增「在此新建笔记」「移动到…」（二级菜单，自动排除自身与后代，防止父子成环）「向前移动」「向后移动」，顺序按 inkstone 重排。
- 新增 Ctrl/Cmd + / 插入隐藏注释（inkstone「笔记工具」里这项标了这个快捷键）。只在编辑器有焦点时生效，不抢全局，避免吃掉输入法等其它 Ctrl+/ 语义。
- hook 层新增 `reorderFolder`：同级内**交换**相邻两者的 `order_num`（不是简单 ±1 —— order_num 可能有空洞或重复，±1 会撞车），两条 `updateFolder` 都成功才改本地，失败整份回退。
- 仍未做（需拍板）：**上传图片**（工具栏唯一明确缺失项，涉及存储）、**文件夹外观**（图标/配色，需后端新字段与迁移）。
- 新增 3 条 DOM 回归；全量单测 2060 通过（1 本地跳过），tsc / lint / build / smoke 全绿。

## 2026-10-06 · 记事本：左下角账号区、文件夹树、工具栏二次点击取消

- 归档 / 回收站从左栏导航组移到**左下角固定区**（不再随文件夹滚动跑出视野），并在同一处显示账号头像+用户名与设置按钮（复用站点设置弹窗）；未登录或老部署不传回调时不给死按钮。
- 选中文件夹时**中间笔记列不再渲染**，该文件夹的笔记直接内联显示在左栏该文件夹下（inkstone 文件夹树）；左栏「新建笔记」直接把笔记建在当前文件夹里（folder_id 随创建落库）。标签视图仍走中间列（标签是交叉维度，没有树状归属）。
- 工具栏补齐「再点一次取消」：新增通用开关 `undoableInsert`（判据＝同一工具 + 上次片段仍在原位，缺一不可，避免误删正文），标题/引用/内容块/分隔线/折叠/标签页/笔记嵌入/块引用/块 ID/笔记属性/插入表格/块级公式现在都能二次点击撤销。
- 修掉三个块级插入（分隔线 / 折叠 / 标签页 / 嵌入 / 表格 / 块级公式）在光标位于行中间时**吞掉该行正文**的缺陷：改为按整行切分插入。
- 新增 DOM 回归：撤销语义（含换按钮/改正文不误撤）、左下角账号区、文件夹树内联与中间列隐藏、文件夹内新建。全量单测 2057 通过（1 本地跳过），tsc / lint / build / smoke 全绿。

## 2026-10-06 · 记事本工具栏补全（inkstone 式下拉）+ 新建笔记入口左移

- 工具栏对齐 inkstone：新增「链接 / 图片 / 插入 / 块」四个下拉入口，与既有「标题 / 内容块 / 语言 / 公式 / 表格」同级（行内强调/代码/列表图标组保留）。
- 链接下拉：网页链接、双链 `[[笔记]]`、笔记嵌入 `![[笔记]]`、块引用 `![[笔记#^块ID]]`；图片下拉：网络图片（上传图片暂未开放，菜单中置灰）。
- 插入下拉：块 ID（` ^abc12`）、笔记属性（YAML front matter）、隐藏注释（`%%…%%`）、标签（`#标签`）；块下拉：折叠内容（`> [!FOLD]`）、标签页（`:::tabs`）、分隔线（`---`）。
- 预览层接入 `resolveNote` / `onOpenNote`：笔记嵌入按标题取正文并递归渲染，点标题跳到对应笔记；嵌入递归深度上限 3，防两篇互嵌栈溢出。
- 新建笔记按钮从顶栏移到左栏「文件夹」小节标题右侧，与「新建文件夹」并排（参考 inkstone 布局）。
- 新增 DOM 回归：四个下拉入口与菜单项、嵌入插入结果、新建笔记按钮定位；全量单测 2050 通过，tsc / lint / build / smoke 全绿。

## 2026-10-06 · 记事本只读分享与 Mermaid

- 新增令牌分享表（schema10；上线核验后补基础batch建表）和主人创建/查询/撤销接口；公开接口只返回标题、正文和更新时间，不缓存。
- 分享对话框支持1/7/30天或永久，重新生成轮换令牌；公开只读页面独立于登录界面。
- Mermaid 围栏走独立 opaque-origin 沙箱，主页面保留 Trusted Types；沙箱禁止联网、表单与同源访问。
- 分享真实SQLite隔离、轮换、过期、撤销回归通过；真实Chrome验证分享弹窗生成/撤销与公开图表沙箱，图表独占依赖不进首屏。
- 修正Cloudflare HTML规范化路径：无扩展名沙箱地址也使用专用安全头。迁移多行DDL改prepare整条执行，避免D1 exec按行拆SQL且异常被吞后版本虚增。
- 更新source-map-js传递依赖消除高危审计项；Mermaid内嵌KaTeX仍有低危审计项，受沙箱与strict模式限制，继续跟进上游。

## 2026-10-06 · 修复：记事本文件夹创建/删除 500（parent_id 缺列）

- 修复「新建文件夹」与「删除文件夹」线上报 API 错误 500：已部署的 `note_folder` 表**缺 `parent_id` 列**。老库建表时尚无该列，`CREATE TABLE IF NOT EXISTS` 不对已存在表补列；而负责 `ALTER` 补 `parent_id` 的 `migrateFolderTagTables` 此前**定义却没接进 `runMigrations`**，于是老实例上这一列永远补不上。`createFolder` 的 `INSERT (…, parent_id, …)` 与 `deleteFolder` 的 batch（`UPDATE note_folder SET parent_id = NULL`）都踩到缺列 → 500。
- 修复方式：在 `runMigrations` 第 6.5 步改调 `migrateFolderTagTables`（建表后补 `parent_id`），并升结构版本号到 `8`，让已部署实例（版本停在 7）冷启动时会重跑迁移补上该列。
- 标签的创建/删除本身正确（表结构完整、路由与弹窗入口齐全），此前「标签删不掉」多为同一故障会话的连带观感；已在真实 SQLite 上回归验证「建/删文件夹、建/删标签」四个操作全部跑通。
- 新增真实 SQLite 回归测试（`tests/noteFolderTagRealSql.test.ts` + `schemaMigration` 的 `parent_id` 守卫），堵住「单测全绿、线上 500」的盲区：FakeD1/MockD1 不执行 SQL，发现不了「真实库里缺一列」。

## 2026-10-06 · 记事本第四批 D：版本历史与内容块

- 新增版本历史：正文改动前自动留档，顶栏可列出各版本时间与字数并一键恢复；恢复动作本身也会留档，可再撤回。
- 快照每条笔记只保留最近 60 条（超出自动裁剪），避免随时间无限增长撑爆数据库；列表不返回正文全文，按需单取。
- 新增内容块：`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!QUOTE]` 渲染成带图标配色的提示块，工具栏可一键插入；不认识的类型与普通引用块保持原样。
- 修复版本历史列表的绑定参数顺序错误（`LIMIT` 占位符与账号参数错位，表现为历史永远为空）。

## 2026-10-06 · 记事本第四批：双链、反向链接与交互质感

- 正文支持 `[[双链]]`：预览里渲染为可点链接，单击跳到对应笔记；标题找不到时报错提示，不再点了毫无反应。
- 顶栏新增「反向链接」，角标显示被引用条数，面板分「链出去」与「链进来」两段，均可点击跳转。全部在客户端算，不新增数据表。
- 工具栏新增「链接与引用」：把选中的文字变成脚注引用（原文搬进文末定义），连续插入自动递增编号，再点一次可完整撤销。
- 新建/重命名文件夹与标签、删除分类改用站内弹窗，替换原生 prompt/confirm；删除前说清「笔记不会被删」。
- 拖放补视觉反馈：拖起项半透明、可放置目标行高亮并清除；界面层拦下「拖进自身子文件夹」造成的环。
- 全屏记事本支持 Escape 关闭（有改动先保存）与 Tab 焦点循环；子文件夹缩进改为 10px 递增并封顶 6 级；窄屏保留三档视图（收窄为图标）。

## 2026-10-06 · 记事本第四批 A：修复查发现的三个缺陷

- 文件夹「更多」菜单锚点改为真实按钮，菜单不再弹到屏幕左下角（此前 `anchorEl` 为空，视口左上/底部原点）。
- 文件夹与标签的条数不再计入归档笔记，与界面本地统计口径统一，避免首屏数字随后自动变小。
- 删除标签时同步清理本地标签关联，标签视图计数不再可能串到其他标签。
- 补充守卫：分类计数子查询必须带归档过滤、菜单锚点来源、删除标签的关联清理；并在真实 SQLite 上验证计数语义。

## 2026-10-06 · 记事本第三批：分类备份、子文件夹与正文标签

- 备份格式1.4包含文件夹父子关系、标签和笔记标签关联，恢复按目标ID及文件夹路径映射，保留归档状态；老备份缺分类字段时不覆盖本地分类。
- 恢复写入、关联更新与旧数据清理统一一个D1事务，容量拒绝不拆分提交；修复未取得恢复锁的请求误释放持有者锁的问题。
- 子文件夹树形展示，菜单创建子文件夹/移到根目录；支持文件夹拖入父文件夹、笔记拖入文件夹，校验归属及自身/祖先循环。
- 正文内联#标签自动追加关联，忽略代码、转义和链接；预览双击标签跳到标签视图。移除正文标签不自动删除已有关联。
- 正文与自动标签同事务保存；标签元数据刷新失败不回滚已保存正文。模拟接口对齐，解析器按需加载，保持首屏预算。

## 2026-10-06（五续）· 记事本第二批：CodeMirror 6 与脚注

- 源码编辑器改用 CodeMirror 6：Markdown 语法着色、行号、当前行、自动换行、括号匹配与撤销/重做。
- 通过同步编辑接口保留工具栏格式开关、选区、代码语言、表格、公式及自动保存；大纲滚动改用编辑器真实选区布局。
- 支持 `[^id]` + `[^id]: 说明` 与 `^[行内说明]`，工具栏增加行内脚注按钮。预览用 token→React 输出编号、注释与返回链接，不使用 HTML 字符串注入。
- CodeMirror/Lezer 单独按需分包，避免 manualChunks 的 vendor 兜底将编辑器装入首页；增加首屏产物守卫。
- 测试改用 CM 状态与选区接口，并补充脚注多次引用、排序、转义、代码及安全渲染用例。

## 2026-10-06（四续）· 修「左两栏还是拖不动」+ 记事本整块移出首屏

上一轮说「左两栏可拖动」是**假通过**，用户一试还是拖不动。这轮真机复现并修掉。

- **左两栏拖不动：分隔条被压成 0 高度**。
  根因是两条 `ColResizeHandle` 被写进了导航列 / 列表列**内部**，而那两列是
  `flex-direction: column` → 分隔条被压成 `h=0`、贴在 `x=0`，真实鼠标**点不中**。
  真机 CDP 量到 `7 × 0 @ x=0`；挪到列外后是 `7 × 651 @ x=128`，
  真实鼠标一拖 `128 → 208`，落盘值与渲染宽度一致。
  另外给分隔条补了 `alignSelf: stretch` + `minHeight` + `touch-action: none`
  （触屏上不写后者，拖动会被滚动手势吃掉）。
- **⚠️⚠️ 为什么上一轮没抓住**（这条比 bug 本身更值得记）：
  验收用的是页内 `el.dispatchEvent(new MouseEvent("mousedown"))` ——
  **合成事件不做浏览器的命中测试**，直接把事件塞给那个元素，
  于是「元素在不在、handler 跑没跑」全都能骗过去。真机走的是
  命中测试 → 事件目标 → React handler 的完整链路，两者结论相反。
  → 给 `harness/cdp.mjs` 补了 `dragMouse()` / `centerOf()`（走 `Input.dispatchMouseEvent`），
  **依赖命中测试的交互（拖分隔条、拖排序、点遮挡层）从此只能用它验**。
  单测里则改成断言 DOM 结构（分隔条的 `parentElement` 必须是左栏容器，不能是某一列）。
- **记事本整块移出首屏**：
  之前只 lazy 了 `NotesPage` 组件，但 `App.tsx` 顶层还调着 `useNotes()` ——
  **hooks 不能异步调用**，所以整个 hook（乐观更新、回滚、全部文案）都留在首屏包里，
  等于只 lazy 了一半（实测首屏里还留着 22 条 hook 的中文文案）。
  现在新增 `components/NotesOverlay.tsx`：hook 与视图一起装进去，对这个文件做 lazy；
  App 这边只留一个 `notesCount` 数字给顶栏菜单显示（进面板时回报）。
  - 真实首屏 919.0 KB / gzip 296.8 KB（基线 914.1 / 295.2）
  - index chunk 223.42 → **218.19 KB**
  - 真机验：登录后首屏 41 个资源请求里**没有**记事本 chunk，
    点「记事本」才下载 `NotesOverlay`（58.49 KB / gzip 18.22 KB），面板与计数均正常
  - 守卫：`tests/bundleBudget.test.ts` 加两条 —— App 不得静态 import / 调用 `useNotes`，
    且**产物**的首屏文件里搜不到 `INSERT INTO notes` 与 hook 文案
- 用例 1943 → **1946**。

## 2026-10-06（三续）· 高亮修复 + 左两栏可拖动 + 对照 inkstone 第一批

用户提了三件事：左边两栏太窄、高亮按钮点击无效、把对比报告的第一批做掉。

- **高亮按钮「点击无效」**：插入是对的（源码里确实有了 `==高亮==`），**预览里不出效果** ——
  解析层从来没装 `mark` 规则，所以那四个字符原样显示，看着像按钮坏了。
  已补 `utils/markdownMark.ts`（与公式同一套思路：自写 inline 规则出 `mark_inline` token，
  渲染层映射成 `<mark>`）。判据比公式那套宽：`==` 是用户明写的意图，不与正文撞车，
  所以只要求闭合标记两侧非空白，不拒「内容首尾带空格」。
- **左两栏可拖动**：导航列（128）与列表列（208）原来是定死常量，现在两条缝都能拖，
  宽度存 localStorage，双击回默认。三个坑：
  - 命中区必须 **7px**（2px 的细线在笔记本触控板上根本点不中）；
  - 宽度要**设定即所得**：列表列原来留着 `flex: 1`，浏览器会按容器剩余空间重排，
    实测「设 208 → 量出 221」，存进 localStorage 的值和真实宽度差 13px，刷新后列宽会跳；
  - 拖动闭包读不到最新 state（同分隔条那次），最新宽度走 ref。
- **对照 inkstone 第一批**（报告 `docs/notes-inkstone-gap-2026-10-06.md` 里的四项）：
  - **导出 Markdown**：列表行菜单里加一项，标题 + 正文存成 `.md`。
    文件名要洗一遍：Windows 禁止的 `/ \ : * ? " < > |` 换下划线、结尾的点与空格去掉
    （系统会悄悄截掉 → 导出成没有后缀的文件）。用 Blob 而不是 data URL（后者有长度上限）。
  - **大纲**：从源码抽标题层级，点一条把光标送到那行**并选中整行**
    （只挪光标的话，长笔记里那根 1px 竖线根本找不着）。代码块里的 `#` 不是标题 ——
    这条最容易错，判错了一次大纲里就凭空多出「安装依赖」，点进去落在代码块中间。
  - **搜索视图**：升级成左栏独立视图（原来只有列表上方一个输入框），**多搜标签名** ——
    用户记不清正文里有没有那个词，但记得「我给标了『合同』的那几条」。
    归档的笔记也一并搜；⌘K 现在会同时切到搜索视图（只聚焦输入框的话打完字列表纹丝不动）。
  - **状态栏「创建于 …」**：跟 inkstone 一样放右端，时间解析不出来就整项不显示。
- 用例 1912 → **1943**（新增 markdownMark 9 条、noteOutline 12 条、noteExport 9 条、
  第一批界面 9 条）；首屏 230.00 KB（预算 236）。

## 2026-10-06（续）· 全面排查：修一个线上 500 + 补齐文件夹/标签入口

对照 inkstone 逐项过一遍记事本，挖出 7 个问题，其中一个是**线上功能整个不可用**。

- **P0：线上「新建笔记」必然 500**。`createNote` 的 `INSERT` 列了 8 个字段
  （阶段三收尾加了 `folder_id`）却只给了 7 个值，SQLite 直接报
  "table notes has 8 columns but 7 values were supplied"。
  迷惑之处在于 `GET /api/notes` 完全正常，列表看着好好的，只有新建这一条路是死的。
  已修，并补了一条 SQL 形状守卫（INSERT 的列数必须等于**顶层**值数）——
  现有那几条守卫盯的是「占位符数 == bind 参数数」，这一条照样成立，所以一直没人发现。
- **回收站还原会静默丢状态**：`reinsertNote` 的 INSERT 少写 `folder_id` / `archived`。
  删笔记时进回收站的是 `SELECT *` 的完整行（字段都在），少写一列就是「还原时清零」：
  归档笔记弹回「全部」视图、归了文件夹的笔记掉回「未归类」，而用户看着像还原成功。
- **标签关联在删除时既没存也没清**：`note_note_tag` 留着指向已删笔记的悬空行（还占着左栏计数），
  还原又换了新 id，标签再也接不回来。现在 `deleteNote` 一并存 `tagIds`、一并清关联，
  `reinsertNote` 写回新 id（写前先确认标签还活着）。
- **P1 越权：`listNoteTags` 全表扫 `note_note_tag`**。那张表没有 `user_id` 列，
  归属只能靠 `JOIN notes` 判定 —— 不加就是跨账号把别家的 (noteId → tagId) 拉回前端。
- **`deleteFolder` 不是事务**：先删文件夹再清 `notes.folder_id`，中途失败就留下
  「文件夹没了、笔记还指着它」的悬空值，那几条笔记在左栏任何文件夹视图里都点不出来。
  已改成同一个 `db.batch`，并调整成先清关联再删文件夹。
- **「未归类」视图判据错了**：它筛的是 `site_id`（没挂在站点上），
  而记事本根本没有「把笔记挂到站点」的入口，`site_id` 永远是 null ——
  于是这个视图跟「全部」**完全等价**（左栏两个计数一模一样）。已改成按 `folder_id` 判。
- **文件夹 / 标签功能是「有后端、没入口」**：数据层、接口、路由全齐，
  界面上却没有一处能把笔记归进去（`onAssignTags` 传进去了但从没被调用），两个视图永远是空的。
  已给每行加 hover 出来的「⋯」菜单（收藏 / 归档 / 归入文件夹 / 编辑标签 / 删除），
  列表行同时显示标签徽章 —— 这也是 inkstone 的做法。
- **拖分隔条的比例存不回去**：`onUp` 里写的是 `readSplitRatio()`，
  那是**从 localStorage 读**，存回去的必然是拖动前的旧值（拖完刷新就弹回去）；
  而且 `onUp` 是 mousedown 那一刻挂的闭包，读 `splitRatio` 状态也拿不到最新值 —— 改走 ref。
- 公式补上 LaTeX 原生定界符：`\(…\)` 行内、`\[…\]` 块级，与 `$…$` 两套并存。
  它们的规则**故意不同**：`$` 会和正文里的美元符号撞车，所以内容首尾带空白一律不认；
  `\(` 是明写的意图标记，只要求非空。注册位置也相反 —— `\(` 必须排在 markdown-it 的
  `escape` 规则**之前**（escape 会把 `\(` 当 ASCII 标点转义吃掉），`$` 排在之后。
- 用例 1876 → **1898**；首屏体积不变（katex 仍独立分包）。

## 2026-10-06 · 记事本阶段四：代码块语言 / 表格行列 / 相对时间 / 自动保存 / 公式

编辑器能写公式了，写错的代价也小了。这一轮只动记事本，导航页没碰。

- **公式（KaTeX，新增依赖 `katex`）**：`$行内$` 与 `$$块级$$` 在预览里真渲染成公式
  （块级居中、可横向滚动）。三个坑都记在代码注释里：现成的 markdown-it 公式插件都注册
  `renderer.rules`，而本项目渲染层只把 markdown-it 当**解析器**（token → React 元素），
  插件完全不会被调用；块规则的签名是四参数 `(state, line, endLine, silent)`，
  少接一个参数时 `silent` 收到的是**行号** → token 一个都出不来、正文被吞、界面零报错。
  CSP 开了 `trusted-types`，所以渲染走 `katex.render` 的 DOM 入口（createElement），
  不碰 `innerHTML` 那一串禁用的 sink。KaTeX 动态引入并单独分包，
  没进首屏（首屏体积不变）。
- **代码块语言下拉**：改围栏语言不动正文一个字；选语言时顺手补贴一个该语言的空代码块。
- **表格增删行列**：新增纯函数 `utils/markdownTable.ts`，连带重排对齐。
  光标落在**表头或分隔行**时新行必须落到整表末尾 —— 插在表头与分隔行之间会把分隔行挤走，
  整张表当场散掉（浏览器实测撞过）。
- **相对时间**：列表里的绝对时刻改成「N 分钟前」，鼠标悬停仍是完整时间。
- **自动保存的状态摊开**：原来只有一句「有未保存的改动」，看不出到底存没存。
  现在状态栏依次显示 待存 → 正在保存 → 已保存 · 刚刚（「刚刚」会自己走秒，不会永远停住）。
- **公式的误伤边界**：`$100 和 $5` 里的第一枚 `$` 形式上能配到对（内容是 `100 和 `），
  放过去正文里的美元符号就全被吃掉。现在行内公式的内容**首尾带空白一律不认**。
- 用例 1876 条（单测 1875 过 / 0 败）；首屏体积与上一轮持平。

## 2026-10-05（十六续）· 滚动条真因 + 可拖分隔条 + 格式工具栏

- **滚动条的真因找到了**：上一轮只给**外层容器**补了 `minHeight: 0`，
  却漏了**预览区自己**。flex 子项默认 `min-height: auto`，Markdown 一长就把预览区
  撑高、连带整页出现滚动条（该滚的只有预览区内部）。
  这已经是同一个坑第三次出现（前两次是列表栏、编辑区容器）——
  **`minHeight: 0` 要加在「每一个参与纵向 flex 的子项」上，不是只加最外层。**
- **可拖拽分隔条**：`splitRatio` 状态（0.2~0.8 之间夹紧），左栏按百分比取宽，
  松手时写进 `localStorage` 记住；**双击回到对半**。
  两个实现要点：
  - `mousemove` / `mouseup` 挂在 **window** 上，不是分隔条自己 ——
    指针拖出那条 8px 宽的带子就会丢事件，只挂元素上会「拖到一半卡住」。
  - 拖动时给 `body` 加 `userSelect: none`，否则拖动会顺带选中整页文字。
  - `role='separator'` + `aria-orientation='vertical'`：读屏软件能认出这是个分隔条。
- **Markdown 格式工具栏**（15 个按钮：H1/H2、粗、斜、删、行内代码、代码块、引用、
  无序/有序列表、待办、链接、图片、高亮、表格）。点一下在**光标处**插入，
  有选区时**包住选区**；插完用 `requestAnimationFrame` 把光标放回插入内容之后。
  关键：按钮用 `onMouseDown` + `preventDefault` ——
  默认行为会让 textarea 失焦，`selectionStart` 变成 0，插入位置全跑到开头。
- **守卫同步更新**：原来那条「两栏 basis 必须相同」已经过时（机制换成了
  「左栏按比例 + 分隔条」），改成断言新机制；另加一条盯工具栏的
  `onMouseDown preventDefault` 与 `setSelectionRange`。
- **诚实说明**：我尝试装 `agent-browser` 想直接目测效果，**装不上**（沙箱限制）。
  所以这次的布局效果我仍然**没有亲眼看过** —— 前几轮连续返工正是这个原因。
  代码层面的守卫只能防回退，防不了「看起来怪」。
- 用例 1772 → **1773**；首屏 225.96 KB 不变。

## 2026-10-05（十五续）· 修分栏比例与残留滚动条

用户反馈「还是有滚动条，分栏两边大小不合理」。

- **分栏不合理的原因算得出来**：容器 890px 时，源码区 `flex: 1 1 50%`（basis 445）
  与预览区 `flex: 1`（basis 0）**basis 不同**，剩余 445px 再按 grow(1:1) 分 →
  源码 667 / 预览 222 —— 预览只剩四分之一，看着就像「被挤没了」。
  修：源码区分栏时也用 `flex: 1 1 0`（basis 0），两边对称，严格对半。
  **教训：一组 flex 子项要等分，basis 必须都相同**（要么都 0，要么都同一个值）。
- **滚动条这次是双保险**：上一轮补了 `minHeight: 0`，但页面级滚动条仍在 ——
  与其继续逐层找哪一漏了，不如在**整页容器**上直接 `overflow: hidden`：
  这一层本来就是「整页不该滚」的语义（该滚的是预览区内部），
  写出来还兼作自我说明。加了守卫钉住它。
- **两条新守卫**：分栏两栏 basis 必须一致（不许出现 `1 1 50%`）、
  整页容器必须带 `overflow: hidden`。变异验证：源码区改回 `1 1 50%` → 立刻变红。
- 写守卫时又踩了一次**注释污染**：源码注释里正好写着「1 1 50%」当反例，
  `source.includes("1 1 50%")` 命中注释 → 守卫永远红。
  用 `stripComments` 解决（**这个坑今天已经踩第二次**，CHANGELOG 里也记过一次）。
  另外剥完注释要**在同一个字符串上找索引** —— 拿原文偏移切清理后的字符串会切错位置。
- 用例 1770 → **1772**；首屏 225.96 KB 不变。

## 2026-10-05（十四续）· 修布局：中间空白与页面级滚动条

用户反馈「中间还是空的，为什么有滚动条」。两个症状同一个根：**flex 约束写重了**。

- **中间那块空白**：左栏（笔记列表）内层已经用 `width: 300 + flexShrink: 0` 定死了宽度，
  而它**外层**那个容器又写了 `flex: 1` —— flex 把外层撑到约 445px，里面的列表还是 300px，
  多出来的 145px 就是「空白」：**内容被一个自己撑大的空容器推到右边去了**。
  修：外层改成 `flex: "0 0 auto"`，宽度只由内层决定。
  **教训：定宽的一层和外层不能同时用 flex 分配宽度** —— 宽度只能由一层说了算。
- **页面级滚动条**：右栏容器缺 `minHeight: 0`。flex 子项默认 `min-height: auto`，
  内容一高就把这层撑高、进而把最外层 `position: fixed; inset: 0` 的容器顶出视口 ——
  表现就是整页出现滚动条（而记事本本该只在**预览区内部**滚）。
  修：两个容器都补 `minHeight: 0`，并给标题框与状态栏加 `flexShrink: 0`（别被内容挤扁）。
- **两条静态守卫**（jsdom 没有布局，「中间空白」「页面滚动条」这类**视觉问题目测不了**，
  只能把结论钉在源码上）：左栏容器必须是 `flex: "0 0 auto"`、右栏必须带 `minHeight: 0`。
  变异验证：把左栏改回 `flex: 1` → 立刻变红。
- 用例 1768 → **1770**；首屏 225.96 KB 不变。

## 2026-10-05（十三续）· 记事本视觉重做

用户对照 inkstone 的截图提了四条：① 标题左边那个「0」是什么 ② 搜索栏放大镜错位
③ 中间空白栏是干嘛的 ④ 整体太简陋。

- **①「0」是个真 bug**：`{note.pinned && <PushPinIcon/>}` —— `pinned` 存的是数字
  `0/1`，而 **`0 && x` 在 JS 里返回 0**，React 把 0 当文本渲染出来，于是每条未置顶的
  笔记标题左边都挂着一个孤零零的 "0"。改成 `Boolean(note.pinned) && …`。
  加了回归用例（**必须传 `pinned: 0` 而不是 `false`**，否则测不到这条路径），
  变异验证：去掉 `Boolean()` → 立刻变红，失败信息直接把 `0甲内容` 打出来。
- **② 放大镜**：原来是「原生 `<input>` + 一枚 `position: absolute` 的图标」，
  那个定位既对不齐又飘在框外。换成 MUI `TextField` + `slotProps.input.startAdornment`，
  图标跟着输入框走。加用例断言放大镜在 `.MuiInputAdornment-root` 里。
- **③ 中间那片空白**：源码区当时是「无边框 + 透明背景」，跟白色的预览区糊成一片，
  看着就像那块没内容。现在两栏各有边框、圆角与淡底色（源码稍深、预览稍浅），
  分栏一眼能看出来是两栏。标题框也从裸 `<input>` 换成 `TextField variant="standard"`
  （之前那版字号与下划线都看不出来，标题像是没有）。
- **④ 整体向 inkstone 靠**：
  - 列表项：圆角、hover 过渡、加了**更新时间**（今天给时刻、更早给日期），空内容显示
    「空白笔记」而不是空白一片；左栏顶部加「共 N 条，M 条置顶」。
  - 状态栏：字 / 字符 / 预计阅读时长 / 当前视图（照 inkstone 那一行）。
  - 列表搜索框、标题框统一用 MUI 组件，不再手搓原生标签。
- 用例 1766 → **1768**；首屏 225.96 KB 不变（都是原生标签换 MUI，体积没涨）。

## 2026-10-05（十二续）· 收尾

**记事本最后一块：Markdown 渲染层**（方案里最微妙的一处）。至此记事本完整可用。

- **`src/utils/markdownToReact.tsx`**：markdown-it **只当解析器**（`md.parse()` 出 token），
  再把 token 映射成 React 元素。全程**不产生 HTML 字符串、不碰任何 sink**，
  连 DOMPurify 都不需要 —— 保住「全仓 0 处 innerHTML」，也就保住了 CSP 的
  `require-trusted-types-for 'script'`（enforce、无 trusted-types 指令）不炸。
  覆盖：标题 / 段落 / 有序无序列表 / **任务列表（真 checkbox）** / 引用 / 代码块（带
  `data-lang`）/ 表格 / 分隔线 / 粗斜删除线高亮 / 行内代码 / 链接（外链带
  `target=_blank rel=noopener`，`javascript:` 降级成纯文本）/ 图片（只放行 http(s) 与内联图片）。
- 写它时踩了三个坑，都写进注释了：
  1. **配对标签必须按 `nesting` 用栈处理**。`strong_open` / `strong_close` 是两个 token，
     我一开始 `children.map()` 逐个渲染，**结果 strong / em / link 全都渲染不出来**
     （open/close 都落进 default 分支，只剩一堆空 span）。
  2. **token 名带 `_open` 后缀**：映射表写成 `strong` 一个都匹配不上（它给的是
     `strong_open`），同样全落进 span。
  3. `takeUntilClose` 的深度**从 1 起算**（调用方已消费了 open）。从 0 起算的话
     第一个内容 token 会被 `depth >= 1` 挡掉，**引用和表格整块变空**。
- **一个 `manualChunks` 的坑（+105KB）**：`vite.config.ts` 里那条兜底规则
  `if (!id.includes("node_modules")) return; … return "vendor"` 会把**所有**
  node_modules 扫进 `vendor`，而 `vendor` 是**首屏 chunk** —— markdown-it 于是被
  硬塞进首屏，bundleBudget 直接判红（实测 1019.4 KB，超预算 69 KB）。
  它明明只被动态 import（`loadParser` 里 `import("markdown-it")`）。
  修法：给它单独一条规则 `return "markdown"`，与它的依赖
  （mdurl / uc.micro / entities / linkify-it）一起成块（实测 102.84 KB 独立成块）。
  **教训：加新依赖后要跑 bundleBudget —— 动态 import 不等于不进首屏，
  `manualChunks` 的兜底规则会把它捞进去。**
- **测试**（`tests/markdownRender.dom.test.tsx`，10 条）：结构断言（真的渲染出
  h1/li/blockquote/table/pre，不是纯文本）+ 安全断言（`<script>` / `onerror` /
  `javascript:` / `data:text/html` 一律不执行、降级成纯文本）+
  **静态守卫：渲染层源码里不许出现 `innerHTML` / `dangerouslySetInnerHTML` /
  `document.write` / `eval` 等 sink，也不许调用 markdown-it 的 `.render(`**。
  静态扫之前先 `stripComments` —— 不剥的话会扫到注释里「为什么不用 dangerouslySetInnerHTML」
  这类说明文字，守卫变成永远红的假警报（比没有守卫更糟）。
- 接线：`NotesPage` 的预览栏换成 `<MarkdownPreview>`（异步解析 + 「解析中…」占位 +
  取消标记，输入快时不会闪回旧内容）。
- 用例 1755 → **1766**；首屏回到 225.96 KB，bundleBudget 通过。

**记事本至此完整**：数据通路 / 导入导出（默认含 + 合并覆盖 + 三态统计）/ 独立页面
（参考 inkstone 的列表 + 源码|预览分栏 + 状态栏）/ Markdown 渲染。剩下没做的只有
**拖拽排序**与**离线队列**（两处都已有服务端接口，见下轮）。

## 2026-10-05（十一续）

**又一轮 500，这次是 SQL 写错了**（用户报「新建笔记失败：API 错误: 500」）。

- 根因：`createNote` 的 `order_num` 子查询里用了 `scopeSql(true)`。它生成的是
  ` AND user_id = ?`，接在 `FROM notes` 后面就成了
  `FROM notes AND user_id = ?` —— **SQL 语法错误**。
  规则是：`scopeSql(true)` 只在「语句已经有 WHERE」时用（追加 AND），
  没有 WHERE 时必须用 `scopeSql(false)`（生成 WHERE）。
- 还漏绑了子查询里那个 `?` 的参数（7 个占位符只给了 6 个）。
  用 `scopeParams([])` 取 —— 它在单账号部署（uid 为 NULL）下返回空数组，两种情况都对。

### 顺着修出了三处同类错误

写完守卫一扫，发现**同样的误用还有两处**，都已经在代码里了：
`listNotes`（`FROM notes AND …`）与 `transfer.ts` 合并分支里读本地笔记那条。
更要紧的是：上一轮修 500 时**我以为已经修完了** ——
一个 python 脚本里三处改动共用一个 assert，其中一处失败导致**整体没写入**，
我却没有检查结果就提交了。**「脚本没报错」不等于「改成功了」**（这坑我今天踩第二次了）。

### 加了 SQL 形状守卫（tests/noteSql.test.ts，5 条）

这类错误在现有测试结构里是**盲区**：
- `noteRoutes` 测路由层（只验证「路由把什么交给 api」）；
- `noteTransfer` 的 MockD1 按前缀字符串匹配，**不校验参数个数**；
- `schemaMigration` 不碰业务 SQL。

守卫里有两条特别值得说：
1. **运行时检查**：真调一次 `listNotes` / `countNotes`，看生成的 SQL 长什么样。
   之前我写的是「在源码文本里找字面 ` AND `」—— 而源码里是 `${this.scopeSql(true)}`
   （函数调用），那条检查**永远是绿的**，变异验证时才发现它形同虚设。
   **静态正则抓不住这种事**。
2. `createNote` 的 bind 必须展开 `...scopeTail`（子查询参数漏绑的守卫）。
变异验证：listNotes 改回 `scopeSql(true)` → 立刻变红并打出真实 SQL；
删掉 `...scopeTail` → 那条也变红。

- 用例 1750 → **1755**。

## 2026-10-05（十续）

**修 500 + 记事本改成独立页面**（两件事，用户一次报上来的）。

### 1. 记事本接口一律 500

`migrateIfNeeded` 读到与库里相同的 `SCHEMA_VERSION` 就**直接返回，连 CREATE TABLE
都不跑**。昨天加了 `notes` 表却没动版本号，于是：

- 本地 / 全新部署：正常（全新迁移，建表语句全跑）
- **已部署的线上实例：`notes` 表永远不存在** → 记事本接口全 500

`SCHEMA_VERSION` 2 → 3（ALTER 都是「先查缺哪些列再补」，重跑安全）。
加了一条静态守卫：读建表语句、断言版本号 **不小于 3**，失败信息里写清后果。
写成「>= 3」而不是「== 3」，以后加表继续 +1 时它仍然成立。
变异验证：改回 2 → 变红。

⚠️ 教训：**给已部署的项目加表 = 加建表语句 + 升版本号，两件必须一起做**。
本地测试用 FakeD1（每次都是空库 + 全新迁移），**永远发现不了这个坑**。

### 2. 记事本从「右侧抽屉 + 弹窗编辑」改成独立页面

用户要求参考 inkstone 的布局。看它的 `features/workspace/Workspace.tsx` 后照着做：

```
┌──────────────────────────────────────────┐
│ Header：返回 · 源码/分栏/预览 切换 · 新建    │
├────────────┬─────────────────────────────┤
│  笔记列表   │ 笔记标题（输入框）             │
│  （置顶在前）├─────────────────────────────┤
│  搜索      │  内容区：源码 | 预览（分栏）     │
│            ├─────────────────────────────┤
│            │ 状态栏：字数 · 视图 · 置顶 · 删除 │
└────────────┴─────────────────────────────┘
```

照搬的四点：
- **全 Flex 布局**（inkstone 也是 Flex，不是 Grid）
- **源码 / 分栏 / 预览三档视图**，桌面端可分栏
- **底部状态栏**摆字数与视图状态
- **移动端不硬塞双栏**，改成「列表 / 编辑」两屏 + 返回按钮

为什么不用右侧抽屉：记事本是「想到就写」的地方，要的是一整屏能打字；
抽屉里再弹编辑框等于两层套娃。原来的 `NotesPanel.tsx` 删掉，换成 `NotesPage.tsx`。

**草稿只在内存里**，点保存或切走时才写库 —— 原来那个「编辑弹窗」每关一次就丢一次草稿。
列表区加 `data-note-list` 标记，让测试能只盯列表（编辑/预览区本来就显示原文）。

- 用例 1749 → **1750**；首屏 225.95 KB，bundleBudget 通过。

## 2026-10-05（九续）

**记事本第 7 项：面板 UI**。**记事本现在能用了**（Markdown 渲染层与拖拽排序还没做，
所以内容暂时按纯文本摘要显示，编辑框里写 Markdown 源码）。

- **`NotesPanel.tsx`**（lazy）：右侧面板 + 编辑弹窗。列表项显示标题 + 内容摘要
  （摘要会把 Markdown 语法符号去掉，不直接显示源码）；关键字过滤是**纯客户端**；
  编辑弹窗的尺寸沿用「网站设置」那套约定（`minHeight` 下限 + `rows={18}` 撑大）。
- **`useNotes.ts`**：状态与请求从 App 抽出来（App 已 2700+ 行，按项目约定该拆）。
  列表在**首屏就拉一次** —— 顶栏按钮要显示条数，不能等点开面板才加载。
  **乐观更新 + 失败回滚**：想到就写的场景里，保存有 200ms 延迟手感会立刻变差；
  失败时回滚到旧值并提示，代价远小于「每敲一个字都等一下」。
- **顶栏入口**：独立按钮（不塞进「更多选项」——笔记是高频入口），后面带条数。
  `HeaderActions` / `HeaderActionsSlot` 两层 prop 一起加。
- **一个被预算守卫抓到的取舍**：侧边抽屉原本用 `<Drawer>`，结果它把整套 slide
  动画依赖拉进了共享 chunk（进而进首屏），`bundleBudget` 直接判红（只剩 2.6% 余量，
  要求 3%）。改用 `<Dialog>` 撑出侧边形状 —— `Dialog` 早被确认框用着，
  同样的视觉，零新增首屏体积。**这就是那道守卫存在的意义。**
- **测试**（`tests/notes.dom.test.tsx`，8 条）：面板的摘要/过滤/空状态，
  以及 useNotes 的乐观更新与**失败回滚**。
  变异验证：把两处 `setNotes(回滚)` 删掉 → 2 条变红。
  写测试时踩了一个坑：`void act(async …)` 不被 await，断言会在它完成前就跑了；
  而且必须**单独等一轮**让首屏那次 `listNotes` 落地，否则「回滚到删除前」
  断言的是空→空，等于什么都没测。
- 用例 1741 → **1749**。

## 2026-10-05（八续之二）

**修一个把「备份」页彻底废掉的严重问题**（用户报「乱码、备份和恢复点击没用」）。

- 根因：`BackupDialog.tsx` 里 `{tab === 0 ? (` 的**开头的 `{` 丢了**，
  于是 `tab === 0 ? (` 变成 JSX 里的**纯文本节点**。后果不只是「多了几行乱码」：
  - 整个「备份」页的内容（BackupTab）被当成文本，**页面里同时渲染两个 tab 的内容**；
  - 真正的按钮全被这些文本挤走/盖住，**「备份到本地」「从本地文件恢复」全都点不动**。
  - 损坏来自 `1b4a326 拆 BackupDialog`（很早），一直没人发现。
- **TS 编译抓不到**：JSX 文本位置出现 `tab === 0 ? (` 是**合法语法**（就是一串字符串），
  编译器只会抱怨「后面那个 `)` 多了」——而三元表达式的另一半正好配平了它。
  `npm run build` 全绿、首屏预算照常通过。
- **测试也没抓到**：`tests/BackupDialog.dom.test.tsx` 里**每一条用例都用
  `initialTab={1}`**（恢复页），「备份」页从来没被渲染过。
- 补 2 条用例（该文件 7 → 9）：
  - 渲染 tab 0，断言页面上**不含 `tab === 0` 这类源码文本**、能看到「备份到本地」、
    **看不到「恢复到本地」**（两个 tab 同时出现就是条件渲染失效的特征）；
  - 顺带钉住新加的「备份包含记事本」开关在 tab 0 上、默认开。
  变异验证：把 `{` 改回去 → 第 8 条立刻变红。
- ⚠️ **教训**：页面级用例要**覆盖每个 tab / 每个分支**。全都只测一个分支时，
  另一个分支坏成什么样都不会有人知道。
- 用例 1739 → **1741**。

## 2026-10-05（八续）

**记事本第 4–5 项：导入导出**（这轮的核心目的）。数据通路见上一条。
**UI 面板与 Markdown 渲染还没做**，所以线上仍然看不到记事本 —— 但备份里已经有它的数据了。

- **导出**（`transfer.ts` + `configKeys.ts`）：
  - `ExportData.notes`（**可选字段**）。`queryExportBundle` 把 notes 加进**同一次
    `db.batch`** —— 多一张表不增 D1 往返。
  - 导出时**抹掉 `id` / `user_id`，保留 `uuid`**：id 是对方库的 AUTOINCREMENT，
    照搬必撞主键；user_id 只能由导入者决定；uuid 是合并去重的唯一依据。
  - 独立开关 `backup.includeNotes`，**默认含**（与凭据开关相反）。
    关闭时**整块不放 `notes` 字段**而不是放空数组 —— 空数组会被导入当成
    「备份里一条笔记都没有」，从而清空本地；字段缺失才表示「与笔记无关」。
- **导入**（`transfer.ts`）：三种情形靠**字段是否存在**区分，语义完全不同：
  | 情形 | 行为 |
  |---|---|
  | 备份无 `notes` 字段（老备份 / 关了开关） | **本地一根汗毛不动**，即使选了「完全覆盖」 |
  | `merge`（默认） | 按 uuid 识别：本地没有就插入；同 uuid 比 `updated_at`，**文件里较新才覆盖**，本地较新则跳过；本地多出来的原样保留 |
  | `replace` | 清空本地全部再插入，`removed` 记本地条数 |
  - 覆盖写回**原 id**（新建再删会把 `updated_at` 弄丢）
  - `user_id` 写 `currentUserId`（导入者），**不是文件里的值**
  - 跟着现有的 250 语句分批提交；回滚带上新建的笔记 id
  - 返回 `noteStats`（created/updated/skipped/removed）—— 合并模式下
    「本地较新就跳过」是正确行为，不给数字用户会以为没生效
- **归一化**：没有 `uuid` 的笔记补一个（否则每次导入都多一份）；
  非字符串的 title/content 压成空串。
- **UI**：`BackupTab` 加「备份包含记事本」开关（默认开），走
  `useBackupController.handleToggleIncludeNotes` 落到服务端配置。
- **测试**（`tests/noteTransfer.test.ts`，13 条）：三条决策各有用例。
  变异验证三处：① 让老备份也清笔记 → 2 条变红；② 合并时无视 `updated_at` 一律覆盖
  → 「保留本地那份」变红；③ `user_id` 照抄文件里的 → 「归导入者」那条变红。
- 用例 1726 → **1739**。

## 2026-10-05（七续）

**记事本第 1–3 项：数据通路**（表 + 服务端 + 客户端）。方案见 `docs/notebook-design.md`。
UI、Markdown 渲染、导入导出还没做，所以**这一版线上还看不到记事本**。

- **建表**（`internals.ts`）：`notes` 表 + 两条索引。三个刻意的设计：
  `user_id` 与 sites 同构（可直接复用 `scopeSql`，含单账号部署 uid=NULL）；
  **不建到 sites 的外键**（卡片删了笔记要留下来）；`content` 存 Markdown 源码。
- **`uuid` 工具**（`src/utils/uuid.ts`）：用 `crypto.getRandomValues` 手搓 RFC 4122 v4。
  没用 `crypto.randomUUID()` —— 运行时有，但本项目 workers-types v5 没有它的类型。
- **服务端七个方法**（`src/API/methods/notes.ts`）：`listNotes` / `getNote` / `createNote`
  （顺带生成 uuid、order_num 缺省时排到末尾）/ `updateNote`（白名单逐字段）/
  `deleteNote`（**先搬回收站再删行**）/ `updateNoteOrder`（分批 250，同 transfer.ts）/
  `countNotes`。
- **回收站支持 note**：还原走 `reinsertNote`（与 `reinsertSite` 同一套做法，
  实现放在 `recycle.ts` 里 —— 一开始我放错文件了，`reinsertXxx` 都住那儿）。
- **路由**（`worker/routes/data.ts`）：GET/POST `notes`、GET `notes/count`、
  GET/PUT/DELETE `notes/:id`、PUT `note-orders`。四个写分支都过 `writeGate` 限速。
  请求体是用户可控的，所以**逐字段白名单**：`id` / `user_id` / `uuid` / `order_num`
  一律不认（由服务端决定），`site_id` 显式传 `null` 才是解除关联。
- **客户端 + mock**：七对方法齐平（`apiContract` 守卫会查），mock 给了两条示例笔记。
- **测试**（`tests/noteRoutes.test.ts`，12 条）：覆盖上面那三处最容易坏的地方。
  其中「四个写分支都过限速闸」用**静态检查**而不是打桩 ——
  `writeGate` 是 data.ts 内部闭包（引用真实的 `enforceWriteGuard`），桩不掉；
  而漏掉限速的表现恰恰是「功能全正常、只是限速没了」，只能数代码。
  变异验证：删掉 DELETE 分支的 `writeGate()` → 那条立刻变红。
- **踩了一个坑**：`idx_notes_user` 最初写成 `notes(user_id, pinned DESC, order_num)`，
  `schemaMigration` 的 FakeD1 报「有索引建在了列还不存在的时候」——
  它的解析器把 `pinned DESC` 当成一个列名。真实 SQLite 支持索引方向修饰，
  但既然索引本来就能反向扫描满足 `DESC`，去掉更稳（也省得校验工具误判）。
- 用例 1714 → **1726**。

## 2026-10-05（六续）

- **网站设置彻底恢复自适应**：`settingsPaper`（主窗那份样式）里**不再有任何高度设置** ——
  既不 `height` 也不 `minHeight`。上一版虽然改成了 `minHeight`，但主窗内容少时
  底部照样空一段（用户：「还是没恢复原来大小」）。两窗不再共用同一份样式。
- **新增 `notesPaper`**：放大窗专用的面板样式，宽度/配色/圆角/毛玻璃仍从
  `settingsPaper` 派生（两窗看起来是一套），只多给一个 `minHeight` 下限。
  备注窗内容就是一个大输入框，撑高不违和。
- **「放大」改成用 `rows={20}`**，不再拉伸 textarea。
  先探过 MUI 9 的结构（`FormControl → InputBase-root → textarea`，
  textarea 是 `display:block`、高度由 `rows` 决定），确认「硬设 height:100%」
  就是「光标落在框中间」的来源 —— 那套技巧全部去掉。
- **判据同步换掉**（前几轮的判据都是为上一版写的，已经过期）：
  - 「两窗 className 必须完全相同」→「宽度与视觉一套，但高度不要求相同」；
  - 新增「`settingsPaper` 里不许出现 height / minHeight」（防回退第一轮）；
  - 新增「`notesPaper` 里要有 minHeight + calc 视口兜底、且不许写死 height」；
  - 新增「`rows={2x}` 且源码里不许再出现 `MuiInputBase-root`」（防回退第二轮）。
  两处都做了变异验证：给主窗加回 `minHeight` → 第 15 条红；
  给 textarea 加回 `height:100%` → 第 16 条红。
- 用例 1717 → **1714**（合并了 3 条重复的高度判据，净减 3 条）。

## 2026-10-05（五续）

- **输入框「只有当中能打字」**：是我上一轮加的 `& textarea { height: 100% }` 造成的 ——
  框被拉高了，但内容仍按原高度**垂直居中**，于是光标出现在框中间、上下打不了字。
  去掉那套 flex/height 技巧，改用 `rows={15}` 定高：文字自然从顶部开始。
  教训：拉伸输入框要用 `rows`，别硬设 `height: 100%`。
- **网站设置底部空出一段 → 恢复自适应**：这是上一轮「两窗写死 `height: 700px`」的副作用
  （主窗内容只有约 600px，撑到 700 就留了空白）。
  改成两窗共用的 **`minHeight: min(620px, calc(100vh - 104px))`**：主窗内容多就自然变高
  （不留多余空白），放大窗有这个下限保证够大。
  **「严格等大」和「不留空白」本身是冲突的** —— 等大只能写死高度，而写死高度对主窗
  就是强加空白。为这件事来回改了四轮，结论写进代码注释了。
  用例同步加了一条硬判据：`settingsPaper` 里**不许**出现 `height:`，只准 `minHeight:`，
  防止有人再改回去（已变异验证：改回 `height` → 变红）。
- 主窗字段区从 `flex:1 + overflowY:auto` 简化为只 `minHeight:0 + overflowY:auto`（不再需要 flex 撑开）。
- 用例 1717（未增减，只换了判据）。

## 2026-10-05（四续）

用户反馈三点：两个框大小又不一致、右键编辑备注不要先弹网站设置、输入框只有当中能打字。

- **改固定高度，彻底不做 JS 测量**。之前那版「点开时量主窗 `offsetHeight`、当放大窗的
  `minHeight`」实测**根本没生效** —— 那是动态测出来的：量不到（ref 没挂上 / 布局未完成）
  就静默退化成「按内容自适应」，于是又矮一截。为这件事用户反馈了三轮。
  现在两窗用**同一个 `settingsPaper`**，高度写死 `min(700px, calc(100vh - 104px))` ——
  值来自同一处，不可能不一致；`calc` 那部分是小屏兜底，防止超出屏幕。
  配套：主窗字段区改成 `flex:1 + minHeight:0 + overflowY:auto`，否则固定高度后
  底部的凭据区会被挤出弹窗够不着（`minHeight:0` 是 flex 子项能滚的前提）。
- **`notesOnly` 模式**：卡片右键「编辑备注」**只渲染备注窗，主窗整个不挂载** ——
  用户点的是备注，先糊一整屏设置再让他自己找备注框，等于把三步做成五步。
  与 `initiallyExpandNotes` 分开而不是合并成一个 flag：两个诉求不同（前者是「不要主窗」，
  后者是「打开就是放大态、主窗还在下面垫着」）。
  `notesOnly` 下两个出口的语义也变了：关闭 = 关掉整个弹窗；
  **保存 = 直接 `onUpdate` 写库**（没有主窗替你提交）。
  标志在关闭时清掉，`handleMenuEdit` 里也显式清一次 —— 靠关闭时清不够保险。
- **输入框整个区域都能打字**：光给 `.MuiInputBase-root` 设 `height:100%` 不够，
  textarea 自己还是 `rows={10}` 那个高度，于是框的下半截点不进焦点
  （用户报的「只有当中能打字」）。要连 `& textarea { height: 100% }` 一起设。
- 用例 1715 → **1717**。高度那条判据也换了：原先断言「量到高度后两窗样式不同」，
  现在断言「两窗 className **完全相同**」+ 静态检查「`settingsPaper` 里确实写了
  `min(…, calc(100vh …))`」—— 后者保证「共享函数确实产出了高度」，
  而不是恰好两边都没高度。变异验证：把 `setNotesOnly(true)` 改成 `false` → 用例变红。

## 2026-10-05（三续）

用户提了三个要求，一次做完：

- **放大窗里的输入框也同步放大**：内容区 `flex:1` + 输入框
  `sx={{ flex:1, "& .MuiInputBase-root": { height: "100%" } }}`。
  ⚠️ **只写 `flex:1` 不够** —— 那只能撑开 FormControl，textarea 在 InputBase 内部
  有自己的高度，必须连它一起设成 100%。
  ⚠️ 顺带认一个错：上一轮这两段代码**根本没写进文件**（python `s.replace()` 没匹配上，
  而我没 assert 就当成功了），所以用户看到的是「窗变高了、输入框没变、底部空一大块」。
  **教训：用脚本改文件时每步都要 assert，「没报错」不等于「改成功了」。**
- **「完成」按钮改成「保存」**。
- **卡片右键新增「编辑备注」，直达放大窗**（`SiteCard.tsx`）：用户既然点了备注，
  就不该先看到一整屏设置再自己找备注框。实现是给 `SiteSettingsModal` 加
  `initiallyExpandNotes` prop —— 菜单点击时置一个「下次打开时」的标志，
  弹窗挂载那一刻读它（组件是条件渲染的，初始值刚好对上），
  **关闭时清掉标志**，否则以后点「编辑」也会被强制进放大窗。
  菜单项排在「编辑」前面（同属修改类）。
- 用例 1709 → **1715**（`siteSettingsModal` 15 → 18，`siteCard` 9 → 12）。
- **一个值得记的测试教训**：先给右键入口写了三条弱断言（菜单项存在 / 顺序在前 /
  点击不抛错），跑变异验证时把 `onClick` 换成 `handleMenuEdit` —— **测试依然全绿**，
  等于这个功能压根没被测住。改成一条强断言：
  「点编辑备注 → `#notes-expanded` 出现且带着原备注；点编辑 → 主窗里没有放大窗」，
  两条路必须区分得开。这次变异立刻变红。
  配套要解决两件事：
  ① 测试的 `mount` 原来只包 `UIPrefsProvider`，而 `SiteSettingsModal` 还要
     `useAppConfig()` —— 缺 Provider 时那条路径跑不起来（先报
     `RangeError: Array buffer allocation failed`），补上 `AppConfigProvider` 即可；
  ② 弹窗是 `lazy(() => import(...))`，点开要等 Suspense，**必须用
     `await act(async () => { …; await sleep(80) })`** —— 裸 `setTimeout` 里的更新
     不在 act 范围内，React 不刷新，DOM 里永远找不到。

## 2026-10-05（再续）

- **网站设置的备注框右侧加放大按钮**，点开一个**与网站设置同尺寸**的大弹窗
  （`fullWidth` + `maxWidth='sm'` + 同一个 `nav-settings-dialog`）专门改备注 ——
  备注是那一屏里唯一可能写很长的字段，两行框里改长文本很难受。
  两个实现细节是刻意的：
  - **两边共用同一份 `formData.notes`**，不做两份再同步 —— 少一处能写错的地方
    （同步逻辑一旦漏掉，表现就是「大窗改了、主窗没改」，用户以为没保存）。
  - **放大窗放在主 Dialog 外面**（fragment 并列），不是塞进去 —— 弹窗套弹窗时
    关掉大窗不会顺手把设置也关掉。
  打开时 `autoFocus`，光标直接落在框里可以接着写。
- **修三个用户反馈的问题**（截图指出「两个框大小不一致、按钮太丑、字重叠」）：
  - **两个窗共用同一份面板样式**（新抽的 `settingsPaper(theme)`）。之前放大窗只抄了
    `borderRadius`，毛玻璃、边框、阴影、半透明背景**全没抄**，所以它看起来比主窗
    小了一号 —— 而当时的用例只比「都有 `paperWidthSm`」，压根没抓到。
    共用之后才敢把断言升级成**整串 className 必须完全相同**（已变异验证：
    改回只抄 borderRadius → 立刻变红）。以后改主题只改这一处，不会再漂移。
  - 放大图标 `OpenInFull`（斜小箭头）换成 `Fullscreen`（四角扩张），语义更准。
  - **去掉放大窗输入框的 `label`**：窗口标题已经写着「备注」，再挂一个既是重复标签，
    又会在 `autoFocus` 时因为 label 收缩动画没跑完而**压在 placeholder 上叠字**
    （就是截图里那个「字重叠」）。可见标签交给 DialogTitle，语义用
    `slotProps.htmlInput['aria-label']` 补上 —— 读屏仍能听到「备注」。
    注意 MUI 9 已移除 `inputProps`，要用 `slotProps={{ htmlInput: … }}`。
- **「大小还是不一致」的第二次修复：这次差的是高度**。上一轮统一了宽度（两窗同为
  `paperWidthSm`）和面板样式，但**高度是由内容决定的** —— 放大窗只有一个输入框，
  矮一大截，看起来仍然是小一号。而肉眼判断「大小」主要看的就是高度。
  改法：点放大时量一次主窗 paper 的 `offsetHeight`，作为放大窗的 `minHeight`
  （`settingsPaper(theme, { minHeight })` —— 样式仍出自同一个函数，只多这一条）；
  paper 改成 flex 列容器、内容区 `flex:1`、输入框跟着撑满（照项目里
  「paper 定高、内容 flex:1」的约定），不定高的话底部会空一大块。
  量不到高度时（jsdom / 极端情况）不设高度、退回内容自适应 —— 不能因为量不到就卡住功能。
  用例补 1 条：jsdom 里 `offsetHeight` 恒为 0，「量高度」在默认环境里根本测不到，
  所以手动给主窗 paper 灌 640，再断言「量到高度后放大窗样式必须与主窗不同」——
  相同就说明 `minHeight` 没被用上，又回到只对齐宽度的状态。变异验证：去掉它 → 变红。
  原有那条「两窗 className 必须完全相同」继续有效（`minHeight` 为空时两窗共用同一份
  样式对象），两条一起把「同宽」与「等高」都钉住了。
- 补 9 条用例（`siteSettingsModal.dom.test.tsx` 6 → 15）：放大入口在备注框内、
  大窗与主窗同尺寸、打开时带着现有内容、大窗改字主窗跟着变、**关大窗不连带关主窗**、
  右上角关闭同样只关自己、没打开时大窗不在 DOM 里。
  已做变异验证两处：把「完成」改成顺带调 `onClose()` → 「不连带关主窗」那条变红；
  把放大窗样式改回只抄 borderRadius → 「两窗样式必须相同」那条变红；
  去掉 `minHeight` → 「高度对齐」那条变红。
- 用例 1700 → 1707 → 1708 → **1709**。

## 2026-10-05（续）

**要点**：B 级三项。安全头两处的差异查清后发现**大部分是有意的**，于是没有机械补齐，
而是补了一条守卫把「哪些故意不同」钉住；另外给使用频率最高的搜索框补了直测。
三个大件（`App.tsx` / `GroupCard` / `SiteCard`）本轮**没有拆** —— 理由见下。

### 工程
- **安全头两处的差异查清了，并落守卫**（`tests/securityHeaders.test.ts`，4 条）：
  安全头分散在 `public/_headers`（静态资源，9 项）与 `worker/util.ts` 的
  `securityHeaders()`（Worker 响应，5 项）。原以为要「补齐」，读完注释才发现
  **CSP / COOP / Permissions-Policy / X-Permitted-Cross-Domain-Policies 是故意不加的**：
  它们只对会被当成文档渲染的响应有意义，JSON 与图片响应加了不起作用；更关键的是
  图标代理要传自己的 `default-src 'none'; sandbox`（`worker/icon.ts`），默认塞一条
  CSP 会把它盖掉 —— 白名单哪天被绕过时那道沙箱是最后一道防线。
  所以守卫钉的是「**该有的必须有，不该有的不许有**」：既断言 nosniff / HSTS / CORP /
  X-Frame-Options 齐全，也断言那四条**不许出现**，还直接照 icon.ts 的用法调一次
  `securityHeaders()` 确认沙箱 CSP 没被默认值盖掉。已做变异验证：给 `securityHeaders`
  加一条默认 CSP → 两条守卫同时变红。
  真正需要处理的只有 `Referrer-Policy` 两处取值不同，已在注释里写明**为什么故意不同**
  （该头只对文档/导航生效，API 响应上近乎无效，取更严的值没有副作用）。
  顺手清掉了 `util.ts` 顶部两段重叠的注释。
- **`HeaderSearchBox` 补直测**（新增，10 条）：284 行、**使用频率最高的一个控件**，
  此前零覆盖。搜索坏掉的表现往往不是报错而是「搜不到了」「按回车没反应」，很隐蔽。
  钉住的：有关键词下列表是**结果**、没关键词时是**历史**（两者不能串）、悬停要能改选中项
  （否则只能一路按 ↓）、面板关着时不渲染内容、语义搜索开关必须带 `aria-pressed`
  且没准备好时禁用。已做变异验证：去掉 `onMouseEnter` → 对应用例变红。
  ⚠️ MUI 的 `ListItemButton` 渲染成 **div 而不是 li**，按标签名找会一个都找不到，
  得用 `.MuiListItemButton-root`。
- 用例 1686 → **1700**。

### 暂缓：三个大件先不拆
`App.tsx` 1996 / `GroupCard` 914 / `SiteCard` 990。`App.tsx` 本身就是零覆盖第一名，
在它上面做结构改动没有回归网撑着；`GroupCard` 那个 272 行的 `renderSites` 与组件状态
深度耦合，硬拆会变出 20+ props 的组件，可读性未必改善。**先补网再拆**。

## 2026-10-05

**要点**：新一次全面复查（`docs/improvement-review-2026-10-05.md`）挖出一条被两轮复查
都漏掉的真问题 —— **首屏预算只覆盖了真实首屏的 23.7%**。另外两条里一条是真问题
（mock 与真实 client 之间没有任何契约守卫），一条是**我自己的检测脚本误报**，
已更正并改落一条守卫。B 级项（安全头统一、继续补网、拆大件）本轮未做。

### 修复
- **首屏预算改成真实总量**（`tests/bundleBudget.test.ts`）：原来只统计 `index-*.js`
  一个文件（216.6 KB / gzip 71.2），而 Vite 会在 `index.html` 里给首屏静态依赖发
  `modulepreload` —— 那些是浏览器**必定要下**的。实测真实首屏 =
  `index` 216.6 + `mui` 402.6 + `react` 202.0 + `vendor` 75.3 + runtime/css 17.6
  = **914.1 KB / gzip 295.2 KB**，另外 76.3% 当时完全不受约束：谁把 MUI 涨一涨，
  CI 全绿，只有用户感觉首屏变慢。更要紧的是，之前几次「首屏 264 → 221 KB」的成绩单
  其实只动了真实首屏的四分之一。现在按总量设预算（950 KB / gzip 305 KB），
  原始与 gzip 双断言，并保留 index chunk 作为子指标。分包策略本身不动
  （react/mui/vendor 分离是对的：改业务代码时不用重下最稳的那 402 KB）。

### 工程
- **mock 与 client 的契约守卫**（`tests/apiContract.dom.test.tsx`）：用例几乎全走
  `MockNavigationClient`，线上跑的是 `NavigationClient`，两边不一致的表现就是
  「上千条用例全绿、线上一个接口报错就白屏」。而 TypeScript 不会拦 ——
  `MockNavigationClient` 没有 `implements NavigationAPI`（接口靠 mixin 声明合并补签名，
  mock 不在其列）。实测基线：前端调用 40 个方法 mock 一个不缺、client 缺 0 个，
  所以**现在没有缺口**，这个用例是让缺口以后不能悄悄出现。钉两件事：
  ① 前端调用的每个方法两边都得有；② 透传型接口（bootstrap / getGroups / getConfigs /
  aiStatus）两边返回的**结构**必须一致。已做变异验证：让 client 像真实 bug 那样
  多包一层 `data`，守卫立刻变红并打印出完整差异。
- **图标按钮可访问名守卫**（`tests/iconButtonA11y.test.ts`）：51 个 `IconButton`
  全部有可访问名，一条不缺（复查报告里说缺 9 个是误报，见下）。留这条守卫是因为
  这类缺陷截图对比和冒烟测试都发现不了。
- 用例 1676 → **1686**。

### 更正
- 复查报告的 A3「9 个图标按钮没有可访问名」是**误报**，已作废。检测脚本用正则
  `<IconButton\b([\s\S]{0,600}?)(?:\/>|>)` 找标签结束，而 `onClick={() => ...}` 里的
  **`>`**（箭头函数的 `=>`）被当成了结束符，属性列表在 `=>` 处就被截断，后面的
  `aria-label` 自然看不见。改成手写状态机（遇 `=` 且下一字符是 `>` 则跳过）后，
  结果是 0 个缺失。教训：正则扫 JSX 要提防 `=>` 和字符串里的 `>` 这类假终止符 ——
  这类「检测结果」不复核就会变成错误的行动项。报告里保留了这段更正而不是删掉。

## 2026-10-04

**要点**：失效链接的判据改准了 —— 一次探测失败不再直接标失效，老判据留下的「失效」标记
也一并降级成「疑似」。顺带挖出四个**静默失效**的真 bug：拼音搜索其实一直是坏的、
注销弹窗只填空格就能点确认、新增卡片时 `/a/b` 与 `/ab` 被判成同一个链接、
「清缓存（含登录）」和「清缓存」两个按钮干的事一模一样。
其余是补网与搬家：WebDAV 与定时备份第一次有了真端到端，批量条改懒加载把首屏压回 221 KB。

### 修复
- **失效链接改成两段式判据**：`probeLink` 用的是 no-cors 请求，拿不到真实状态码，
  fetch 抛错只说明「这次请求没发出去」—— 网络抖一下、被广告拦截插件挡掉、DNS 临时抽风、
  站点慢过 6 秒超时，都会失败。改成第一次失败只记「疑似」，7 天内第二次失败才升级成
  「失效」；探测成功时两个标记一起清（漏删疑似的话，残留记录会让下一次偶发失败被当成
  「连续第二次」直接标死）；人工「标记为失效」不需要凑两次 —— 用户的判断比探测可靠。
- **旧判据留下的「失效」标记降级成「疑似」**：只改判据治不了存量，用户升级完打开页面，
  那几个天天在用的站照样挂着红标。用**基线时间戳**而不是「迁移过没有」的布尔标记：
  失效记录能从服务端合并回来，布尔标记跑一次就不能再跑，本机降级完云端那份旧的又并回来；
  时间戳天然幂等，云端回填多少次都会被下一次启动再降级一次。
- **拼音搜索一直是失效的**：`pinyin-match` 的 ESM 入口最后是 `export { l as default }`，
  而 `l` 是 `{ match }` —— `typeof mod.default === "function"` 永远为假，matcher 一直是
  null，而且**不报错**（match 为 null 时直接早退）。改成按 default / default.match /
  mod.match 三种形状依次取。
- **注销弹窗只填空格就能点「确认注销」**：`!password` 对 `"   "` 放行，按钮亮了会让用户
  以为填对了、然后被一个 400 打回来。改成 `!password.trim()`（回车那条同样）。
- **新增卡片的重复网址误判**：`utils/duplicate.ts` 的 urlKey 把非字母数字全抹掉，
  路径层级被压平 —— `a.com/a/b` 与 `a.com/ab` 算出同一个 key，新卡片被「链接已存在」拦下。
  现在压成单个 `/`，`?` 与 `#` 保留，查询串不再和路径混淆。
- **覆盖模式导入的播种键补上 overwrite**：覆盖模式下「没勾 = 备份里没有」，
  沿用合并模式的勾选会什么都没动就丢数据。
- **两处依赖数组写错了，注释写的理由也是错的**：`AiAssistantDialog` 的注释说
  「api 每次渲染都是新引用」—— 其实 `api` 是 App 顶层的**模块级常量**，引用永远稳定，
  可以正常进依赖；按那句错注释去「修」反而会跑偏。`AiSuggestDialog` 那条更实际：
  它依赖 `sites` / `groups` / `allTags`，这三个是父组件每次渲染新建的数组
  （内容一样、引用不同），照原样进依赖会变成「问 AI → 重渲染 → 再问」的死循环，
  所以当初才禁用了规则。改成**比内容不比引用**（拼字符串当指纹），
  内容真变了才重问 —— 依赖选的是对的对象，规则也就不用禁了。
- **`clearLocalAppData(includeAuth)` 的 includeAuth 完全不起作用**：那段
  `if (!includeAuth && k === "auth_token") continue` 是**死代码**（auth_token 键名进不了
  清单），于是错误边界上两个长得不一样的按钮干的事一模一样。改成 includeAuth 管
  rememberedLogin —— 不勾就只清缓存，不动记住的账号名，这也才是那个参数的本意。
- **`getDomainFromUrl("http://")` 返回 `"http"`**：解析失败会「补个协议再试」，
  拼出一个看着合法、其实没意义的图标地址。已经写了 `://` 却解析不了就是坏链接，
  直接返回空串。
- **「站点更新后打开是旧页面」能自己发现了**（新增）：Service Worker 会缓存上一版的 HTML
  外壳，网络不通时导航失败就把它喂给浏览器；而那个外壳引用的懒加载块带内容 hash，
  新版本里文件已经没了 —— 页面能起来，一点开某个弹窗就 404。
  现在构建号会烘进产物（与 precache-manifest 同源），加载时跟服务端的对一次，
  不一样就清 SW 缓存重载一次。**必须放在加载阶段主动查**：等报错再救的那条路径也在
  产物里，而出问题的正是上一版产物，它根本没有那段代码。

- **被服务端拒绝的改动不再「悄悄消失」**：重放路径是「先从队列里划掉（`drop`）再进失败清单
  （`pushFailed`）」，而只有 `drop` 会通知订阅者 —— 通知发出去的那一刻这条还没进清单，
  于是 OfflineBanner 与顶栏角标读到的都是旧列表，界面上根本不显示这条。
  它恰恰是失败清单唯一存在的理由（悄悄丢掉等于骗人「都同步好了」）。修在 `pushFailed` 里补通知。

### 工程
- **WebDAV 备份真端到端**（23 条）：本地起一个 mock WebDAV 服务，让 worker 真打一遍
  MKCOL / PUT / PROPFIND / GET / DELETE。单测里的 fetch 是假的，只能证明「我们发出了什么」；
  这条能证明 gzip 流的组装与解压、Basic 凭据的 UTF-8 编码（口令里放中文）、
  以及「没开内网豁免时一个请求都没发出去」（不是发完再报错）。
- **定时备份端到端**（20 条）：wrangler 本地模式下 cron 不生效，用 `--test-scheduled` 把
  scheduled 挂到 `/__scheduled` 真派发一次 —— 它坏了是静默的，备份默默不写，
  发现时已经没有可恢复的数据。
- **首屏快照缓存补直测**（14 条）：核心是「快照里不许有明文凭据」—— 哪天为了
  「复制密码开箱可用」把 stripCredentials 拿掉，界面完全正常、白屏也没变短，
  只是全站密码开始往 sessionStorage 里躺。
- **httpUtils 补直测**（19 条）：cookie 的 HttpOnly / SameSite / Max-Age、同源判定、安全头。
  这里的错法**不报错**：少个 HttpOnly、SameSite 掉一级，全都是「功能正常、安全没了」。
  ⚠️ 其中 `isSameOrigin` 只比 host 不比协议是**有意为之**（host 相同只差 scheme 不构成
  CSRF，把 scheme 加进比较反而会在反代场景下把所有本站写操作打成 403），
  取舍写进用例注释，免得以后有人来「修」它。
- **e2e 不再写死产物目录名**：脚本里写的还是改名前的 `dist/myhomepage`，而本地 dist 里
  一直留着旧目录、恰好能找到 —— 也就是说四档依赖升级后跑的那几次「e2e 20/20」验的
  都是**升级前的旧 worker 包**。改成自己找 `dist/*/wrangler.json`，多份时取最新并打印
  被忽略的那份；另加一条「产物比 worker 源码还旧」的告警。
- **README 的菜单路径不再会和界面对不上**（新增）：菜单改过名（数据备份 → 备份与恢复、
  账号管理 → 账号与安全）但 README 没跟着改，而这类漂移没有任何东西会报错。
  `tests/readmeMenu.test.ts` 盯着每一条「更多选项 → X」必须是菜单里真有的项。
- **后端四条零测试路由补网**（新增，共 70 条）：`worker/routes/account.ts`（324 行）、
  `backup.ts`（340）、`config.ts`（161）、`ops.ts`（121）此前一条用例都没有 ——
  `routeCoverage` 只证明「有模块认领了这个 path」，认领之后做的事全靠这里。
  重点钉住：全站外观只有 owner 能改、管理员凭据不许从配置接口走（否则绕过「校验当前密码」）、
  注销账号必须再验一次密码且成功后拉黑令牌、`users/sweep` 必须排在 `users/:id/status` 前面
  （后者会把 "sweep" 当 id 去 parseInt）、审计的 limit 要夹在 1~200。
- **四个零覆盖的前端件补网**（新增，36 条）：`useThemeController`（三档循环，写反的表现是
  「点主题按钮没反应」）、`usePrefSync`（失败一律静默，写反了数据会慢慢不对）、
  `useSiteSettings`（批量保存 + 改凭据后踢回登录页）、`OfflineBanner`（失败清单不显示
  等于悄悄吞掉用户的改动）。
- **首屏预算改成按当前产物算**：原来只按基线（221.18 KB）算余量，中间陆续加进去的几 KB
  它一概看不见 —— 实测出现过「基线余量 6.25%、实际只剩 4.24%」而用例是绿的。
- **三个展示型组件补 DOM 用例**（新增，28 条）：`MoreMenu`（分区顺序「整理与数据 →
  设置与账号 → 帮助与安装 → 会话」，且**每一项必须先 `onClose()` 再执行动作** —— 反了
  菜单会飘到左上角）、`DisplayControls`（星标/多选是开关必须带 `aria-pressed`，
  退出多选要走 `exitMultiSelect()` 而不是 `setMultiSelect(false)`，后者会留下幽灵勾选；
  面板里是三档直选不是循环）、`SiteListBody`（**站点排序模式用 `groups` 而不是
  `displayedGroups`** —— 否则拖完保存会把没显示的分组一起重排）。
  这三个刚做过一轮重排，此前只有仓库外的 ui-smoke 盯着，CI 里没有回归网。
- **两个数据层 hook 补直测**（新增，21 条）：`useSites`（站点按 `order_num` 归堆、
  无 id 的分组丢弃、**静默刷新失败不弹提示也不动 loading**、仅认证类失败才触发
  `onAuthFail`）、`useConfigController`（**WebDAV 配置必须单独存放、不留在 configs 里**
  —— 否则会被写进备份文件；主色预览值优先、非法值丢弃；撤预览后回滚到已保存值）。
- **补网终于有了一份「该补谁」的清单**：`npm run coverage`（新增 `script/coverage.mjs`）。
  之前三轮补网全是靠人肉点名 —— 我说「这四个件零覆盖」是因为我读了代码，
  下一个我不知道名字的零覆盖模块谁也不会报。它用 esbuild 的 metafile 反推
  **哪些 src/ / worker/ 文件从未被任何用例引入**，按行数排出来。
  第一份结果：204 个源文件里 **42 个（9869 行）零覆盖**，其中
  `API/client.ts`（937 行，所有请求的唯一出口）此前一条用例都没碰到过。
  ⚠️ 它是文件级的「有没有被碰过」，不是行覆盖率 —— 想看百分比得再装 c8
  （脚本会自动多跑一层；本机装不动，所以默认只出清单）。
- **`API/client.ts` 补直测**（新增，15 条）：它是全部前后端约定的出口，
  而其余用例大多走 mock —— mock 和真实 client 只要有一处不一致，
  表现就是「1600 条用例全绿、线上一个接口报错就白屏」。钉住的有：
  **幂等 ID 用完即清**（挂着不清，用户后续每个操作都会被服务端认成同一条而吞掉，
  已做变异验证）、401 必须清本地登录标记（不清就是「标记在、令牌不在」的半登录态，
  表现为刚登录成功就闪回登录页）、非 JSON 的错误页不能二次抛错
  （否则用户看到的是 `Unexpected token <`）、网络抖动不把已登录用户踢下线。
- **`AddSiteDialog` 补直测**（新增，13 条）：它是**用户最高频的一条路径**（加个网站），
  397 行此前零覆盖 —— 改坏这里的表现不是报错，而是「按钮点了没反应」或
  「字段顺序乱了填错地方」。钉住字段顺序（名称 → 链接 → 图标 → 描述 → 备注 → 凭据，
  与「网站设置」对齐）、AI 补全入口的出现与禁用条件、**创建中必须禁用提交按钮**
  （手快一点就是两个重复站点，已做变异验证）。
  其中一条专门钉住一次产品决策：URL 框旁边**曾经**还有个「抓取网站标题和描述」按钮，
  用户明确要求去掉了 —— 它要是哪天被加回来，那条用例会红。
- 用例 1459 → 1598 → 1648 → 1663 → **1676**。

### 重构
- **BackupDialog 1381 → 687**：两个巨大的 render 函数（`renderBackupTab` / `renderRestoreTab`，
  加起来 700 多行）搬成 `BackupTab.tsx`（501）与 `RestoreTab.tsx`（368），
  两个「给人看」的格式化函数落 `utils/backupFormat.ts`。都是**逐行原样搬迁**，
  状态与写操作仍留在弹窗本体 —— 想在这两页里改一个开关，不用再在上千行的文件里找那一段。
- 二次确认弹窗走按需入口（新增 `ConfirmDialogGate`）：`ConfirmDialog` 是每个删除操作都要
  先过的门，却一直静态待在首屏包里，而它只在「用户点了删除之后」才出现。
  打开过一次之后常驻，不是关了就卸载（删完一张再删一张不该各加载一次）。
- 懒加载浮层统一套 `ChunkBoundary`（新增）：断网时点开一个弹窗，以前会一路冒到根错误边界、
  把整站换成「页面出了点问题」，而实际只是那一个弹窗的代码没下载下来。
  现在只影响它自己，文案按「是不是离线」分开说离线时不给「重试」（块本来就没缓存到本地）。
- **离线时点开懒加载弹窗有了明确反馈**（新增）：以前断网点开一个没缓存过的弹窗，
  整站会被换成错误页 —— 数据一条没丢，看着却像天塌了。
- App.tsx 2186 → 1981：键盘编排抽成 `useGlobalShortcuts`（100 多行，17 条用例钉住 6 条
  守卫）、视口态抽成 `useViewportUi`（8 条）。两块原先都一条用例没有，且写错都不报错。
- 书签导入的写库过程搬到 `useBookmarkImport`（11 条）：此前解析 / 差异 / 预览三处都有用例，
  唯独「点确认之后到底往库里写了什么」这一层没有 —— 而这一层写错的后果是**数据错的**
  （分组重复建、排序号盖掉已有分组）、界面上还全看不出来。
- 配置状态收进 `useConfigController`；主色 / 毛玻璃的规整函数落 `utils/configForm.ts`
  + 11 条单测（这两个值从数据库、备份文件、云端同步三条路进来，脏值防不住，
  写错的表现是「主题悄悄变丑」）。
- 折叠态整套搬进 `useCollapseController`（7 条）。
- 注销与回收站这两个站内仅有的「点了就没了」的地方，第一次有了 DOM 冒烟。

### 性能
- **批量条改懒加载**：它只有进入多选模式（勾了卡片）才出现，却一直躺在首屏里（6.8 KB）。
  首屏 227.57 → 221.18 KB，预算余量回到 6.2%。
- 新增 `precacheManifest.test.ts`：首屏包里不能出现只该在触发后才出现的标记，
  且清单与磁盘产物要双向对齐（悬空条目会让 install 整批失败，漏登记会离线 404）。

---

## 2026-10-03

**要点**：四档大版本依赖升级全部落地（eslint 10 / TypeScript 6 / vite 8 / MUI 9），
升级前先做了一轮**实测**评估（`docs/dependency-upgrade-assessment.md`），不是看版本号猜。
配套的是给几个此前零覆盖的高危域补网 —— 升级前先补网，才知道升完有没有被咬到。

### 新增
- **批量打标签的候选分两排**：「常用」取前 12 + 「推荐」（常用词里库里还没有的），
  超过 12 个给「显示全部 N 个」入口。与单张卡片那两排的关键区别是**不按已选过滤** ——
  批量里勾上的必须留在原处显示选中态，否则点一下就消失，数不出自己勾了哪些。

### 修复
- **点候选标签要填进输入框**：上一版做成「另存一份 pickedTags + chip 变实心」，看着像选上了、
  框里却是空的，用户看不出自己到底要提交哪些。改成点候选写进输入框，候选的选中态由
  输入框内容派生 —— 「要提交哪些标签」只有一处真相，填完还能手改还能删。
- **BackupDialog 的偶发 flake**：备份文件是 FileReader **异步**解析的，用例只固定睡 30ms
  就断言「恢复按钮已可用」，机器一忙就不够用。改成轮询等条件；对照验证（人为拖慢 250ms）
  下旧写法红 2 条、新写法通过。
- 恢复令牌 `expHours=0` 时签出只有 1 秒有效的令牌（`Math.max` 套在秒上），
  表现是找回密码莫名失败、报错还是看不出原因的「签名不合法」；
  `rememberedLogin` 遇到坏 JSON 只返回 null 不清掉，脏数据一直留在本机。

### 安全
- `scripts/rotate-secrets.mjs`：只生成新密钥并打印 wrangler 命令，不替人执行。
  开头先把代价讲清楚 —— **换了 AUTH_SECRET / DATA_ENCRYPTION_KEY，库里已加密的站点密码
  与 WebDAV 口令就解不开了**，所以顺序必须是「先导出一份备份 → 再轮换 → 再把加密项重填一遍」。
- 修正历史扫描里「本仓库历史确实明文提交过管理员账号密码」这句 —— 实测不成立
  （命中的两处分别是空占位与运行时随机生成）。真实的不确定性来自**历史重写**：
  GitHub 对被丢弃的提交对象不保证立刻回收，所以轮换仍是稳妥选择，但理由要写对。

### 工程
- **依赖四档全升**：eslint 10（连带 react-hooks 7 / react-refresh 0.5，新增两条核心规则
  逐个改而不是关掉）、TypeScript 6.0.3（零代码改动）、vite 8.3（连带 plugin-react 6 /
  esbuild 0.28，打包器换成 rolldown）、MUI 9.4。**MUI 9 评估漏估了**：只扫「v9 移除的 API
  在本项目的用量」得到全 0，真正的大头是 system props 被移除 —— 159 处类型错误、
  分布在 30 个文件，基本靠官方 codemod 搬。
- **TypeScript 7 仍然不动**：7.0 不带 compiler API（要等 7.1），typescript-eslint 的 peer
  也没放宽 —— 硬装会让 lint 跑在官方不支持的组合上，「静默少查一批规则」很难发现。
  由 `tests/toolchainPin.test.ts` 盯着：peer 区间一放宽，那条断言就会红，也就是在提醒
  可以安排升级了。
- **升级前先补网**：MUI 9 那条 ButtonBase 行为变化（Enter/Space 的 click 现在会冒泡）
  此前一条用例都没盯着 —— 补了 2 条键盘打开用例（焦点在外壳 / 焦点在 `<a>`，
  各按回车和空格），MUI 7 上先跑绿、再用「故意连开两次」验证两条都会红，
  结论是本项目没被咬到。
- **后端 API 端到端接进 CI**：此前 CI 只有 typecheck / lint / 单测 / 构建 / 前端冒烟，
  真实后端契约一次都没在流水线里跑过 —— 而「新库首次登录必须先改密」「改密会使当前令牌
  作废」这类契约，只有真打一遍接口才会暴露。
- 用例 947 → 1216。

### 性能
- **LoginForm 改懒加载**（最后一个静态 import 的大组件，732 行）：首屏 231.74 → 222.61 KB。
  ⚠️ 中途踩过一次：拆 JSX 时把它写成**静态** import，登录页整份进了首屏包
  （227 → 237 KB，直接顶到 235 KB 预算边上），改回 lazy 才落回来。
- 新增 `bundleBudget.test.ts`：首屏包超 235 KB 就红，且预算与基线要留 ≥5% 余量 ——
  预算贴着基线写的话，红的会是「MUI 升了个小版本」而不是「真的有人在往首屏里塞东西」。

### 重构
- SiteCard 1186 → 972：图标状态机 `useSiteIcon`、缩略图超时兜底 `useSiteThumb`、
  纯展示拆出 `SiteCardAvatar` / `SiteCardText` / `Highlighted`（都用**具名 memo** 包着，
  卡片会渲染 N 次，父组件重渲染时它们不该白跑一遍）。
- App.tsx 2330 → 2251（JSX 收尾）：`HeaderActionsSlot` / `SearchStatusLine` / `LoginScreen`。
- 撤销 / 重做执行层抽成 `useUndoRedo`：最重要的一条是**凭据** —— 撤销快照里的账号密码
  落盘前就被抹掉了，写回库里时必须把这两个字段排除在外，否则撤销一次「改标题」会把
  库里的站点密码清成空，等于借撤销之手做了一次静默的凭据删除。

---

## 2026-10-02

**要点**：AI 助手三件事 —— 站点元信息补全、标签自动整理、语义搜索。默认关闭，开了也
**只给建议不落笔**；模型走 HTTP 直连，不引 `ai` / `vectorize` binding。
配置从「网站设置」挪进了**「更多选项 → AI 助手」**独立弹窗（它是跟着账号走的私密凭据，
不该和「站点长什么样」混在一起），并加了**凭据可见切换**与**测试连接**。

### 新增
- **AI 补全（站点弹窗）**：卡片「网站设置」里、链接输入框下面多了「AI 补全」，把站点名称
  与链接交给模型，回来只填**名称与简介**。分组**只在已有分组里选中，绝不自动新建**；
  填完还得你自己点保存。
- **AI 整理标签（标签管理器）**：顶部「用 AI 整理标签」，一次最多送 40 个站点，回来是一份
  逐条勾选的清单 —— 每个站点给出建议标签和建议分组，**分组只展示、不自动移动**，
  勾选后只写标签。
- **语义搜索（搜索框）**：搜索框尾部多了星形按钮，打开后按语义相似度重排卡片。
  关掉、或者最像的那个都不到 0.25 分，就原样退回关键词结果 —— 不会让你搜不到东西。
- **「更多选项 → AI 助手」**：总开关 + 两种 provider（Cloudflare Workers AI / OpenAI
  兼容端点）+ 两个模型名。区块顶部写明「打开后站点名称与链接会送到模型服务」。
  - **凭据可以核对**：token / 密钥输入框右边有眼睛按钮，点一下露明文 —— 32 位 token
    手抄错一位是最常见的「连不上」，看不见就没法自查。遮蔽用的是 CSS（`text-security`）
    而不是 `type=password`，浏览器认不出它是密码字段，也就不会弹「要不要保存密码」、
    不会拿导航站的登录账号来自动填充。
  - **测试连接**：填完不用先保存就能点，拿当前这份配置各发一条最短请求，
    **文本模型与嵌入模型分开报**（文本通、嵌入不通要说得清是哪一项，附带向量维度）。
    这两件事坏了的表现完全不同：前者让「AI 补全」不能用，后者让语义搜索变成摆设。

### 安全
- `ai.*` 配置**按账号存**（不串号）；`ai.apiKey` 与 `ai.cfToken` **落库加密**（复用既有的
  `enc$1$` 密文）；**不进备份** —— `ai.` 归入 secret 前缀，导出时整段跳过。
- 出站请求统一走既有的 `safeFetch`（只放行 http/https、逐跳重验 hostname），不新增 SSRF 面。
- 三个端点各一把按账号的内存限速：文本生成 20 次/分、向量化 10 次/分、语义检索 30 次/分。
  AI 是按量付费的，一个手滑的循环能刷掉一天额度。
- **测试连接的请求体只认白名单里的 7 个 `ai.*` 键，且只认字符串值**，其余一律忽略
  （4 条单测钉住，包括「没填密钥时一次外网请求都不发」）。
  它绕过了「已存配置不全就 400」那道闸，所以闸门得换到请求体上。

### 工程
- **不引 `ai` / `vectorize` binding**：binding 一旦声明而账号没开通，部署会**直接失败**。
  改成 HTTP 直连 + 用户在设置里自填 provider 与密钥 —— 没配就只是「功能没开」，
  其余功能照常。
- **向量不进 Vectorize**：几十到几百条站点，在 D1 存向量（`site_embeddings` 表，JSON 数组）、
  Worker 内存里算余弦就够了；真到千条以上再迁也不迟。`SCHEMA_VERSION` 提到 `2` 保证新表被建。
- 模型「胡说」的护栏集中在 `src/utils/aiMeta.ts`：抠 JSON（裸 JSON / 代码块 / 前后废话三种）、
  字段截断、标签清洗（去 `#`、挡纯符号）、分组只认已有名、建议里编造的站点 id 一律丢弃。
  16 条单测钉住这些规则。
- 弹窗里的「小节 / 开关行」两个排版件抽到 `src/components/dialogSection.tsx`：
  设置弹窗是懒加载的，AI 弹窗从它导入会把那一整个代码块一起拖过来。

---

## 2026-10-01

**要点**：恢复改成真正的一次原子切换、批量导入有了真实进度；离线队列有了状态机、退避
和「可查看失败清单」；`AUTH_SECRET` 拆成三把独立的钥匙；首次部署不再可能建出两个 owner；
按需加载与缓存治理落地；搜索建成检索索引（3000 站点每敲一个字 10.5ms → 0.6ms）；
取图标可以彻底不外访（隐私模式）；点一次卡片不再让全页重渲染。

### 安全
- **`AUTH_SECRET` 拆成三把钥匙**：新增 `DATA_ENCRYPTION_KEY`（站点密码 / WebDAV 凭据落库加密）
  与 `JWT_SECRET`（登录令牌签名），另配 `JWT_SECRET_OLD` 只用于验签兜底（平滑轮换）。
  三者缺省全部回退 `AUTH_SECRET`，**不配就等于没启用这个功能**。
  密文带钥匙编号：新写入是 `enc$1$…`，升级前的是 `enc$…`，两种同时在库可读 ——
  轮换数据密钥不必停机迁移，也不必担心站内已有密文变成废数据。
- **初始化竞争**：`ensureOwnerUser` 过去「读到 users 表为空 → INSERT」之间有裂缝，
  首次部署两个并发请求会各建一个 owner。现在用幂等表当跨请求锁；
  幂等表不可用时退回原行为，绝不因为拿不到锁就阻断初始化。
- **DB 故障时的鉴权取向**钉成了四种：默认 fail-closed、迁移未完成前 fail-open、
  `NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR=1` 逃生口、抖动推出的结论不进缓存。
- 补完 S07（解压压缩比闸门 + 慢流/超限/压缩炸弹回归）、S09（统一打开入口 `utils/safeOpen.ts`）、
  S10（配置与 WebDAV 端点各一把按 IP 分桶的锁）、安全头补 HSTS 与 CORP。
- 修 `readBoundedBytes` 的真 bug：超时回调里 `reader.cancel()` 会让挂着的 `read()` 以
  `done:true` 抢先结束，`Promise.race` 因此误判「流正常结束」并返回被截断的 body —— 慢流攻击此前静默生效。

### 修复
- **覆盖恢复改成原子切换（D01）**：过去是「先插分组拿 id → 再插站点 → 最后配置与清理一个事务」，
  中间两步没有任何事务保护，失败只能靠事后回滚，而回滚本身也可能留下孤儿行。
  现在**预分配 id**（从 `MAX(id)+1` 起），把「插分组 / 插站点 / 写配置 / 清旧数据」
  全部塞进**同一个 D1 batch** —— 要么整份备份生效，要么一个字节都不变。
  并发恢复仍有账号级锁。故障注入覆盖「插分组 / 插站点 / 写配置 / 清旧站点 / 清旧分组」五个失败点。
- **离线队列重做（D02）**：
  - 逐项 `pending → sending →（服务端确认后）删除`，成功一条才从盘上划掉一条；
    卡在 sending 超过租期的会被收回重排（页面关了不丢操作）。
  - 暂时性失败按**指数退避**（1s→2s→…→60s，带抖动）往后推，不再一遍遍锤刚挂掉的服务端。
  - 重试到上限或服务端明确拒绝（4xx）的，移进**可查看的失败清单**：顶栏能展开查看原因、
    单条重试 / 放弃 / 全部重试 / 清空 —— 不再让注定失败的操作永远占着待同步角标。
  - **临时 ID 映射**：离线新建分组拿到负数占位 id，界面立刻能显示它、也能在它下面加卡片；
    重放时用真实 id 回填（`group_id` 与记录自己的 `id` 都会翻译），不会挂到一个本地才有的号上。
  - 修「重放时再次入队」：重放调的是被包装过的方法，失败会再入一条，同一件事于是做两遍。
    现在重放期间关闭入队入口。

### 性能
- **搜索不再每次按键全量归一化**：站点侧的可搜文本（名称+链接+描述）与分组名只在
  **数据变了**时算一次，查询侧只归一化一次，剩下就是 `includes`。
  实测每敲一个字（同一个关键词、同一份数据）：
  300 站点 1.34ms → 0.25ms，1000 站点 3.60ms → 0.18ms，3000 站点 10.52ms → 0.62ms。
  命中结果与逐条现算**逐条比对过**（测试里同一批关键词跑两遍，必须同真同假），
  这是纯加速，不是换了套搜索语义。
- **恢复/导入不再逐条等加密**：站点密码改为限并发批量加密（并发窗口 16，顺序与输入一致）。
  原来是几千次串行 `await`，纯本地计算被拖成一条流水线。
- **超大备份分块提交**：单个 D1 `batch` 最多 250 条语句。日常备份（几十条）仍然
  **一个事务切过去**，只有超大备份才分块 —— 分块后每块各是一个事务，
  中途失败靠按 id 回滚已提交的块收场，库里不会留下半份新数据。
- **导入进度是真的**：前端要进度时（`Accept: application/x-ndjson`）服务端走流式响应，
  边跑边把 `校验 / 加密 / 写入 / 清理 / 收尾` 五个阶段的真实条数推下来。
  服务端不认这个头（老部署）就自动落回整包 JSON，只是没有进度，导入照常完成。
  拿不到进度时界面只转圈，**不画按时间匀速前进的假进度条**。
- **冷启动不再白跑一遍迁移**：`configs.schema.version` 记下结构版本号，
  对得上就跳过建表 / 补列 / 建索引那二十多条语句（省掉的是一整趟查询，不是正确性 ——
  往 `runMigrations` 里加新步骤时把 `SCHEMA_VERSION` +1 即可让它自动重跑）。

### 新增
- **图标隐私模式**（设置 → 离线与缓存，默认关）：打开后卡片一律用首字母块，
  浏览器与本站都不再为取图标访问任何外站 —— 取图标本身就是在告诉对方
  「有人在访问这个域名」，公共图标服务还会顺带记下它。缩略图（第三方截图服务）同样不发。

### 重构
- **账号边界清单集中到 `utils/sessionBoundary.ts`**：退出登录 / 注销账号 / 换人登录
  共用的「上一个账号的痕迹要清哪几样」原来是三处各写一遍，漏一条就是同一个后果 ——
  离线队列会被补发到新账号名下、撤销快照能一键把别人的卡片改回来、首屏缓存把上一个人
  的数据先画出来。现在清单就是那两个函数体，逐条有单测。
- **命令面板条目搬到 `hooks/useAppCommands.ts`**：App 只把动作传进去，
  「哪条命令叫什么、属于哪个分组、按下去跑什么」由它统一维护，并第一次有了单测
  （站点命令的分组副标题、开关类文案跟着状态变、站点命令上限）。
- 本机偏好的 Context 按「多久变一次」拆成三份：稳定（设置项 + 全部写操作回调）、
  星标 / 标签 / 死链、访问统计。React 的 Context 没有选择器，value 一变订阅者全体
  重渲染 —— 以前每点一次卡片（记一次访问）都会让左侧分组栏、几百张不显示热度的卡片
  一起重渲染一遍。现在卡片 / 分组 / 分组栏只订阅前两份，访问统计的变化只通知
  真正显示热度的地方（有渲染计数的单测钉住这条）。

### 修复
- **图标记事不再一条写到老**：以前「这个源能用 / 用不了」记下就永久有效 ——
  站点换了 favicon 看不到新的，一次 404 则终身出局。现在成功记事 7 天、
  失败负缓存 24 小时，到期就当作没记过，重新试一次。
- **objectURL 不再只借不还**：每张图标的 objectURL 都钉着一份内存里的 blob，
  以前建了就再也不释放。现在按引用数借还，空闲的按 LRU 保留 120 个、超了才 revoke，
  卡片切来切去不会把内存越堆越多。

### 性能
- **图标靠 HTTP 缓存而不是再叠一层**：代理响应从「一年 immutable」改成
  7 天 + `stale-while-revalidate`。站点换 favicon 是常事，一年不回源等于把老图标钉死；
  回源放在后台，用户这边不会因为缓存过期而白等一次网络。

### 新增
- **设计 tokens**：`src/index.css` 里把散落的 `--glass-*` 收成一套语义变量
  （surface 三级 / border 三档 / radius / spacing / shadow / blur / 文字层级），
  旧的 `--glass-*` 全部降级为指向它们的别名，暗色与「关毛玻璃」只重定义语义层。
  分组强调色仍然只画一条 3px 细线，不铺整块高饱和背景。
- **清爽模式**（设置 → 外观，默认关）：一并关掉毛玻璃、柔光背景、装饰动画与悬浮阴影，
  只留纯色底和静态卡片 —— 比单独关毛玻璃更彻底，后者只是换一种合成方式，
  背景那层 `blur(48px)` 与几百张卡片的入场动画照旧在烧 GPU。
- **拖拽的按钮替代**：分组排序给「上移 / 下移」，分组内排序给「前移 / 后移」，
  到头自动禁用。拖拽不是人人可用（触屏长按误触、读屏拿不到指针、键盘要按空格拾起），
  顺序调整从此有了一条看得见、点得到的路。
- **公开品牌配置 `src/brand.ts`**：站点名、一句话介绍、主题色的唯一来源。
  `npm run sync:brand` 把它同步到 `index.html` 与 `manifest.webmanifest`，
  `npm run check:brand` 只校验（已接进 `npm run ci`），一致性有单测钉着。
  登录页不再写死一个常量，改「网站设置 → 标题」后登录页与标题栏一起变。

### 修复
- **确认弹窗的三条硬规则**：影响面（对象 + 数量 + 可撤销性）明写出来，
  不再让正文去猜；提交中确认与取消一起禁用、Esc / 点遮罩不放行；**异步确认失败时不关闭**，
  用户可以直接再点一次。清空回收站失败不再「先关窗再报错」。
- **自定义背景有蒙版下限**：滑块拉到最清晰也保留一层 12% 的蒙版，
  亮图上的浅色文字不会糊掉（换算集中在 `utils/backgroundMask.ts`）。
- 登录页三处会误导人的文案：「记住我（一个月免登录）」→ 明确只记账号名、不保存密码；
  恢复入口改说「选择文件、只在本机签名、不上传」，不再用「上传私钥」这种说法；
  注册提示改成「只有站点所有者能生成邀请码」（服务端确实只放 owner）。
- 小屏触控目标：对话框 / 批量条 / 底栏按钮撑到 44px；卡片上那几个小图标用透明热区
  把可点范围补到 44px（视觉尺寸不变，免得把卡片撑变形）。
- 小屏弹窗改贴底面板（顶部圆角、最高 92dvh、底部操作区 sticky），
  软键盘弹出时视口跟着收，提交按钮不会被顶到屏幕外；底栏让开 iPhone 的安全区。

### 重构
- 弹窗外壳 `components/dialogShell.ts`：标题 / 正文 / 底部操作三区的圆角、材质、
  内边距收成一份，另有 `.MuiDialog-paper` 兜底。以前每个弹窗各写一份 paper 样式，
  同一个「确定」在不同弹窗里看着像两个产品。
- 分组工具条（添加卡片 / 排序 / 编辑）平时不再常显：指到分组或键盘走进来才浮出，
  编辑 / 多选 / 排序态常显，触屏一律常显 —— 平时是安静的导航，编辑时才集中给入口。

### 工程
- 新增 `npm run sync:brand` / `check:brand`，把品牌信息从 `src/brand.ts` 同步到
  静态的 `index.html` 与 `manifest.webmanifest`（CI 里以 check 模式拦截漂移）。
- 新增 `.github/workflows/secret-history.yml`：每周 + 手动，gitleaks 扫**全部 Git 历史**
  （`--redact`、不阻断、结果上传 artifact）。CI 那步仍只扫工作区、负责拦新泄漏 ——
  历史里的东西只能靠轮换解决，挂在每次 push 上只会得到一条被习惯性忽略的红灯。
- 单测 712 → 767；App.tsx 3736 → 3627 行。

### 新增
- **恢复预览说到字段级**：备份导入前的清单里，「更新」不再只有两个字 ——
  现在直接写出「名称、链接已改」，展开看得到从什么改成什么。
  唯一的例外是账号与密码：预览是要摆在屏幕上的，只说「有变化（内容不显示）」。
  清单长了可以按关键词筛、只看有变化的，筛选只影响显示、不动勾选。
- **标签重命名 / 合并**（标签管理里每行多了两个按钮）：重命名到已存在的标签时
  明确提示「等于把两个标签合并」，合并则说清源标签会消失、影响几个网站；
  两个动作都是**整份写回**，提示条上挂「撤销」（撤销=写回旧表），并同步正在用的标签筛选。
- **高级搜索语法**（搜索框）：`tag:AI` / `group:开发` / `in:开发` / `url:github` /
  `is:starred` / `is:dead` / `#标签` / `-排除词`，支持双引号包整体。
  语法只做**收窄**，认不出的 token 退回普通关键词（含 `http://` 这种会被误当协议的）；
  写了不认识的条件会点名提示，不会静默变成「什么都搜不到」。搜不到时空状态顺带教一下语法。
- **命令面板会排序、记最近用过**：关键词按「完全相等 > 前缀 > 包含（越短越靠前）>
  说明/别名 > 跳字」打分，最近用过的排在前面，回车与点击都走同一条路（先记再用）。
- **书签导入先体检**：选完文件先给出「新增 N / 重复 M / 无效 K」。
  重复按 `urlKey` 判定（协议、www、末尾斜杠不同也算同一条），说清是**已存在于哪个分组**
  还是**文件内跟哪个文件夹撞了**；`javascript:` / `place:` 这类伪协议直接标无效并给出原因。
  重复默认跳过（可展开查看，最多列 50 条），需要时也能开关「连重复的也一起导入」。
  建卡片改成限并发（6），一份几百条的书签不再一条条等。

### 修复
- **书签文件夹认不出来**：浏览器导出的书签里，文件夹的 `<DL>` 是**嵌在 `<DT>` 里**的
  （`<DT><H3>工具栏</H3><DL>…链接…</DL></DT>`），原来的解析只认「`<DL>` 前面那个 `<DT>`」
  这一种并列写法，于是一份书签里的**所有**链接都落进兜底分组「导入的书签」，
  导出时的目录结构一点都没保留。现在嵌套与并列两种写法都认。

### 工程
- 单测 767 → 821。

---

## 2026-09-30（第二轮）

**要点**：限速计数不再「读整条 → 改 → 整条写回」、App.tsx 再瘦 85 行、CI 多一道密钥扫描和一个会自己敲键盘的冒烟。

### 安全
- **限速计数改条件更新（CAS）**：登录 / 初始化 / 注册 / 恢复 / 导出 / 写接口那六把锁，
  过去都是「读出整条 configs → 改一个桶 → 整条写回」。两个请求同时读到同一份快照时，
  后写的那份会把前一份**整个盖掉** —— 反映到攻击场景就是「受害者的一次写入把攻击者
  攒的失败次数冲回小数」，限速形同虚设。现在比较与写入压进同一条 SQL
  （`compareAndSetConfig`，判据是 `rows_written` 而不是 `success`），抢不到就重读重算、
  最多三次；存储层没有 CAS 能力时退回原行为。
- **CI 加了密钥扫描（gitleaks）**：扫描工作区文件，把 AUTH_SECRET / AUTH_PASSWORD /
  WebDAV 口令误写进文件的改动拦在合并之前。刻意**不扫 Git 历史** —— 那里曾有明文密钥，
  扫出来也救不回来（正解是轮换），只会得到一条永远修不好的红灯。
  白名单见根目录 `.gitleaks.toml`。

### 重构
- App.tsx 再抽出两块纯逻辑：`utils/cardFocus.ts`（方向键在卡片网格里移动焦点，
  64 行 + 10 条矩形级单测）与 `utils/customCss.ts`（自定义 CSS 清洗）。
  前者原先只能用假 DOM 顶着整个 React 树测，现在喂几个矩形就能验证；App.tsx 3646 行。

### 工程
- CI 冒烟从 32 条扩到 45 条断言，补的三组都是「元素在不在」测不到的：
  - **方向键真的把焦点挪到了下一张卡片**（按行 / 列判定先在 Node 侧重算一遍期望值，
    换布局不会假红）；
  - **站点凭据的密码框必须是 `type=text` + `-webkit-text-security: disc`**，
    并且 `name` 不能叫 `password`（改回去功能一切正常，只是浏览器又开始自动填充）；
  - **搜索框用 CDP 真的插文本**，验证受控组件的 `onChange` 没断 —— 改了 input 的 name
    却忘了同步 `formDataKey` 映射时，页面照常渲染、但敲键盘没反应。

---

## 2026-09-30

**要点**（第一轮）：写接口补上限速、访问记录与折叠态可跨设备同步、审计日志里能看前端错误、依赖升到 MUI 7.3 / vite 6.4 / TS 5.9 / wrangler 4.144。

### 新增
- **写操作限速**：分组 / 站点的增删改、批量删除、导入此前一把锁都没有（登录失败、注册、导出才有）。
  现在按「账号 + 来源 IP」分桶，一分钟 120 次内不受影响，超出后指数退避并回 `Retry-After`。
- **导入条数上限**：光限 10MB 体积不够（全是短记录的 JSON 能塞几万条，整批 INSERT 会把 D1 顶满），
  另加分组 2000 / 站点 20000 的条数上限；导入也补上了审计（此前只有导出有）。
- **访问统计与分组折叠可跨设备同步**：跟随「数据同步 → 星标、标签与访问记录」开关一起上传服务端。
  访问次数按各设备取**较大值**合并（相加会把两台机器各点一次记成两次），折叠态以最后一次操作为准。
- **审计日志新增「前端错误」视图**：错误上报此前只躺在 `audit_log` 的一串 JSON 里没人看得懂，
  现在按「来源 + 错误信息」归并，展示次数 / 最近时间 / 发生在哪些页面，仅站点所有者可见。
- **设备级会话管理**：`user_sessions` 表 + 登录登记 + 验签限频刷新；
  账号管理里可逐台踢下线或「退出其它设备」。吊销 = 先拉黑再删行（只删行等于没吊销，JWT 是自包含的）。
- **沉睡扫描手动入口**：`POST /api/users/sweep`，不必再等每周 cron。

### 安全
- WebDAV 备份通道的 SSRF：`davFetch` 改手动重定向、逐跳校验主机（`allowPrivateNetwork` 只放行初始主机）。
- `isBlockedHost` 补 IP 字面量归一化（十进制 / 八进制 / 十六进制 / 省略写法），挡住 `http://2130706433` 这类绕过。
- `/api/report-error` 实测 body 长度（此前只看 `Content-Length` 头，可被伪造）。

### 性能 / 工程
- 每请求两次账号态查询合并为一次；配置解密由串行改并行。
- `loginGuard` 不再整 blob 重写，改成单桶增量合并。
- 依赖升级：MUI 7.0.1→7.3.11、vite 6.2→6.4.3、typescript 5.7→5.9.3、wrangler 4.138→4.144。
  TS 5.9 把 `Uint8Array` 泛型化后，`crypto.ts` 引入 `Bytes = Uint8Array<ArrayBuffer>` 与零拷贝 `asBytes()`。
- `NavigationAPI`（3739 行）按域拆成 `src/API/methods/*.ts`；`worker/index.ts`（1323 行）按前缀拆成 6 个路由模块。
- favicon / 图标改 1 年 `immutable` 缓存；`prefers-reduced-motion` 加了全局兜底。

---

## 2026-09-29

**要点**：多账号收尾、外观按账号隔离、沉睡账号治理落地、删掉 Docker 部署方式。

### 新增
- 外观配置（标题 / 主题色 / 背景）按账号隔离，所有者那份同时是全站默认与登录页外观。
- 沉睡账号治理：停用 → 宽限期 → 硬删，阈值可在「账号管理」里改，所有者永不参与治理；
  用私钥找回时一并解除停用状态。
- 审计日志与回收站 7 天保留期，可配置。

### 修复
- 还原回收站时丢 `user_id`，导致「点了还原没反应」。
- 账号状态查询的异常结论会进缓存（误判停用后一分钟才恢复）。
- 多选删除与撤销改成批量接口，不再全量重拉；菜单开合不再引起顶栏重排。

---

## 2026-09-28

**要点**：多账号体系、Ed25519 私钥找回密码、备份口令与 `AUTH_SECRET` 解耦。

### 新增
- **多账号**：邀请码注册、数据按账号隔离、注销账号；新增「账号管理」弹窗。
- **忘记密码**：改用 Ed25519 公私钥（网页生成密钥对，公钥入库、私钥只留本地），
  凭私钥认领账号，忘记账号名也能找回。移除旧的应急重置码。
- WebDAV 备份配置按账号隔离；「导出 / 导入数据」合并为「数据备份」。

### 修复
- 备份口令改用 10 万次迭代（`NAVIHIVE-ENC2`）—— Workers 的 PBKDF2 上限就是 10 万，
  原先 15 万次在服务端解不开；旧的 ENC1 仍可兼容读取。
- 恢复失败不再清空现有数据；加密备份可在任意账号输入口令恢复。
- 取消备份密码的 8 位长度限制（只保留非空与两次一致）。

---

## 2026-09-27

**要点**：安全加固集中落地——会话改 httpOnly cookie、凭据加密、SSRF 收敛、CSP trusted-types。

### 安全
- 会话令牌从 `localStorage` 改 httpOnly cookie，令牌可吊销（jti 黑名单），改密后令牌版本 +1。
- 站点凭据与 WebDAV 密码落库加密；首次部署强制改密。
- 抽出 `safeFetch` 统一出站请求：手动重定向 + **每跳**重验主机，挡住借 302 跳内网的 SSRF。
- 启用 `require-trusted-types-for`，封死 DOM XSS sink；`isBlockedHost` 补 IPv6 / 组播 / CGNAT 段。
- `/api/*` 响应统一 `no-store` + `Vary: Cookie`；`/api/init` 不再暴露「已初始化 / 未初始化」。

### 新增
- 客户端错误上报（`/api/report-error`），敏感字段先 sanitize 再落库。
- 本地备份可用口令加密；WebDAV 自动备份只滚动清理自己那一份，手动备份永不删除。
- WebDAV 加「允许内网地址」开关（默认关），修家庭 NAS 被 SSRF 黑名单误伤。

---

## 2026-09-26

**要点**：撤销 / 重做、登录失败限速、安全响应头、离线写入队列、拼音搜索。

### 新增
- 撤销 / 重做操作栈（Ctrl+Z / Ctrl+Shift+Z）。
- 登录失败限速：连错 5 次后每次等待翻倍，最长 30 分钟（按来源 IP 分桶）。
- 离线写入队列：网络错入队 `localStorage`，恢复后重放。
- 拼音搜索、导入前差异预览、图标离线缓存、失效检测改增量。
- 安全响应头（CSP / HSTS / nosniff / frame-ancestors）；图标走同源代理。

### 修复
- 触屏判定不再用 `@media (hover: none)`（CI 上浮层常显、设置按钮不显）。
- 卡片浮层、分组栏焦点环、带 label 输入框的外圈焦点环等一批视觉 / 无障碍问题。

---

## 2026-09-25

**要点**：视觉体系成型（毛玻璃卡片、暗色适配、骨架屏）、备份与登录体验。

### 新增
- 全站视觉美化：毛玻璃卡片、吸顶分组、实时搜索、骨架屏、暗色适配、访问热力图、滚动进度条。
- 卡片改为真实链接（中键点击后台打开）；PWA 支持。
- 每周自动备份一次，只保留最新一份；登录页「记住账号密码」+ 应急重置码找回。
- 分组编辑改为打字确认，删除确认里的分组名可点击复制。

---

## 2026-09-24

- 项目初始化（`[CI Skip] source repo import`），后续在此基础上迭代。

---

## 仍在待办（写在这里是为了不丢）

- **密码强度校验是死代码**：`validatePasswordStrength`（≥12 位、拒同字符重复）只有定义和单测，
  三个改密 / 注册路径都没接它 —— 管理员密码目前可以设成 `1`。
- **部署密钥轮换**：`AUTH_SECRET / PASSWORD / USERNAME / RESET_CODE` 的种子值曾经进过 Git 历史，
  上线前必须用 `wrangler secret put` 换成全新随机值。轮换 `AUTH_SECRET` 会让 D1 里的 `enc$` 站点 /
  WebDAV 密码解不开，需先备份、部署后重新填一次。
