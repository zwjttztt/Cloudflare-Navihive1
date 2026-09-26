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
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
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
    // 备份数据换了就重新按默认规则勾一遍（默认：新增 + 更新）
    const [seededFor, setSeededFor] = useState<ExportData | null>(null);
    if (diff && data && seededFor !== data) {
        setSeededFor(data);
        setSelected(defaultSelection(diff));
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
                inputProps={{ "aria-label": `选择 ${entry.name}` }}
            />
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Typography variant='body2' noWrap>
                    {entry.name}
                </Typography>
                <Typography variant='caption' color='text.secondary' noWrap sx={{ display: "block" }}>
                    {entry.detail}
                </Typography>
            </Box>
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
        >
            <DialogTitle sx={{ fontSize: 16, fontWeight: 600, pr: 6 }}>
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

            <DialogContent sx={{ pt: 0.5, pb: 1 }}>
                <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 1 }}>
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

                <Box sx={{ maxHeight: 320, overflowY: "auto", pr: 0.5 }}>
                    {diff.groupEntries.length > 0 && (
                        <Box sx={{ mb: 1 }}>
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                sx={{ px: 0.5, display: "block", mb: 0.25 }}
                            >
                                分组（{diff.groupEntries.length}）
                            </Typography>
                            {diff.groupEntries.map(renderRow)}
                        </Box>
                    )}

                    {diff.siteEntries.length > 0 && (
                        <Box>
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                sx={{ px: 0.5, display: "block", mb: 0.25 }}
                            >
                                卡片（{diff.siteEntries.length}）
                            </Typography>
                            {diff.siteEntries.map(renderRow)}
                        </Box>
                    )}
                </Box>

                {overwrite && (diff.removedGroups.length > 0 || diff.removedSites.length > 0) && (
                    <Typography variant='caption' color='error.main' sx={{ display: "block", mt: 1 }}>
                        覆盖后还会删掉 {diff.removedGroups.length} 个分组、{diff.removedSites.length} 张卡片
                        {diff.removedSites.length > 0
                            ? `（如 ${diff.removedSites.slice(0, 3).join("、")}${diff.removedSites.length > 3 ? " 等" : ""}）`
                            : ""}
                    </Typography>
                )}
            </DialogContent>

            <DialogActions sx={{ px: 2, pb: 2, pt: 0.5, gap: 1 }}>
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
