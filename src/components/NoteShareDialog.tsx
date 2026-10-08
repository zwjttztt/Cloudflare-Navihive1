import { useEffect, useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField } from "@mui/material";
import type { NoteShare, NoteShareListItem } from "../API/types";

export interface NoteShareApi {
    getNoteShare(id: number): Promise<NoteShare | null>;
    /** 分享列表（设置页「分享列表」用） */
    listNoteShares(): Promise<NoteShareListItem[]>;
    createNoteShare(id: number, days: number | null): Promise<NoteShare | null>;
    revokeNoteShare(id: number): Promise<{ success: boolean }>;
}

export default function NoteShareDialog({ id, api, onClose }: { id: number; api: NoteShareApi; onClose: () => void }) {
    const [share, setShare] = useState<NoteShare | null>(null);
    const [days, setDays] = useState("7");
    const [busy, setBusy] = useState(true);
    const [message, setMessage] = useState("");
    useEffect(() => {
        let live = true;
        api.getNoteShare(id).then(value => { if (live) setShare(value); })
            .catch(() => { if (live) setMessage("无法读取分享状态，请关闭后重试"); })
            .finally(() => { if (live) setBusy(false); });
        return () => { live = false; };
    }, [api, id]);
    const link = share ? `${location.origin}/s/${share.token}` : "";
    const act = async (revoke: boolean) => {
        setBusy(true);
        setMessage("");
        try {
            if (revoke) {
                const result = await api.revokeNoteShare(id);
                if (!result.success) throw new Error("撤销失败");
                setShare(null);
            } else {
                const value = await api.createNoteShare(id, days === "forever" ? null : Number(days));
                if (!value) throw new Error("笔记不存在");
                setShare(value);
            }
        } catch { setMessage("操作失败，请重试"); }
        finally { setBusy(false); }
    };
    return <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
        <DialogTitle>只读分享</DialogTitle>
        <DialogContent>
            <Alert severity="info" sx={{ mb: 2 }}>持有链接的人无需登录即可查看已保存内容。后续保存会同步到分享页；请勿分享敏感资料。</Alert>
            <TextField select label="有效期" value={days} disabled={busy} fullWidth onChange={e => setDays(e.target.value)}>
                <MenuItem value="1">1天</MenuItem><MenuItem value="7">7天</MenuItem><MenuItem value="30">30天</MenuItem><MenuItem value="forever">永久（可随时撤销）</MenuItem>
            </TextField>
            {share && <>
                <TextField sx={{ mt: 2 }} label="分享链接" fullWidth value={link} slotProps={{ input: { readOnly: true } }} />
                <p>{share.expires_at === null ? "永久有效" : `到期时间：${new Date(share.expires_at).toLocaleString()}`}</p>
                <Button disabled={busy} onClick={() => { void navigator.clipboard.writeText(link).then(() => setMessage("链接已复制"), () => setMessage("复制失败，请手动复制链接")); }}>复制链接</Button>
            </>}
            {message && <Alert sx={{ mt: 2 }} severity="info">{message}</Alert>}
        </DialogContent>
        <DialogActions>
            <Button disabled={busy} onClick={onClose}>关闭</Button>
            {share && <Button disabled={busy} color="error" onClick={() => void act(true)}>撤销分享</Button>}
            <Button disabled={busy} variant="contained" onClick={() => void act(false)}>{share ? "重新生成（旧链接失效）" : "生成分享链接"}</Button>
        </DialogActions>
    </Dialog>;
}
