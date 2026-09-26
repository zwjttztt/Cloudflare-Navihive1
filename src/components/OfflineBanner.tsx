// 断网提示：离线时顶部固定一条提示，恢复后闪一条「已恢复」。
// 导航站的数据全在云端，离线状态下改东西会失败，不提示的话用户只会觉得「点了没反应」。
import { useEffect, useState } from "react";
import { Alert, Box } from "@mui/material";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import CloudDoneIcon from "@mui/icons-material/CloudDone";

export default function OfflineBanner() {
    const [offline, setOffline] = useState(
        () => typeof navigator !== "undefined" && navigator.onLine === false
    );
    const [justBackOnline, setJustBackOnline] = useState(false);

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
                    ? "网络已断开：现在改的内容存不到服务器，等恢复后再操作一次"
                    : "网络已恢复"}
            </Alert>
        </Box>
    );
}
