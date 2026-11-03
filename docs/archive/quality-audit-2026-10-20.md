# NaviHive 质量评估与优化分析（2026-10-20）

评估对象：`zwjttztt/Cloudflare-Navihive1` main（v4.3.2）。
方法：**实测优先**——本地起自托管服务跑全站体检 / 无障碍 / 对比度审计，统计构建产物与源码规模，
读关键源码与配置核对安全项；不采信「应该没问题」的推断。
线上快照：`https://<your-host>`，容器 healthy，跑 v4.3.2。

---

## 0. 总览

| 维度 | 现状判定 | 一句话结论 |
|------|---------|-----------|
| 视觉呈现 | 🟢 良好（1 处键盘可达性瑕疵） | 亮/暗两态对比度 0 不合格，但 3 个控件焦点环不可见 |
| 功能完整性 | 🟢 良好（2 处缺口） | 功能面广且 E2E 护航，但 9 个源文件零测试触及、发版页是死链 |
| 架构设计 | 🟡 可接受（1 个结构性问题） | 分层清晰、坑已沉淀，但 `NotesPage.tsx` 6675 行是明确的坏味道 |
| 安全性 | 🟢 良好（1 项需权衡） | CSP + Trusted Types + HSTS 全家桶；docker.sock 挂载是自助升级的固有代价 |
| 运行速度 | 🟡 良好（1 处纯浪费） | 懒加载做得细，但 katex 被打包两份、首屏 core 891KB 偏重 |

**门禁现状（全部实跑）**：单测 2879 全绿 · `tsc -b` 0 错 · eslint 0 error（22 warning）· build 通过 ·
全站体检 28 项 0 问题（4 视口 × 路由 × 弹窗 × 记事本）· 无障碍 0 不合格 · 对比度亮/暗 0 不合格 ·
CI + docker-publish 全绿。

**规模基线**：源码 85264 行（src 268 文件 74663 / worker 9195 / server 1406），测试 279 文件 2879 用例，
运行时依赖 23 + 开发依赖 17，构建产物 8.9MB / 161 个 JS（首屏 core 9 个文件 891KB，其中 JS 843.9KB）。

---

## 1. 视觉呈现

### 1.1 键盘焦点环 —— ✅ 已查明：是判据假，不是页面坏 🟢
- **原判断（错）**：无障碍审计的焦点参考项显示「只看星标」`outlineWidth: 0px` +
  `boxShadow: none`，据此认为「这一排 chip 键盘焦点完全不可见」。
- **真相**：老审计脚本用 `el.focus()` 测量，而**它不触发 `:focus-visible`**，
  量出来恒为「不可见」—— 那一屏数字全是假数据（连「常用工具」都是
  `outlineWidth: 3px` 而 `outlineStyle: none`，等于全员不可见）。
  改用 CDP 发**真 Tab 键**（`Input.dispatchKeyEvent`）后，index.css 的全局
  `:focus-visible { outline: 2px solid var(--accent) }` 对所有控件（含 Chip）一直有效。
- **本轮动作**：a11y 脚本第 4 节改成真 Tab 键测量并**升为判据**
  （Tab 30 个可聚焦元素，任一个量不到轮廓/阴影即失败）；输入框单独判
  「MUI 聚焦边框是否出现」（项目刻意不给输入框补 outline，会与聚焦边框叠成双环，
  见 `useThemeController` 的 MuiInputBase 注释）。
- **顺手抓到的真问题**：判据升真后才发现它**整类漏测** —— 标签栏在无标签时整条不渲染，
  Chip 根本进不了 Tab 序列，量出来一片绿其实什么都没验。现在用
  `Page.addScriptToEvaluateOnNewDocument` 在文档加载前往 localStorage 塞两个标签。
- **教训**：曾据此加过一个 `MuiChip` 焦点环补丁，**反向验证时发现移除后审计照样绿**，
  说明它不可观测、没修复任何实际问题，已撤掉并在主题里写明「不要再加」。
  「没验证过的修复不说已修复」——这条对自己的判断同样适用。

### 1.2 设计令牌双轨制 🟢 低
MUI theme 与 `index.css` 的 CSS 变量各管一套（有 `script/sync-brand.mjs --check` 守着品牌色漂移）。
目前没出问题，但新增视觉属性时容易漏一边。
- **优先级**：P3｜**收益**：新增主题属性时只有一个地方要改。

---

## 2. 功能完整性

### 2.1 九个源文件从未被任何用例引入 🟡 中高
覆盖率扫描（301 个源文件）显示 **292 个被触及，9 个合计 924 行完全没进过测试**：

