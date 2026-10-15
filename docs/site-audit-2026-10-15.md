# NaviHive 全站审查报告（2026-10-15）

审查对象：自托管主站（`home.zwjttzt.com` → Cloudflare → VPS 443 → nginx → 127.0.0.1:8787 → 容器），
代码基线 `cf51ecf`（v0.3.0）。维度：功能完整性 / 运行稳定性 / 加载速度 / 交互操作 / 页面逻辑。

方法：生产环境实测（计时 / 响应头 / 缓存 / 回退行为 / 配置与日志）、构建产物分析（块大小与依赖图）、
本地审计脚本（a11y / 对比度）、单测与冒烟证据、代码走查。

**结论先说**：站点的「工程质量」维度（安全头、测试、构建纪律、运行时健康）相当扎实；
真正的问题集中在**运维面**——主站转正了，但备份是空的。以下按严重程度排序。

---

## P0 · 主站零备份（数据安全，唯一「正在流血」的项）

**事实**（生产库实测）：

- 数据量：13 个分组 / 36 个站点 / 4 篇笔记 / 3 个账号，全部只存在于单点 Docker 命名卷
  `navihive_navihive-data`。盒子一挂（磁盘故障 / VPS 商事故 / 误操作 `down -v`），全没。
- 配置表里**没有任何 WebDAV 备份配置**（无 `backup.webdav.*` 键）。
- cron 日志里 `notesBackup` 每小时秒退（0.0s）——没有目标可传，备份从未发生过。
- 背景：你之前配 WebDAV 时撞上「空体 DELETE 500」那个 bug（c49c59f 已修），配置很可能就没存住。

**叠加风险**：生产库 `backup.includeCredentials=true`——备份会含站点账号密码的**明文**；
而备份文件加密（`backup.password` 类键）**同样未配**。一旦配上 WebDAV 而没开文件加密，
明文凭据会直接同步到网盘。

**可执行建议**（按序）：

1. 站点里「更多选项 → 备份与恢复」配 WebDAV（`dav.zwjttztt.com`，500 已修，能存住了）；
2. **同时打开「备份文件加密」并设密码**（明文凭据 + 网盘 = 裸奔）；
3. 手动触发一次备份，我这边验证文件真的落上去了、能拉回来（恢复演练）；
4. 确认 cron 的每周自动备份开始跑（日志里 `notesBackup` 应有实际耗时）。

> 手册依据：`deploy/selfhost.md` 第七节「自托管最大的新增责任是备份……先验一遍能恢复再信任它」。

---

## P1 · 首屏被弹窗族 MUI 占走 425KB raw / 128KB gzip（加载速度）

**事实**（构建产物依赖图分析）：

- 首屏下载：index 243KB + **mui-lazy 425KB** + react 207KB + vendor 77KB + css 18KB ≈ **975KB raw**
  （gzip 后约 260KB，其中 mui-lazy 占 128KB）。
- `mui-lazy` 里装的是 Dialog / Modal / Menu / Popover / Snackbar / Card——**按定义是弹窗才用的**，
  却被 entry 块**静态 import**（`import{…}from"./mui-lazy-…js"`），Vite 因此给它发了 modulepreload。
- 根因：manualChunks 把所有「懒弹窗也用」的 MUI 归进 mui-lazy；而首屏组件确实需要其中一部分——
  `SnackbarHost`（全局 toast）、`MoreMenu`（顶栏菜单）、`SiteCard`（卡片菜单）、`GroupCard`（分组对话框）。
  共享模块没法只给一边，于是全被拽上首屏。
- 对比：2026-10-12 的首屏优化文档目标是 **513KB raw**（见 `vite.config.ts` 注释里的实测记录），
  现在 975KB——**回退了约 460KB raw**。

**可执行建议**（两条路线，推荐 A）：

- **A. 把「点了才出现」的首屏 MUI 消费者改懒加载**：`MoreMenu` 用 `React.lazy` +
  `ChunkBoundary when={menuOpen}`（项目现成模式）；`SiteCard` 的卡片菜单、`GroupCard` 的对话框同理。
  首屏只剩 `SnackbarHost` 需要 Snackbar——若也接受 toast 晚 ~100ms 出现，可一并懒化。
  预期：entry 不再静态依赖 mui-lazy → 首屏 **-425KB raw / -128KB gzip**，回到 ~550KB raw。
- **B. 改 manualChunks：把共享 MUI 复制回 index**（2026-10-12 实测总积体只 +0.24%），
  弹窗块各自再带一份。改动小但首屏还是要下这些字节，治标。
- 改完必须重测：首屏 raw 总字节（不是单块）+ `bundleBudget` 不红。

---

## P1 · 生产分享功能未实测（功能完整性）

**事实**：分享创建 / 撤销 / 公开页访问（`/s/:token`、`/sg/:token`）在自托管生产端**从未端到端验证过**。
代码侧有 32 条单测（b7083ed），但生产链路（CF → nginx → 容器 → 公开路由脱敏）没跑过。
分享是暴露给非登录用户的入口，出问题的面最大（要么分享打不开，要么脱敏不彻底）。

