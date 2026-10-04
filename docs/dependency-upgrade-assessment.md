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
