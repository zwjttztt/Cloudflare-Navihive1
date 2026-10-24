# NaviHive 全站质量评估报告

- **评估日期**：2026-10-24
- **评估对象**：Cloudflare-Navihive1（NaviHive 个人导航站 + 记事本，双端部署：Cloudflare Workers / 自托管 VPS）
- **评估方式**：基于当前代码库的逐项实证检查（源码走查 + 构建产物实测 + 现成审计工具运行 + 门禁全量重跑），不依赖历史结论
- **代码基线**：`6160932`（main）

---

## 0. 总览

### 规模基线

| 项 | 数值 |
|---|---|
| 前端源码 src/ | 311 文件 / 79,610 行 |
| Worker（Cloudflare 侧） | 35 文件 / 9,378 行 |
| 自托管 server/ | 6 文件 / 1,954 行 |
| 测试 tests/ | 313 文件 / 67,155 行（96 DOM + 214 纯逻辑，**测试/源码比 0.84**） |
| 组件 / hooks | 91 + 13（notes 子目录）/ 37 |
| 生产依赖 | 23 个（MUI 9、CodeMirror 6、mermaid、katex、dnd-kit 等） |
| 文档 | CHANGELOG 4,887 行 + docs/ 35 份专题报告 |
| CI | 7 个工作流（ci / deploy / docker-publish / prod-smoke / secret-history / visual-regression） |

### 门禁现状（本次重跑，全绿）

`tsc -b --force` 0 error · ESLint 0 error（42 条既有 react-refresh warning）· 单测 **3,099 全绿** · build 通过 · 首屏体积预算 10/10 · 冒烟全通过 · a11y 审计 0 项不合格 · 对比度亮/暗双态 0 处不合格

### 总体判断

**工程质量在「个人/小团队自托管项目」范畴内属于第一梯队**，多数维度有主动设计而非被动补救：安全响应头 + Trusted Types CSP、全接口限速、SSRF 纵深防御、复合索引体系、Service Worker 核心/懒加载分层、离线 mutation 队列、备份完整性摘要与口令加密。本次评估**未发现高危漏洞或功能性缺陷**；发现的问题集中在两类——**规则漂移**（自定的守卫被大多数路由绕过）与**体量顽固**（拆分两轮后仍有 3 个 2000+ 行大文件）。

按优先级汇总：**P1 × 1，P2 × 6，P3 × 6**（详见各维度与第 6 节行动项）。

---

## 1. 安全性评估

### 1.1 做得好的（实证确认）

| 措施 | 证据 |
|---|---|
| XSS 防护 | 全仓 **0 处** `innerHTML` / `dangerouslySetInnerHTML` / `eval`（markdown 走 ReactNode、KaTeX 走 createElement）；CSP 带 `require-trusted-types-for 'script'` + Trusted Types 白名单 |
| 会话安全 | 令牌 httpOnly + SameSite=Strict + Secure（https 时）+ Path 限定；响应体不回传令牌；黑名单吊销机制 |
| CSRF | Sec-Fetch-Site 优先（不受反代回源 Host 改写影响）+ Origin 兜底 + SameSite=Strict 三保险 |
| 限速 | 登录（第 6 次起锁 1 分钟、指数至 30 分钟封顶）、注册、初始化、图标代理（60/min）、错误上报，全部带 CAS 重试保写入原子性 |
| SSRF | safeFetch：scheme/port/host 黑名单 + IP 字面量归一化（防十进制/八进制/十六进制绕过）+ 手动重定向每跳重验 + 跨源剥凭据头 + 双层超时 + Cloudflare 平台层 egress 拦截 |
| 密钥管理 | AUTH_SECRET 缺失拒启；PBKDF2 迭代可配（自托管 60 万 / Workers 10 万）；凭据加密落库（keyring）；日志 redactSecrets 脱敏 |
| 备份文件 | 完整性摘要（防篡改检测）+ 可选口令加密（AES-GCM + PBKDF2 随机盐）；敏感配置分类体系（加密/私有/外观）单一事实源 |

### 1.2 问题与建议

#### S1 · 19 处写接口绕过 `readJsonBody` 守卫 —— **P1 · 影响中**

