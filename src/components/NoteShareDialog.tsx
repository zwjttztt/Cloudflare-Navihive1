import { useEffect, useState } from "react";
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Switch,
    TextField,
    Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type { NoteImportStats, NotesImportPayload, NoteShare, NoteShareListItem, NoteStats } from "../API/types";
import ConfirmDialog from "./ConfirmDialog";

export interface NoteShareApi {
    getNoteShare(id: number): Promise<NoteShare | null>;
    /** 分享列表（设置页「分享列表」用） */
    listNoteShares(): Promise<NoteShareListItem[]>;
    /** password 可空：string = 重设/设访问口令；null = 清除；不传 = 保持 */
    createNoteShare(id: number, days: number | null, password?: string | null): Promise<NoteShare | null>;
    revokeNoteShare(id: number): Promise<{ success: boolean }>;
    /** 更新有效期但**保留 token**（链接不变）—— inkstone SharePanel 的「更新设置」 */
    updateNoteShare(id: number, days: number | null, password?: string | null): Promise<NoteShare | null>;
    /**
     * 数据页「双链 / 版本历史」两格的全站计数。可选：老部署的 api 没有
     * 这个方法，两格自动显示「—」，不报错（与 uploadApi 的可选方法同一套路）。
     */
    reindexNotes?(): Promise<{ success: boolean; count: number }>;
    notesStats?(): Promise<NoteStats>;
    /**
     * 导入「记事本导出」JSON（exportAllData 的形状）：按 uuid 合并、较新者胜。
     * 可选：老部署没有 notes/import 端点时数据页的导入行整个不出现。
     */
    importNotes?(payload: NotesImportPayload): Promise<NoteImportStats>;
}

type ExpiryKey = "keep" | "0" | "1" | "7" | "30";

const EXPIRY_OPTIONS: { value: ExpiryKey; label: string; days: number | null }[] = [
    { value: "0", label: "永久", days: null },
    { value: "1", label: "1 天", days: 1 },
    { value: "7", label: "7 天", days: 7 },
    { value: "30", label: "30 天", days: 30 },
];

