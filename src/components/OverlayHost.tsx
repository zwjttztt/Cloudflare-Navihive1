// src/components/OverlayHost.tsx
// 浮层与弹窗的挂载区：移动端底栏、命令面板、批量操作条、两处确认框、标签管理。
// 原来内联在 App.tsx 里 124 行。
//
// 这里全是「开关状态 + 对应回调」的接线，不含业务逻辑——每个被挂的东西本身
// 已经是独立组件了。抽出来的好处是 App 的渲染树能一眼看到主体，而不是被一堆
// 挂载点淹没。
import { Suspense } from "react";
import { Menu, MenuItem, ListItemText } from "@mui/material";
import MobileTabBar from "./MobileTabBar";
import CommandPalette, { type CommandItem } from "./CommandPalette";
import BookmarkImportDialog from "./BookmarkImportDialog";
import BulkActionBar from "./BulkActionBar";
import ConfirmDialog from "./ConfirmDialog";
import TagManagerDialog from "./TagManagerDialog";
import { SortMode } from "../constants";
import type { GroupWithSites } from "../types";
import type { DuplicateHit } from "../utils/duplicate";
import type { ParsedBookmarkGroup } from "../utils/bookmarks";

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
        /** 移动端「分组」菜单 */
        groupsAnchor: HTMLElement | null;
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
    tagManager: {
        open: boolean;
        tags: string[];
        counts: Record<string, number>;
        onDeleteTag: (tag: string) => void;
        onClose: () => void;
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
    tagManager,
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

            {/* 移动端「分组」菜单：列出所有分组，点一下跳过去 */}
            <Menu
                anchorEl={mobile.groupsAnchor}
                open={Boolean(mobile.groupsAnchor)}
                onClose={mobile.onCloseGroups}
                anchorOrigin={{ vertical: "top", horizontal: "center" }}
                transformOrigin={{ vertical: "bottom", horizontal: "center" }}
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
                />
            </Suspense>

            {/* 批量多选：底部操作条（删除 / 星标 / 标签 / 移动分组） */}
            {bulkBar.visible && (
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
                    onClose={tagManager.onClose}
                />
            </Suspense>
        </>
    );
}

/** 让调用方少写一遍：批量操作条只在多选且非排序模式时挂载 */
export const bulkBarVisible = (multiSelect: boolean, sortMode: SortMode) =>
    multiSelect && sortMode === SortMode.None;
