// src/components/navigationCenter/model.ts
// 导航页「设置」中心的**条目注册表**：分组、id、名称、说明、图标、可见性。
//
// 为什么单独一个文件、且刻意不带 JSX（.ts 而不是 .tsx）：
//   · 注册表是**数据**，渲染在 NavigationCenterDialog 里做。两边分开之后，
//     权限过滤（谁能看到哪几项）就成了这里的一个纯函数，能单独测，
//     不必先挂出一棵 React 树；
//   · 不带 JSX 的模块不会被打包器当成组件块，将来「按 id 懒加载面板」的
//     边界也干净 —— 注册表本身永远进不了面板块。
//
// 信息架构（2026-10-31 A+B 方案用户确认）：
//   数据与活动（统计 / 数据与维护 / 数据安全 / 审计日志）
//   外观与工具（外观与搜索 / 密码保险库 / AI 设置）
//   个人与支持（账号与安全 / 快捷键与操作帮助）
//   底部危险区（退出登录 —— 不做导航项，固定在左栏底部、隔分隔线、error 色）
// 「备份与恢复」+「回收站」合成「数据安全」，「高级」拆散吸收（CSS→外观，
// 版本升级→数据与维护）：11 条收敛到 9 条，每个分组重新只讲一个主题。
// 原来的「帮助」「会话」两个单条分组删掉：一个分组只装一项，等于多一层目录。
import type SvgIcon from "@mui/material/SvgIcon";
import InsightsIcon from "@mui/icons-material/Insights";
import SettingsBackupRestoreIcon from "@mui/icons-material/SettingsBackupRestore";
import HistoryIcon from "@mui/icons-material/History";
import PaletteIcon from "@mui/icons-material/Palette";
import StorageIcon from "@mui/icons-material/Storage";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import LockIcon from "@mui/icons-material/Lock";
import ManageAccountsIcon from "@mui/icons-material/ManageAccounts";
import KeyboardIcon from "@mui/icons-material/Keyboard";
import LogoutIcon from "@mui/icons-material/Logout";

/** 图标组件的类型：与 @mui/icons-material 的 SvgIconComponent 同一个东西 */
export type NavCenterIcon = typeof SvgIcon;

/** 面板 id。它同时是面板懒加载的分发键，改名要连 panels 一起改 */
export type NavCenterId =
    | "stats"
    | "backup"
    | "audit"
    | "config-appearance"
    | "config-data"
    | "ai"
    | "vault"
    | "account"
    | "shortcuts"
    | "logout";

/**
 * 谁能看到这一项。
 *   always —— 跟登录无关（统计对所有人可见；全站设置 / AI 设置 / 保险库也一直是这个入口）
 *   authed —— 仅登录态（账号与安全、退出登录）
 *   owner  —— 仅站点所有者（审计日志；后端同样会挡，这里只是别让人白点一次）
 */
export type NavCenterAudience = "always" | "authed" | "owner";

export interface NavCenterItem {
    id: NavCenterId;
    /** 左栏条目与右栏标题共用这个名字 —— 用户点完要能看到「我到了哪儿」 */
    label: string;
    /** 右栏标题下那句一行说明 */
    description: string;
    /**
     * 过滤用的别名（可搜索词）。左栏过滤框同时匹配 label / keywords / description ——
     * description 已经覆盖了大部分同义词（「主色」「圆角」「CSS」都在外观与搜索的
     * 说明里），这里只补说明里**没有**、但人一定会拿来找它的词。
     * 不写 = 只按「名称 + 一行说明」搜。
     */
    keywords?: string[];
    icon: NavCenterIcon;
    audience: NavCenterAudience;
}

export interface NavCenterGroup {
    id: string;
    title: string;
    items: NavCenterItem[];
}

