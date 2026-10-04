// src/components/ImportPreviewDialog.tsx
// 导入备份前的差异预览：先把「这份备份会带来什么」摊开给用户看，
// 让他自己挑要导入哪些分组 / 卡片，确认后才真的写库。
import { useMemo, useState } from "react";
import {
    Box,
    Button,
    Checkbox,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Divider,
    IconButton,
    Stack,
    Tooltip,
    Typography,
    TextField,
    FormControlLabel,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { ExportData } from "../API/http";
import { GroupWithSites } from "../types";
import {
    DiffEntry,
    DiffStatus,
    STATUS_LABEL,
    applyImportSelection,
    computeImportDiff,
    defaultSelection,
} from "../utils/importDiff";
import { dialogActionsSx, dialogContentSx, dialogPaperSx, dialogTitleSx } from "./dialogShell";

const STATUS_COLOR: Record<DiffStatus, "success" | "warning" | "default" | "error"> = {
    added: "success",
    updated: "warning",
    unchanged: "default",
    removed: "error",
};

interface ImportPreviewDialogProps {
    open: boolean;
    data: ExportData | null;
    /** true=覆盖恢复，false=合并追加 */
    overwrite: boolean;
    current: GroupWithSites[];
    onCancel: () => void;
    onConfirm: (data: ExportData) => void;
}

export default function ImportPreviewDialog({
    open,
    data,
    overwrite,
    current,
    onCancel,
    onConfirm,
}: ImportPreviewDialogProps) {
    const diff = useMemo(
        () => (data ? computeImportDiff(current, data, overwrite) : null),
        [current, data, overwrite]
    );

    const [selected, setSelected] = useState<Set<string>>(new Set());
    // 长清单（几百条备份）里找一条太难：给一个关键词框 + 只看有变化
    const [keyword, setKeyword] = useState("");
    const [changedOnly, setChangedOnly] = useState(false);
    // 展开看字段差异的条目
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    // 备份数据换了就重新按默认规则勾一遍：
    // 合并导入默认「新增 + 更新」，覆盖恢复默认全选（见 defaultSelection 的说明）。
    // 模式也要算进播种键 —— 覆盖模式下没勾的那部分会被当成「备份里没有」直接删掉，
    // 沿用合并模式那套勾选等于让人什么都没动就丢数据。
    const [seededFor, setSeededFor] = useState<ExportData | null>(null);
    const [seededMode, setSeededMode] = useState(false);
    if (diff && data && (seededFor !== data || seededMode !== overwrite)) {
        setSeededFor(data);
        setSeededMode(overwrite);
        setSelected(defaultSelection(diff, overwrite));
    }

    if (!data || !diff) return null;

    const toggle = (key: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const selectByStatus = (statuses: DiffStatus[]) => {
        const set = new Set(statuses);
        const next = new Set<string>();
        for (const entry of [...diff.groupEntries, ...diff.siteEntries]) {
            if (set.has(entry.status)) next.add(entry.key);
        }
        setSelected(next);
    };

    const selectAll = () => {
        const next = new Set<string>();
        for (const entry of [...diff.groupEntries, ...diff.siteEntries]) next.add(entry.key);
        setSelected(next);
    };

    // 筛选只影响「看什么」，不影响勾选项：
    // 用户缩小范围是为了看清，不是要放弃没显示出来的那些
    const keywordLower = keyword.trim().toLowerCase();
    const visible = (entries: DiffEntry[]) =>
        entries.filter(entry => {
            if (changedOnly && entry.status === "unchanged") return false;
            if (!keywordLower) return true;
            return (
                entry.name.toLowerCase().includes(keywordLower) ||
                entry.detail.toLowerCase().includes(keywordLower)
            );
        });
    const visibleGroups = visible(diff.groupEntries);
    const visibleSites = visible(diff.siteEntries);

    const preview = applyImportSelection(data, diff, selected);
    const total = diff.groupEntries.length + diff.siteEntries.length;

    const renderRow = (entry: DiffEntry) => (
        <Box
            key={entry.key}
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                py: 0.4,
                px: 0.5,
                borderRadius: "10px",
                cursor: "pointer",
                "&:hover": { bgcolor: "action.hover" },
            }}
            onClick={() => toggle(entry.key)}
            data-import-row={entry.key}
            data-status={entry.status}
        >
            <Checkbox
                size='small'
                checked={selected.has(entry.key)}
                onChange={() => toggle(entry.key)}
                sx={{ p: 0.5 }}
                slotProps={{ input: { "aria-label": `选择 ${entry.name}` } }}
            />
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Typography variant='body2' noWrap>
                    {entry.name}
                </Typography>
                <Typography
                    variant='caption'
                    noWrap
                    sx={{
                        color: 'text.secondary',
                        display: "block"
                    }}>
                    {entry.detail}
                </Typography>
                {/* 「名称、链接已改」：不展开也知道动了什么 */}
                {entry.changeSummary && (
                    <Typography
                        variant='caption'
                        noWrap
                        sx={{
                            color: 'warning.main',
                            display: "block"
                        }}>
                        {entry.changeSummary}
                    </Typography>
                )}
                {entry.fields && expanded.has(entry.key) && (
                    <Box sx={{ mt: 0.5, display: "grid", gap: 0.25 }}>
                        {entry.fields.map(field => (
                            <Box key={field.field} sx={{ display: "flex", gap: 0.75, alignItems: "baseline" }}>
                                <Typography variant='caption' sx={{ flexShrink: 0, opacity: 0.8 }}>
                                    {field.label}
                                </Typography>
                                {field.sensitive ? (
                                    <Typography variant='caption' sx={{
                                        color: 'text.secondary'
                                    }}>
                                        有变化（内容不显示）
                                    </Typography>
                                ) : (
                                    <Typography
                                        variant='caption'
                                        sx={{
                                            color: 'text.secondary',
                                            minWidth: 0,
                                            wordBreak: "break-all"
                                        }}>
                                        {field.before || "（空）"} → {field.after || "（空）"}
                                    </Typography>
                                )}
                            </Box>
                        ))}
                    </Box>
                )}
            </Box>
            {entry.fields && entry.fields.length > 0 && (
                <IconButton
                    size='small'
                    onClick={e => {
                        e.stopPropagation();
                        setExpanded(prev => {
                            const next = new Set(prev);
                            if (next.has(entry.key)) next.delete(entry.key);
                            else next.add(entry.key);
                            return next;
                        });
                    }}
                    aria-label={`查看「${entry.name}」的变化详情`}
                    aria-expanded={expanded.has(entry.key)}
                    sx={{ p: 0.5 }}
                >
                    {expanded.has(entry.key) ? (
                        <ExpandLessIcon fontSize='small' />
                    ) : (
                        <ExpandMoreIcon fontSize='small' />
                    )}
                </IconButton>
            )}
            <Chip
                size='small'
                label={STATUS_LABEL[entry.status]}
                color={STATUS_COLOR[entry.status]}
                variant={entry.status === "unchanged" ? "outlined" : "filled"}
                sx={{ height: 22, fontSize: 11, flexShrink: 0 }}
            />
        </Box>
    );

    return (
        <Dialog
            open={open}
            onClose={onCancel}
            maxWidth='sm'
            fullWidth
            className='nav-import-preview'
            slotProps={{ paper: { sx: dialogPaperSx } }}
        >
            <DialogTitle sx={{ ...dialogTitleSx, pr: 6 }}>
                导入预览
                <Tooltip title='关闭'>
                    <IconButton
                        size='small'
                        onClick={onCancel}
                        aria-label='关闭导入预览'
                        sx={{ position: "absolute", right: 10, top: 10 }}
                    >
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            </DialogTitle>

            <DialogContent sx={{ ...dialogContentSx, pt: 0.5, pb: 1 }}>
                <Typography
                    variant='caption'
                    sx={{
                        color: 'text.secondary',
                        display: "block",
                        mb: 1
                    }}>
                    {overwrite
                        ? "覆盖恢复：勾选的内容会替换现有数据，没被这份备份包含的分组和卡片会被清掉。"
                        : "合并导入：勾选的内容会追加到现有数据后面，已有的分组和卡片不会被改动。"}
                </Typography>

                <Stack direction='row' spacing={0.75} sx={{ flexWrap: "wrap", gap: 0.75, mb: 1 }}>
                    <Chip size='small' color='success' label={`新增 ${diff.counts.added}`} />
                    <Chip size='small' color='warning' label={`更新 ${diff.counts.updated}`} />
                    <Chip size='small' variant='outlined' label={`无变化 ${diff.counts.unchanged}`} />
                    {overwrite && (
                        <Chip size='small' color='error' label={`将删除 ${diff.counts.removed}`} />
                    )}
                </Stack>

                <Stack direction='row' spacing={1} sx={{ mb: 1 }}>
                    <Button size='small' onClick={selectAll}>
                        全选
                    </Button>
                    <Button size='small' onClick={() => selectByStatus(["added", "updated"])}>
                        只看新增与更新
                    </Button>
                    <Button size='small' onClick={() => setSelected(new Set())}>
                        全不选
                    </Button>
                </Stack>

                <Divider sx={{ mb: 1 }} />

                {/* 关键词 + 只看有变化：几百条的备份里找一条全靠它 */}
                <Stack direction='row' spacing={1} sx={{ mb: 1, alignItems: "center" }}>
                    <TextField
                        size='small'
                        value={keyword}
                        onChange={e => setKeyword(e.target.value)}
                        placeholder='在清单里找…'
                        aria-label='在差异清单里搜索'
                        sx={{ flexGrow: 1, maxWidth: 220 }}
                    />
                    <FormControlLabel
                        control={
                            <Checkbox
                                size='small'
                                checked={changedOnly}
                                onChange={e => setChangedOnly(e.target.checked)}
                                slotProps={{ input: { "aria-label": "只显示有变化的" } }}
                            />
                        }
                        label={
                            <Typography variant='caption' sx={{
                                color: 'text.secondary'
                            }}>
                                只显示有变化的
                            </Typography>
                        }
                        sx={{ m: 0 }}
                    />
                </Stack>

                <Box sx={{ maxHeight: 320, overflowY: "auto", pr: 0.5 }}>
                    {visibleGroups.length > 0 && (
                        <Box sx={{ mb: 1 }}>
                            <Typography
                                variant='caption'
                                sx={{
                                    color: 'text.secondary',
                                    px: 0.5,
                                    display: "block",
                                    mb: 0.25
                                }}>
                                分组（{visibleGroups.length}
                                {visibleGroups.length !== diff.groupEntries.length
                                    ? ` / ${diff.groupEntries.length}`
                                    : ""}）
                            </Typography>
                            {visibleGroups.map(renderRow)}
                        </Box>
                    )}

                    {visibleSites.length > 0 && (
                        <Box>
                            <Typography
                                variant='caption'
                                sx={{
                                    color: 'text.secondary',
                                    px: 0.5,
                                    display: "block",
                                    mb: 0.25
                                }}>
                                卡片（{visibleSites.length}
                                {visibleSites.length !== diff.siteEntries.length
                                    ? ` / ${diff.siteEntries.length}`
                                    : ""}）
                            </Typography>
                            {visibleSites.map(renderRow)}
                        </Box>
                    )}

                    {visibleGroups.length === 0 && visibleSites.length === 0 && (
                        <Typography
                            variant='body2'
                            sx={{
                                color: 'text.secondary',
                                py: 2,
                                textAlign: "center"
                            }}>
                            没有匹配的条目。筛选只影响显示，勾选的条目一个都不少。
                        </Typography>
                    )}
                </Box>

                {overwrite && (diff.removedGroups.length > 0 || diff.removedSites.length > 0) && (
                    <Typography
                        variant='caption'
                        sx={{
                            color: 'error.main',
                            display: "block",
                            mt: 1
                        }}>
                        覆盖后还会删掉 {diff.removedGroups.length} 个分组、{diff.removedSites.length} 张卡片
                        {diff.removedSites.length > 0
                            ? `（如 ${diff.removedSites.slice(0, 3).join("、")}${diff.removedSites.length > 3 ? " 等" : ""}）`
                            : ""}
                    </Typography>
                )}
            </DialogContent>

            <DialogActions sx={dialogActionsSx}>
                <Button onClick={onCancel} variant='outlined' color='inherit' size='small'>
                    取消
                </Button>
                <Button
                    onClick={() => onConfirm(preview)}
                    variant='contained'
                    size='small'
                    disableElevation
                    disabled={preview.groups.length === 0 && preview.sites.length === 0}
                >
                    导入 {preview.groups.length + preview.sites.length} / {total} 项
                </Button>
            </DialogActions>
        </Dialog>
    );
}
