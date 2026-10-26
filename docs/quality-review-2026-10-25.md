# 全站质量评估报告（2026-10-25）

> 范围：视觉呈现 / 功能完整性 / 架构设计 / 安全性 / 运行速度
> 方法：4 个只读审计方向并行（视觉、安全、架构、性能）+ 主线复核 3 条关键结论（其中 1 条被推翻）
> 规模基线：865 个 git 文件；`src/` 82.6k 行、`worker/` 9.7k 行、`tests/` 70.3k 行
> 说明：本报告不含任何真实凭据原文，涉及凭据处只给 sha256 前 8 位与长度。

---

## 0. 总体判断

**这是一个工程质量明显高于同类个人项目的代码库**：`any` 计数为 0、strict 全开、16 道 CI 检查、
3234 条单测、CSP 带 `require-trusted-types-for 'script'`、SQL 全参数绑定、SSRF 防护有手动重定向与私网复核、
0 处 `innerHTML`、0 个 `TODO/FIXME`。**真正的问题不在"有没有做"，而在三处**：

1. **状态机缺边界**（加载 / 保存失败 / 触屏）——功能都在，但特定条件下会「说错话」或「入口消失」；
2. **双实现 + 双部署的漂移面**——同一件事有两份代码/两张表/两套常量，改一处忘一处不会编译报错；
3. **性能瓶颈集中在"每键入"与"每张卡片"两个高频路径**，且已有现成开关（`nav-lite` / `computeWindow`）没用上。

风险排序：**数据静默丢失 > 发布绕过测试 > 协议常量漂移 > 交互性能**。

---

## 1. 视觉呈现

| # | 位置 | 问题 | 影响 | 优先级 | 预期收益 |
|---|---|---|---|---|---|
| V1 | `notes/NotesListPane.tsx:676` | 行尾「⋯」只在 `:hover` / `:has(:focus-visible)` 出现，缺 `@media (hover:none)` 兜底（左栏 `sidebarSection.tsx:544` 有） | **高**：触屏上改名/置顶/删除入口整体消失，功能不可达 | **P1** | 补 3 行，手机端恢复全部行操作 |
| V2 | `notes/NotesListPane.tsx:402` | 只有「有数据 / 空」两态，`useNotesData` 无 loading 标志 | **高**：慢网首屏先显示「还没有笔记」，数据到了整列刷出 | **P1** | 3~5 行骨架，消除「错误事实」与整列跳变 |
| V3 | `EmptyArt.tsx:170` | 空态说明 12px + `text.disabled`（≈2.85:1） | **高**：空页唯一引导文字不达 AA | **P1** | 换 `text.secondary`（≥4.6:1） |
| V4 | `SiteCard.tsx:787` | 卡片外层 div `tabIndex=0` 且无 `role`，内层 `CardActionArea` 又是停靠点 | 高：每卡 Tab 两次，第一次不播报 | P2 | 去掉外层 tabIndex，键盘每卡一次且可念 |
| V5 | `NoteGraphDialog.tsx:250` | **paper 写死 `borderRadius: isNarrow ? 0 : 3`**（3×14=42px），绕开 `--card-radius`（默认 22px） | 中：切「标准/锐利」档时它纹丝不动 | P2 | 走 `dialogPaperTokens`，同批弹窗一个材质 |
| V6 | `dialogShell.ts:44` / `CommandPalette.tsx:142` | 命令面板纸面写死 `18px` + `blur(18px)`，输入框 `14px`，里外不同源 | 中：换圆角档后「外圆内方」 | P2 | 圆角由 `--card-radius` 派生 |
| V7 | `SiteCard.tsx:759` vs `NotesListPane.tsx:623/638` | 导航卡 hover = 抬 6px + 双层阴影 + 图标放大 + 标题染色；笔记「卡片」只有 `--shadow-chip` + 换底色 | 中：两页来回切能看出不是一个产品 | P2 | 笔记卡片最厚那层统一 `--glass-shadow` |
| V8 | `SiteCardText.tsx:48` | 卡片标题写 rem，不吃字号档位（`index.css:822` 的 94%/107%）；笔记标题走 `--notes-font-scale` 会动 | 中：调「大字号」后两页不同步 | P2 | 标题乘 `--font-scale` |
| V9 | `index.html:119` | 启动骨架圆角 12px、真实卡片 22px，挂载瞬间整屏「圆角张开」；骨架配色只认 `prefers-color-scheme`，不认已存 light/dark | 中：首帧到首屏可见跳变 | P2 | 骨架用同一份 token，首帧零跳变 |
| V10 | `AddSiteDialog.tsx:87` 等 | 33 个弹窗仅 12 个用 `DialogCloseButton`，其余手写 ×（位置差约 40px、多数无 Tooltip） | 低：× 落点不固定 | P2 | 全部换共用组件 |
| V11 | `SiteCard.tsx:724` / `BacklinksPanel.tsx:87` | 复制账密按钮 26×26、反链收起按钮 22×22（WCAG 2.5.8 下限 24） | 中：误触 / 点不到 | P2 | `::after` 扩到 44px |