- **描述**：`worker/routes/jsonBody.ts` 定义了请求体守卫（非对象/数组形态一律 400，防「body 是 null → 500」和「body 是字符串 → 静默建空记录」两类事故）。但实际业务路由中 **19 处使用 `await request.json().catch(() => ({}))`** 模式直接解析：`account.ts` ×3、`ai.ts` ×5、`data.ts` ×2、`ops.ts` ×4、`public.ts` ×4（含注册、口令校验），另有 `worker/util.ts` 的 `safeJson` 是同类模式。这些写法把「解析失败」吞成空对象、把「字符串/数字 body」静默放行到默认分支——正是守卫注释里明确要消灭的两种形态，只是从「500」变成了「静默 200 默认行为」。
- **影响**：无直接可利用漏洞（下游字段校验仍会挡），但错误语义不一致（同类垃圾输入，有的接口 400、有的静默接受），且项目自定的硬规则已事实性失效——规则漂移比单点错误更难查。
- **优先级**：P1（成本半天，属「本该如此」的收口）。
- **预期收益**：写接口输入语义统一；`jsonBodyGuard.test.ts` 类守卫可扩展到全量写接口清单，防再次漂移。
- **建议做法**：19 处逐个换成 `readJsonBody` / `readJsonValue`（排序类老接口用后者，兼容双形状）；补一条「所有 POST/PUT 路由都过守卫」的静态扫描测试。

#### S2 · 自托管运行时出站请求少一道平台层拦截 —— **P2 · 影响中低**

- **描述**：`safeFetch` 的注释明确其内网黑名单只是「纵深防御」层，上面还有 Cloudflare Workers 平台的 egress 拦截（连 DNS rebinding 解析回内网 IP 都能拦）。但**自托管 Node 运行时没有这一层**——Node `fetch`（undici）会真实连接解析出的 IP。hostname 黑名单 + 重定向逐跳重验仍在，但「域名首次解析时是公网、实际连接时被 rebinding 到内网」的窗口无法覆盖。
- **影响**：仅自托管部署 + 需要攻击者能影响 DNS 解析的场景；图标代理与 AI 出站两条路暴露。
- **优先级**：P2。
- **预期收益**：自托管侧 SSRF 防护闭环，与 Cloudflare 侧对齐。
- **建议做法**：server 侧对 `safeFetch` 增加「连接前 `dns.lookup` 校验解析 IP 不在黑名单」的 Node 专属路径（Workers 侧不启用，平台已拦）。

#### S3 · mock 模式与真实 API 的行为一致性覆盖有限 —— **P3 · 影响低**

- **描述**：`src/API/mock.ts`（1,591 行）的 `exportData`/`importData` 不过滤配置（直接吐 `mockConfigs`），与真实链路的 `backupScope` 判定完全脱节。今天这类「备份范围」修复在 mock 模式下验证不到。
- **影响**：仅影响演示模式（`VITE_USE_REAL_API` 未设时）；生产双端都走真实链路。
- **优先级**：P3。
- **预期收益**：演示模式也能回归备份规则；mock 与真实的契约从「形状」深入到「行为」。
- **建议做法**：mock 的导入导出接同一份 `pickExportConfigs` / `pickImportConfigEntries`（纯函数，接入成本低）。

---

## 2. 运行速度评估

### 2.1 现状实测

| 指标 | 实测值 | 预算/参考 |
|---|---|---|
| 首屏总体积 | **871.4 KB raw**（6 个文件：index 241 + mui-core 328.8 + react 201.9 + vendor 75.3 + preload-helper 3.2 + css 21.3） | 预算 900 KB raw，gzip ≈290/300 KB |
| index 单块 | 241.0 KB | 预算 256 KB（余量 6%） |
| 移动端 Slow-4G + CPU 4× | FCP 5,068 ms · LCP 6,064 ms · CLS 0.031 | 预算 FCP ≤7,157 · LCP ≤8,017 |
| 冷访问传输 / 请求数 | 881 KB / 78 个请求 | — |

### 2.2 做得好的

- Service Worker **核心/懒加载双清单**：install 只预缓存首屏闭包，9 个懒弹窗用到才缓存（避免了「懒加载只省解析、不省流量」的假优化）；
- 首屏 MUI 闭包用**源码层静态 import 扫描**归桶（避开 rolldown 回调期动态边干扰，注释记录了误判教训）；
- mermaid（elk 1.46 MB）/ cytoscape（434 KB）/ katex（259 KB）/ 编辑器（564 KB）/ NotesOverlay（326 KB）全部懒加载；
- `bootstrap?full=1` 合并启动请求；前端按账号 SWR 缓存；服务端 20+ 复合索引（`internals.ts`）；列表字段裁剪；离线 mutation 队列（指数退避 + 租约 + 失败保留）。

