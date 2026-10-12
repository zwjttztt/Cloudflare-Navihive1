// src/components/MaintenanceBanner.tsx
// 维护模式横幅：服务端开着 `maintenance.enabled` 时挂出来。
//
// 为什么需要它：维护期间**写操作会被 503 拦下**（worker/routes/middleware.ts），
// 用户点任何按钮都只会看到一句「暂时不能修改」。没有横幅的话，第一反应是
// 「站坏了 / 我的数据出问题了」—— 而实际上只是运维在改库，读操作一切正常。
//
// 轮询而不是一次性：维护是运维时临时开的，开着的时候用户要尽快看到，
// 关了也要尽快消失。60 秒一次，代价是一个极小的 GET（还走 no-store）。
import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import BuildIcon from "@mui/icons-material/Build";

const POLL_MS = 60_000;

/** 只依赖「探测维护状态」这一个方法：App 里的 api 可能是真客户端也可能是 mock */
interface MaintenanceProbe {
    checkMaintenance(): Promise<boolean>;
}

export default function MaintenanceBanner({ client }: { client: MaintenanceProbe }) {
    const [on, setOn] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const poll = async () => {
            try {
                const next = await client.checkMaintenance();
                // 竞态防护：组件卸载后回来的响应不能改状态
                if (!cancelled) setOn(next);
            } catch {
                // 探测失败就当「没在维护」：横幅是提示，不能因为它自己出错把页面搞挂
                // （不兜的话这里是 unhandledRejection，node:test 会直接判红）
            }
        };
        poll();
        const timer = setInterval(poll, POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [client]);

    if (!on) return null;

    return (
        <Box
            role='status'
            aria-live='polite'
            sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 1,
                py: 0.75,
                px: 2,
                bgcolor: "warning.main",
                color: "warning.contrastText",
            }}
        >
            <BuildIcon fontSize='small' />
            <Typography variant='body2' sx={{ fontWeight: 600 }}>
                系统维护中：数据可以正常查看，暂时不能修改。维护结束后会自动恢复。
            </Typography>
        </Box>
    );
}