**视觉结论**：导航页与笔记页的 token 体系已经打通（圆角/字号/遮罩/顶栏），剩余不一致集中在
**弹窗的内部细节**与**两页"卡片"这个词的两套物理形态**。上表 P1 三条都不是审美问题，是可用性缺陷。

---

## 2. 功能完整性

| # | 位置 | 问题 | 影响 | 优先级 | 预期收益 |
|---|---|---|---|---|---|
| F1 | `notes/useNoteAutoSave.ts:74` | 保存失败只把状态退回 `pending` 静默重试，界面无错误态 | **高**：用户以为已保存，关掉即丢内容 | **P0** | 失败即时提示 + 常显「未保存」，防静默丢失 |
| F2 | `notes/NotesListPane.tsx:402` | 同 V2：把「在加载」说成「没有」 | 高 | P1 | 见 V2 |
| F3 | `src/API/methods/notes/notesNote.ts:96` | `listNotes` 无 `LIMIT`/分页；`?fields=list` 摘要阀门默认不开（`data.ts:620` 注释自陈） | 中：200 条以上列表字节线性涨 | P1 | 默认开 `fields=list`，列表字节 -60~80% |
| F4 | `AttachmentPreviewDialog.tsx:414` | `<img>` 无宽高占位，解码完成时弹窗高度从 0 跳到 60vh | 中：每次打开都抖一下（CLS） | P2 | 固定比例占位 |

**完整性结论**：`TODO/FIXME` 为 0，README 的 16 节功能与实际实现一致，测试 70.3k 行覆盖到
「源码静态守卫」层级。**缺口不在功能数量，而在"功能存在但边界没兜住"**：加载态、保存失败态、
触屏可达性三类。这三类恰恰是自动化测试最不容易覆盖的（jsdom 没有 hover 语义、没有真实网络抖动）。

---

## 3. 架构设计

| # | 位置 | 问题 | 影响 | 优先级 | 预期收益 |
|---|---|---|---|---|---|
| A1 | `.github/workflows/deploy.yml:45` | 只有 `npx wrangler deploy`，无 `needs:`/`workflow_run`，不跑任何测试 | **高**：手动部署可发布 CI 红的 commit | **P0** | 改为 `workflow_run: CI completed` 后才允许部署 |
| A2 | `src/API/methods/migration.ts:81` | 全局单一 `SCHEMA_VERSION="26"`，版本相等直接 return；加补列忘 +1 就永久跳过（`noteFolderTagRealSql.test.ts:296` 记过真实事故） | **高**：只在生产暴露的数据事故类型 | **P0** | 每步带 `stepId` + 已跑集合，可重入 |
| A3 | `src/API/transport.ts:64` vs `worker/httpUtils.ts:14` | `SESSION_COOKIE` 双份定义；`Idempotency-Key` 在 `client.ts:115` 硬编码 vs `worker/idempotency.ts:25` 常量 | 中：改一处 = 全站静默掉线 / 重复写入 | P1 | 协议常量收敛到 `shared/` |
| A4 | `API 响应` (`client.ts:152`) | `response.json() as T`，全仓 0 处运行时校验（zod 只在 overrides） | 高：双端字段漂移时运行时才炸，炸点离原因很远 | P1 | 5 个高频响应加运行时 schema |
| A5 | `worker/` 35 处 `import "../src/…"` | 事实上的共享内核放在叫「前端」的目录里 | 中：新人会往 src 里塞服务端逻辑 | P2 | 迁到 `shared/core/` |
| A6 | `tests/` 67/327 文件做源码静态守卫（209 处） | 20% 测试在读源码字符串，重构必须同步改守卫 | 中：重构变贵的第一来源 | P1 | 分「结构性 / 文案性」两层，文案类改快照 |
| A7 | `worker/types.ts` vs `src/API/schema.ts` | D1/Env 类型双份声明（注释自认副本） | 低：好在不同步是编译错 | P2 | 合并 |
| A8 | `worker/rateLimit.ts:40` | `windows.size > maxKeys` 直接 `clear()`，2000 个 key 即清空全部计数 | 中：限速可被重置 | P1 | 改 LRU |
| A9 | `dist/client` 无 sourcemap | 线上崩溃栈只有压行列号 | 中：故障定位成本 | P2 | 开 hidden sourcemap |
| A10 | `CHANGELOG.md` 5247 行 / 548KB / 206 条 | 单日最多 14 条并列，已不适合当发布说明 | 低：可读性 | P2 | 按天合并 + 明细移 `docs/changelog/` |

