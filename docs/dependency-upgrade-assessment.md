# 大版本依赖升级评估（2026-10-03）

一轮**实测**而不是"看版本号猜"的评估。每条结论都有 `npm install --dry-run` 的结果
支撑（dry-run 不改 lockfile）。

## 结论先说

分四档，按这个顺序做：

| 档 | 内容 | 阻力 | 建议 |
|---|---|---|---|
| 1 | eslint 10 + typescript-eslint / @eslint/js / globals | 小（flat config 已就位） | 现在就能做 |
| 2 | TypeScript 6 | 小（strict / bundler / types 都已就位） | 跟着档 1 |
| 3 | vite 8（连带 plugin-react 6 + esbuild 0.28） | 中（esbuild 也是单测 runner 的依赖） | 单独一轮 |
| 4 | MUI 9 | 中（代码改动小，但有一条行为变化要回归） | 单独一轮 |
| — | TypeScript 7 | **有硬阻塞**（见下） | 等 7.1 |

## 实测矩阵

```
npm install --dry-run @mui/material@9 @mui/icons-material@9
  → 通过（4s）：@mui/system / styled-engine / private-theming / types 一起升到 9.4.0

npm install --dry-run eslint@10
  → 通过：added 113 / removed 18 / changed 26

npm install --dry-run typescript@6
  → 通过：changed 1

npm install --dry-run vite@8
  → 失败，两个原因：
    · @vitejs/plugin-react@4.7 的 peer 只到 vite ^7
    · vite 8 要 esbuild ^0.27 || ^0.28（当前 0.25.12）
npm install --dry-run vite@8 @vitejs/plugin-react@6 esbuild@0.28
  → 通过：added 108 / removed 31 / changed 5

npm install --dry-run typescript@7
  → 能装上，但 npm 一路 warn：
    peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.71.0
```

### TypeScript 7 的硬阻塞

TS 7 是 Go 原生重写，**7.0 不带 compiler API**（计划 7.1 才有）。而本项目
`eslint.config.js` 用的是 `typescript-eslint`，它要靠 compiler API 做类型感知 ——
上面的 peer 区间 `>=4.8.4 <6.1.0` 就是证据：装了 7 之后 lint 跑在官方不支持的
组合上，npm 只是 warn 不会拦，但哪天 lint 静默少查一批规则很难发现。

微软给的过渡方案是 npm alias 双装（`typescript` → `@typescript/typescript6` 给
工具链用，`@typescript/native` 给 `tsc` 用）。**在 7.1 出来之前不值得为这个
加快 10 倍的 tsc 引入一条静默风险** —— 本项目的 typecheck 也就几秒。

另外 TS 7 必须先过 TS 6：ES5 target、AMD/UMD 模块、`baseUrl` 都已移除，`strict`
与 `moduleResolution: bundler` 成为默认值。本项目这几项**已经就位**
（tsconfig.app/node 都是 `strict: true` + `moduleResolution: "bundler"`，
`types` 也是显式写的），所以档 2 的阻力预计很小。

### vite 8 的连带项

`@cloudflare/vite-plugin@1.62.5` 的 peer 是 `vite: ^6.1.0 || ^7.0.0 || ^8.0.0`
—— **Cloudflare 侧不挡 vite 8**，这点先确认了好办。

真正的连带是 esbuild：它的 peer 区间要求 0.27/0.28，而 `script/unit-tests.mjs`
**也用 esbuild 打测试 bundle**。所以升 esbuild 要顺手确认单测 runner 还正常
（`npm run test` 1216 条全绿就是验收标准）。

## MUI 9 的迁移量：比想象中小

先扫了一遍 v9 移除的 API 在本项目里的用量：

```
componentsProps        0    TransitionProps     0
disableEscapeKeyDown   0    GridLegacy          0
direction="column"     0    StepIconComponent   0
BackdropComponent      0    SwipeableDrawer     0
```

**全部为 0** —— 说明这一档主要是"装上再跑一遍"的工作量，不是逐处改代码。
MUI 官方也给了 codemod（`npx @mui/codemod@latest deprecations/*`）。

但有一条**行为变化**必须专门回归：

> **ButtonBase**：Enter / Spacebar 触发的 click 现在会**冒泡**到祖先，且 `onClick`
> 收到的是 MouseEvent 而不是 KeyboardEvent。

本项目的卡片自己处理键盘（`SiteCard.tsx` 的 `handleKeyDown` 里回车/空格打开链接），
而卡片里又有 `CardActionArea`（基于 ButtonBase）。冒泡一变，最可能出现的症状是
**按回车打开两次链接**，或者键盘事件被父级的 onClick 再接一次。

好消息是这条路径有网：`siteCard.dom.test.tsx` 与 `npm run smoke` 都盯着键盘打开。
升完要专门手动验一次：聚焦卡片 → 回车 → 只开一个标签页。

其它两条次要的：
- **浏览器目标提升**：Chrome 117 / Firefox 121 / Safari 17（原 109 / 115 / 15.4）。
  导航站是自用为主，但如果有老设备访问要留意。
- **Backdrop 不再默认加 `aria-hidden`**：读屏用户可能读到弹窗背后的内容。
  `lazyBoundary` 那批无障碍用例会兜住大部分情况。

## 每一档的验收方式

现成的守卫，不用另写：

```bash
npm run typecheck   # TS 版本变化的直接影响
npm run lint        # eslint / typescript-eslint 版本变化
npm run test        # 1216 条；esbuild 变化在这里暴露
npm run build       # 看 index chunk（bundleBudget 守卫会挡住超预算）
npm run smoke       # 键盘打开卡片那条，MUI 9 的重点回归点
npm run e2e         # 后端契约（vite/wrangler 变化的兜底）
```

`npm run ci` 已把这几步串起来（含 e2e）。

## 风险与收益

`npm audit --omit=dev` 现在是 0 漏洞 —— **这一轮不是安全驱动**，纯属技术债。
所以可以按上面的顺序慢慢来，不必一次全上。

收益最大的是 MUI 9（官方称包体 -3%、sx 性能 +30%）与 vite 8（构建速度）；
风险最大的是 TypeScript 7（静默风险）与 vite 8（牵动 esbuild → 单测 runner）。
