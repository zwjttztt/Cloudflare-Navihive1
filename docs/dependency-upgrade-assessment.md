# 大版本依赖升级（2026-10-03，四档全做完）

一轮**实测**而不是"看版本号猜"的评估，然后按档 1→4 顺序全部落地。
每条结论都有 `npm install --dry-run` 的结果支撑（dry-run 不改 lockfile）。

## 结论与结果

| 档 | 内容 | 评估时的阻力 | 实际结果 |
|---|---|---|---|
| 1 | eslint 10 + typescript-eslint / @eslint/js / globals | 小 | ✅ 连带升了 react-hooks 7 + react-refresh 0.5；改 14 处无用赋值 + 1 处 cause |
| 2 | TypeScript 6 | 小 | ✅ 零代码改动（只改了 README 徽章） |
| 3 | vite 8（连带 plugin-react 6 + esbuild 0.28） | 中 | ✅ 构建器换成 rolldown，专门验了自研的 precache 插件 |
| 4 | MUI 9 | 中 | ⚠️ 评估漏估了：system props 移除才是大头（159 处类型错误） |
| — | TypeScript 7 | **硬阻塞** | ⏸ 等 7.1（见下） |

用例 1216 → 1220（新增 2 条键盘打开 + 2 条 lint 配置守卫）。

## 档 1：eslint 10（连带 react-hooks 7 / react-refresh 0.5）

```
npm install --dry-run eslint@10 @eslint/js@10 typescript-eslint@latest globals@latest
  → ERESOLVE：eslint-plugin-react-hooks@5 的 peer 只到 ^9
npm install --dry-run ... eslint-plugin-react-hooks@7 eslint-plugin-react-refresh@latest
  → 通过：added 117 / removed 18 / changed 30
```

**react-hooks 5 → 7 是硬连带**（peer 只到 eslint 9），react-refresh 0.4 → 0.5 同理。
装完 lint 从 0 条变成 86 条，两类：

- **eslint 10 新进 recommended 的核心规则**（15 条）：`no-useless-assignment` ×14 一律是
  「`let x = 初值; try { x = … } catch { x = 兜底 }」—— 两条路都赋值，初值永远读不到；
  去掉初值只留类型声明即可。`preserve-caught-error` ×1：crypto.ts 把 PBKDF2 的原始错误
  翻成人话时丢了 `cause`，补 `{ cause: error }`（app 的 lib 提到 ES2022，target 不动）。
  这两类是真问题，逐个改而不是关掉。
- **react-hooks v7 新进 recommended 的 React Compiler 规则**（69 条）：查的是"编译器
  编译不过"而不是"现在跑错了"。本项目没开 compiler，全开等于 60+ 条改不动也不改变行为的
  报错。做法是**白名单以外的全关**（`eslint.config.js` 里 `KEPT_REACT_HOOKS`），
  只留升级前就在跑的 `rules-of-hooks` / `exhaustive-deps`。
  写成"白名单以外全关"而不是手写一份 off 列表，是为了将来插件再加规则时默认不静默生效。
  这两条决策由 `tests/eslintReactHooks.test.ts` 盯着。

react-refresh 0.5 新报的 2 条 warning 是真的：ErrorBoundary.tsx 既导出组件又导出两个
普通函数。把 `listLocalAppKeys` / `clearLocalAppData` 挪到 `src/utils/localAppData.ts`。

## 档 2：TypeScript 6.0.3（零代码改动）

TS 6 移除的 ES5 target / AMD-UMD 模块 / `baseUrl` 本项目都没用到，`strict`、
`moduleResolution: bundler`、显式 `types` 早就就位，`tsc -b` 一遍就过。

唯一要动的是 README 的 TypeScript 徽章 —— `readmeBadges` 用例拿 `node_modules` 里的
实际版本对徽章，升上来当天就红（这正是它存在的意义）。

### TypeScript 7 仍然不动

TS 7 是 Go 原生重写，**7.0 不带 compiler API**（计划 7.1 才有），而 `eslint.config.js`
用的 typescript-eslint 要靠 compiler API 做类型感知 —— peer 区间
`>=4.8.4 <6.1.0` 就是证据。装了 7 之后 lint 跑在官方不支持的组合上，npm 只是 warn 不拦，
哪天静默少查一批规则很难发现。TS 6（档 2）是上 TS 7 的必经之路，已经铺好了。

## 档 3：vite 8.3（连带 plugin-react 6 / esbuild 0.28）

```
npm install --dry-run vite@8
  → 失败：plugin-react@4 的 peer 只到 vite ^7；vite 8 要 esbuild ^0.27 || ^0.28