### 2.3 问题与建议

#### P1 · 慢网首屏体感偏慢 —— **P2 · 影响中**

- **描述**：FCP 5.1s 在预算内（探针有意「先报告不卡门」），但 Slow-4G 是真实的移动端/弱网场景。881 KB 传输量是主因，其中 mui-core 328.8 KB 是首屏最大单项——这是「多个首屏页面共用组件都进闭包」的结构性成本，闭包扫描已做过一轮，剩余空间在「组件级按需 import 审查」（如确认没有整包 `@mui/icons-material` 泄漏）与「小 chunk 合并减请求数」（78 个请求里有不少可合并的碎块）。
- **影响**：弱网/低端机用户首屏等待 5 秒级。
- **优先级**：P2。
- **预期收益**：FCP 预计 -1~2s；请求数 -10~20。
- **建议做法**：① 跑 `audit:perf` 对比基线定位最大可砍项；② 审计 `@mui/icons/material` 是否有 barrel import；③ 评估首屏 MUI 组件的具名 import 完整性。

#### P2 · 性能探针只报告不卡门 —— **P3 · 影响低**

- **描述**：`perf-audit` 结果不进 CI 门禁（2026-10 的有意决策）。劣化不会被自动发现。
- **建议**：给 LCP 设一个宽硬预算（如 ≤8.5s）进 CI，FCP 继续只报告。收益：防无声劣化，几乎无误报成本。

---

## 3. 架构设计评估

### 3.1 做得好的

- **三端结构清晰**：`worker/`（Cloudflare Fetch handler + 路由层）· `server/`（Node http 桥：请求转 Fetch + cron + 升级 helper）· `shared/`（两端共用的零依赖事实源：SPA 路由表）；
- **API 分层**：`methods/`（15 个领域）× `http.ts`（门面）× `mock.ts`（替身）× `clientMethods/`（传输），配置分类（加密/私有/外观/敏感）收敛在 `configGuards.ts` 单一事实源；
- **行为对齐有守卫**：双部署的 SPA fallback、安全头（`_headers` 两端同解析）、JSON 守卫都有测试盯着，注释里记录了真实的踩坑（1101、immutable headers、undici body 复用）；
- **知识管理**：CHANGELOG 4,887 行按天归档 + docs/ 35 份专题 + 代码注释大量「为什么」；
- **测试体系**：3,099 条用例、96 个 DOM 测试（真实交互级别）、视觉回归基线、覆盖率体检机制。

### 3.2 问题与建议

#### A1 · 顽固大文件（拆分两轮后仍有 3 个 2000+ 行）—— **P2 · 影响中**

- **描述**：`NotesPage.tsx` 3,300 行 · `NotesSettingsDialog.tsx` 2,372 行 · `App.tsx` 2,342 行。前两轮已从这几位身上拆掉 5,000+ 行（NotesPage 拆过两批、App 拆出账号/配置/站点 hooks），但剩余体量仍超出单人舒适レビュー尺寸。App.tsx 有 bundleBudget 守卫禁止静态 import `useNotes`（防记事本焊回首屏），但本体的 2,342 行里仍有可抽的编排段。
- **影响**：认知负荷与 review 成本；改动冲突面大。
- **优先级**：P2（按需推进，不阻塞）。
- **预期收益**：单文件回落到 1,500 行以内；后续功能改动定位更快。
- **建议做法**：`NotesSettingsDialog` 按设置 tab 拆（外观/编辑器/备份各自独立文件）；App.tsx 把 render 段按区域抽组件（侧栏 / 顶栏 / 浮层宿主已部分存在）。

#### A2 · 三端同步的结构性成本 —— **P3 · 影响低**

- **描述**：每个 API 方法要 worker/methods + mock + clientMethods 三处实现，靠形状守卫与 e2e 矩阵对齐（见 S3 的行为层缺口）。
- **建议**：与 S3 合并处理；或评估 mock 从「手写替身」转为「真实 methods + 内存 D1」的复用度（改动大，仅记录）。

#### A3 · server/entry.ts 职责偏多 —— **P3 · 影响低**