/** 左栏的三个分组（顺序即显示顺序） */
export const NAV_CENTER_GROUPS: NavCenterGroup[] = [
    {
        id: "data",
        title: "数据与活动",
        items: [
            {
                id: "stats",
                label: "统计",
                description: "访问统计与运营看板：哪些网站常被点开、什么时候最活跃。",
                // 「访问 / 看板 / 活跃」说明里都有了，这里只补说明里没有的几种叫法
                keywords: ["排行", "趋势", "热度"],
                icon: InsightsIcon,
                audience: "always",
            },
            {
                id: "config-data",
                label: "数据与维护",
                description: "离线缓存、跨设备同步、失效链接检测与版本升级。",
                // 缓存 / 同步 / 升级 / 离线 说明里已有；补「死链」（失效链接的俗称）等
                keywords: ["死链", "更新", "存储"],
                icon: StorageIcon,
                audience: "always",
            },
            // A+B 方案（2026-10-31 用户确认）：备份与回收站合成「数据安全」
            // —— 怎么不丢（备份）、怎么找回（回收站）、留多久（保留策略，
            // 从「数据与同步」迁来：规则跟着被管的东西走）。见 panels/DataSafetyPanel.tsx。
            {
                id: "backup",
                label: "数据安全",
                description: "数据保留策略、备份与恢复、回收站：怎么不丢、怎么找回、留多久。",
                // 「备份 / 恢复 / 回收站 / 保留」说明里已有，补导出导入这些动作词
                keywords: ["还原", "导入", "导出", "WebDAV", "快照"],
                icon: SettingsBackupRestoreIcon,
                audience: "always",
            },
            {
                id: "audit",
                label: "审计日志",
                description: "谁在什么时候改了什么。仅站点所有者可见。",
                keywords: ["记录", "历史", "操作"],
                icon: HistoryIcon,
                audience: "owner",
            },
        ],
    },
    {
        id: "system",
        title: "外观与工具",
        items: [
            // 全站设置原是一个面板内三张 Tab（外观与搜索 / 数据 / 高级），
            // 2026-10-31（B1）摊平：外观与搜索 / 数据与维护进左栏，
            // 「高级」拆散吸收（CSS → 外观与搜索，版本升级 → 数据与维护）。
            // 两条共用同一个懒加载 chunk（见 panels/ConfigPanel.tsx）。
            {
                id: "config-appearance",
                label: "外观与搜索",
                description: "站点名称、主色、圆角字号、背景壁纸、自定义 CSS、图标与拼音搜索。",
                // 「主色 / 字号 / 壁纸 / CSS / 图标」说明里已有；补主题向的词
                keywords: ["主题", "深色", "暗色", "颜色", "字体"],
                icon: PaletteIcon,
                audience: "always",
            },
            {
                id: "vault",
                label: "密码保险库",
                description: "端到端加密保存站点密码，主密码独立、可用恢复码找回。",
                // 加密 / 主密码 / 恢复码 说明里已有，补「密码本」这类日常叫法
                keywords: ["密码本", "钥匙", "自动填充"],
                icon: LockIcon,
                audience: "always",
            },
            {
                id: "ai",
                label: "AI 设置",
                description: "模型服务与凭据配置，配好才能用智能补全与语义搜索。",
                keywords: ["密钥", "API", "Key"],
                icon: AutoAwesomeIcon,
                audience: "always",
            },
        ],
    },
    {
        id: "personal",
        title: "个人与支持",
        items: [
            {
                id: "account",
                label: "账号与安全",
                description: "账号密码、恢复密钥、登录设备与注销账号。",
                // 「登录 / 设备 / 注销」说明里已有；补会话与改密码
                keywords: ["会话", "修改密码"],
                icon: ManageAccountsIcon,
                audience: "authed",
            },
            {
                id: "shortcuts",
                label: "快捷键与操作帮助",
                description: "键盘快捷键一览，以及把本页安装到桌面。",
                keywords: ["热键", "PWA"],
                icon: KeyboardIcon,
                audience: "always",
            },
        ],
    },
];

/**
 * 底部危险区：退出登录。
 *
 * 它**不是导航项** —— 点了不会打开一个面板，而是直接二次确认后执行。
 * 之所以沉在左栏最底部、隔一条分隔线、用 error 色，是因为它和上面那些
 * 「改一改设置」的动作性质完全不同：它是「离开当前状态」。
 */
export const NAV_CENTER_DANGER: NavCenterItem[] = [
    {
        id: "logout",
        label: "退出登录",
        description: "结束当前登录会话。",
        icon: LogoutIcon,
        audience: "authed",
    },
];

/** 有右栏面板的 id：退出登录不是导航项，没有面板 */
export type NavCenterPanelId = Exclude<NavCenterId, "logout">;

/** 按 id 取条目（左栏分组与底部危险区都查） */
export function findNavItem(id: NavCenterId): NavCenterItem | undefined {
    for (const group of NAV_CENTER_GROUPS) {
        const hit = group.items.find(item => item.id === id);
        if (hit) return hit;
    }
    return NAV_CENTER_DANGER.find(item => item.id === id);
}

export interface NavCenterVisibility {
    isAuthenticated: boolean;
    isSiteOwner: boolean;
}

function visible(item: NavCenterItem, ctx: NavCenterVisibility): boolean {
    if (item.audience === "owner") return ctx.isSiteOwner;
    if (item.audience === "authed") return ctx.isAuthenticated;
    return true;
}

/** 过滤后的分组（空分组整组不出现，不留一个光秃秃的小标题） */
export function visibleNavGroups(ctx: NavCenterVisibility): NavCenterGroup[] {
    return NAV_CENTER_GROUPS.map(group => ({
        ...group,
        items: group.items.filter(item => visible(item, ctx)),
    })).filter(group => group.items.length > 0);
}

/** 过滤后的危险区条目（未登录时一条都没有） */
export function visibleNavDanger(ctx: NavCenterVisibility): NavCenterItem[] {
    return NAV_CENTER_DANGER.filter(item => visible(item, ctx));
}

/** 所有当前可见的导航项 id，按显示顺序（不含底部危险区） */
export function visibleNavIds(ctx: NavCenterVisibility): NavCenterPanelId[] {
    return visibleNavGroups(ctx)
        .flatMap(group => group.items)
        .map(item => item.id)
        // logout 只住在底部危险区，不会出现在分组里 —— 这个 filter 只是让类型
        // 说清「分组里的 id 一定有面板」，不是在运行期兜底
        .filter((id): id is NavCenterPanelId => id !== "logout");
}

/**
 * 把当前选中项校正成一个**真的可见**的 id。
 *
 * 为什么需要它：登录后打开中心、再退出登录（或切换账号），上一个选中项
 * 可能已经不可见 —— 不校正的话右栏会留一个空面板，用户以为弹窗坏了。
 * 回退到第一个可见项（= 左栏第一项）是最不意外的选择。
 */
export function resolveNavActiveId(
    activeId: NavCenterPanelId,
    ctx: NavCenterVisibility
): NavCenterPanelId {
    const ids = visibleNavIds(ctx);
    if (ids.includes(activeId)) return activeId;
    return ids[0] ?? "stats";
}
