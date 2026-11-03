# 状态地图（2026-10-21）

> 承接质量评估 3.4：「某个状态到底存在哪」开始需要翻文件。
> 这一页只回答四个问题：**存在哪 / 谁写 / 谁读 / 会不会同步到服务端**。
> 状态变了就顺手改这里 —— 它比代码注释更容易被找到，比口头传授更可靠。

## 一、全局有三类状态，先分清类别再找

| 类别 | 存哪 | 特点 | 典型例子 |
| --- | --- | --- | --- |
| **服务端权威** | D1 / SQLite，走 `/api` | 多设备一致，登录才拿得到 | 分组、站点、笔记、配置项 |
| **本机偏好** | `localStorage`（前缀 `navihive:`） | 跟设备/浏览器走，不进备份 | 视图模式、密度、折叠态、圆角 |
| **本机缓存** | `sessionStorage` / Cache Storage | 只为「下一次打开更快」，丢了大不了重拉 | bootstrap 首屏快照、SW 预缓存 |

判断口径：**「换一台设备后，它该不该跟着变」** —— 该变 → 服务端；不该变 → 本机。
（例外：`site.primaryColor` 这类外观既存服务端配置、又只影响本人，见第三节。）

## 二、4 个 Provider 文件、6 个 context

| context | 定义处 | 消费 hook | 谁写 | 谁读 |
| --- | --- | --- | --- | --- |
| **UIPrefs·Stable**（几乎不变） | `context/uiPrefsStore.ts` | `useUIPrefsStable()` | `UIPrefsContext.tsx` | 卡片/分组/列表（重渲染最敏感的地方优先用这个） |
| **UIPrefs·Prefs**（会变的偏好） | 同上 | `useUIPrefsPrefs()` | 同上 | 设置面板、布局容器 |
| **UIPrefs·Visits**（访问统计） | 同上 | `useUIPrefsVisits()` | 同上 + `usePrefSync` | 卡片角标、热力图 |
| **AppConfig** | `context/appConfigStore.ts` | `useAppConfig()` | `App.tsx` 的 `applyRemoteExtras` | 全站（站点索引、notesBridge、配置项） |
| **Ai** | `context/AiContext.tsx` | 同名导出 | AI 助手弹窗 | AI 助手 |
| **Notify** | `context/NotifyContext.tsx` | `useNotify`（`hooks/useNotify.ts` 提供 notify） | 任意调用方 | 全局 Snackbar |

为什么要拆成 Stable / Prefs / Visits 三个：**减少重渲染**。
访问统计每点一次链接就变，如果和 `viewMode` 挤在同一个 context 里，点一次卡片会让所有读
`viewMode` 的组件一起重绘。

## 三、本机偏好的键（`localStorage`，前缀 `navihive:`）

「会同步」列是重点：带 ✅ 的会写回服务端（需在设置里打开对应开关），其余只在本机。

| 键 | 含义 | 会同步 |
| --- | --- | --- |
| `viewMode` | 卡片 / 列表 / 图标墙 | — |
| `density` | 卡片密度（comfortable / compact / **ultra**） | — |
| `radius` / `fontScale` | 圆角 / 字号档位 | — |
| `favoritesEnabled` | 是否显示「星标」分组 | — |
| `pinyinSearch` | 拼音首字母搜索 | — |
| `glassEffects` / `liteMode` | 毛玻璃 / 清爽模式 | — |
| `offlineFull` | 离线增强（预下载全部功能） | — |
| `iconPrivacy` | 图标隐私模式 | — |
| `railCollapsed` | 左侧导航列是否收起 | — |
| `collapsedGroups` | 分组折叠态 | ✅ |
| `visits` / `visitsSynced` | 访问次数 / 上次同步给服务端的快照 | ✅ |
| `starred` / `tags` | 星标 / 标签（并集合并） | ✅ |
| `deadLinks` / `linkSuspect` / `linkHealthDemotedAt` | 失效链接与巡检状态 | ✅ |
| `searchHistory` / `commandRecent` | 搜索历史 / 最近命令 | — |
| `prefSync` | 「同步这些偏好」总开关 | — |
| `theme` | 浅色 / 深色 / 跟随系统 | — |

## 四、本机缓存（可以随时丢）

| 键 / 位置 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| `sessionStorage: navihive:bootstrap-cache` | 上次 bootstrap 的快照 | 首屏多等一次请求 |
| `sessionStorage: navihive:bootstrap` | 同上（旧键，兼容用） | 无感 |
| Cache Storage `navihive-*` | Service Worker 预缓存 | 下次联网重下 |
| `navihive:failedMutations` | 离线排队的写操作 | **会丢未同步的改动**，别随手清 |

## 五、容易找错的三处

1. **「站点密码」到底在哪？** —— 服务端 `sites.password`（`enc$…` 密文），
   前端只在打开卡片菜单时按需解密。别去 localStorage 找，那里没有。
2. **「笔记的界面偏好」是另一套。** 记事本自己的 `settings.density`（`utils/notesSettings.ts`）
   只有舒适/紧凑两档，**与全局的 `Density`（三档）不是同一个东西**，存在 `notesSettings` 里。
3. **`activeAccount` 是数据边界。** 换账号时 `setAccountUid` 会用它给离线队列、
   撤销快照、偏好划边界；看到「换个账号登录后某设置回来了」，先查这条。

## 六、37 个 hook 的分域（按职责找文件，不用记名字）

| 域 | hook |
| --- | --- |
| 数据层 | `useSites`、`useNotes`、`useSiteSync`、`useSiteIcon`、`useSiteThumb` |
| 认证与账号 | `useAccountSession`、`usePwaInstall` |
| 站点操作 | `useSiteActions`、`useSiteCreator`、`useSiteSettings`、`useGroupActions`、`useBulkActions`、`useTagOpsActions`、`useMultiSelect`、`useBookmarkImport` |
| 搜索与排序 | `useSiteSearch`、`useSemanticSearch`、`useSortController` |
| 笔记与编辑器 | `useEditorTools`、`useHistoryStack`、`useUndoRedo`、`useScrollLock`、`usePanelBreakpoint` |
| 界面外壳 | `useAppDialogs`、`useAppCommands`、`useNavSceneEffects`、`useDocumentEffects`、`useViewportUi`、`useCollapseController`、`useGlobalShortcuts`、`useOfflineBannerVisible`、`useNotify` |
| 同步与备份 | `usePrefSync`、`useBackupController`、`useConfigController` |
| 其它 | `useAiAssistant` |

> 主题（`themeMode` / `darkMode` / MUI theme）在 `hooks/useThemeController.ts`，
> 它是**普通 hook 不是 context** —— 由 `App.tsx` 调用后往下传，因为它要跟 MUI Provider 同级。