**架构结论**：分层是清晰的（`src/` 对 `worker`/`server` 零 import、worker 不引 React、产物里搜不到 SQL），
**主要债务是"同一件事有两份实现"**：schema 版本号、会话 cookie、幂等头、D1 三份语义
（`server/sqlite-d1.ts` 真事务 / `tests/helpers/realSqliteD1.ts` 用 Promise.all / D1 本体）。
其中测试替身 batch 非事务最隐蔽——「删站点 + 写回收站 + 写墓碑」的半提交在 CI 里永远绿。

---

## 4. 安全性

> **前提修正（主线复核）**：审计初稿把「历史明文密钥」判为可直接伪造当前会话。
> 实测结论**相反**：线上 `.env` 三个凭据与历史提交里的**均不相同**（已轮换），
> 因此「用旧 secret 伪造 owner 令牌 / 用旧密码登录」不成立。真实风险降级为下面 S1。

| # | 位置 | 问题 | 影响 | 优先级 | 预期收益 |
|---|---|---|---|---|---|
| S1 | git 历史 `a0e9846` / `6f944c5` 的 `wrangler.jsonc` | 公开仓库历史含 `AUTH_USERNAME/PASSWORD/SECRET` 明文；`a0e9846` 的密码 22 位、secret 33 位（指纹 78cb728d / 79ef599b），仓库有 1 个 fork | 高：旧密码若在别处复用即失效；历史无法撤回 | **P0** | `git filter-repo` 清史 + force push；确认旧值未在他处复用 |
| S2 | `src/API/crypto.ts:94` | `typeof exp === "number" && exp < now` —— **缺 exp 的令牌被判有效**（永不过期） | 高：任一签发路径漏 exp 就是永久令牌 | **P0** | 要求 exp 必须为 number，否则 invalid |
| S3 | `server/entry.ts:198-201` + `worker/loginGuard.ts:49` | 自托管信任客户端可伪造的 `CF-Connecting-IP`/`CF-Visitor` | 高：限速分桶可绕过、cookie `Secure` 可降级 | P1 | 仅在明确反代后信任，否则取 socket 地址 |
| S4 | `src/API/methods/accounts.ts:630` vs `:852` | 注册要求 ≥6 位，改密只 `if (password)` —— 可设 1 位或等于账号名 | 中：弱口令 | P1 | 改密复用同一策略；密码校验接口独立限速（5 次/10 分钟） |
| S5 | `worker/rateLimit.ts:35-49` | 计数在 isolate 内存，冷启动/新实例归零（登录/写入已走 D1 CAS，AI/图标/上报没有） | 中：AI 成本防护在多实例下失效 | P1 | 关键端点改 D1/KV；加账号级日配额 |
| S6 | `src/API/navigationApi.ts:190` | `AUTH_ENABLED=false` 时用硬编码串当加密密钥 | 中：该模式下站点密码「加密」人人可解 | P1 | 该模式不落密文或强制要求密钥 |
| S7 | `src/API/navigationApi.ts:199` | `AUTH_SECRET` 兼作数据加密密钥 —— 轮换签名钥会让旧密文全解不开 | 中：S1 的修复被这条卡住 | P1 | 拆出 `DATA_ENCRYPTION_KEY` 并做一次重加密迁移 |
| S8 | `server/entry.ts:87-89` | DNS 复核异常时 `return true`（fail-open） | 中：SSRF 防线在异常路径失效 | P2 | 改 fail-closed |
| S9 | `worker/util.ts:198-233` | 私网黑名单不认非规范 IPv6（`::ffff:7f00:1` 等） | 中：靠平台 egress 兜底 | P2 | 先规范化 IP 再判定 |
| S10 | `src/API/methods/notes/notesAttachment.ts:99` | 公开取图 JOIN 未带 `a.user_id = s.user_id`，靠 note_id 全局唯一兜底 | 低 | P2 | 补条件 |
| S11 | `public/_headers:30` | `img-src https:` / `connect-src https:` 过宽 | 低：有注入点即可外带 | P2 | 收敛白名单 |
| S12 | `noteHtmlExport.ts:139` | 打印 iframe 无 `sandbox`，blob 与页面同源 | 低 | P2 | `sandbox=""` |

