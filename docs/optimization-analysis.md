# Cloudflare-Navihive1 优化点分析

> 分析时间：2026-09-27 · 最后校对：2026-09-30 · HEAD `1fdfcc9`
>
> ⚠️ 这是一份**快照式**分析：下面的行数是写这份文档当时的体检数据，
> 后面的工程动作会持续改变它们。**落地进度以各条目前的 ✅ / ⬜ 标记为准**，
> 行数和「已完成」清单只在每次大改后统一校对一次。

## 一、现状体检（客观数据）

### 首屏资源（生产构建 dist/client/assets）

> 2026-09-30 重新量过一遍（`dist/client/assets`，量的是 `npm run build` 的产物）：

| 资源 | 原始大小 | gzip |
|---|---|---|
| mui-*.js | 362 KB | 108 KB |
| react-*.js | 218 KB | 67 KB |
| index-*.js（App 本体） | 195 KB | 64 KB（分析时 159/52，随功能增长） |
| vendor-*.js | 94 KB | 42 KB |
| index-*.css | 14 KB | 4 KB |
| **首屏 JS 合计** | **869 KB** | **≈281 KB** |
| Roboto 字体（latin，现 3 字重 × woff2+woff） | ≈ 127 KB（**运行时按需下**，不在 precache） | — |
| 弹窗 chunk（10 个，全部 lazy） | 70 KB | 28 KB（首次访问不进首屏） |

已做对的：全部弹窗 `React.lazy`、pinyin-match 按需 import、字体只引 latin 子集、
bootstrap 已带弱 ETag/304、SW 分层缓存（API 永不缓存）。

> **两处口径修正**（2026-09-30 复核，早先写错过一次）：
> - 字体那 127 KB **不在 precache 里**。`dist/client/precache-manifest.json` 只有 16 条，
>   全是 JS/CSS；SW 对 `destination === "font"` 走的是**运行时缓存**（CacheFirst 之类），
>   也就是说只有页面上真用到了某个字重才会去下。所以「字体」这一行既不算首屏、
>   也不算 precache 流量，删字重省的是**用到了才付**的钱。
> - 「弹窗 70 KB 不进首屏」**只在首次访问成立**：10 个 lazy chunk 全在 precache 清单里，
>   SW 安装完会在后台把 70 KB 全量拉走。它换来的不是「少下 70 KB」，而是
>   「首屏不用等这 70 KB」。别拿它当省流量的成果报。

### 代码规模（2026-09-30 校对）

| 文件 | 分析时 | 现在 |
|---|---|---|
| `src/App.tsx` | 4058 行 / 54 个 useState | 4071 行 / 29 处 useState（已抽走批量选择、对话框编排等域） |
| `worker/index.ts` | 1675 行单文件 | **155 行**（纯分发）+ `worker/routes/*` 8 个模块 |
| `src/API/http.ts` | 未列入 | **已拆完**：barrel 25 行 + `navigationApi.ts` 159 行 + `methods/*` 10 个模块（见补充条目 A） |
| SiteCard / GroupCard / SiteSettingsModal | 1159 / 805 / 737 | 1167 / 830 / 776 |

---

## 二、优化建议（按「价值/成本」排序）

### ★ 高价值、低成本

**1. ✅ 已完成 —— 提交 lockfile，根治「npm install 崩」**
仓库已有 `package-lock.json`，CI 与本地解析到同一棵依赖树。

**2. ✅ 已完成 —— 清理 package.json**
`@cloudflare/workers-types` 已从 dependencies 移除；脚本统一为 npm 风格；
`name` / `version` 改成 `navihive` / `0.1.0`。

**3. 🔶 部分完成 —— 字体瘦身（收益比原先估的小很多，优先级已下调）**
300 的细体已经砍掉了（现在是 400/500/700 三档 × woff2+woff ≈ 127KB）。
剩下两步没做：再砍到 2 个字重、去掉 `.woff` 回退。

⚠️ **原先这里写「还能再省 ~85KB precache」是错的**，2026-09-30 复核后更正：
- 字体**根本不在 precache**（见上面「两处口径修正」），省的是运行时流量，不是首屏；
- 去掉 `.woff` 实际省 **0** 字节 —— @fontsource 的 `src` 列表里 woff2 在 woff 之前，
  现代浏览器永远只下 woff2，`.woff` 只是给老浏览器留的回退，普通访问压根不会请求它；
