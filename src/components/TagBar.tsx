// src/components/TagBar.tsx
// 标签筛选栏：把用过的标签列成一排，点一下只看带这个标签的网站；
// 左边那颗星是「只看星标」开关。没有任何标签时整条不渲染，省得占地方。
import { Box, Chip, Tooltip } from "@mui/material";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import ClearIcon from "@mui/icons-material/Clear";
import TuneIcon from "@mui/icons-material/Tune";

interface TagBarProps {
    /** 全部用过的标签名 */
    tags: string[];
    activeTags: string[];
    onToggleTag: (tag: string) => void;
    onClearTags: () => void;
    /** 「只看星标」是否开启 */
    starFilter: boolean;
    onToggleStarFilter: () => void;
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
    onManageTags,
}: TagBarProps) {
    const hasFilter = starFilter || activeTags.length > 0;

    if (tags.length === 0) return null;

    return (
        <Box
            className='nav-tag-bar'
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

            {tags.map(tag => {
                const active = activeTags.includes(tag);
                return (
                    <Chip
                        key={tag}
                        label={tag}
                        size='small'
                        variant={active ? "filled" : "outlined"}
                        color={active ? "primary" : "default"}
                        onClick={() => onToggleTag(tag)}
                        className='nav-tag-filter'
                        data-active={active ? "true" : "false"}
                    />
                );
            })}

            {hasFilter && (
                <Tooltip title='清除筛选'>
                    <Chip
                        icon={<ClearIcon />}
                        label='清除筛选'
                        size='small'
                        variant='outlined'
                        onClick={() => {
                            if (starFilter) onToggleStarFilter();
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