**✅ 已达标（不必再投入）**：SQL 全参数绑定 + ORDER BY 白名单；0 处 `innerHTML`；
CSP `script-src 'self'` + `require-trusted-types-for 'script'`；PBKDF2 60 万/10 万 + 16B 盐 + 常数时间比较；
附件按文件头嗅探 + 拒 SVG/HTML + 25MB 上限；SSRF 每跳校验 + 手动重定向 + 剥跨源凭据；
`.env`/`data/` 未跟踪；错误响应不泄露堆栈。

---

## 5. 运行速度

| # | 位置 | 现象（证据） | 影响 | 优先级 | 预期收益 |
|---|---|---|---|---|---|
| P1 | `NotesPage.tsx:2389/2607` + `NoteEditor.tsx:563` | CodeMirror `updateListener` 每次 docChanged 就 `doc.toString()` + `setDraft`；`paneCtx` 每渲染新建对象；`NotesListPane` **0 个 useMemo/useCallback 且未 memo** → 每键入 1 次 = 6 个面板 + 全部可见行 reconcile | **高** | **P1** | 200 条笔记下每键入 -150~400ms，掉帧消失 |
| P2 | `hooks/useNotes.ts:380-388` | 打开记事本 5 个请求、**3 个串行 RTT**（count→notes；folders→tags→noteTags） | **高** | **P1** | 1~3s/RTT 链路上省 2~6s；请求 5→2 |
| P3 | `server/static.ts:191-205` | 自托管静态**不压缩**：`dist/client/assets` 0 个 `.gz/.br`，全靠反代 `gzip on`；无反代时 874.2 KB 裸传 | **高** | **P1** | 首屏字节 -67%（874→287 KB） |
| P4 | `SiteCard.tsx:748-757` | 每张卡 `backdropFilter: blur(14px) saturate(1.4)`；JS 侧 23 处 + CSS 侧 12 处 | **高** | **P1** | 集显滚动 +15~30fps；`nav-lite` 开关已存在 |
| P5 | `notes/notesBackup.ts:92` | `SELECT COUNT(*) … WHERE updated_at >= ?` 无 `(user_id, updated_at)` 索引（每 2 分钟一次全扫）；每轮回全量 `noteTags` | 高 | **P1** | 加 1 个索引：全扫→区间，5000 条时省读配额 |
| P6 | `NotesOverlay.tsx:18` | 静态 import NotesPage → 打开记事本一次拉 `note-editor` 551KB（CodeMirror 全家） | 中 | P2 | 编辑态才下，首次可读内容提前约 1 RTT |
| P7 | `MermaidNode.tsx:33` | **每张图一个 iframe**，各自跑 mermaid 核心 + elk(1.4MB)/cytoscape(424KB)；源码每变一次整轮重渲 | 中 | P2 | 10 图笔记内存 -80% |
| P8 | `methods/data.ts:51-60` | 每站点两个**完全相同**的相关子查询（note_id/note_title 各带 ORDER BY LIMIT 1） | 中 | P2 | 200 站点 -200 次探测 |
| P9 | `tests/bundleBudget.test.ts` | 首屏 874.2KB/286.6KB，`mui-core` 单块 328.8KB 占 37.6% | 中 | P2 | 源码闭包扫描排除非首屏 MUI，-40~60KB gz |
| P10 | `index.css` / `SiteCard.tsx:562` / `App.tsx:1698` | `transition: all` 三处（含根节点），主题切换把 blur/shadow 一起补间 | 中 | P2 | 改枚举属性，主题切换 -200~400ms |
| P11 | `public/sw.js:12-19` | core 预缓存含 `katex-*.css`（29.8KB），不读数学也要装 | 低 | P2 | 安装期 -1 请求/-29.8KB |

