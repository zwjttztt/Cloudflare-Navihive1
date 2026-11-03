# docs 索引

`docs/` 下所有 markdown 的**唯一索引**。这里只做一件事：**让你在三秒内找到该读的那一份**。

文件按「现在还算不算数」分成三层，别跨层引用当现状：

- **§1 长期文档** —— 跟着代码一起维护，改了代码就要来看它；
- **§2 已是历史但没归档** —— 没有日期后缀，读起来像说明书，结论却已被取代；
- **§3 历史报告（`docs/archive/`）** —— 一次性快照。**别把历史报告当现状**，它们的价值是「当时为什么这么想」；
- **§4 运维手册** —— 在 `deploy/` 下，出事时才翻，但请先读一遍（形态不同别混读）。

> 这个索引本身有守卫：`tests/docsIndex.test.ts` 断言 `docs/**/*.md`（含 `archive/`）**每一份都出现在本文件里**，
> 并断言本文件、根 `README.md`、`SECURITY.md`、`CONTRIBUTING.md` 里的相对 `.md` 链接**全部指向真实存在的文件**。
> 漏登记一份、或挪了文件没改链接，`npm test` 直接红 —— 在此之前这两件事都没有任何东西会报错
> （本文件的三张表就曾经同时漏掉 `api.md` / `architecture.md` / `codes.md` 这三份最该被读的）。

---

## 0. 三秒导航

| 你想干什么 | 读这份 |
|---|---|
| 跑起来、改代码、提 PR | [`contributing.md`](contributing.md) → 根 [`README.md`](../README.md) |
| 查某个 API 端点 / 它的坑 | [`api.md`](api.md) |
| 搞清目录职责、请求时序、数据层、分包 | [`architecture.md`](architecture.md) |
| 查错误码 / 代码里的内部代号 | [`codes.md`](codes.md) |
| **动手改之前** | [`pitfalls.md`](pitfalls.md)（每条都是线上真出过的事） |
| 样式该写在哪、状态存在哪 | [`style-guide.md`](style-guide.md) · [`state-map.md`](state-map.md) |
| 部署 / 升级 / 回滚 / 备份 | [`../deploy/selfhost.md`](../deploy/selfhost.md) → [`deploy/release.md`](deploy/release.md) |
| 查某次审计说了什么 | §3（归档表） |

---

## 1. 长期文档（跟着代码维护，优先读）

| 文档 | 一句话 |
|---|---|
| [`contributing.md`](contributing.md) | 开发入门、端点注册、测试与提交检查清单 |
| [`api.md`](api.md) | 全站 API 端点表，含鉴权级别与每条的坑（路由顺序、批量上限等） |
| [`architecture.md`](architecture.md) | 目录职责、请求时序、数据层（表结构与索引的权威位置）、前端分层、构建分包、部署升级 |
| [`codes.md`](codes.md) | 内部错误码 / 代号索引，含「本条目代码中未使用」这类负向记录 |
| [`pitfalls.md`](pitfalls.md) | 改这个项目前先读。每条都是线上真出过的事，按「症状 → 根因 → 现在怎么防」写 |
| [`style-guide.md`](style-guide.md) | 样式该写哪儿：`index.css` / `sx` / theme / `App.css` 四处的边界与特异性规则 |
| [`state-map.md`](state-map.md) | 某个状态存在哪、谁写、谁读、会不会同步到服务端。（随状态结构变更同步维护） |
| [`notebook-design.md`](notebook-design.md) | 记事本的设计定稿：数据模型、双链、渲染层与 CSP 的冲突取舍 |
| [`dependency-upgrade-assessment.md`](dependency-upgrade-assessment.md) | 大版本依赖升级的实测结论（不是「看版本号猜」那套） |
| [`dual-deploy-arch-2026-10-14.md`](dual-deploy-arch-2026-10-14.md) | 双部署（Cloudflare + VPS）的架构前提与代价，解释为什么会有两条发布路径。架构决策记录：日期是决策日，不是过期日 |
| [`mobile-touch-audit-2026-11-02.md`](mobile-touch-audit-2026-11-02.md) | **当前有效的移动端触控规范**：24×24 / 44×44 分档理由、双视口 0 违规结论、fail-closed 闸门。`script/a11y-audit.mjs` 的分档就是照它实现的 —— 改档位先改这份 |

