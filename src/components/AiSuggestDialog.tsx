// src/components/AiSuggestDialog.tsx
// AI 给的标签 / 分组建议清单：看完勾一勾再落地。
//
// 这里刻意**不自动应用**：模型把「云盘」打成「网盘」是常事，让它直接改库，
// 用户只会发现标签莫名其妙多了一堆。跟导入预览一个路子 —— AI 只负责把候选摆出来。

import { useEffect, useMemo, useState } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    Box,
    Typography,
    Checkbox,
    FormControlLabel,
    List,
    ListItem,
    ListItemText,
    Chip,
    Stack,
    LinearProgress,
    Alert,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import type { AiAssistant } from "../hooks/useAiAssistant";
import type { TagSuggestion } from "../utils/aiMeta";
import { dialogActionsSx, dialogContentSx, dialogPaperSx, dialogTitleSx } from "./dialogShell";

interface AiSuggestDialogProps {
    open: boolean;
    onClose: () => void;
    ai: AiAssistant;
    /** 要整理的站点（已经由调用方裁好数量） */
    sites: { id: number; name: string; url: string; description?: string }[];
    /** 已有分组名：让模型优先从里面选 */
    groups: string[];
    /** 已有标签：避免重复建议 */
    allTags: string[];
    onApply: (picked: { id: number; tags: string[] }[]) => void;
}

export default function AiSuggestDialog({
    open,
    onClose,
    ai,
    sites,
    groups,
    allTags,
    onApply,
}: AiSuggestDialogProps) {
    const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
    const [selected, setSelected] = useState<Record<number, boolean>>({});
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    // 每次打开重新问一次：站点可能刚改过，拿旧建议来应用会指向已经不存在的卡片
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setBusy(true);
        setMessage("");
        setSuggestions([]);
        setSelected({});
        void (async () => {
            const res = await ai.suggestTags(sites, { groups, tags: allTags });
            if (cancelled) return;
            setBusy(false);
            if (!res.ok) {
                setMessage(res.message);
                return;
            }
            setSuggestions(res.data);
            setSelected(Object.fromEntries(res.data.map(item => [item.id, true])));
            if (res.data.length === 0) setMessage("AI 这次没给出建议，再试一次或换个模型。");
        })();
        return () => {
            cancelled = true;
        };
        // ai / sites / groups / allTags 每次渲染都是新引用，故意只在 open 变化时重跑
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const nameOf = useMemo(() => {
        const map = new Map<number, string>();
        for (const site of sites) map.set(Number(site.id), site.name || site.url);
        return map;
    }, [sites]);

    const picked = suggestions.filter(item => selected[item.id] !== false);

    const apply = () => {
        onApply(picked.map(item => ({ id: item.id, tags: item.tags })));
        onClose();
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth='xs'
            slotProps={{ paper: { sx: dialogPaperSx } }}
        >
            <DialogTitle sx={dialogTitleSx}>
                AI 标签建议
                <Box sx={{ flexGrow: 1 }} />
                <Button
                    size='small'
                    onClick={onClose}
                    aria-label='关闭 AI 标签建议'
                    sx={{ minWidth: 0, p: 0.5 }}
                >
                    <CloseIcon fontSize='small' />
                </Button>
            </DialogTitle>

            <DialogContent sx={dialogContentSx}>
                <Typography
                    variant='body2'
                    sx={{
                        color: 'text.secondary',
                        mb: 1.5
                    }}>
                    下面是模型给的建议，勾上你要的那些再应用。应用后提示条上有「撤销」。
                </Typography>

                {busy && <LinearProgress sx={{ mb: 1.5, borderRadius: 1 }} />}

                {message ? (
                    <Alert severity='info' sx={{ mb: 1 }}>
                        {message}
                    </Alert>
                ) : null}

                {suggestions.length > 0 && (
                    <>
                        <Stack direction='row' spacing={1} sx={{ mb: 0.5 }}>
                            <Button
                                size='small'
                                onClick={() =>
                                    setSelected(
                                        Object.fromEntries(suggestions.map(s => [s.id, true]))
                                    )
                                }
                            >
                                全选
                            </Button>
                            <Button
                                size='small'
                                onClick={() =>
                                    setSelected(
                                        Object.fromEntries(suggestions.map(s => [s.id, false]))
                                    )
                                }
                            >
                                全不选
                            </Button>
                            <Typography
                                variant='caption'
                                sx={{
                                    color: 'text.secondary',
                                    alignSelf: "center"
                                }}>
                                共 {suggestions.length} 条建议
                            </Typography>
                        </Stack>

                        <List
                            dense
                            sx={{
                                maxHeight: 320,
                                overflowY: "auto",
                                borderRadius: "12px",
                                border: "1px solid var(--border-hairline)",
                            }}
                        >
                            {suggestions.map(item => (
                                <ListItem key={item.id} disableGutters sx={{ px: 1 }}>
                                    <FormControlLabel
                                        sx={{ width: "100%", m: 0 }}
                                        control={
                                            <Checkbox
                                                size='small'
                                                checked={selected[item.id] !== false}
                                                onChange={e =>
                                                    setSelected(prev => ({
                                                        ...prev,
                                                        [item.id]: e.target.checked,
                                                    }))
                                                }
                                                slotProps={{
                                                    input: {
                                                        "aria-label": `采纳「${
                                                            nameOf.get(item.id) ?? item.id
                                                        }」的建议`,
                                                    },
                                                }}
                                            />
                                        }
                                        label={
                                            <ListItemText
                                                primary={nameOf.get(item.id) ?? `站点 ${item.id}`}
                                                secondary={
                                                    <Stack
                                                        direction='row'
                                                        spacing={0.5}
                                                        sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.25 }}
                                                    >
                                                        {item.tags.length === 0 ? (
                                                            <Typography variant='caption'>
                                                                {item.group
                                                                    ? `建议分组：${item.group}`
                                                                    : "（没有标签建议）"}
                                                            </Typography>
                                                        ) : (
                                                            item.tags.map(tag => (
                                                                <Chip
                                                                    key={tag}
                                                                    size='small'
                                                                    label={tag}
                                                                    variant='outlined'
                                                                />
                                                            ))
                                                        )}
                                                        {item.group && item.tags.length > 0 ? (
                                                            <Chip
                                                                size='small'
                                                                label={`分组 ${item.group}`}
                                                                color='primary'
                                                                variant='outlined'
                                                            />
                                                        ) : null}
                                                    </Stack>
                                                }
                                                slotProps={{
                                                    primary: { noWrap: true }
                                                }}
                                            />
                                        }
                                    />
                                </ListItem>
                            ))}
                        </List>

                        <Typography
                            variant='caption'
                            sx={{
                                color: 'text.secondary',
                                display: "block",
                                mt: 1
                            }}>
                            建议的分组只列出来给你参考，不会自动移动卡片（挪分组比加标签难撤销得多）。
                        </Typography>
                    </>
                )}
            </DialogContent>

            <DialogActions sx={dialogActionsSx}>
                <Button size='small' onClick={onClose}>
                    取消
                </Button>
                <Button
                    size='small'
                    variant='contained'
                    disabled={busy || picked.length === 0}
                    onClick={apply}
                >
                    应用 {picked.length > 0 ? `${picked.length} 条` : ""}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