**性能结论**：字节优化已经做得不错（分包、按需、骨架内联），**剩下的瓶颈是"每键入"和"每张卡"两个高频路径**，
以及一个纯运维缺口（自托管不压缩）。前者是体感"打字发涩"，后者是一行响应头换 67% 字节。

---

## 6. 高优先级行动项

### P0（先做，有真实损失风险）
1. **F1 自动保存失败要说话**（`useNoteAutoSave.ts:74`）——唯一会静默丢用户内容的地方，且丢的时候界面一切正常。
2. **A1 部署链路加测试门禁**（`deploy.yml`）——发布是唯一能把事故送上线的高速路，现在它只检查"能编译"。
3. **A2 迁移版本号改成逐步 stepId**（`migration.ts:81`）——已经发生过一次的数据事故类型，只在生产暴露。
4. **S1 清理 git 历史里的旧凭据**（公开仓库 + 1 fork）→ 顺序：先做 S7（拆 `DATA_ENCRYPTION_KEY` 并重加密）
   再换 `AUTH_SECRET`，最后 `filter-repo` + force push；同时确认旧密码未在他处复用。
5. **S2 让 `exp` 成为必需声明**（`crypto.ts:94`）——一行改动，关掉"永不过期令牌"后门。

### P1（体验与稳定，一轮可做完）
6. 触屏行操作入口（V1）+ 列表加载态（V2）+ 空态对比度（V3）——三条都是"用户第一眼就撞上"的。
7. 记事本打开改并发（P2：5 请求/3 串行 → 2 请求/1 RTT）。
8. 每键入重渲染（P1：`paneCtx` 稳定化 + `NoteRow` memo + draft 合并 150ms）。
9. 自托管 gzip（P3）+ 卡片密度 blur（P4，走现成 `nav-lite`）+ `(user_id, updated_at)` 索引（P5）。
10. API 响应运行时校验（A4）+ 协议常量收敛 `shared/`（A3）+ 限速 `clear()` 改 LRU（A8）。

### P2（打磨与稳态）
弹窗内部细节（V5/V6/V10）、两页"卡片"形态统一（V7）、字号档位覆盖标题（V8）、
记事本按需加载 CodeMirror（P6）、mermaid iframe 池（P7）、sourcemap（A9）、
静态守卫分层（A6）、CHANGELOG 整理（A10）。

---

## 附：本报告的复核记录

- 安全初稿结论「可用历史 secret 伪造 owner 令牌」→ **推翻**：线上 `.env` 三值与历史均不同（已轮换）。
- `NoteGraphDialog.tsx:250` 写死圆角 → **证实**，且说明现有守卫 `dialogConsistency.test.ts` 有漏洞：
  正则只匹配数字/px 字面量，`isNarrow ? 0 : 3` 这类三元表达式绕过了检查（值得补一条）。
- `deploy.yml` 无测试门禁 → **证实**（仅 `npx wrangler deploy`）。
- `crypto.ts:94` 缺 exp 判有效 → **证实**（`typeof exp === "number" && exp < now`）。
- 功能完整性由主线补充：`TODO/FIXME` = 0，缺口在状态机边界而非功能数量。
