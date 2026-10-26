// src/components/HeaderClock.tsx
// 头部小部件：实时时钟 + 日期 + 星期。纯本机时间，不请求网络。
import { useEffect, useState } from "react";
import { Box, Typography } from "@mui/material";

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const two = (n: number) => String(n).padStart(2, "0");

export interface HeaderClockProps {
    /** 滚动进入紧凑模式后只留时间：宽度让给站名，日期不是随时要看的信息 */
    compact?: boolean;
}

export default function HeaderClock({ compact = false }: HeaderClockProps) {
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
            // aria-label 与 title 说同一件事，但 title 给鼠标用户看完整时间，也让缩写（compact）不至于丢信息
            aria-label={`当前时间 ${time} ${date} ${week}`}
            title={`${time} ${date} ${week}`}
            // 现在待在品牌行右侧，不再和工具栏挤一行，所以 600px 起就能显示
            sx={{ display: { xs: "none", sm: "flex" }, flexShrink: 0 }}
        >
            {/* 单行元信息：时间用正文色、日期用次要色 —— 时钟不是操作，不该占用代表交互的 accent 蓝，
                也不该比站名更抢眼。字号压到 13/12，跟 H1 拉开层级，读作「标题右端的注脚」 */}
            <Typography
                className='nav-clock-meta'
                sx={{ fontSize: 13, fontWeight: 500, color: "text.primary" }}
            >
                {time}
            </Typography>
            {!compact && (
                <>
                    <Typography
                        className='nav-clock-meta'
                        aria-hidden='true'
                        sx={{ color: "text.disabled", mx: 0.75 }}
                    >
                        ·
                    </Typography>
                    <Typography
                        className='nav-clock-meta'
                        sx={{ fontSize: 12, color: "text.secondary" }}
                        noWrap
                    >
                        {date} {week}
                    </Typography>
                </>
            )}
        </Box>
    );
}