npm install --dry-run vite@8 @vitejs/plugin-react@6 esbuild@0.28
  → 通过：added 108 / removed 11 / changed 5
```

`@cloudflare/vite-plugin` 的 peer 本来就写着 `^6 || ^7 || ^8`，Cloudflare 侧不挡。

**vite 8 换掉了打包器：rollup → rolldown**（产物里多一个 `rolldown-runtime` 块）。
所以除了"装上再跑一遍"，专门验了三处跟打包器耦合的地方：

1. `vite.config.ts` 里自研的 `precacheManifest` 插件（`generateBundle` 里自己走 chunk 图
   分 core / lazy）。rolldown 下仍然分对：core 6（含 1 个 CSS）+ lazy 21 = 磁盘上 26 个 js，
   两边差集都是空 —— 既没有"清单指向不存在的文件"，也没有"产物没进清单"
   （后者会让懒加载弹窗离线时 404）。
2. esbuild 现在只剩 `script/unit-tests.mjs` 在用（vite 8 不再依赖它），0.25 → 0.28 的
   验收就是 1216 条用例全绿。
3. dev server 真起了一遍：index 200、sw.js 200、`/api/init` 走 worker 返回
   `{"ok":true,"initialized":true}`，plugin-react 6 的 react-refresh 也注进去了。

产物：index 228.30 → 227.53 KB（预算 235 内），构建 5.96s → 2.58s。
块划分有变化（vendor 96→77 KB，mui 380→402 KB），是 rolldown 的 chunk 策略不同。

## 档 4：MUI 9.4（评估漏估的地方在这里）

扫"v9 移除的 API 在本项目里的用量"得到全 0，于是评估写成"主要是装上再跑一遍"。
**这个判断只对了一半**：漏掉了 system props 的移除，装上当天 `tsc -b` 冒出 **159 条**
类型错误，分布在 30 个文件。真实工作量：

| 类别 | 处数 | 处理 |
|---|---|---|
| system props（`mt` / `color` / `fontWeight` / `display` / `alignItems` …） | 137 | codemod `v9.0.0/system-props` 搬进 `sx` |
| TextField `InputProps` / `inputProps` / `InputLabelProps` → `slotProps.*` | 9 | codemod `deprecations/text-field-props` |
| Dialog `PaperProps` → `slotProps.paper` | 4 | codemod `deprecations/dialog-props` |
| ListItemText `primaryTypographyProps` → `slotProps.primary` | 5 | codemod `deprecations/list-item-text-props` |
| Menu `MenuListProps` → `slotProps.list` | 3 | codemod `deprecations/menu-props` |
| Avatar `imgProps` → `slotProps.img` | 1 | codemod `deprecations/avatar-props` |
| 图标 `DeleteOutline` / `PersonOutline` / `AddCircleOutline` → `…Outlined` | 3 | 手写（官方没给 codemod） |
| codemod 搬完还剩下的（`slotProps` 里的 `fontSize`） | 7 | 手写包一层 `sx` |

⚠️ codemod 走 jscodeshift 会**整文件重排**，两种表现，处理方式不同：

1. 纯被重新排版、一个语义改动都没有：`src/utils/advancedSearch.ts` 与
   `src/utils/customCss.ts`，已还原（判据：全文件去空白后与 HEAD 相同）。
2. 顺手把整块 JSX 重新缩进：`AddSiteDialog`（原来多缩了 8）、`SettingsDialog`
   （原来少缩了 4）、`App.tsx`（整块 +3）。前两个是**修好了**（原来相对父级是错的），
   留着；App.tsx 那个既没修好也没修坏、纯多 600 行 diff，已手工退回去
   （退完 App.tsx 的净改动只剩 6 行，构建产物字节不变）。

### 那条行为变化的回归：ButtonBase 的 Enter / Space

> MUI 9：Enter / Spacebar 触发的 click 现在会**冒泡**到祖先，且 `onClick` 收到的是
> MouseEvent 而不是 KeyboardEvent。

评估时以为"这条路径有网（siteCard.dom.test.tsx + smoke 盯着键盘打开）"——
**其实没有**：仓库里当时一条键盘打开的用例都没有，冒烟脚本也数不了标签页。
所以先补网再升级：

- `tests/siteCard.dom.test.tsx` 新增 2 条，按"焦点在卡片外壳 / 焦点在里面的 `<a>`"
  分别按回车和空格，把 `window.open` 换成计数器断言**只开一次**。
- 补完先在 MUI 7 上跑绿，再用"故意连开两次"验证用例会红（否则等于没网）。

结论：**本项目没被这条变化咬到**。卡片里的 `CardActionArea` 传了 `component="a"` + `href`，
ButtonBase 对原生可交互元素不改键盘行为（jsdom 里连"未实现导航"的噪音都没有）；
真正处理键盘的是卡片外壳自己的 `handleKeyDown`，只跑一次。
多选模式下卡片里的 IconButton 根本不渲染，冒泡也无处可去。

### 主动接受的一处视觉变化

`ListItemIcon` 默认 `min-width` 从 56px 改成 36px（按 `theme.spacing` 算）。
命中的是 BulkActionBar / DisplayControls 里菜单项的图标位（CommandPalette 那边本来就
显式写了 34，不受影响）。**不回钉旧值** —— 图标是 `fontSize='small'`（20px），56px 的
盒子留的空白过大，收紧是上游的有意改动，钉回去只是攒债。这里记一笔，免得以后看 diff 时
以为是不小心改的。

### 逐条排查过的"静默"变更（TS 不报错的那批）

- 已移除的 CSS 类：项目 CSS 里用到的 20 个 `Mui*` 选择器（`.MuiDialog-paper`、
  `.MuiChip-root`、`.MuiTouchRipple`…）**没有一个在移除名单里**。
- Stepper / TablePagination / Autocomplete / SwipeableDrawer / Grid：本项目 0 用量。
- Slider：只用了 `onChange`，没有靠 `onMouseDown` 取消拖动的那套写法。
- MenuItem 全部在 `Menu` 或 `Select` 内（v9 起 MenuItem 裸用会抛错）。
- `TextField select` 的 InputLabel 变 `<div>`：项目用的是 `FormControl + InputLabel +
  Select`，不走那条路径。
- ButtonBase 的 `component` + `nativeButton` 警告：项目用到的是 `component='a'` /
  `'label'`，都是字符串字面量，走 `allowInferredHostMismatch`，不告警。

## 每一档的验收方式（现成的，不用另写）

```bash
npm run ci   # typecheck → lint → test → check:brand → build → e2e → smoke
```

## 顺带改掉的一件事

CI 里的 `npm ci --legacy-peer-deps` 去掉了 `--legacy-peer-deps`：它是为 MUI 7 的 peer
告警加的，大版本升完之后本地 `npm ci` 实测无冲突。留着它只会让以后真正的 peer 冲突被
静默跳过。

## 风险与收益

`npm audit --omit=dev` 现在仍是 0 漏洞 —— **这一轮不是安全驱动**，纯属技术债。
收益最大的是 vite 8（构建 5.96s → 2.58s）与 MUI 9（官方称包体 -3%、sx 性能 +30%）；
风险最大的是 TypeScript 7（静默风险，已排除）与 MUI 9（实际是 159 处类型错误，已过）。

---

# 附录：依赖公告例外登记 + 供应链固定（审查项 R18，2026-11-04）

这一节和上面几节性质相反：上面记的是「升完了」，这里记的是**没升的部分、以及为什么**。
两块内容：

1. **依赖公告**：dev 链上有 2 条真公告，在「只允许 patch/minor 且必须 lint + tsc 全绿」的
   约束下消不掉，逐条登记责任人 + 到期日；
2. **供应链**：基础镜像与上游服务镜像按 digest 固定，固定不了的两处登记例外。

⚠️ 下面两张表**不是文档，是配置**：`tests/dependencyExceptions.test.ts` 与
`tests/supplyChainPinning.test.ts` 会解析它们。缺责任人、缺到期日、到期日已过、
公告 ID 形状不对、基线声明过期 —— 任何一条都会让单测变红。改表的时候当成改代码。

## 1. 本轮 audit 的真实输出（2026-11-04T11:21:20Z）

```bash
$ npm audit --json             # 全量（含 devDependencies）
  metadata.vulnerabilities = { info: 0, low: 0, moderate: 15, high: 0, critical: 0, total: 15 }
  退出码 1                        # npm 只要 total > 0 就非 0，与严重度无关