> `style-guide.md` / `state-map.md` 原来叫 `style-guide-2026-10-21.md` / `state-map-2026-10-21.md` ——
> 它们是长期文档，日期后缀是误加的，已去掉。`mobile-touch-audit-2026-11-02.md` 保留日期后缀的唯一原因是
> `src/index.css` 与 `script/a11y-audit.mjs` 的注释按这个名字引用它，改名的收益不值那份 grep 噪音。

---

## 2. 已是历史、但还没归档的（无日期后缀，容易被误当现状）

这几份没有日期，读起来像「说明书」，但结论已被后续方案取代。**照做会出错**：

| 文档 | 状态 | 一句话 |
|---|---|---|
| [`notes-inkstone-plan.md`](notes-inkstone-plan.md) | `已落地` | 记事本对标 inkstone 的改造方案（当时含真实 Chrome 实测）—— 方案本身做完了，留着当决策记录 |
| [`password-manager-scope.md`](password-manager-scope.md) | `仅历史` | 密码管理器范围文档（三档方案，用来拍板）；拍板结果见 `password-manager-plan-B.md` |
| [`password-manager-plan-B.md`](password-manager-plan-B.md) | `部分落地` | 方案 B：独立保险库 + 端到端加密的详细设计（库与解锁已实现，恢复码流程未完成） |
| [`password-manager-options-overview.md`](password-manager-options-overview.md) | `仅历史` | 上面三份（含已归档的深度分析）的合并速览 |
| [`optimization-analysis.md`](optimization-analysis.md) | `仅历史` | 2026-09-27 的优化点分析。快照式，里面的行数与体积数据已全部过期 |

---

## 3. 历史报告（`docs/archive/`，只写结论与状态）

状态标记：`已落地` = 报告里的建议已经进了代码；`部分落地` = 做了一部分；
`已废弃` = 结论已被后续方案取代，**照做会出错**；`仅历史` = 只是一次快照/评估，
不代表现在，也不建议照着做。

### 3.1 仍在 `docs/` 顶层的一次性快照（3 份，因为 `src/**` 注释按原路径引用它们）

| 文档 | 结论 / 状态 |
|---|---|
| [`site-audit-2026-10-15.md`](site-audit-2026-10-15.md) | 自托管主站生产实测（功能/稳定/速度/交互/逻辑） · `仅历史`。`src/App.tsx`、`AriaLiveRegion`、`SiteCard`、`SnackbarHost` 的注释直接引用它，挪走会让注释里的路径失效 |
| [`dialogs-audit-2026-10-16.md`](dialogs-audit-2026-10-16.md) | 弹窗排查，P1/P2/P3 当日修复并三档复测 · `已落地`。约 10 处 `src/components/**` 注释按「P2-1 / P3-3」引用它 |
| [`dialogs-audit-2026-10-23.md`](dialogs-audit-2026-10-23.md) | 全站弹窗排查与整改计划，**当轮只出报告不改代码** · `仅历史`。`ConfirmDialog`、`SiteSettingsModal` 等注释按「A2 / G3」引用它 |

> 这三份要进 `archive/` 的前提是同时改掉 `src/**` 里的注释路径 —— 那是代码改动，不属于文档整理。
> **新写的代码注释请引用 §1 的长期文档，或 `archive/` 里的完整路径**，别再加新的顶层快照。
>
> 顶层另外还有两份带日期的文件，但它们**不是快照**、已在 §1：`dual-deploy-arch-2026-10-14.md`
> （架构决策记录，日期是决策日不是过期日）与 `mobile-touch-audit-2026-11-02.md`（当前有效的移动端触控规范）。
> 于是 `docs/` 顶层带日期的一共 5 份 = 本节 3 份 + §1 那 2 份，其余 27 份都在 `archive/`。

### 3.2 `docs/archive/` 归档表（2026-10-04 ~ 2026-10-28 的一次性结论）

