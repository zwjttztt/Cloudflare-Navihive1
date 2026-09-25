// src/components/HeaderClock.tsx
// 头部小部件：实时时钟 + 日期 + 星期。纯本机时间，不请求网络。
import { useEffect, useState } from "react";
import { Box, Typography } from "@mui/material";

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const two = (n: number) => String(n).padStart(2, "0");

export default function HeaderClock() {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        // 每秒对齐刷新，比固定 1000ms 间隔更不容易「跳秒」
        let timer = 0;
        const tick = () => {
            setNow(new Date());
            timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
        };
        tick();
        return () => window.clearTimeout(timer);
    }, []);

    const time = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
    const date = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const week = WEEK[now.getDay()];

    return (
        <Box
            className='nav-clock'
            aria-label={`当前时间 ${time} ${date} ${week}`}
            sx={{ display: { xs: "none", md: "flex" }, mr: 0.5 }}
        >
            <Typography className='nav-clock-time' sx={{ fontSize: 20 }}>
                {time}
            </Typography>
            <Typography variant='caption' color='text.secondary' sx={{ fontSize: 11 }}>
                {date} {week}
            </Typography>
        </Box>
    );
}
