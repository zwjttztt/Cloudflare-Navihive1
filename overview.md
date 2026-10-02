# Navihive 交付概览：AI 功能收尾 + Vue 迁移样板

## 一、AI 助手功能收尾（已上线）

按反馈完成四件事，均已推送且 CI 绿灯：

1. **AI 助手弹窗关闭按钮错位修复** — `dialogShell.ts` 的 `dialogTitleSx` 缺 flex 容器，标题内占位 Box 把关闭按钮顶到下方，补全 `display:flex; alignItems:center; gap:1`。
2. **保存后自动关闭** — `AiAssistantDialog.tsx` 去掉「已保存」播报，成功后 `onSaved?.()` 再 `onClose()`，失败才显 error 提示。
3. **AI 补全按钮挪到「网站链接」框右侧** — 原先在名称框右侧；现在名称框回退纯净版，按钮挂在 URL 框右（新增站点弹窗里与「抓取」按钮并列）。
4. **去掉 AI 建议分组功能** — 点 AI 补全后不再自动套 `group_id`、不再弹「AI 建议分组」提示，只填名称与描述，分组交回手动选。

对应提交：`466a1de` / `a25df66` / `5610f58` → 远端 `2bde94a` / `8dac858` / `ec38326`，CI 均 15 步 0 失败。

## 二、前端框架迁移：方案一（Vue 3）样板

### 为什么这么做

选定 **Vue 3 + Vite + TypeScript + Pinia + Naive UI**：

- 现有 `src/API/types.ts`、`configKeys.ts`、`configGuards.ts`、`utils/pinyin.ts` 都是**纯 TypeScript、零 React 依赖**，可被 Vue 直接复用，数据形状不会两边跑偏。
- Worker（`worker/index.ts`）+ D1 与前端完全解耦，迁移前端**不碰后端、不碰数据库**。
- Naive UI 表单/弹窗组件齐全，工具型管理界面最快对齐现有 MUI 体验。

### 落地方式（关键决策）

**与 React 并存，不直接替换。** 新增 `vue/` 目录，产物输出到 `dist-vue/client`（React 仍占 `dist/client`），迁移期可随时来回对照；`.gitignore` 已忽略 `dist-vue`。

### 目录结构

```
vue/
├── index.html
├── vite.config.ts          # root=vue/，别名 @ 与 @shared(→仓库 src)
├── tsconfig.json
└── src/
    ├── main.ts             # createApp + Pinia + Router
    ├── App.vue             # naive-ui Provider 外壳（中文 locale）
    ├── router/index.ts
    ├── api/
    │   ├── types.ts        # 再导出 React 侧的纯 TS 契约
    │   └── http.ts         # /api 客户端，请求约定与原版一致
    ├── stores/nav.ts       # Pinia：分组/站点/配置/搜索
    ├── views/HomeView.vue  # 分组卡片网格 + 搜索
    └── components/
        ├── SiteCard.vue
        └── SiteEditDialog.vue
```

### 请求约定（与原版一致）

`baseUrl=/api`、`credentials: same-origin`（JWT 在 httpOnly cookie 里，令牌不落 JS）、非 2xx 优先取服务端 `message`、401 单独识别。

### 新增脚本

```bash
npm run vue:dev         # 开发（默认代理到 http://127.0.0.1:8787，可用 VUE_API_TARGET 改）
npm run vue:typecheck   # vue-tsc 类型检查
npm run vue:build       # 类型检查 + 构建到 dist-vue/client
```

### 验证结果

- `vue-tsc` 类型检查 **0 错误**
- 构建通过（2696 模块，主包 497.60 kB / gzip 156.55 kB）
- **真实浏览器渲染验证**：对接 `harness/stub-server.mjs`（新增 `STUB_ROOT` 环境变量切换静态目录），无头 Chrome 加载后——**2 分组 3 站点全部正确渲染出 3 张卡片**，无报错、无空态
- 现有 React 管线未受影响：typecheck 0 / lint 0 error / 单测 **842 全过** / build 通过

## 三、已知限制与下一步

- **Vue 样板尚无登录能力**：生产开了 `AUTH_ENABLED=true`，API 全部要求 JWT，所以这个样板现在直接上线会导致 `/api/bootstrap` 401、页面只剩错误态。**它还不能替代生产前端。**
- 未实现的功能：登录、设置、备份与恢复、回收站、标签管理、离线队列、拖拽排序、主题/毛玻璃、语义搜索与 AI 补全入口。
- 要部署到预览 Worker，需先给新 Worker 配 `AUTH_SECRET` 等 secrets；secrets 只写不读，无法从现有 Worker 读出复制，需要你重新 `wrangler secret put`。

建议下一步顺序：**登录 → 设置/配置读写 → 离线队列 → 拖拽排序 → 备份/回收站**，每完成一块对照 React 版验证，全部齐备后再切换根 `vite.config.ts` 与 `wrangler.jsonc` 正式替换。