- 真正能省下的只有「砍一个字重」那一份 ≈ 22 KB，而且只对**确实用到该字重**的页面成立。

结论：还值得做（纯删减、零风险），但别再按 85 KB 预期它。适合顺手清，不值得单开一轮。

**4. ✅ 已完成 —— CSP 收紧 + 上报**
`public/_headers` 已经是**强制生效**的 CSP（不再是 Report-Only），并带了
`report-uri /api/csp-report`；接收端在 `worker/csp.ts`，用例在 `tests/csp.test.ts`。
`require-trusted-types-for 'script'` + `trusted-types navihive-sw` 也一并开了。

### ★★ 中等价值、中等成本

**5. ✅ 已完成 —— worker/index.ts 拆路由模块**
`worker/index.ts` 现在只有 155 行，负责「算请求上下文 → 按顺序问各路由模块 → 404/500 兜底」。
路由按前缀落在 `worker/routes/`：`public`(368) / `data`(323) / `account`(225) /
`backup`(172) / `config`(146) / `middleware`(126) / `ops`(101) / `types`(31)，
共用一套 `handle(ctx): Promise<Response | null>` 约定：认领了返回 Response，没认领返回 null。
WebDAV 那一坨也顺手拆成了 `worker/webdav/{types,config,naming,transport,index}`。

配套做了两件事，是这次拆分敢动手的前提：
- `tests/routeCoverage.test.ts`：50 个 `(method, path)` 组合跑真实分发表，断言**恰好一个模块认领**，
  另有 7 个不存在的组合断言没人认领 —— 路由漏挂 / 重复认领会立刻红。
- 拆分时用「原始文件与拆分后所有 `if (path …)` 条件做多重集比对」验证零丢失、零新增。

注意：**分发顺序是语义不是排版**。public 必须在鉴权之前（图标 / 上报带不上 Authorization、
登录注册是「还没登录才要用的」），受保护路由必须在鉴权之后、且在「强制改密」闸门之后。
`worker/index.ts` 顶部注释记了这条，别随手挪。

**6. ⬜ App.tsx 继续按域抽离（延续 #169/#173 的路线）**
已从 54 个 useState 降到 29 处（批量选择域、部分对话框编排已抽走）。剩下的域仍可走
「App 侧解构保持原名 + 纯函数下沉 utils / hooks」的老手法：
- **搜索域**：搜索词 / 命中 / 历史状态 + HeaderSearchBox 串联逻辑
- **对话框编排**：OverlayHost 的 props 已经很宽，可以把「哪个弹窗开着」收成一个
  `overlay: {type, payload}` 单 state，替代十几个独立布尔。

⚠️ 这一条**成本高、收益是维护性的**，且 App.tsx 几乎所有交互都从这里发散出去。
真要动，先把「补充条目 B」的渲染层单测铺开再动手，否则等于闭眼改 4000 行。

**7. ✅ 已完成 —— cron 扩展：死链巡检**
`worker/cron.ts` 现在跑两件事：每周 WebDAV 备份 + 死链巡检（`sweepOneAccount`，
挑「最久没探过」的站点重探一轮合并进 `link.health` 快照）。巡检按账号逐个跑，
各写各的快照，不会串成跨账号混合数据。用例见 `tests/linkSweep.test.ts`。

### ★ 长期 / 可选

**8. MUI 表面积**（首屏 108KB gzip 的来源）
tree-shaking 已生效，108KB 是真实用量。再往下只有两条路：换更轻的组件方案（成本极高，
不建议），或接受现状。**结论：不动**。如果想抠，可把 `@dnd-kit`（约 30KB，只在排序模式
用到）改成动态 import，排序模式懒加载。

**9. 首屏 index chunk（64KB gzip，分析时 52KB）**
是 App 本体逻辑。上面第 6 条每抽出一个域，这块就小一圈，与重构是同一件事的两面。

**10. bootstrap 二次优化（优先级低）**
已有 ETag/304。若站点数涨到几千再考虑 Cache API 边缘缓存，目前个人规模收益趋近于零。