- **描述**：1,126 行内混排 http 代理、cron 定时、docker endpoint（网页升级 helper）、_headers 解析。功能稳定（升级 helper 踩坑都已修），但单一文件承载四种职责。
- **建议**：暂不动；若再改升级链路，顺手把 docker endpoint 段抽出。

---

## 4. 功能完整性评估

### 4.1 功能矩阵（实证清点，全部实装）

| 域 | 功能 |
|---|---|
| 导航核心 | 站点 CRUD / 分组 / 标签 / 星标 / 拼音搜索 / 命令面板 / 排序 / 批量操作 / 回收站 |
| 数据 | 导入导出（合并/覆盖）/ 书签导入 / 图标代理与批量接口 / 附件管理 |
| 分享 | 笔记分享（口令/令牌只读）/ 分组分享 / 浏览次数防刷 / SPA 公开页 |
| 备份 | 本地下载（可选口令加密）/ WebDAV 上传 / 每周 cron 自动备份 / 恢复预览（字段级差异）/ 备份完整性校验 |
| 账号 | 多账号 / 邀请码 / 角色（owner/user）/ 会话管理（设备列表/踢下线）/ 沉睡治理 / 恢复密钥 / 首登改密 |
| 记事本 | 文件夹/标签 / Markdown 编辑器（CodeMirror）/ 双链与反链 / 图谱（cytoscape）/ 版本历史 / 附件 / 待办聚合 / 全文检索（FTS5） |
| AI | AI 助手 / AI 补全 / 连接测试 / 双 provider（Workers AI / OpenAI 兼容） |
| 平台 | 离线 mutation 队列 / Service Worker / PWA / 浏览器扩展（一键存站）/ 统计看板 / 审计日志 |

### 4.2 问题与建议

#### F1 · 密码管理器扩展集成长期挂账 —— **P2 · 影响低（增强项）**

- **描述**：任务 #88「密码管理器扩展」自 2026-10-21 起 pending；范围文档已完备（`docs/password-manager-scope.md` / `plan-B.md` / `analysis`），属「设计完毕未实施」。
- **建议**：确认是否仍要做——若做，按既有范围文档进入增量开发；若不做，关掉任务避免清单噪声。

#### F2 · 无前端路由框架，深链能力受限 —— **P3 · 影响低**

- **描述**：刻意不用 react-router（URL 只有 `/`、`/s/<token>`、`/sg/<token>` 三条，未知路径 404 是 P2-8 的主动收紧）。副作用：分享页无法深链到「某篇笔记的某一节」。
- **建议**：产品取舍，记录即可；如未来需要，锚点（`#标题`）已在编辑器中支持，可在公开页复用。

#### F3 · 站点↔笔记「显式一对一」后的老数据无回填 —— **P3 · 影响低**

- **描述**：绑定策略 2026-10-23 起改为显式一对一（删了「正文提到站名就算相关」），符合用户既定策略；存量数据的关联不会自动重建。
- **建议**：符合预期，仅记录。

---

## 5. 视觉呈现评估

### 5.1 做得好的（实证确认）

- **语义色 0 处写死**：全站颜色走 MUI 主题 token / CSS 变量；74 处 hex 全部是合理形态——标签色板（`EditGroupDialog` 预设色）、品牌定义（`brand.ts`）、`var(--token, #fallback)` 兜底；
- 弹窗材质单一真源（`dialogPaperTokens`）；关闭出口/命名/尺寸统一（2026-10-23 全站整改）；
- a11y 审计 0 项不合格、对比度亮/暗双态 0 处不合格（均有 CI 化守卫）；
- 视觉回归基线进 CI；移动端 11 个媒体查询 + 底部面板体系。

### 5.2 问题与建议

#### V1 · 视觉回归「基线缺失即静默录制并通过」—— **P2 · 影响中低**

- **描述**（已实证）：`script/visual-regression.mjs` 在 `!fs.existsSync(file)` 时**直接新建基线并记为通过**（`status: "新建基线"`）。后果：新增组件/新场景第一次跑就自动录基线，CI 全绿——该场景此后再改版，比对的是「改版后自己录的基线」，回归检测静默失效。新建的 baseline JSON 虽会进 git（`tests/visual-baseline/`）留下 diff，但不看 diff 就发现不了。
- **影响**：回归网有效性取决于纪律。
- **优先级**：P2。
- **预期收益**：回归网真正生效。
- **建议做法**：改为「基线缺失 → 明确失败并提示 `--update-baseline` 录基线」；CI 中单独跑一次 `--update-baseline` 由人工触发并 review diff。

