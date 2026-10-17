// src/utils/dialogChunks.ts
// 各懒加载弹窗 / 菜单的**预取入口**（2026-10-17 首开延迟排查）。
//
// 为什么单独建这个文件：预取必须与组件处的 `lazy(() => import("./X"))` 指向
// **同一个模块**，rolldown 才会把它们归进同一个 chunk —— 调用这些函数只会把
// 已经规划好的块提前下载，不会产生重复块。这里只允许动态 import，禁止静态
// import（那会把全部弹窗焊回首屏，静态守卫 tests/lazyPrefetch.dom.test.tsx 盯着）。
//
// 背景（docs/perf-audit-plan-2026-10-17.md 的「按键首开延迟」一节）：
// 「更多选项」菜单、卡片右键菜单、各弹窗全是「条件挂载 + lazy」，首次点击要
// 现场下载「菜单/弹窗块 + 它们的 MUI 依赖块」，在每请求 1~3 秒的链路上就是
// 数秒的空窗，且加载期间没有任何视觉反馈（Suspense fallback 为 null）——
// 用户实测「首次点击反馈延迟很久、关闭后再次打开才恢复正常」。预取把这段
// 下载挪到用户点击之前：悬停菜单按钮时取菜单块、菜单展开时取全部目标弹窗块、
// 首屏空闲时把常用块全部备齐（见 lazyPrefetch.ts）。
export const dialogChunks = {
    // 菜单本体（悬停「更多选项」/ 卡片设置按钮时预取）
    moreMenu: () => import("../components/MoreMenu"),
    siteCardContextMenu: () => import("../components/SiteCardContextMenu"),
    // 「更多选项」菜单项的目标弹窗
    settings: () => import("../components/SettingsDialog"),
    stats: () => import("../components/StatsHubDialog"),
    backup: () => import("../components/BackupDialog"),
    recycle: () => import("../components/RecycleBinDialog"),
    audit: () => import("../components/AuditDialog"),
    aiAssistant: () => import("../components/AiAssistantDialog"),
    account: () => import("../components/AccountDialog"),
    shortcuts: () => import("../components/ShortcutsDialog"),
    // 新增 / 分组（顶栏主按钮与菜单里的「新增分组」）
    addSite: () => import("../components/AddSiteDialog"),
    editGroup: () => import("../components/EditGroupDialog"),
    // 卡片设置 / 卡片右键菜单的目标弹窗
    siteSettings: () => import("../components/SiteSettingsModal"),
    // 其余低频弹窗（idle 兜底预取用）
    groupShare: () => import("../components/GroupShareDialog"),
    tagManager: () => import("../components/TagManagerDialog"),
    bookmarkImport: () => import("../components/BookmarkImportDialog"),
    importPreview: () => import("../components/ImportPreviewDialog"),
    commandPalette: () => import("../components/CommandPalette"),
    // 二次确认 / 操作反馈 / 批量操作等「小而高频」件（2026-10-17 第二轮排查补进）：
    // 块本体都只有 1~10 KB，但首次触发要现场等 1 个 RTT —— 在慢链路上就是
    // 「点了删除确认没反应」「操作成功了提示条半天不出来」。全部转静态会撞
    // 首屏预算的 5% 余量红线，所以走 idle 预取：登录后错峰备齐，首次触发 0 请求。
    confirm: () => import("../components/ConfirmDialog"),
    snackbar: () => import("../components/SnackbarHost"),
    bulk: () => import("../components/BulkActionBar"),
    aiSuggest: () => import("../components/AiSuggestDialog"),
    tagBar: () => import("../components/TagBar"),
    siteSkeleton: () => import("../components/SiteListSkeleton"),
};