| 文件 | 行数 | 承担的关键路径 |
|------|-----|--------------|
| `src/main.tsx` | 211 | **版本漂移自愈**（清 SW 缓存重载）、脚本/样式加载失败恢复、ChunkLoadError 兜底、公开分享页路由 |
| `src/components/ErrorBoundary.tsx` | 148 | React 渲染崩溃兜底页 |
| `src/API/responses.ts` | 179 | 响应解析 |
| `worker/types.ts` / `worker/routes/types.ts` | 231 | 纯类型，可接受 |
| `src/components/ThemeToggle.tsx` | 60 | 主题切换 |
| `src/API/schema.ts` / `src/types.ts` | 60 | 类型定义，可接受 |
| `src/mermaidSandbox.ts` | 35 | mermaid 独立渲染沙箱 |

- **影响**：`main.tsx` 那三条路径正是「站点升级后不白屏」的唯一保障，原来**只靠真机验证**。
  这类代码的特点是「改动无声、回归致命」——v2.0.0 登录设备去重没写单测导致无声回归，是同一类教训。
- **本轮已处理（两个最大的）**：
  - 自愈逻辑从入口抽成 `src/utils/staleRecovery.ts`（清缓存 / 闩锁 / 一次性令牌 / 离线判断），
    配 `tests/staleRecovery.dom.test.tsx` **6 例**：只清本站缓存、两条路径共用闩只刷一次、
    令牌已存在不重复刷、**真离线什么都不做**、拿不到在线状态按在线处理、清缓存抛错也照常重载。
  - `tests/errorBoundary.dom.test.tsx` **4 例**：抛错时渲染自助恢复页（三个按钮 + 错误详情）、
    没抛错原样渲染 children、「清理本机数据」**不动记住的账号名**（越界）、
    「连登录一起清理」才清、不碰别人的 localStorage key。
  - 顺带修掉两个让单测够不着它们的原因：单测环境补 `__NAVIHIVE_BUILD_VERSION__` /
    `__NAVIHIVE_APP_VERSION__` 的 esbuild define（否则 `localBuildVersion()` 恒为空串，
    整套版本判断被跳过）、补 `sessionStorage` 全局。
- **优先级**：P1（已完成 2/9，剩 `API/responses.ts`、`ThemeToggle` 等）｜
  **收益**：把「升级后自愈」从侥幸变成有守卫的属性。

### 2.2 发版页是死链 🟡 中
设置里写着「更新内容见[发版页]」，但 GitHub Releases 只有 **v0.1.0（3 周前）**——
本项目一直直推 main、从不打 tag。用户点进去看不到任何更新记录。
- **优先级**：P2｜**收益**：二选一——(a) 每次发布补一个 Release（tag + 说明），
  (b) 把文案改成指向 `CHANGELOG.md`（raw 或 blob 链接）。推荐 (a)，顺带给用户一个可订阅的变更通道。

### 2.3 其他
- 待办 `#88 密码管理器` 范围待定，不影响本次评估。
- 导入导出 / WebDAV 备份 / 分享 / 附件 / AI 助手均有 E2E 或专项脚本护航，功能面完整度高。

---

## 3. 架构设计

### 3.1 `NotesPage.tsx` 6675 行：唯一的上帝组件 🟡 中高
| 文件 | 行数 |
|------|-----|
| `src/components/NotesPage.tsx` | **6675** |
| `src/components/NotesSettingsDialog.tsx` | 2358 |
| `src/App.tsx` | 2178 |
| `src/API/methods/notes.ts` | 1990 |

- **影响**：单文件承载侧栏 / 列表 / 编辑器 / 预览 / 各类弹窗控制器。改任一角落都要全量 typecheck、
  review 成本高、合并冲突概率大；也是「改 A 坏 B」类回归的温床（本批附件弹窗修复就动到它三处）。
- **本轮已完成第一期（低风险外移）**：
  - `NotesShortcutsDialog.tsx`（键盘快捷键弹窗，原本占父文件 13 行 JSX，只依赖 EDITOR_SHORTCUTS + Kbd）
  - `src/utils/noteSummary.ts`（列表预览摘要，纯函数）+ `tests/noteSummary.test.ts` **6 例**
  - `NotesPage.tsx` 6675 → 6649 行
- **剩余工作（需专门批次，建议顺序）**：① 侧栏 section（`components/notes/sidebarSection.tsx`
  已有雏形，把渲染与状态接过去）② 右键菜单动作表（1826 行起那一大段）③ 批量操作条
  ④ 各弹窗控制器群。每步只外移、不动渲染逻辑，配一次全量回归。