### 补充条目（2026-09-30 追加，编号接在上面之后）

**A. ✅ 已完成 —— 拆 `src/API/http.ts`（原 3739 行 / 130 个方法）**

方法体**逐字**搬到 `src/API/methods/*.ts`，类壳留在 `src/API/navigationApi.ts`：

| 模块 | 行数 | 模块 | 行数 |
|---|---|---|---|
| `methods/accounts.ts`（多账号） | 873 | `methods/data.ts`（分组 / 站点） | 550 |
| `methods/recycle.ts`（回收站） | 480 | `methods/transfer.ts`（导入导出） | 394 |
| `methods/migration.ts`（建表 / 迁移） | 377 | `methods/config.ts`（配置） | 350 |
| `methods/recovery.ts`（密钥恢复） | 341 | `methods/auth.ts`（鉴权） | 314 |
| `methods/internals.ts`（共享常量 / 纯函数） | 142 | `methods/audit.ts`（审计） | 84 |

做法：方法体不动，签名里加 `this: NavigationAPI` 让 TS 认得 this，类上用 interface
声明合并补回方法签名，最后 `Object.assign(原型, 各域实现)` 混回去。对外签名一行没改。

**⚠️ 拆分本身很顺利，真正的坑在打包（后来者务必看这段）**：
一开始把类留在 `http.ts` 里，结果浏览器包 index chunk 从 **199.77 KB 涨到 262.81 KB**
（gzip 66.34 → 81.86）。原因是那句 `Object.assign` 是**模块顶层副作用**，而前端 30 多处
要从 `http.ts` 引类型和常量 —— 只要模块被引用，Rollup 就必须保留它的副作用，
于是 126 个方法体（几乎全是 D1 的 SQL 字符串）全被拖进浏览器，白白多发 63 KB 死代码。
修法是把类单独放 `navigationApi.ts`，`http.ts` 只用 `export type` 再导出类型
（类型在编译期擦掉，不带运行时依赖）；需要类的**值**（`new NavigationAPI` / `createAPI`）
的 Worker 和测试直接引 `navigationApi.ts`。改完产物字节数与拆分前**完全一致**。
`tests/apiSurface.test.ts` 里有两条守卫盯着这个边界。

覆盖：`tests/apiSurface.test.ts` 逐个域核对方法真的混进了原型。这道网不是摆设 ——
interface 声明合并**只补类型**，TS 不会核实原型上真有这些方法，某个域漏加进混回列表时
编译照样过，上线后才炸。已做变异验证：摘掉 config 域，用例立刻红。

**B. ✅ 已完成 —— 渲染层补单测（登录 / 设置 / 账号 / 两张卡片）**
按「从没被任何测试加载过的 src 文件」排过一遍序（105 个文件里 49 个零覆盖），
挑了最大、最容易改坏又最不敢改的几块补齐：

| 用例文件 | 例数 | 覆盖的组件 |
|---|---|---|
| `tests/siteCard.dom.test.tsx` | 7 | SiteCard（1167 行） |
| `tests/groupCard.dom.test.tsx` | 8 | GroupCard（830 行） |
| `tests/loginForm.dom.test.tsx` | 15 | LoginForm（726 行，登录 / 注册 / 找回三视图） |
| `tests/settingsDialog.dom.test.tsx` | 10 | SettingsDialog（756 行） |
| `tests/accountDialog.dom.test.tsx` | 11 | AccountDialog（739 行） |

钉住的都是「改坏了不会报错、但用户会难受」的那类行为：
记住我有没有如实传出去、注册的三道前端校验、非所有者的权限降级、
生成私钥前必须先验当前密码、沉睡阈值填 0 时本地拦截 ——
以及一条安全断言：**新密码明文不得出现在恢复令牌里**（令牌里只带 PBKDF2 哈希）。

跑在 jsdom 上（见 `script/unit-tests.mjs` 的 DOM banner）。写这类用例有几个坑，后来者别再踩：
- jsdom 环境**没挂 `localStorage`**，组件里是直接写 `localStorage.getItem` 的，
  测试文件开头要自己 `Object.defineProperty(globalThis, "localStorage", { value: window.localStorage })`。