$ npm audit --omit=dev --json   # 只算生产依赖
  vulnerabilities = {}           # 空
  退出码 0
  metadata.dependencies = { prod: 244, dev: 320, optional: 87, peer: 1, total: 564 }
```

**15 个节点 ≠ 15 个漏洞。** npm 的 `vulnerabilities` 列的是「受影响的包节点」，
真公告只有两条，另外 13 个是被它们牵连的父包（这些条目的 `via` 里挂的是父包名，
不是公告）：

| 真正带公告的包 | 当前版本 | 公告 | 严重度 | 修好的版本 | 谁把它拉进来的 |
| --- | --- | --- | --- | --- | --- |
| `glob` | `13.0.6` | GHSA-3g3m-2fjr-6pw4（AbortSignal 取消绕过 → 超时后仍可遍历文件系统） | moderate | `>=14.0.2`（**major**） | `c8@12 → test-exclude@8` |
| `minimatch` | `10.2.6` | GHSA-g3hv-75wg-m249（globparts 放大 → DoS） | moderate | `>=11.0.1`（**major**） | `c8 → test-exclude`、`eslint`、`@eslint/config-array`、`@typescript-eslint/typescript-estree` |

13 个牵连节点：`@eslint-community/eslint-utils`、`@eslint/config-array`、`@eslint/js`、
`@typescript-eslint/eslint-plugin`、`@typescript-eslint/parser`、`@typescript-eslint/type-utils`、
`@typescript-eslint/typescript-estree`、`@typescript-eslint/utils`、`c8`、`eslint`、
`eslint-plugin-react-refresh`、`test-exclude`、`typescript-eslint`。

两条公告在上游都**没有 CVSS 向量**（`npm audit --json` 里 `cvss.score = 0`、
`vectorString = null`，CWE 分别是 CWE-400 / CWE-405）。也就是说这个 moderate 是 npm 的
默认档，不是算出来的分数 —— 别拿它当精确风险值，它只能当「该看一眼」的信号。

## 2. 逐项判定：没有一个 patch/minor 能消掉（2026-11-04 逐条查 registry）

判定门槛（本轮硬约束）：只接受 patch/minor，且必须 `eslint` 0 error + 六组 `tsc` 全 0。
按这个门槛逐条查过，**结论是一个包都没升** —— 因为升了也不减一个公告：

| 候选 | 现值 → 最新 | 它自己声明的依赖（`npm view`） | 能消掉公告吗 | 结论 |
| --- | --- | --- | --- | --- |
| `eslint` | `10.12.0` → `10.14.0`（minor） | `minimatch: ^10.2.6` | 否 | 不动（升了还是 10.x 的 minimatch） |
| `typescript-eslint` | `8.71.1` → `8.72.1`（minor） | `typescript-estree` → `minimatch: ^10.2.2` | 否 | 不动 |
| `@eslint/js` | `10.0.1` = latest | — | 否 | 不动 |
| `c8` | `12.0.0` = latest | `test-exclude: ^8.0.0` | 否 | 不动（上游没新版） |
| `test-exclude` | `8.0.0` = latest | `glob: ^13.0.6`、`minimatch: ^10.2.2` | 否 | 不动（上游没新版） |
| `eslint-plugin-react-refresh` | `0.5.7` = latest | peer `eslint` | 否 | 不动（它只是被 eslint 牵连） |
| `minimatch` | `10.2.6` → `11.0.4` | — | 能，但那是 **major** | 走例外登记 |
| `glob` | `13.0.6` → `14.0.3` | `minimatch: ^11.0.2` | 能，但要 major + 连带 minimatch major | 走例外登记 |

关键事实（这三条决定了「等上游」是唯一现实选项）：

- `minimatch` 的 10.x 线**终点就是 10.2.6**，没有同 major 的修复版可等；修复只在 11.x。
- `eslint@10.14.0`（当前 latest）与 `@eslint/config-array@latest` 都还写着 `^10.x` ——
  上游自己没有跟进，本仓升 eslint 的 minor 版不可能把 minimatch 升上去。
- `c8@12` / `test-exclude@8` 都已是各自 latest，`glob ^13` 的声明就在最新版里。

`npm audit fix` 能「修」，但看它给的是什么方子（`fixAvailable` 字段逐条抄下来）：
`@eslint/js` → **降**到 9.39.5、`typescript-eslint` → **降**到 8.36.0、`c8` → **降**到 9.1.0
（`eslint-plugin-react-refresh` 直接写着 `fixAvailable: false`，没有修法）。
三个都是 **major 降级**，等于把「eslint 10 + TypeScript 6」这套组合拆掉（见本文档档 1 / 档 2）。
所以它被明确禁止，不是「懒得修」。

另外两条硬约束也走不通：

- `overrides` 里硬推 `minimatch: ^11` / `glob: ^14` 是**跨 major 强推**，eslint 内部对
  minimatch 的用法（`ignore` 解析、`globparts`）在 11.x 有行为变化，必须跑全量用例 +
  覆盖率链路验收；本轮不允许动。
- 修 `glob` 不能只升 glob：`glob@14` 自己依赖 `minimatch@^11`，等于同时 major 两个。

## 3. 生产依赖基线

生产依赖基线：0 个漏洞（`npm audit --omit=dev`，生产依赖 244 个），核对日期：2026-11-04。
复查周期：180 天内必须重跑一次并更新这条记录的日期（逾期单测直接红）。

为什么这条能当门禁而不只是记录：`--omit=dev` 的那 244 个包才是会进产物的
（vite 打包进 `dist/`、esbuild 打进去 `dist-server/entry.mjs`、`undici` 被 COPY 进镜像）。
devDependencies 全是构建/测试工具，不进产物也不进镜像 —— 上面两条公告就属于这一类。

⚠️ 顺带记一笔 CI 口径的问题（**只记录，本轮不改**）：`.github/workflows/ci.yml` 的生产
门禁是 `npm audit --audit-level=high --omit=dev`。「生产 0 漏洞」现在是事实，所以这道门禁
是绿的；但它的口径只卡 high/critical —— **生产链上真出现 moderate 时它不会红**。
这条 gate 该不该收紧到 moderate 是另一个决策（收紧要先确认 244 个生产依赖长期为 0 可维护），
不在 R18 范围内，这里只留证据。

## 4. 依赖公告例外登记

| 包名 | 当前版本 | 公告 ID | 为什么修不了 | 责任人 | 到期日 | 复查命令 |
| --- | --- | --- | --- | --- | --- | --- |
| `glob` | `13.0.6` | `GHSA-3g3m-2fjr-6pw4` | 修复版 14.0.2 是 major；唯一引入方 `c8@12 → test-exclude@8` 都已是 latest，没有可升的 patch/minor。可达性：test-exclude 只用它展开 `script/coverage.mjs` 里写死的 `--exclude` 模式（字面量），不接收外部输入 | 主理人 | 2027-02-28 | `npm audit --json` 后看 `vulnerabilities.glob` |
| `minimatch` | `10.2.6` | `GHSA-g3hv-75wg-m249` | 修复版 11.0.1 是 major，且 10.x 线终点即 10.2.6；三个上游（eslint 10.14.0 / @eslint/config-array latest / typescript-estree 8.72.1）都仍声明 `^10.x`，没跟进。可达性：模式串来自 `eslint.config.js` 与本仓 tsconfig 的 include（字面量），不是请求输入 | 主理人 | 2027-02-28 | `npm audit --json` 后看 `vulnerabilities.minimatch` |

复查（到期日前必做一次，做完全量重跑 `npm run ci`）：

```bash
npm audit --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const a=JSON.parse(s); for (const k of ["glob","minimatch"]) console.log(k, a.vulnerabilities[k]?.severity ?? "已消失"); });'
npm view eslint@latest dependencies.minimatch      # 上游是否终于改用 ^11
npm view @typescript-eslint/typescript-estree@latest dependencies.minimatch
npm view test-exclude@latest dependencies           # 是否换掉 glob ^13
```

三条都还指向旧 major → 这条例外继续续期（改到期日，写清续期理由）；
任一转向 `^11` / `^13→^14` → 立刻按 patch/minor 升上去，然后把这一行从表里删掉。
**删行是最好的结果**，守卫会强制表里每一行都有责任人和未过期的到期日，所以不可能留着忘掉。

## 5. 供应链固定：已经钉住 digest 的三处

| 位置 | 固定后的写法 | 备注 |
| --- | --- | --- |
| `Dockerfile` builder 阶段（第 40 行） | `FROM node:22-slim@sha256:4b150b48…c7279da AS builder` | 多架构 manifest list 的 digest（amd64 / arm64 共用同一个 index），保留 tag 便于人读 |
| `Dockerfile` runtime 阶段（第 62 行） | 同上（同一个 digest） | 不用 `FROM builder` 派生：会把构建链路带进最终镜像 |
| `docker-compose.yml` 的 upgrader | `image: docker:27.5-cli@sha256:851f91d2…15e3065c` | upgrader 是唯一挂 docker.sock 的特权容器，它跑的内容必须定死 |

### digest 是怎么来的（不是抄的）

先说**没走通的那条路**：任务要求用 Docker Hub registry API 匿名 token 解析。本机出网
策略挡掉了 Docker Hub 整个域，实测：

```bash
$ curl -sS -o /dev/null -w "http=%{http_code}\n" https://auth.docker.io/token
curl: (7) CONNECT tunnel failed, response 502      # http=000
$ curl … https://registry-1.docker.io/v2/          # http=000
$ curl … https://hub.docker.com/v2/repositories/library/node/tags/22-slim   # http=000
```

所以改用**四个独立来源交叉验证**，四个结果完全一致：

1. **本仓 ghcr 镜像里 buildx 的 provenance**（最硬的一条）：`ghcr.io/zwjttztt/navihive:latest`
   是 2026-11-03 由 CI 在本仓 Dockerfile 上构建的，它的 attestation manifest 里明写
   `docker-image://docker.io/library/node:22-slim@sha256:4b150b48…c7279da` ——
   这是 **buildkit 从 Docker Hub 解析出来**再写进来源证明的，等于 Hub 自己的答案。