- **优先级**：P1（第一期已落地）｜**收益**：首期收益是「能单独看、单独测」；
  全部完成后文件降到 ~3000 行量级，回归面骤降。

### 3.2 双轨运行时的抽象成本 🟢 低
`worker/`（CF Workers + D1）与 `server/entry.ts`（Node + SQLite）共用同一份 handler，
另有 `src/API/mock.ts`（1531 行）服务开发/测试。三套并存意味着同一行为要在三处对齐，
`import.meta.env.VITE_USE_REAL_API` 的切换语义要格外小心。
- **优先级**：P3｜**收益**：明确 mock 只属于测试、并在文档里写死「真实客户端是唯一事实来源」。

### 3.3 踩坑知识只活在注释和 memory 里 🟡 中
项目已经踩过并修掉一批很贵的坑（`routes/data.ts` 的 `startsWith("X/")` 前缀必须排在
`X/{id}` 之后、D1 batch 按「是否返回行」派发、Workers `env.ASSETS.fetch()` 返回 immutable headers、
rolldown 回调期 `importers` 混动态边、弹窗 fallback 禁 `null`……）。这些目前散落在
代码注释 + `.workbuddy/memory`，新贡献者（或未来的自己）要重新踩一遍。
- **优先级**：P2｜**收益**：沉淀成 `docs/pitfalls.md`，每条配一个静态守卫或单测（项目已有这个传统，
  如 `systemUpgradeGuard.test.ts`）。

### 3.4 `server/entry.ts` 里塞了 ~400 行升级逻辑 🟢 低
拉镜像 / helper 容器 / 兜底 / 状态都在入口文件里。功能上没问题，但入口文件应只管「接线」。
- **优先级**：P3｜**收益**：拆出 `server/upgrade.ts`，入口只剩 `mountUpgradeRoutes(server)`。

---

## 4. 安全性

### 4.1 docker.sock 挂载 = 把宿主机 Docker 控制权交给容器 🟡 中高（需权衡）
网页一键升级的前提是把 `/var/run/docker.sock` 挂进容器，且容器以 `user: "0:0"` 跑
（sock 属 `root:docker`，非 root 连不上）。等价于：**容器内进程可以起特权容器、挂载宿主任意路径、
读写所有卷**。
- **现有缓解**：端口只绑 `127.0.0.1:8787`（不直接暴露公网）、owner-only 端点、compose 注释里写明了代价。
- **风险残余**：一旦应用层被突破（XSS + owner 会话），就是宿主机 root。
- **本轮已做**：`deploy/selfhost.md` 新增独立小节讲透风险，并给出三种选法
  （不挂 sock 最稳 / 挂 sock + 只绑回环 / 套 `docker-socket-proxy` 只放行必要端点），
  连「放行哪些、禁哪些」都列清了。**没有**真的上 proxy —— 那会改变升级链路的连接方式
  （代码里 `DOCKER_SOCK` 是硬编码 unix socket），需相应改造加真机验证，风险收益不成比例，
  交给用户按文档自己决策。
- **优先级**：P2（文档已交付）

### 4.2 依赖漏洞：2 处 low（katex 原型污染）🟢 低
```
katex 0.11.0-0.18.1  Existing prototype pollution can bypass trust restrictions
mermaid 10.9.0-rc.1-12.1.0  Depends on vulnerable versions of katex
```
触发条件是渲染**不可信**的 LaTeX。笔记内容本人写、分享页只读，实际可利用面很小。
- **本轮已修**：`npm audit` 报的是嵌套那份 `mermaid/node_modules/katex@0.16.47`；
用 overrides 统一到 0.19.0 后，**0.19.0 不在 advisory 受影响范围（0.11.0–0.18.1）内**，
`npm audit` 现在 **0 vulnerabilities** —— 和上一条一次解决。
- **优先级**：P3（已修）

### 4.3 做得好的部分（应保持）
- CSP 全栈：`default-src 'self'`、`object-src 'none'`、`base-uri 'self'`、`form-action 'self'`、
  `frame-ancestors 'none'`，且 **`require-trusted-types-for 'script'` enforce 生效**，
  只放行 `navihive-sw` 一个策略名（连 SW 注册那个坑都堵上了）。
- HSTS 2 年含 preload、`nosniff`、`X-Frame-Options: DENY`、`no-referrer`。
- 认证侧：会话 TTL 双档、登录设备按**归一化设备键**判重（不计版本/IP 漂移）、限速桶 + XFF 门控、
  沉睡/注销治理对 owner 关闭。
- 分享侧：64 hex token、`need-password`、防刷 cookie、资产会话隔离。
- CSP `report-uri` 已接，但**没有告警链路**——被拦的资源只进 Workers 日志。建议后续接一条
  「CSP 违规 > N 条/小时」的通知。🟢 低优先级。