| 文档 | 结论 / 状态 |
|---|---|
| [`archive/engineering-review-2026-10-28.md`](archive/engineering-review-2026-10-28.md) | 工程健康度复审，列出静默出错点与 P0/P1 行动项 · `仅历史`（行动项另见计划文档） |
| [`archive/quality-review-2026-10-25.md`](archive/quality-review-2026-10-25.md) | 五维质量评估（视觉/功能/架构/安全/性能），3 条关键结论复核 · `仅历史` |
| [`archive/quality-assessment-2026-10-24.md`](archive/quality-assessment-2026-10-24.md) | 全站质量评估，含门禁全量重跑数据 · `仅历史` |
| [`archive/plan-2026-10-21-quality-followup.md`](archive/plan-2026-10-21-quality-followup.md) | 承接 10-20 评估的后续计划，标记每条是否已做 · `部分落地` |
| [`archive/quality-audit-2026-10-20.md`](archive/quality-audit-2026-10-20.md) | 质量评估与优化分析（v4.3.2 基线） · `仅历史` |
| [`archive/quality-review-2026-10-20-full.md`](archive/quality-review-2026-10-20-full.md) | 全站评估（v4.5.0，独立审查版） · `仅历史` |
| [`archive/selfhost-audit-2026-10-16.md`](archive/selfhost-audit-2026-10-16.md) | 自托管全模块走查（83 项 HTTP 检查）与修复清单 · `已落地` |
| [`archive/selfhost-plan-2026-10-14.md`](archive/selfhost-plan-2026-10-14.md) | 自托管迁移方案（方案 B）的原理与取舍 · `已落地` |
| [`archive/vps-reverse-proxy-2026-10-14.md`](archive/vps-reverse-proxy-2026-10-14.md) | 方案 A：VPS 只做反代加速，站点仍在 Cloudflare · `已废弃`（站点已整体搬到 VPS） |
| [`archive/coverage-checkup-2026-10-13.md`](archive/coverage-checkup-2026-10-13.md) | 覆盖率体检，把「从没被用例碰过的代码」变成可查的表 · `仅历史`（阈值后来重做过） |
| [`archive/crud-audit-2026-10-13.md`](archive/crud-audit-2026-10-13.md) | CRUD 全面审查 + 性能瓶颈，所列缺陷当日全修 · `已落地` |
| [`archive/perf-status-2026-10-13.md`](archive/perf-status-2026-10-13.md) | 增删改查与数据加载的剩余优化项与触发阈值 · `仅历史` |
| [`archive/password-manager-analysis-2026-10-13.md`](archive/password-manager-analysis-2026-10-13.md) | 密码管理器范围与设计分析（其「站点密码明文」判断有误，见 `password-manager-options-overview.md` 的更正） · `仅历史` |
| [`archive/inkstone-full-compare-2026-10-11.md`](archive/inkstone-full-compare-2026-10-11.md) | 与 inkstone 的全项目逐模块源码级对比 · `仅历史` |
| [`archive/inkstone-gap-assessment-2026-10-11.md`](archive/inkstone-gap-assessment-2026-10-11.md) | 四维差距评估，结论是「无剩余已知缺项」 · `已落地` |
| [`archive/inkstone-vs-navihive-analysis-2026-10-11.md`](archive/inkstone-vs-navihive-analysis-2026-10-11.md) | 对比之后的方案与方向建议 · `仅历史` |
| [`archive/nav-site-audit-2026-10-11.md`](archive/nav-site-audit-2026-10-11.md) | 导航站侧源码级自查（AI 向量跨账号删除等） · `仅历史` |
| [`archive/perf-audit-2026-10-11.md`](archive/perf-audit-2026-10-11.md) | 全项目性能排查，首屏 304KB gzip 基线 · `仅历史` |
| [`archive/notes-sync-backup-phase-2026-10-11.md`](archive/notes-sync-backup-phase-2026-10-11.md) | 阶段 0–5 实施与验收清单（WebDAV 备份闭环） · `已落地` |
| [`archive/notes-inkstone-gap-2026-10-10-r4.md`](archive/notes-inkstone-gap-2026-10-10-r4.md) | 记事本对齐第四轮，剩余差距逐项列证 · `部分落地` |
| [`archive/notes-inkstone-gap-2026-10-10-r3.md`](archive/notes-inkstone-gap-2026-10-10-r3.md) | 记事本对齐第三轮，三批次已实施 · `已落地` |
| [`archive/notes-inkstone-gap-2026-10-10.md`](archive/notes-inkstone-gap-2026-10-10.md) | 记事本 vs inkstone 第二轮差距清单 · `仅历史` |
| [`archive/notes-inkstone-gap-2026-10-09.md`](archive/notes-inkstone-gap-2026-10-09.md) | 记事本 vs inkstone 第三轮源码级差距 · `仅历史` |
| [`archive/notes-inkstone-gap-2026-10-06.md`](archive/notes-inkstone-gap-2026-10-06.md) | 记事本 vs inkstone 首轮差距 + 排查 · `仅历史` |
| [`archive/notes-audit-2026-10-06-round2.md`](archive/notes-audit-2026-10-06-round2.md) | 记事本第二轮复查 + 后续计划 · `已落地` |
| [`archive/improvement-review-2026-10-05.md`](archive/improvement-review-2026-10-05.md) | 全面复查，本轮开始「有数据支撑」 · `已落地` |
| [`archive/improvement-review-2026-10-04.md`](archive/improvement-review-2026-10-04.md) | 复查：还能改进什么（含四档依赖大版本升级） · `已落地` |