2. `public.ecr.aws/docker/library/node:22-slim`（AWS ECR Public 对 Docker 官方镜像 `library/*` 的镜像）
3. `docker.m.daocloud.io/library/node:22-slim`（Docker Hub 拉取代理）
4. `docker.1ms.run/library/node:22-slim`（同上）

2/3/4 都做了内容自校验：`sha256(响应体) === 响应头 Docker-Content-Digest`，且与 1 相等。
`docker:27.5-cli` 用 2/3/4 三个来源验证（同样自校验通过，三者一致）。

**是不是当前内容（而不是陈年缓存）**：

- `node:22-slim` 的 amd64 image config：`created = 2026-10-28T01:43:58Z`、
  `NODE_VERSION = 22.23.4`；而本仓 2026-11-03 那次 CI 构建出来的镜像里
  `NODE_VERSION` 也是 22.23.4 —— 两者对得上，说明解析到的就是当时 Hub 上的内容。
- `docker:27.5-cli` 的 image config：`DOCKER_VERSION = 27.5.1`、`created = 2025-02-12`，
  与 compose 里那句「27.x 线的终点是 27.5.1、2025-02 之后未再更新」吻合。

换 digest 的姿势（下次升级基础镜像时用自己机器跑，别照抄上面的值）：

```bash
docker buildx imagetools inspect node:22-slim          # 人读：看 Digest 行
# 或直接看本地 pull 下来的 RepoDigests：
docker pull node:22-slim && docker inspect --format='{{index .RepoDigests 0}}' node:22-slim
```