- 启动脚本给的 `IntersectionObserver` 是**永不触发**的替身，正好用来测懒挂载；
  但真要看卡片就得手动触发回调，而且挂载走 `requestAnimationFrame` 分帧队列，
  触发后要 `await` 几帧才真的 setState。
- 失效链接记录 `navihive:deadLinks` 是按 **URL** 做键的，不是按站点 id。
- 「最近访问」的 id 是 `-1`，它自己有「清空」分支会接管标题栏 —— 想测
  `canManageGroup`（负 id 不给增删改）要用 `-2` 之类的其它负数，否则测了也白测。
- 提交中的按钮文字会被换成进度圈，按**文案找按钮**会直接找不到人 ——
  查提交按钮请用 `form button[type="submit"]`。
- 给受控输入赋值必须走原生 value setter 再派发 `input`，直接改 `el.value` 会被
  React 的 value tracker 吞掉，`onChange` 不触发。
- 组件是受控的（值都在父组件）时，用一个小 Harness 持有 state，别直接喂死值 ——
  否则「改完状态回滚没回滚」这类行为测不出来。

**C. ✅ 已完成 —— `tests/` 进类型检查**
`tsconfig.json` 原先只引用了 app / node / worker 三个 project，`include` 分别是
`src` / 构建脚本 / `worker`，**没有一个是 `tests`**。所以 `npm run typecheck` 全绿
不代表测试文件没有类型错误 —— 把 `createAPI` 从 `http.ts` 挪走时 tsc 一声不响，
是 esbuild 打包阶段才暴露的。

现已新增 `tsconfig.tests.json`（`include: ["tests"]`，`lib` 带 DOM、开 `jsx`）
并挂进 `tsconfig.json` 的 references，`npm run typecheck` 一并检查测试文件。
顺带装了 `@types/node`（测试要用 `node:test` / `node:assert` / `Buffer`）。

**D. ✅ 已完成 —— 清掉死依赖 `@cfworker/jwt`**
它一直在 `dependencies` 里，但全仓没人 import：JWT 是 `src/API/crypto.ts` 手写的
（`signJwt` / `verifyJwt` / `peekJwtClaim`）。已从 `package.json` 移除并同步了 lockfile。

---

## 三、不建议动的

- **换掉 MUI / 大改视觉体系**：CI 冒烟（`script/ci-smoke.mjs`，约 25 条断言）与
  jsdom 组件用例全部锚定现有 DOM 结构，重写性价比极差。
- **D1 行式存储改造**：现 JSON 直存对个人规模完全够用。
- **收紧缩略图 / 图标代理**：现有方案（同源代理 + IndexedDB blob 缓存 + 8s 超时兜底）
  已是正确的形态。

## 四、建议的落地顺序

1. ✅ 已做：lockfile + package.json 清理
2. ✅ 已做：CSP 收紧 + report-uri 上报
3. ✅ 已做：worker 路由拆分（含 webdav）；App.tsx 批量选择域抽离
4. ✅ 已做：死链巡检挂 cron
5. ⬜ 字体瘦身收尾（第 3 条）：砍到 2 字重 + 去掉 .woff —— 纯删减、零风险，随时可做
   （收益已下调到 ≈22 KB，见第 3 条的更正，别按 85 KB 预期）
6. ✅ 已做：拆 `src/API/http.ts`（补充条目 A）
7. ✅ 已做：渲染层补单测 —— 登录 / 设置 / 账号三个弹窗 + 两张卡片（补充条目 B）
8. ✅ 已做：`tests/` 进类型检查（补充条目 C）
9. ✅ 已做：清掉死依赖 `@cfworker/jwt`（补充条目 D）
10. ⬜ App.tsx 继续抽域（第 6 条）—— 现在 B 铺开了，可以排上日程了

> 十条原始建议 + 追加的 A/B/C/D 四条，现在只剩 3（字体）、6（App 抽域）两条没做完。
> 已完成的几条都配了回归网：路由覆盖测试、迁移 schema 测试、CSP 测试、
> 死链巡检测试、渲染层 jsdom 用例、API 表面覆盖测试、打包边界守卫。
> 单测基线 454 → 475 → 509。
> **后面再做大拆分，请沿用同样的套路：先补覆盖，再动结构，最后跑一遍变异验证**
> （故意改坏一处，确认用例真的会红）。
