// src/components/OverlayHost.tsx
// 浮层与弹窗的挂载区：移动端底栏、命令面板、批量操作条、两处确认框、标签管理。
// 原来内联在 App.tsx 里 124 行。
//
// 这里全是「开关状态 + 对应回调」的接线，不含业务逻辑——每个被挂的东西本身
// 已经是独立组件了。抽出来的好处是 App 的渲染树能一眼看到主体，而不是被一堆
// 挂载点淹没。
import { Suspense, lazy } from "react";
import { Menu, MenuItem, ListItemText } from "@mui/material";
import MobileTabBar from "./MobileTabBar";
import ConfirmDialog from "./ConfirmDialog";
// 下面六个都是「触发了才用得到」的浮层，所以走 lazy —— 它们外面已经套了 <Suspense>，
// 静态 import 会让那个 Suspense 永远不触发、包照样进首屏。
//
// BulkActionBar 是这里面唯一一条**批量条**：只有进入多选模式（勾了卡片）才出现，
// 平时首屏根本用不到它，却有 6.8 KB 躺在 index chunk 里。首屏预算只剩几 KB 余量，
// 它是最干净的一刀 —— 代价是首次进入多选时要等一个小数百 KB 的块。
// 类型只用得到这几条，单独走 import type（编译期擦除，不会把组件本体拖回主包）。
import type { CommandItem } from "./CommandPalette";
import type { AiConfigClient as AiConfigClientLike } from "./AiAssistantDialog";
import type { AiAssistant } from "../hooks/useAiAssistant";
import type { GroupWithSites } from "../types";
import type { DuplicateHit } from "../utils/duplicate";
import type { ParsedBookmarkGroup } from "../utils/bookmarks";

const CommandPalette = lazy(() => import("./CommandPalette"));
const BookmarkImportDialog = lazy(() => import("./BookmarkImportDialog"));
const AiSuggestDialog = lazy(() => import("./AiSuggestDialog"));
const AiAssistantDialog = lazy(() => import("./AiAssistantDialog"));
const TagManagerDialog = lazy(() => import("./TagManagerDialog"));
const BulkActionBar = lazy(() => import("./BulkActionBar"));

export interface OverlayHostProps {
    /** 移动端底栏：搜索 / 分组 / 新增 / 更多 / 星标 */
    mobile: {
        onSearch: () => void;
        onGroups: (event: React.MouseEvent<HTMLElement>) => void;
        onAdd: () => void;
        onMore: (event: React.MouseEvent<HTMLElement>) => void;
        onToggleStar: () => void;
        starActive: boolean;
        badge: number;
        /** 底栏退场（视口跨过 1344px）时收掉挂在底栏按钮上的弹层 */
        onExitViewport?: () => void;
        /** 「分组」菜单（窄屏底栏与窄桌面顶栏共用） */
        groupsAnchor: HTMLElement | null;
        /** 锚点在上方（顶栏）时菜单往下展开，在下方（底栏）时往上展开 */
        groupsPlacement?: "top" | "bottom";
        onCloseGroups: () => void;
        groups: GroupWithSites[];
        onJumpGroup: (groupId: number) => void;
        activeGroupId: number | null;
    };
    commandPalette: {
        open: boolean;
        onClose: () => void;
        commands: CommandItem[];
    };
    bookmarkImport: {
        open: boolean;
        onClose: () => void;
        onImport: (groups: ParsedBookmarkGroup[]) => Promise<number>;
        /** 现有分组：导入前用来判断哪些链接库里已经有了 */
        groups: GroupWithSites[];
    };
    /** 批量操作条：只在多选且非排序模式时出现 */
    bulkBar: {
        visible: boolean;
        count: number;
        groups: GroupWithSites[];
        allTags: string[];
        /** 签名跟 BulkActionBar 保持一致：星标要带目标状态、标签要带标签名、移动要带目标分组 */
        onStar: (starred: boolean) => void;
        onTag: (tags: string[]) => void;
        onMove: (groupId: number) => void;
        onDelete: () => void;
        onFinish: () => void;
        onExit: () => void;
    };
    /** 重复网址确认：撞车时先问一句 */
    dupPrompt: {
        url: string;
        hit: DuplicateHit;
        run: () => void | Promise<void>;
    } | null;
    onDupConfirm: () => void;
    onDupCancel: () => void;
    onJumpToSite: (siteId: number) => void;
    /** 批量删除确认 */
    bulkDelete: {
        open: boolean;
        count: number;
        onConfirm: () => void;
        onClose: () => void;
    };
    aiSuggest: {
        open: boolean;
        onClose: () => void;
        ai: AiAssistant;
        sites: { id: number; name: string; url: string; description?: string }[];
        groups: string[];
        allTags: string[];
        onApply: (picked: { id: number; tags: string[] }[]) => void;
    };
    tagManager: {
        open: boolean;
        tags: string[];
        counts: Record<string, number>;
        onDeleteTag: (tag: string) => void;
        onRenameTag?: (from: string, to: string) => void;
        onMergeTags?: (sources: string[], target: string) => void;
        onAiSuggest?: () => void;
        onClose: () => void;
    };
    /** 「更多选项 → AI 助手」：开关、模型服务、凭据与测试连接 */
    aiAssistant: {
        open: boolean;
        onClose: () => void;
        ai: AiAssistant;
        /** 读写 ai.* 配置（只用到 getConfigs / setConfigs） */
        api: AiConfigClientLike;
        /** 保存成功后刷新 /api/ai/status */
        onSaved?: () => void;
        statusText?: string;
    };
}