改完必须同步 `.nvmrc` / `ci.yml` 的 22 这一档，再跑 `npm run ci`。

## 6. 供应链固定例外登记

| 位置 | 目标 | 为什么不固定 digest | 责任人 | 到期日 |
| --- | --- | --- | --- | --- |
| `docker-compose.yml`（navihive 服务） | `navihive:latest` | 本地 `build: .` 的产物：每次构建内容都不同，digest 写死下一次重建就失效。它的安全边界在 Dockerfile 的 `FROM`（已钉），不在这行 | 主理人 | 2027-02-28 |
| `deploy/kpanel-compose.yaml` | `ghcr.io/zwjttztt/navihive:latest` | 粘贴式部署模板 + 滚动发布通道：钉 digest 等于把「几个月后照这份文件新装」的机器冻在写模板那天（装到旧版本，与「更安全」相反）。补偿控制：镜像只能由 CI 结论为 success 后的 `docker-publish.yml` 产出，同一 commit 另有 `:<sha>` tag 可用于「钉住某一版」 | 主理人 | 2027-02-28 |

要「装一次就定死」的正确做法不是 digest，而是 `:<sha>` tag —— 可读、唯一、且能反查到
commit 与那次 CI。digest 在这里只多一层不可读性，挡不住真正的威胁（能改 ghcr 包的人
本来就能改这份 compose 文件）。

