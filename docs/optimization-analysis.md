# Cloudflare-Navihive1 优化点分析

> 分析时间：2026-09-27 · 基于当前 HEAD `ed8f278`（App.tsx 4058 行 / worker 1675 行）

## 一、现状体检（客观数据）

### 首屏资源（生产构建 dist/client/assets）

| 资源 | 原始大小 | gzip |
|---|---|---|
| mui-*.js | 362 KB | 108 KB |
| react-*.js | 218 KB | 67 KB |
| index-*.js（App 本体） | 159 KB | 52 KB |
| vendor-*.js | 94 KB | 41 KB |
| index-*.css | 13 KB | 3 KB |
| **首屏 JS 合计** | **833 KB** | **≈268 KB** |
| Roboto 字体（latin，4 字重 × woff2+woff） | ≈ 172 KB（precache 全量） | — |

已做对的：全部弹窗 `React.lazy`、pinyin-match 按需 import、字体只引 latin 子集、
bootstrap 已带弱 ETag/304、SW 分层缓存（API 永不缓存）。

### 代码规模
- `src/App.tsx` 4058 行、**54 个 useState**，仍在持续增长（最近一轮才从 4279 减下来）
- `worker/index.ts` 1675 行单文件，~30 条路由全靠 if-else 串行分发
- 组件层最大三件：SiteCard 1159 / GroupCard 805 / SiteSettingsModal 737

---

## 二、优化建议（按「价值/成本」排序）

### ★ 高价值、低成本

**1. 提交 lockfile，根治「npm install 崩」**
仓库目前没有任何 lockfile（只有 pnpm-workspace.yaml，但本机无 pnpm）。这是本机
`npm install` 处理 `@img/sharp-*` 可选平台包报 `Invalid Version` 的根源，也意味着 CI 和
一键部署每次解析到的依赖树都不同、不可复现。建议在任意有 pnpm 的环境生成
`pnpm-lock.yaml` 提交进仓库，CI 固定用 pnpm。

**2. 清理 package.json**
- `@cloudflare/workers-types` 同时出现在 dependencies（^4.20250404.0）和 devDependencies
  （^4.20250405.0），版本还不一致 → 从 dependencies 删除。
- `preview` / `deploy` 脚本写死了 `pnpm run build`，与其他脚本的 npm 风格不一致 → 统一。
- `name: "my-react-app"` / `version: "0.0.0"` → 改成 navihive。

**3. 字体瘦身（省 ~65–110KB precache）**
- 界面是中文，Roboto 只覆盖数字/英文。4 个字重（300/400/500/700）可以砍到 2 个
  （400 + 500 或 700）——300 的细体在中文界面里存在感很低。
- 去掉 `.woff` 回退（woff2 覆盖率已 >97%，老浏览器退到系统字体即可），省一半文件数。
- SW install 时 precache 全量清单，字体是纯增量负担，砍掉直接减首访流量。

**4. CSP 从 Report-Only 收紧**
`public/_headers` 的 CSP 一直停留在 Report-Only（当初怕 emotion 注入样式 + 跨域图标白屏）。
建议分两步走：先加 `report-uri`（或用 Workers 接一个上报端点）跑一两周看违规报告，
确认无违规后切 enforce。这是安全上最值得收的口子。

### ★★ 中等价值、中等成本

**5. worker/index.ts 拆路由模块**
1675 行 if-else 已经到维护痛点：每加一条路由还要同步 stub-server。建议拆成
`worker/routes/`（auth / sites / configs / backup / webdav / icon），用一张
`{ method, pattern, handler, auth: boolean }` 路由表替代 if-else 串。拆完单文件
不超过 300 行，login-guard-check.mjs 的打包验证方式不变。
顺带：`new NavigationAPI(env)` 目前每个请求都新建，可下沉到路由分发处共用（小事）。

**6. App.tsx 继续按域抽离（延续 #169/#173 的路线）**
54 个 useState 里还有几块完整的领域可以走「App 侧解构保持原名 + 纯函数下沉 utils」的老手法：
- **批量选择域**：多选状态 + BulkActionBar 的十来个回调（约 300 行）
- **搜索域**：搜索词/命中/历史状态 + HeaderSearchBox 串联逻辑
- **对话框编排**：OverlayHost 的 props 已经很宽，可以把「哪个弹窗开着」收成一个
  `overlay: {type, payload}` 单 state，替代十几个独立布尔。

**7. cron 扩展：死链巡检**
现在 cron 只做每周 WebDAV 备份。`linkHealth.ts` 已有检测逻辑，可以挂进同一个 cron：
每周备份前巡检一遍全部站点链接，把失效结果写进 D1（复用现有 link.health 配置前缀），
用户打开「失效检测」弹窗时直接看上次巡检结果，而不是现场逐个探活。

### ★ 长期 / 可选

**8. MUI 表面积**（首屏 108KB gzip 的来源）
tree-shaking 已生效，108KB 是真实用量。再往下只有两条路：换更轻的组件方案（成本极高，
不建议），或接受现状。**结论：不动**。如果想抠，可把 `@dnd-kit`（约 30KB，只在排序模式
用到）改成动态 import，排序模式懒加载。

**9. 首屏 index chunk（52KB gzip）**
是 App 本体逻辑。上面第 6 条每抽出一个域，这块就小一圈，与重构是同一件事的两面。

**10. bootstrap 二次优化（优先级低）**
已有 ETag/304。若站点数涨到几千再考虑 Cache API 边缘缓存，目前个人规模收益趋近于零。

---

## 三、不建议动的

- **换掉 MUI / 大改视觉体系**：测试基座（265 条 ui-smoke + 98 条单测）全部锚定现有
  DOM 结构，重写性价比极差。
- **D1 行式存储改造**：现 JSON 直存对个人规模完全够用。
- **收紧缩略图 / 图标代理**：现有方案（同源代理 + IndexedDB blob 缓存 + 8s 超时兜底）
  已是正确的形态。

## 四、建议的落地顺序

1. （半天）lockfile + package.json 清理 + 字体瘦身 —— 纯工程卫生，零风险
2. （1 天）CSP report-uri 收集 → 观察两周 → enforce
3. （1–2 天/轮）worker 路由拆分；App.tsx 批量选择域抽离
4. （半天）死链巡检挂 cron