### 3.3 `docs/archive/` 里的更新日志归档

`CHANGELOG.md` 只保留最近一个月；更早的按时间段切进归档，**内容逐行原样搬，最新一段永远在根目录**：

| 文档 | 覆盖区间 |
|---|---|
| [`archive/changelog-2026-10a.md`](archive/changelog-2026-10a.md) | 2026-10-21 ~ 2026-10-31 |
| [`archive/changelog-2026-10b.md`](archive/changelog-2026-10b.md) | 2026-10-11 ~ 2026-10-20 |
| [`archive/changelog-2026-10c.md`](archive/changelog-2026-10c.md) | 2026-10-01 ~ 2026-10-10 |
| [`archive/changelog-2026-09.md`](archive/changelog-2026-09.md) | 2026-09-24 ~ 2026-09-30 |

> 切分纪律：`tests/changelogFreshness.test.ts` 读**根目录** `CHANGELOG.md` 里 `## YYYY-MM-DD` 的最大值，
> 跟最近一次提交的日期比。所以最新一段**必须**留在根目录；归档只搬更早的，
> 且要保证「归档各份行数之和 + 根目录行数 = 切分前行数 + 新增的说明行」。

---

## 4. 运维手册（在 `deploy/` 下，出事时才翻，但请先读一遍）

⚠️ 这几份**互相有矛盾**，因为它们是不同时期、不同形态写的。**先认形态，再认文档**：

| 文档 | 本文对应哪种形态 | 什么时候该读 |
|---|---|---|
| [`../deploy/selfhost.md`](../deploy/selfhost.md) | **当前生产形态**：VPS 上的 Docker 容器（`navihive` + `navihive-upgrader`），宿主反代到 `127.0.0.1:8787` | 唯一的主手册。部署、环境变量、升级回滚、备份恢复、账号密钥、排障、安全须知全在这里。**遇到任何运维问题先翻它** |
| [`../deploy/vps-redeploy-runbook-2026-10-16.md`](../deploy/vps-redeploy-runbook-2026-10-16.md) | 同一形态，但走 **kPanel 面板**（粘贴 compose、面板点反代、面板配证书） | 只在「VPS 重装了、要从零再拉起一台」时读。它假设你没有 shell 习惯、全程用面板操作；日常升级不需要它 |
| [`../deploy/nginx/README.md`](../deploy/nginx/README.md) | **裸机 Nginx**：自己装 Nginx + certbot，不用面板 | 只在「不用 kPanel、想自己写 Nginx 配置」时读。它与 kPanel 那份是**二选一**，不要同时照做（两边都会去抢 80/443） |
| [`deploy/release.md`](deploy/release.md) | 发布流程（本机 → GitHub → GHCR → VPS） | 每次发版都读。五步 + 一条「pull 前后比对 digest」的纪律 |

> 一句话区分：**kPanel 那份讲「怎么从零建一台」，nginx 那份讲「不用面板怎么写配置」，
> selfhost 那份讲「已经在跑了，接下来怎么维护」。** 日常只有 `selfhost.md` 和 `release.md`
> 会被翻开。

---

## 维护约定

- **新增一份文档**：长期文档放 `docs/` 顶层并登记到 §1；**一次性报告直接放 `docs/archive/`**，
  文件名带 `YYYY-MM-DD`，登记到 §3.2。不登记的话，下一个人（包括三个月后的你）仍然只会看见一堆文件名，
  而且 `tests/docsIndex.test.ts` 会红。
- 报告里的结论被推翻时，**不要删文件**，把状态改成 `已废弃` 并补一句「被谁取代」。
  历史报告的价值在于「当时为什么这么想」，删掉就没了。
- 长期文档改了就改，不用留日期；但**改动理由**要写进 `CHANGELOG.md`。
- 挪动/改名任何文档时，**同一批把引用它的地方一起改掉**（`grep -rn "<旧文件名>" .`）——
  `tests/docsIndex.test.ts` 只守本文件与四份根文档里的链接，**代码注释里的路径它看不见**。