#### V2 · CSS 覆盖层的隐性规则未入 style-guide —— **P3 · 影响低**

- **描述**（已实证）：`index.css` 1,460 行含 MUI 覆盖层，「选择器必须带前缀 (0,2,0) 否则输给 emotion 运行时注入」这条关键规则（曾造成「小屏底部面板静默失效一年」）**未收录**在 `docs/style-guide-2026-10-21.md`（该文档只有 80 行，提到 `html.dark` 前缀但无特异性规则），目前仅活在代码注释与工作记忆里。
- **建议**：将该规则补入 style-guide，并在 CI 加一条静态检查（覆盖层选择器无前缀即红）。

#### V3 · 新弹窗用不用公共件靠 review —— **P3 · 影响低**

- **描述**：`DialogCloseButton` / `DialogListRow` / `DialogEmptyState` 已统一，但 48 个 Dialog 文件里新弹窗是否用公共件没有自动检查。
- **建议**：抽一个轻量 lint 规则或组件模板（`npm run check:whitedot` 式的专项守卫先例已在）。

---

## 6. 高优先级行动项汇总

| # | 行动项 | 维度 | 优先级 | 预估工作量 | 预期收益 |
|---|---|---|---|---|---|
| 1 | 19 处写接口换用 `readJsonBody`/`readJsonValue` + 守卫覆盖静态扫描测试 | 安全 | **P1** | 0.5 天 | 输入语义统一，消除规则漂移 |
| 2 | 自托管 Node 侧出站前 DNS 解析 IP 校验（SSRF 闭环） | 安全 | P2 | 0.5 天 | 双端 SSRF 防护对齐 |
| 3 | 首屏性能：MUI 闭包审计 + 小 chunk 合并，FCP 5.1s → 4s 级 | 速度 | P2 | 1-2 天 | 弱网首屏体感 |
| 4 | NotesSettingsDialog / App.tsx 继续拆分（单文件 <1,500 行） | 架构 | P2 | 按需 | 可维护性 |
| 5 | 视觉回归「基线缺失即失败」+ style-guide 收录 CSS 前缀规则 | 视觉 | P2 | 0.5 天 | 质量网有效性 |
| 6 | mock 导入导出接入 backupScope（演示模式行为对齐） | 安全/架构 | P3 | 0.5 天 | 契约从形状深入到行为 |
| 7 | LCP 宽硬预算进 CI | 速度 | P3 | 0.5 小时 | 防无声劣化 |
| 8 | 密码管理器扩展：做（按既有范围文档）或关账 | 功能 | P2（决策） | — | 清理长期挂账 |

**建议执行顺序**：1 → 2 → 5 → 3 → 4（安全收口优先，体验与结构按需）；6/7 顺手做；8 是需要用户决策的事项。

---

## 7. 持续审查的关键位置（审计地图）

后续任何一轮复查，从这些位置入手效率最高：

| 关注点 | 位置 |
|---|---|
| 请求体守卫覆盖 | `worker/routes/jsonBody.ts` + S1 列出的 19 处绕过点 |
| 出站安全 | `worker/safeFetch.ts` · `worker/util.ts`（`isBlockedHost` / `normalizeIpLiteral`）· `worker/icon.ts` |
| 配置分类单一事实源 | `src/API/configGuards.ts`（加密/私有/外观/敏感四类判定） |
| 备份范围 | `src/utils/backupScope.ts` · `src/API/methods/transfer.ts`（exportData/importData） |
| 索引与迁移 | `src/API/methods/internals.ts`（20+ 复合索引 + SCHEMA_VERSION） |
| 首屏预算 | `tests/bundleBudget.test.ts` · `vite.config.ts`（`scanFirstScreenMui` 闭包扫描） |
| 性能探针 | `script/perf-audit.mjs` · `script/ci-smoke.mjs` |
| 视觉回归 | `.github/workflows/visual-regression.yml` · `script/visual-regression.mjs` |
| 三端对齐 | `src/API/mock.ts` vs `src/API/methods/*` vs `src/API/clientMethods/*` |
| 文档真相 | `CHANGELOG.md`（按天）· `docs/pitfalls.md`（踩坑集） |

---

*评估方法说明：本报告全部结论来自对代码库的实测（构建产物测量、审计工具运行、源码走查与 grep 实证），历史 memory 仅作背景参考，未作为判定依据。*