复查：到期前确认这两条理由是否还成立 —— 一旦镜像是从外部 registry 拉的
（比如换成官方镜像仓库），第一行的理由就消失，必须改成 digest 固定。

## 7. 这两块留给单测的守卫

| 守卫 | 钉住什么 | 红了意味着 |
| --- | --- | --- |
| `tests/dependencyExceptions.test.ts` | 例外表每行的责任人 / 到期日（可解析、未过期、不超过 12 个月）、公告 ID 形如 `GHSA-xxxx-xxxx-xxxx`、生产基线声明等于 0 且核对日期不超过 180 天 | 有人加了一条没人负责或无限期的例外；文档里的基线声明过期了 |
| `tests/supplyChainPinning.test.ts` | Dockerfile 每条 `FROM` 必须带 `@sha256:`（否则要在带 owner + until 的允许清单里）、两份 compose 的每个 `image:` 同理、6 个 workflow 顶层必须是只读 `permissions` 且每个 job 都有生效权限、禁止 `permissions: write-all` | 有人新加了一条浮动 tag 的 FROM / image，或新写了一个没声明权限的 workflow |

两块都不联网：基线声明与例外表是「文档里的声明」，单测只检查声明本身是否**有日期、
有责任人、没过期** —— 真正的边界（audit 结果、registry 解析）靠 CI 与人工复查，
不靠单测偷偷打网络（那会让它随机红）。

## 8. 本轮没验证到的点（说清楚，别当已验）

1. **CI 真跑**：`npm run ci` 会在 CI 上真验证；本轮只在本地跑六组 `tsc` + 定向 `eslint`
   + 两个新守卫的私有打包运行。workflow 权限改动要等下一次 CI 跑完才算被 GitHub 接受
   （权限写错的表现是某一步 403，不会在 yaml 解析阶段暴露）。
2. **`docker build` 真拉 digest**：本机被出网策略挡在 Docker Hub 之外，没在这台机器上
   真拉过 `node:22-slim@sha256:4b150b48…`。下次 `docker-publish` 构建成功 = 这条被验证。
3. **可达性没有动态测**：两条公告的「不可达」判定依据是**模式串来源是仓库内字面量**
   这一静态事实（读了 `eslint.config.js` 的 `ignores`、`script/coverage.mjs` 的 `--exclude`、
   tsconfig 的 `include` 的用法），没有插桩实跑。
   如果哪天有代码把用户输入直接喂给 minimatch 做匹配，这条判定立即失效。

