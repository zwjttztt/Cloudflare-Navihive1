# 贡献指南（Contributing）

给想给 NaviHive 加功能 / 修 bug 的人。先读 `docs/README.md` 找到该读的文档，再回来照着做。

## 0. 本地起得来吗

本地开发先配置 `.dev.vars`。`worker/index.ts` 的启动守卫在 `AUTH_ENABLED=true` 且缺少 `AUTH_SECRET` 时返回 503；关闭鉴权时不适用这条守卫。下面生成开发用配置（已有文件请手动合并，避免覆盖）：

```bash
printf 'AUTH_SECRET=%s\nAUTH_USERNAME=root\nAUTH_PASSWORD=dev-only\n' "$(openssl rand -hex 32)" > .dev.vars
```

详见 `README.md` 与 `deploy/selfhost.md`。

## 1. 架构一句话

- 前端：React + Vite + MUI，`src/`。
- 两个后端共享 `worker/index.ts` 的请求处理与 `worker/routes/` 路由：Cloudflare Worker 使用原生 D1；自托管 Node 的 `server/entry.ts` 通过 `server/sqlite-d1.ts` 将本地 SQLite 适配为 D1 接口。
- API 边界：客户端 `src/API/clientMethods/*`，服务端 `src/API/methods/*`。`tests/apiContract.dom.test.tsx` 检查客户端与 `MockNavigationClient` 的方法覆盖及代表性返回形状；服务端行为通过路由测试与 E2E 验证。
- 日志相关约定以 `shared/logger.ts` 的实际实现和验收结果为准；不要假定某个级别会被生产构建移除。

## 2. 加一个新端点

新增端点需检查下列位置；扩展已有域与新增域的注册工作不同：

1. `src/API/types.ts` —— 请求 / 响应类型。
2. `src/API/clientMethods/<domain>.ts` —— 客户端调用方法。新增域时还须在 `src/API/client.ts` 导入域接口与实现，将接口加入 `NavigationClient` 的同名 interface 声明合并，并把实现加入原型混入列表。
3. `src/API/methods/<domain>.ts` —— 服务端业务实现（跑在 Worker 与 Node 两端）。新增域时还须在 `src/API/navigationApi.ts` 导入域接口与实现，将接口加入 `NavigationAPI` 的同名 interface 声明合并，并把实现加入原型混入列表。
4. `src/API/mock.ts` —— mock 实现（离线 / 开发用）。
5. `worker/routes/<domain>.ts` —— 路由层负责请求解析、鉴权边界与业务调用。导出实际的具名处理器，如 `handleAccountRoutes(ctx)`、`handleDataRoutes(ctx)`，返回 `Promise<Response | null>`：命中返回响应，未命中返回 `null`。新增路由模块还须在 `worker/index.ts` 导入并接入分派流程（公开路由与鉴权后路由的执行位置不同）。JSON 输入按对象、数组或兼容形状选择 `worker/routes/jsonBody.ts` 的 `readJsonBody`、`readJsonArray`、`readJsonValue`，不要裸调用 `request.json()`。
6. `src/API/responses.ts` —— 检查并补充响应类型登记；保证客户端方法、服务端实现与响应类型一致。

两道守卫（CI 会卡，少一个就红）：

- **契约守卫** `tests/apiContract.dom.test.tsx`：扫描前端实际调用，并检查 `NavigationClient` 与 `MockNavigationClient` 的方法覆盖和代表性返回形状。客户端与 mock 应同步维护。
- **输入解析守卫** `tests/jsonBodyGuard.test.ts`：递归检查 Worker 源码中直接解析 JSON 的调用。`readJsonBody` 只接受非 null 且非数组的对象、`readJsonArray` 只接受数组、`readJsonValue` 接受对象或数组；非法 JSON 或形状不符返回 400。

## 3. 加一个路由 / 弹窗（lazy 预取三件套）

- 弹窗代码走 `src/utils/dialogChunks.ts` 预取 + `ChunkBoundary` 包裹（调用位置见 `src/App.tsx`）。新增弹窗要在 `dialogChunks` 登记一项，并**禁止** `fallback={null}`——白屏时无处可退。
- 新页面同理：React.lazy + `ChunkBoundary`。

## 4. 三类测试，分别什么时候写

- **行为测试**（多数）：`tests/*.dom.test.tsx` / `*.test.ts`，用真实数据驱动 `waitFor`，验证「做了什么」。优先写这类。
- **静态守卫**：扫源码字符串的测试（如 `jsonBodyGuard`、`hardcodedColorGuard`、`toolchainPin`），钉住「不准这么写」的红线。改了红线逻辑必须同步改守卫。
- **契约测试**：`apiContract` 这类，盯住两个实现必须一致。

注意：静态守卫**不算行覆盖率**，别把它们当成行为覆盖去凑数。

## 5. 提交与推送

1. 本地先跑 `npm run ci`。具体顺序以 `package.json` 的 `scripts.ci` 为准，包含 typecheck、lint、单测、品牌校验、build、bundle budget、API/分享/cron/WebDAV E2E、smoke、a11y/contrast/perf/visual 审计、覆盖率与边界探测；链条遇错停止。**全绿才推**——没跑过的检查不要说通过。
2. 版本号：`script/bump-version.mjs` 按暂存 diff 机械跳档（patch / minor / major），推送前跑它，并把 `package.json` 一起提交。**每次部署都要有版本号变动**。
3. 推送：`git push`，推送后核对远端分支与 CI 结果。
4. 发布路径见 `.github/workflows/deploy.yml`（Cloudflare Worker）与 `.github/workflows/docker-publish.yml`（自托管镜像）。推送后仍须确认对应工作流和目标环境的部署结果。
5. 改动理由写进 `CHANGELOG.md`（长期文档的改动理由也在 CHANGELOG）。

## 6. 红线（违反会被门禁或 review 拦下）

- 浏览器调试日志应在提交前清理；日志调整遵循仓库 lint 配置与相关测试。
- 零 `any` / `as any` / `@ts-ignore` / `TODO` / `FIXME`。
- 颜色字面量走 `index.css` 的 token 或 `--md-*` 变量（`tests/hardcodedColorGuard.test.ts` 是棘轮，只许降不许升）。
- 图标改了要三件套一起做（`public/favicon.ico` / `index.html` 的 `?v=` / 清残留旧图标）。
- 动作类控件不要只做一个灰色线描图标——要么给文字、要么给实心块。
- `index.css` 里的 transition 时长走 `var(--dur-fast/base/slow)`，写死 `0.15s` 会被 `tests/motionTokenGuard` 判红。