function fullTime(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 分享笔记弹窗 —— 布局与交互照 inkstone 的 SharePanel（2026-10-08 用户要求
 * 「布局和功能做得一模一样」）：
 *   链接盒（只读链接 + 复制 + 打开）→ 状态行（到期状态 / 创建时间）→
 *   有效期分段选择（有到期时多一档「保持当前」）→ 只读说明 →
 *   底部：撤销链接（左，危险）/ 完成 / 更新设置。
 * 访问口令（可选，受口令保护时公开页弹出口令框）与浏览次数（每次打开 +1）已补。
 */
export default function NoteShareDialog({
    id,
    api,
    onClose,
    onChanged,
    noteTitle,
}: {
    id: number;
    api: NoteShareApi;
    onClose: () => void;
    /** 分享状态变化（创建/更新/撤销）后回调；设置页用它刷新列表 */
    onChanged?: () => void;
    /** 笔记标题（inkstone 的 Modal description 就是它）：从笔记工具栏打开时
     *  能自己取到，从设置→分享列表里「管理」进来时由列表行把标题带过来。 */
    noteTitle?: string;
}) {
    const [share, setShare] = useState<NoteShare | null | undefined>(undefined);
    const [expiry, setExpiry] = useState<ExpiryKey>("0");
    const [busy, setBusy] = useState<"save" | "revoke" | null>(null);
    const [copied, setCopied] = useState(false);
    const [message, setMessage] = useState("");
    const [confirmRevoke, setConfirmRevoke] = useState(false);
    // 访问口令：开关「需要访问口令」+ 口令输入框。
    // pwEnabled 初始跟后端 hasPassword 走；pwTouched 标记用户是否动过口令，
    // 没动过就按「保持原值」发（undefined），避免一打开就误清空已有口令。
    const [pwEnabled, setPwEnabled] = useState(false);
    const [pw, setPw] = useState("");
    const [pwTouched, setPwTouched] = useState(false);

    useEffect(() => {
        let live = true;
        setShare(undefined);
        setExpiry("0");
        setCopied(false);
        setMessage("");
        setPw("");
        setPwTouched(false);
        api.getNoteShare(id)
            .then(value => {
                if (!live) return;
                setShare(value);
                // 已有有效期时默认选中「保持当前」，避免一打开就误改
                setExpiry(value?.expires_at ? "keep" : "0");
                // 已有口令则默认开开关；具体口令不回前端（只能重设），空着等用户填
                setPwEnabled(!!value?.hasPassword);
            })
            .catch(() => {
                if (live) setMessage("无法读取分享状态，请关闭后重试");
            });
        return () => {
            live = false;
        };
    }, [api, id]);

    /**
     * 算这次要发给后端的 password：
     *   - 开关关 → null（明确清除）
     *   - 开关开但没动过 → undefined（保持原值，已有口令不误清、原本没有也不误设）
     *   - 开关开且填了 → 那个口令（重设/设置）
     *   - 开关开但清空了 → undefined（保持原值）
     */
    const passwordToSend = (): string | null | undefined => {
        if (!pwEnabled) return null;
        if (!pwTouched) return undefined;
        return pw.length > 0 ? pw : undefined;
    };

    const link = share ? `${location.origin}/s/${share.token}` : "";

    const copy = async () => {
        if (!share) return;
        try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
        } catch {
            setMessage("复制失败，请手动复制链接");
        }
    };

    const daysFor = (key: ExpiryKey): number | null => {
        if (key === "keep") return null;
        return EXPIRY_OPTIONS.find(o => o.value === key)?.days ?? null;
    };

    /** 应用设置（已有分享时）；「保持当前」= 不动有效期 */
    const save = async () => {
        if (!share) return;
        setBusy("save");
        setMessage("");
        try {
            if (expiry === "keep") {
                // 有效期不动，但仍要把口令状态同步过去（可能改了口令/开关）
                const value = await api.updateNoteShare(id, null, passwordToSend());
                if (!value) throw new Error("分享不存在");
                setShare(value);
                // 口令已同步，重置「改动」标记；保留有效期「保持当前」
                setPwTouched(false);
                setMessage(value.hasPassword ? "分享设置已更新（链接不变，口令已设置）" : "分享设置已更新（链接不变，已取消口令）");
                return;
            }
            const value = await api.updateNoteShare(id, daysFor(expiry), passwordToSend());
            if (!value) throw new Error("分享不存在");
            setShare(value);
            setExpiry("keep");
            setPwTouched(false);
            onChanged?.();
            setMessage(value.hasPassword ? "分享设置已更新（链接不变，口令已设置）" : "分享设置已更新（链接不变）");
        } catch (error) {
            setMessage("操作失败：" + (error instanceof Error ? error.message : "未知错误"));
        } finally {
            setBusy(null);
        }
    };

    const generate = async () => {
        setBusy("save");
        setMessage("");
        try {
            const value = await api.createNoteShare(id, daysFor(expiry), passwordToSend());
            if (!value) throw new Error("笔记不存在");
            setShare(value);
            setExpiry("keep");
            setPwTouched(false);
            setPwEnabled(!!value.hasPassword);
            onChanged?.();
            setMessage(value.hasPassword ? "公开链接已生成（已设置访问口令）" : "公开链接已生成");
        } catch (error) {
            setMessage("操作失败：" + (error instanceof Error ? error.message : "未知错误"));
        } finally {
            setBusy(null);
        }
    };

    const revoke = async () => {
        setBusy("revoke");
        setMessage("");
        try {
            const result = await api.revokeNoteShare(id);
            if (!result.success) throw new Error("撤销失败");
            setShare(null);
            setExpiry("0");
            onChanged?.();
            setMessage("链接已撤销");
        } catch (error) {
            setMessage("操作失败：" + (error instanceof Error ? error.message : "未知错误"));
        } finally {
            setBusy(null);
        }
    };

    const expired = share?.expires_at != null && share.expires_at <= Date.now();
    // created_at 在 D1 里可能是数字毫秒也可能是字符串，两种都得认
    const createdTs =
        typeof share?.created_at === "number"
            ? share.created_at
            : share?.created_at
              ? Date.parse(String(share.created_at))
              : null;

    /** 分段选择：已有到期时间时多一档「保持当前」（inkstone 同款） */
    const expiryOptions = [
        ...(share?.expires_at ? [{ value: "keep" as ExpiryKey, label: "保持当前" }] : []),
        ...EXPIRY_OPTIONS.map(o => ({ value: o.value, label: o.label })),
    ];

    return (
        <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth='sm'>
            <DialogTitle>分享笔记</DialogTitle>
            <DialogContent>
                <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
                    {noteTitle
                        ? `「${noteTitle}」· 管理这条笔记的只读公开链接`
                        : "管理这条笔记的只读公开链接"}
                </Typography>

                {share ? (
                    <>
                        {/* 链接盒（inkstone SharePanel 同款：链接 + 复制 + 打开） */}
                        <Box
                            data-share-link-box='1'
                            sx={{
                                border: "1px solid rgba(128,128,128,0.25)",
                                borderRadius: 2,
                                bgcolor: "rgba(128,128,128,0.06)",
                                p: 1.25,
                            }}
                        >
                            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                                <LinkIcon fontSize='small' sx={{ color: "var(--accent)", flexShrink: 0 }} />
                                <input
                                    readOnly
                                    value={link}
                                    aria-label='公开链接'
                                    onFocus={e => e.currentTarget.select()}
                                    style={{
                                        minWidth: 0,
                                        flex: 1,
                                        background: "transparent",
                                        border: "none",
                                        outline: "none",
                                        font: "12px/1.4 ui-monospace, monospace",
                                        color: "inherit",
                                    }}
                                />
                                <Button
                                    size='small'
                                    variant={copied ? "text" : "outlined"}
                                    startIcon={copied ? <CheckIcon fontSize='small' /> : <ContentCopyIcon fontSize='small' />}
                                    data-share-action='copy'
                                    onClick={() => void copy()}
                                >
                                    {copied ? "已复制" : "复制"}
                                </Button>
                                <Button
                                    size='small'
                                    variant='text'
                                    startIcon={<OpenInNewIcon fontSize='small' />}
                                    aria-label='打开链接'
                                    data-share-action='open'
                                    onClick={() => globalThis.open(link, "_blank", "noopener")}
                                >
                                    打开
                                </Button>
                            </Box>
                            <Box
                                sx={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    alignItems: "center",
                                    gap: 1.5,
                                    borderTop: "1px solid rgba(128,128,128,0.18)",
                                    mt: 1.25,
                                    pt: 1.25,
                                }}
                            >
                                <Typography
                                    variant='caption'
                                    data-share-expiry='1'
                                    sx={{ color: expired ? "error.main" : "text.secondary" }}
                                >
                                    {share.expires_at == null
                                        ? "永久有效"
                                        : expired
                                          ? "已过期"
                                          : `到期于 ${fullTime(share.expires_at)}`}
                                </Typography>
                                <Box sx={{ flex: 1 }} />
                                {createdTs !== null && Number.isFinite(createdTs) && (
                                    <Typography variant='caption' color='text.disabled'>
                                        创建于 {fullTime(createdTs)}
                                    </Typography>
                                )}
                                {share.views != null && (
                                    <Typography variant='caption' color='text.secondary'>
                                        浏览 {share.views} 次
                                    </Typography>
                                )}
                            </Box>
                        </Box>
                    </>
                ) : (
                    <Typography variant='body2' color='text.secondary'>
                        还没有生成公开链接。选好有效期后点右下角「生成公开链接」。
                    </Typography>
                )}

                {/* 有效期（分段选择，inkstone 的 Segmented 同款） */}
                <Typography variant='body2' sx={{ fontWeight: 600, mt: 2.5, mb: 1 }}>
                    有效期
                </Typography>
                <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }} data-share-expiry-options='1'>
                    {expiryOptions.map(opt => {
                        const active = opt.value === expiry;
                        return (
                            <Box
                                key={opt.value}
                                component='button'
                                type='button'
                                data-expiry-option={opt.value}
                                disabled={busy !== null}
                                onClick={() => setExpiry(opt.value)}
                                sx={{
                                    px: 1.25,
                                    py: 0.4,
                                    fontSize: 12,
                                    borderRadius: 1.5,
                                    cursor: "pointer",
                                    appearance: "none",
                                    font: "inherit",
                                    border: active
                                        ? "1px solid var(--accent)"
                                        : "1px solid rgba(128,128,128,0.35)",
                                    bgcolor: active ? "rgba(176,67,58,0.08)" : "transparent",
                                    color: active ? "var(--accent)" : "text.secondary",
                                }}
                            >
                                {opt.label}
                            </Box>
                        );
                    })}
                </Box>

                {/* 访问口令（inkstone SharePanel 同款）：可选，开启后公开页需输口令才能看 */}
                <Box sx={{ mt: 2.5 }}>
                    <FormControlLabel
                        control={
                            <Switch
                                checked={pwEnabled}
                                disabled={busy !== null || share === undefined}
                                onChange={e => {
                                    setPwEnabled(e.target.checked);
                                    setPwTouched(true);
                                }}
                                data-share-pw-switch='1'
                            />
                        }
                        label='需要访问口令'
                    />
                    {pwEnabled && (
                        <TextField
                            type='password'
                            size='small'
                            fullWidth
                            autoComplete='new-password'
                            value={pw}
                            disabled={busy !== null}
                            placeholder={share?.hasPassword && !pwTouched ? "留空则保持当前口令" : "访问者需输入此口令"}
                            helperText={share?.hasPassword
                                ? "已设置口令；要更换就重新填入，要取消就关掉上方开关"
                                : "设置后，拿到链接的人也需要输入此口令才能查看"}
                            onChange={e => {
                                setPw(e.target.value);
                                setPwTouched(true);
                            }}
                            slotProps={{ input: { "aria-label": "访问口令" } }}
                            data-share-pw-input='1'
                            sx={{ mt: 0.5 }}
                        />
                    )}
                </Box>

                <Alert severity='info' variant='outlined' sx={{ mt: 2.5 }}>
                    公开链接为只读。访问者只能查看这条笔记的最新内容，无法访问其他笔记。
                </Alert>
                {message && (
                    <Alert sx={{ mt: 1.5 }} severity='info'>
                        {message}
                    </Alert>
                )}
            </DialogContent>
            <DialogActions sx={{ px: 2.5 }}>
                {share && (
                    <Button
                        color='error'
                        startIcon={<LinkOffIcon fontSize='small' />}
                        data-share-action='revoke'
                        disabled={busy !== null}
                        sx={{ mr: "auto" }}
                        onClick={() => setConfirmRevoke(true)}
                    >
                        撤销链接
                    </Button>
                )}
                <Button disabled={busy !== null} onClick={onClose}>
                    {share ? "完成" : "取消"}
                </Button>
                <Button
                    disabled={busy !== null || (!!share && expiry === "keep")}
                    variant='contained'
                    data-share-action={share ? "update" : "create"}
                    onClick={() => void (share ? save() : generate())}
                >
                    {share ? "更新设置" : "生成公开链接"}
                </Button>
            </DialogActions>

            {confirmRevoke && (
                <ConfirmDialog
                    open
                    danger
                    title='撤销这条公开链接？'
                    description='拿到链接的人将立即失去访问权限。'
                    confirmText='撤销链接'
                    onConfirm={async () => {
                        await revoke();
                    }}
                    onClose={() => setConfirmRevoke(false)}
                />
            )}
        </Dialog>
    );
}