---

## 5. 运行速度

### 5.1 katex 被打包两份：纯浪费 ~250KB 🟡 中
```
assets/katex-CoonBF1E.js   250KB  含 render   ESM 入口（import ... from "katex"）
assets/katex-DJhrJSbw.js   250KB  含 render   CJS/IIFE 入口（markdown-it-katex 之类走它）
```
两个 chunk **都含完整 render 逻辑**，却是同一个库。根因是两条 import 路径分别解析到 ESM 与 CJS 入口，
rolldown 各打一份。懒加载时才付这 250KB，但这是**没有任何收益的纯重复**。
- **本轮已修**：根因不是打包器，是 **npm 装了两份不同版本** —— 顶层 `katex@0.19.0`
  （公式用）+ mermaid 12.1.0 嵌套的 `katex@0.16.47`（其依赖范围 `^0.16.47` 不含 0.19）。
  mermaid 最高 12.2.0（要 `^0.18.0`）仍不含 0.19，于是用 `overrides` 强制 mermaid 也用 0.19.0：
  `npm ls katex` 现在只剩一份，katex JS chunk 从两份 250KB 变成一份 259KB。
- **优先级**：P2（已修）｜**收益**：约 250KB 懒加载体积全免。

### 5.2 首屏 core 891KB（JS 843.9KB）偏重 🟡 中
core 9 个文件里 `mui-core` 328KB 是大头。项目已经做了能做的：manualChunks 归桶、
源码层闭包扫描判首屏（避免误把懒加载组件塞进 preload）、SW 预缓存。
- **优先级**：P3｜**收益**：可评估的方向——a) 首屏是否真的需要全套 MUI（按实际用到的组件再收一轮）；
  b) 非关键 core（如错误边界依赖）移出首屏。收益是首屏 -50~150KB，需实测权衡。

### 5.3 重依赖栈集中在懒加载侧（可接受，需知悉）
`elk` 1428KB（mermaid 布局）、`note-editor` 551KB、`cytoscape` 424KB、两份 katex 500KB。
合计 ~2.9MB **只在用到对应功能时才加载**，首屏不受影响；但弱网/低端机上「第一次画流程图」仍会等。
- **优先级**：P3｜**收益**：elk 可按图表类型再拆（flowchart / sequence 各一份），收益有限，先记着。

### 5.4 交互延迟 🟢 优
实测：置顶点击到 UI 反馈 **31ms**；右键菜单关闭逐帧检查 36 帧无残留焦点；
即时渲染代码块横向滚动条可拖动且未切回源码。慢请求日志只在 >1s 时打点。

---

## 高优先级行动项（建议顺序）

| # | 行动项 | 维度 | 优先级 | 预期收益 | 工作量 |
|---|--------|------|--------|---------|--------|
| 1 | 修 katex 重复打包（统一 import 入口或 dedupe） | 速度 | P2 | 省 ~250KB 懒加载体积 | 小 |
| 2 | 给发布补 Release（tag + 说明），或把「更新内容见发版页」改指 CHANGELOG | 功能 | P2 | 消除死链，给用户可订阅的变更通道 | 极小 |
| 3 | `main.tsx` / `ErrorBoundary` 补单测（版本漂移自愈、ChunkLoadError、崩溃兜底） | 功能 | P1 | 把「升级后不白屏」从侥幸变成守卫 | 中 |
| 4 | `NotesPage.tsx` 拆分第一期：弹窗控制器 / 附件 Provider / 设置群外移 | 架构 | P1 | 文件 6675 → ~3000 行，回归面骤降 | 中 |
| 5 | 上 `docker-socket-proxy` 或在 selfhost.md 强化 sock 风险小节 | 安全 | P2 | 把「容器失守 = 宿主机 root」的爆炸半径压小 | 中 |
| 6 | 焦点环补齐（「只看星标」等），并把焦点可见性从参考项升为判据 | 视觉 | P2 | 键盘可用性达标 | 小 |
| 7 | `npm audit fix` 消 katex 原型污染告警 | 安全 | P3 | 审计干净 | 极小 |
| 8 | 沉淀 `docs/pitfalls.md`（每条配守卫） | 架构 | P2 | 新贡献者不再重踩已修的坑 | 小 |

---

*评估方式说明：所有「问题」均来自实跑输出或源码核对，未使用推测；门禁数字为本次评估时点实测值。
下次评估建议在同一模板下复跑 `npm test` / `site-audit` / `audit:a11y` / `audit:contrast` / `coverage` 后对比。*