**可执行建议**：在生产上跑一轮：建一个分组分享 → 无痕窗口打开链接 → 核对只看到该分组、
看不到其他数据 → 撤销 → 再开链接应 404。需要密码的分享顺带验 401 + `need-password` 契约。
（这轮我可以写个探针脚本跑，不需要你的凭据之外任何东西——除了登录态，需要你配合点几下。）

---

## P2 · 「只看星标」按钮键盘焦点不可见（交互操作 / 可达性）

**事实**：a11y 审计通过（0 不合格），但焦点可见性是「参考项」——实测样式里
**「只看星标」按钮 `outline: 0px` 且无 boxShadow 兜底**，键盘 Tab 到它时用户看不到焦点在哪。
「回到顶部」同样 outline 0 但有 boxShadow 兜底（合格）；分组折叠按钮有 3px outline（合格）。

**可执行建议**：给该按钮补 `:focus-visible` 样式（outline 或 boxShadow，与「回到顶部」的兜底一致），
并把「焦点可见性」从审计的参考项升级为判据（`script/a11y-audit.mjs` 里加一条：
outline 为 0 的焦点元素必须有 boxShadow）。

---

## P2 · 同机其他服务公网暴露（安全面，范围外但高风险）

**事实**：`ss` 实测，除已修网的 8787 外，这台机器还有：
**kPanel 管理面板 8080**、openlist 5244、monitor 28080，全部绑 `0.0.0.0`。
面板能管整台机器（重启/重装/看全部服务），比 8787 敏感得多。

**可执行建议**（你决定，我不擅自动 kPanel 的东西）：面板端口改绑回环 + 用 SSH 隧道或
Cloudflare Access 之类的前置认证访问；至少确认面板自身密码强度与登录限速。

---

## P2 · 未知 API 路由返回 401 而非 404（页面逻辑 / API 语义）

**事实**：`GET /api/nope`（匿名）→ 401「请先登录」（text/plain）。
安全上合理（不向未认证者暴露路由存在性），但语义不精确：已登录用户请求不存在的路由
也会先过鉴权，排查问题时 401 会误导（「我登录了还 401？」）。

**可执行建议**：低优先。若要改：路由未命中时对**已认证**请求回 404 JSON，
对匿名请求维持 401（保持不暴露）。改动在 `worker/index.ts` 的路由分发处。

---

## P3 · 工程债与已知「刻意未动」项

| 项 | 状态 | 建议 |
|---|---|---|
| C 档密码库对账 | `docs/password-manager-analysis-2026-10-13.md` 与代码现状未对账（早前报告两条结论有错） | 对账一遍再决定要不要单独加密 `sites.password` 列；当前密码已加密（enc$ 前缀），缺口是「备份明文」而非「库内明文」 |
| FTS 降级 UI 提示 | 文档化的建议项，刻意未做 | FTS 不可用时用户无感知；可在搜索框下加一行降级说明 |
| 回收站清理节流 | 文档化的建议项，刻意未做 | 回收站大批量删除时无节流，大站点可能卡 |
| 未跟踪项 | `.github/workflows/docker-publish.yml`、`harness/` 未入库 | 定去向：入库或删 |

---

## 附：审查通过、无需动作的项（证据）

- **安全头**：CSP 完整（含 `require-trusted-types-for` + `trusted-types navihive-sw`）、HSTS 两年含 preload、XFO DENY、XCTO nosniff、Referrer-Policy——全部经生产实测。
- **加载**：TTFB 7ms（源站本机视角）；gzip 生效（react 207KB→71KB）；HTML 2KB；
  资产 `immutable` 一年缓存；HTTP/3（listen 443 quic）已开；SPA fallback 正常；
  manifest / sw.js 200。
- **稳定性**：单测 **2687 全过**；a11y 审计 0 不合格；对比度亮/暗两态 0 不合格；
  容器内存 43MB / 机器 24G（0.18%）；磁盘 6%；cron 四项任务正常；日志轮转 10m×3；
  healthcheck 打 /api/init；启动以来零 TypeError。
- **运行时卫生**：`auth.mustChangePassword=0`（无待改密）、`link.healthSync=true`（死链巡检在跑）、
  `pref.sync=true`（偏好同步在跑）。
- **版本治理**：右下角徽标 v0.3.0 与 commit 对应，SW 版本自愈链路有测试。

## 建议的执行顺序

1. **P0 备份**（今天，30 分钟，需要你在 UI 配 WebDAV + 加密密码，我验证）
2. **P1 首屏 mui-lazy**（下一轮开发，改动集中在 MoreMenu/SnackbarHost/ SiteCard/GroupCard 四个组件 + 重测）
3. **P1 分享实测**（随时，需要你登录态配合点几下）
4. P2 三项按兴致（焦点样式 10 分钟；面板暴露你自己定；API 语义可不动）