export default function OverlayHost({
    mobile,
    commandPalette,
    bookmarkImport,
    bulkBar,
    dupPrompt,
    onDupConfirm,
    onDupCancel,
    onJumpToSite,
    bulkDelete,
    aiSuggest,
    tagManager,
    aiAssistant,
}: OverlayHostProps) {
    return (
        <>
            <MobileTabBar
                onSearch={mobile.onSearch}
                onGroups={mobile.onGroups}
                onAdd={mobile.onAdd}
                onMore={mobile.onMore}
                onToggleStar={mobile.onToggleStar}
                starActive={mobile.starActive}
                badge={mobile.badge}
                onExitViewport={mobile.onExitViewport}
            />

            {/* 「分组」菜单：列出所有分组，点一下跳过去。
                底栏在屏幕下边缘 → 菜单往上翻；顶栏在页面上方 → 菜单往下展开，
                否则顶栏那一档会有一半菜单被推出可视区外 */}
            <Menu
                anchorEl={mobile.groupsAnchor}
                open={Boolean(mobile.groupsAnchor)}
                onClose={mobile.onCloseGroups}
                anchorOrigin={
                    mobile.groupsPlacement === "top"
                        ? { vertical: "bottom", horizontal: "center" }
                        : { vertical: "top", horizontal: "center" }
                }
                transformOrigin={
                    mobile.groupsPlacement === "top"
                        ? { vertical: "top", horizontal: "center" }
                        : { vertical: "bottom", horizontal: "center" }
                }
                slotProps={{ paper: { sx: { minWidth: 180, borderRadius: "14px" } } }}
            >
                {mobile.groups.map(group => (
                    <MenuItem
                        key={group.id}
                        onClick={() => mobile.onJumpGroup(group.id)}
                        selected={group.id === mobile.activeGroupId}
                    >
                        <ListItemText
                            primary={group.name}
                            secondary={`${group.sites.length} 个`}
                        />
                    </MenuItem>
                ))}
            </Menu>

            {/* 命令面板：Ctrl / Cmd + K */}
            <Suspense fallback={null}>
                <CommandPalette
                    open={commandPalette.open}
                    onClose={commandPalette.onClose}
                    commands={commandPalette.commands}
                />
            </Suspense>

            {/* 浏览器书签批量导入 */}
            <Suspense fallback={null}>
                <BookmarkImportDialog
                    open={bookmarkImport.open}
                    onClose={bookmarkImport.onClose}
                    onImport={bookmarkImport.onImport}
                    groups={bookmarkImport.groups}
                />
            </Suspense>

            {/* 批量多选：底部操作条（删除 / 星标 / 标签 / 移动分组） */}
            {bulkBar.visible && (
                // lazy 组件必须自己有一层 Suspense，否则 React 会往上找、找不到就报错。
                // fallback 给 null：批量条是「勾上卡片才出现」的，晚一帧出现比首屏多
                // 背 6.8 KB 划算；真加载失败时用户也能用卡片上的方式退出多选。
                <Suspense fallback={null}>
                    <BulkActionBar
                        count={bulkBar.count}
                        groups={bulkBar.groups.map(group => ({
                            id: group.id,
                            name: group.name,
                        }))}
                        allTags={bulkBar.allTags}
                        onStar={bulkBar.onStar}
                        onTag={bulkBar.onTag}
                        onMove={bulkBar.onMove}
                        onDelete={bulkBar.onDelete}
                        onFinish={bulkBar.onFinish}
                        onExit={bulkBar.onExit}
                    />
                </Suspense>
            )}

            {/* 重复网址确认：同一条链接已经加过，先确认再写库 */}
            <ConfirmDialog
                open={dupPrompt !== null}
                title='这个链接已经加过了'
                description={
                    dupPrompt
                        ? `「${dupPrompt.hit.groupName}」里已有一张同链接的卡片：${dupPrompt.hit.site.name || dupPrompt.hit.site.url}。重复保存后，删的时候容易漏删。`
                        : ""
                }
                confirmText='仍然添加'
                cancelText='取消'
                extraAction={
                    dupPrompt?.hit.site.id != null
                        ? {
                              label: "跳到那张",
                              onClick: () => {
                                  const id = dupPrompt.hit.site.id as number;
                                  onDupCancel();
                                  onJumpToSite(id);
                              },
                          }
                        : undefined
                }
                onConfirm={onDupConfirm}
                onClose={onDupCancel}
            />

            {/* 批量删除确认：删完同样可以在提示条上点「撤销」 */}
            <ConfirmDialog
                open={bulkDelete.open}
                title={`删除选中的 ${bulkDelete.count} 个网站？`}
                description={
                    <span>
                        会先进入回收站（可在「更多选项 → 回收站」中恢复），也可以在提示条上点「撤销」直接还原；
                        站点上保存的账号密码会一并删除。批量操作前建议先到「更多选项 → 数据备份」导出一份备份。
                    </span>
                }
                confirmText='删除'
                danger
                onConfirm={bulkDelete.onConfirm}
                onClose={bulkDelete.onClose}
            />

            {/* 标签管理：集中删标签，删掉即从所有卡片上摘掉 */}
            <Suspense fallback={null}>
                <TagManagerDialog
                    open={tagManager.open}
                    tags={tagManager.tags}
                    counts={tagManager.counts}
                    onDeleteTag={tagManager.onDeleteTag}
                    onRenameTag={tagManager.onRenameTag}
                    onMergeTags={tagManager.onMergeTags}
                    onAiSuggest={tagManager.onAiSuggest}
                    onClose={tagManager.onClose}
                />
            </Suspense>

            {/* AI 标签建议：看完勾一勾再落地，不自动改库 */}
            <Suspense fallback={null}>
                <AiSuggestDialog
                    open={aiSuggest.open}
                    onClose={aiSuggest.onClose}
                    ai={aiSuggest.ai}
                    sites={aiSuggest.sites}
                    groups={aiSuggest.groups}
                    allTags={aiSuggest.allTags}
                    onApply={aiSuggest.onApply}
                />
            </Suspense>

            {/* AI 助手：开关、模型服务、凭据与测试连接（更多选项 → AI 助手） */}
            <Suspense fallback={null}>
                <AiAssistantDialog
                    open={aiAssistant.open}
                    onClose={aiAssistant.onClose}
                    api={aiAssistant.api}
                    ai={aiAssistant.ai}
                    onSaved={aiAssistant.onSaved}
                    statusText={aiAssistant.statusText}
                />
            </Suspense>
        </>
    );
}
