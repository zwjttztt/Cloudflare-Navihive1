# 全项目性能排查（2026-10-11）

基线：远端 75639fa + 本批（命令面板拼音/分组、App.tsx 抽 hook、SiteCard/GroupCard 瘦身、测试加固）。测量方式：构建产物逐文件 gzip 实测（192 个文件、总计 3045KB gzip），首屏以 index.html 的 script+modulepreload+css 合计口径。

## 结论一句话

首屏 304KB gzip、预算内余量 5%+；运行期热点（长任务、滚动卡顿、图片抽动、搜索上限、上传风暴）在既往批次里已系统性治理并有探针/用例把守。当前没有「会拖慢用户」的 P0 瓶颈；剩余可改进项都是「更大更快」级别的优化，按影响排序如下。

## 可改进项（按影响排序）

### 1. Mermaid 传递依赖的布局引擎过大（懒加载，不影响首屏）

- **现状**：`elk` chunk 438KB gzip、`cytoscape.esm` 133KB gzip——都是 mermaid v11 的传递依赖（部分图型的布局引擎），src 里零直接引用。用户渲染对应图型（架构图/思维导图等）时才下载。
- **影响**：首次渲染这类图型会多下 ~570KB gzip、并多一次解析；对「打开笔记里有一张架构图」的场景是可感知延迟。
- **建议**：①短期不动（懒加载已把成本限制在用到的人身上；升级 mermaid 大版本可能换布局引擎，收益不确定）；②中期关注 mermaid 上游是否提供 per-diagram-type 的更细分包；③若未来某图型用户量大，可预加载提示（`modulepreload` 该 chunk 换取渲染时零等待）。
- **优先级**：低（收益场景窄，动作在上游）。

### 2. 首屏 MUI chunk 127KB gzip（最大单件）

- **现状**：首屏必下五件 = mui 126.9 + index 72.6 + react 62.5 + vendor 35.8 + css 4.6。MUI 大头是 @mui/material 核心 + emotion + 已预热的少量图标。
- **影响**：登录前的匿名访客也要下完整 MUI。登录页本身是懒加载的，但 MUI chunk 是 App 壳的依赖，挡不住。
- **建议**：①把 LoginScreen 独立成「MUI 之外的轻壳」收益最大但要维护两套样式（不建议）；②务实做法是确认 CDN/边缘缓存命中（已在 Workers 静态资源上，immutable 命名 + 长缓存已具备）；③持续用 bundleBudget 守卫防止回涨（已就位，995/322 + 5% 余量哲学）。
- **优先级**：低（改动成本高于收益，守卫已防回涨）。

### 3. 记事本编辑器 chunk 187KB gzip（懒加载，可接受）

- **现状**：note-editor 187KB（CodeMirror 全家桶+markdown 扩展），打开记事本才下载。NotesOverlay 本体 79KB。
- **建议**：维持现状。语言包按需已是 CodeMirror 默认行为；无需动作。

### 4. 运行期热点复核（全部已有治理，列出来防回退）

| 热点 | 治理现状 | 守卫 |
|---|---|---|
| 300 卡滚动长任务（14 个/176ms） | mountQueue 每帧一个（本轮抽 utils/mountQueue 并补 2 条调度用例） | tests/mountQueue.test.ts |
| 搜索大数据 | 渲染上限 + 显示更多 + 常用置前 | #14 系列 + siteSearch 用例 |
| 图片塌缩/抽动 | imageCache LRU + width/height 预留 + scrollbar-gutter | #212/#214 用例 |
| 偏好上传风暴 | 1500ms 防抖 + 内容不变不发 | usePrefSync 用例 |
| 图标重复请求 | /api/icon 代理 + iconCache 负缓存 | iconCache 用例 |
| Service Worker 缓存膨胀 | 缓存治理（#51） | 用例 |
| 跨设备同步轮询 | 120s 默认 + 主标签单发 + 页面隐藏跳过 | notesSync 用例 |

### 5. 重复实现清理（本轮已做，留档）

- SiteCard 内嵌的 copyText 与 utils/clipboard.copyToClipboard 完全重复——本轮删除改 import（-49 行，顺带消掉一处行为分叉：重复版少了 setSelectionRange）。
- 此前 BackupDialog/AccountSession/SortController 等大块已抽 hook，App.tsx 2046→1972（剩余主体是组合根接线）。

## 不建议动的

- **elk/cytoscape 预打包**：会把这些字节变相转嫁给所有用 Mermaid 的人，与懒加载初衷相反。
- **再拆 App.tsx 组合根**：剩余 ~700 行是 JSX 组合 + ~1100 行是 30 个已抽域的显式接线，继续拆只会加间接层。
- **手动 wrangler/线上调优**：既定铁律不碰。
