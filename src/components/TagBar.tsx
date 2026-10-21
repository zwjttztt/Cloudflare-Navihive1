// src/components/TagBar.tsx
// 标签筛选栏：把用过的标签列成一排，点一下只看带这个标签的网站；
// 左边那颗星是「只看星标」开关。没有任何标签时整条不渲染，省得占地方。
import { Box, Chip, Tooltip } from "@mui/material";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import ClearIcon from "@mui/icons-material/Clear";
import TuneIcon from "@mui/icons-material/Tune";
import BrokenImageIcon from "@mui/icons-material/BrokenImage";
import { buildTagTree, flattenTagTree, hasHierarchy, matchesAnySelected } from "../utils/tagTree";

interface TagBarProps {
    /** 全部用过的标签名 */
    tags: string[];
    activeTags: string[];
    onToggleTag: (tag: string) => void;
    onClearTags: () => void;
    /** 「只看星标」是否开启 */
    starFilter: boolean;
    onToggleStarFilter: () => void;
    /** 检出失效的链接数量；为 0 时不显示「只看失效」入口 */
    deadCount: number;
    /** 「只看失效」是否开启 */
    deadOnly: boolean;
    onToggleDeadOnly: () => void;
    /** 打开「标签管理」弹窗 */
    onManageTags: () => void;
}

export default function TagBar({
    tags,
    activeTags,
    onToggleTag,
    onClearTags,
    starFilter,
    onToggleStarFilter,
    deadCount,
    deadOnly,
    onToggleDeadOnly,
    onManageTags,
}: TagBarProps) {
    const hasFilter = starFilter || deadOnly || activeTags.length > 0;

    // 既没标签也没筛出失效链接、且没开星标筛选时，这条栏就没东西可放
    if (tags.length === 0 && deadCount === 0 && !starFilter) return null;

    return (
        <Box
            className='nav-tag-bar'
            role='group'
            aria-label='筛选'
            data-has-filter={hasFilter ? "true" : "false"}
            sx={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 0.75,
                mb: 3,
                mt: -1,
            }}
        >
            <Chip
                icon={starFilter ? <StarIcon /> : <StarBorderIcon />}
                label='只看星标'
                size='small'
                variant={starFilter ? "filled" : "outlined"}
                color={starFilter ? "primary" : "default"}
                onClick={onToggleStarFilter}
                className='nav-tag-filter'
                data-active={starFilter ? "true" : "false"}
                sx={{ fontWeight: 600 }}
            />

            {deadCount > 0 && (
                <Tooltip title='只显示检测出问题的链接'>
                    <Chip
                        icon={<BrokenImageIcon />}
                        label={`只看失效 ${deadCount}`}
                        size='small'
                        variant={deadOnly ? "filled" : "outlined"}
                        color={deadOnly ? "error" : "default"}
                        onClick={onToggleDeadOnly}
                        className='nav-tag-filter'
                        data-active={deadOnly ? "true" : "false"}
                    />
                </Tooltip>
            )}

            {/* B4 标签层级（2026-10-22）：有层级时按树排版 —— 父级 chip 后面跟着
                缩进的子级；点父级即筛它和它下面全部子标签（语义在 utils/tagTree）。
                全是一级标签时树形排版纯属添乱，所以走原来的平铺。 */}
            {(hasHierarchy(tags) ? flattenTagTree(buildTagTree(tags)) : tags.map(t => ({ path: t, label: t, depth: 1, children: [] }))).map(
                node => {
                    // ⚠️ 选中判定也走层级：父级被选中时，子级 chip 一同高亮，
                    //    否则会出现「筛出来了但 chip 没亮」的错位感。
                    const active = activeTags.includes(node.path) || matchesAnySelected(node.path, activeTags);
                    return (
                        <Chip
                            key={node.path}
                            label={node.label}
                            size='small'
                            variant={active ? "filled" : "outlined"}
                            color={active ? "primary" : "default"}
                            onClick={() => onToggleTag(node.path)}
                            className='nav-tag-filter'
                            data-tag-path={node.path}
                            data-tag-depth={String(node.depth)}
                            data-active={active ? "true" : "false"}
                            title={node.path}
                            sx={node.depth > 1 ? { ml: `${(node.depth - 1) * 12}px` } : undefined}
                        />
                    );
                }
            )}

            {hasFilter && (
                <Tooltip title='清除筛选'>
                    <Chip
                        icon={<ClearIcon />}
                        label='清除筛选'
                        size='small'
                        variant='outlined'
                        onClick={() => {
                            if (starFilter) onToggleStarFilter();
                            if (deadOnly) onToggleDeadOnly();
                            onClearTags();
                        }}
                        className='nav-tag-clear'
                        sx={{ color: "text.secondary" }}
                    />
                </Tooltip>
            )}

            {/* 标签管理入口：集中在弹窗里删标签（删除即从所有卡片摘掉） */}
            <Tooltip title='管理标签'>
                <Chip
                    icon={<TuneIcon />}
                    label='管理'
                    size='small'
                    variant='outlined'
                    onClick={onManageTags}
                    className='nav-tag-manage'
                    sx={{ ml: "auto", color: "text.secondary", borderStyle: "dashed" }}
                />
            </Tooltip>
        </Box>
    );
}
