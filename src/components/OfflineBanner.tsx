// 断网提示：离线时顶部固定一条提示，恢复后闪一条「已恢复」。
// 注意：离线改动现在会暂存本地（见 src/API/offlineQueue），联网后自动重放，
// 文案要说明「已暂存、会自动同步」，不能再写「存不到服务器、等恢复再操作一次」。
import { useEffect, useState } from "react";
import { Alert, Box } from "@mui/material";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import { pendingCount, subscribe } from "../API/offlineQueue";

export default function OfflineBanner() {
    const [offline, setOffline] = useState(
        () => typeof navigator !== "undefined" && navigator.onLine === false
    );
    const [justBackOnline, setJustBackOnline] = useState(false);
    // 离线期间排进队列、等待联网后同步的改动数量（实时订阅，入队/重放/放回都会刷新）
    const [pending, setPending] = useState(() => pendingCount());
    useEffect(() => subscribe(() => setPending(pendingCount())), []);

    useEffect(() => {
        let timer: number | undefined;
        const onOffline = () => {
            setOffline(true);
            setJustBackOnline(false);
        };
        const onOnline = () => {
            setOffline(false);
            setJustBackOnline(true);
            timer = window.setTimeout(() => setJustBackOnline(false), 2600);
        };
        window.addEventListener("offline", onOffline);
        window.addEventListener("online", onOnline);
        return () => {
            window.removeEventListener("offline", onOffline);
            window.removeEventListener("online", onOnline);
            if (timer) window.clearTimeout(timer);
        };
    }, []);

    if (!offline && !justBackOnline) return null;

    return (
        <Box
            role='status'
            aria-live='polite'
            sx={{
                position: "fixed",
                top: 10,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: t => t.zIndex.snackbar + 1,
                width: { xs: "calc(100% - 20px)", sm: "auto" },
                maxWidth: 460,
                // 这条浮在最上层，别挡住下面的操作
                pointerEvents: "none",
                transition: "opacity .2s ease",
            }}
        >
            <Alert
                severity={offline ? "warning" : "success"}
                icon={offline ? <CloudOffIcon fontSize='inherit' /> : <CloudDoneIcon fontSize='inherit' />}
                sx={{
                    borderRadius: "14px",
                    boxShadow: "var(--glass-shadow-hover)",
                    pointerEvents: "auto",
                }}
            >
                {offline
                    ? `网络已断开：改动已暂存本地${pending > 0 ? `（${pending} 项待同步）` : ""}，联网后自动同步`
                    : "网络已恢复"}
            </Alert>
        </Box>
    );
}
