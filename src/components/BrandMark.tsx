// src/components/BrandMark.tsx
// 站点图标：自动取 favicon，取不到逐级回落，最后才是锁图标。
//
// 2026-10-22 从 LoginForm.tsx 提取成共享组件：登录页（A8 品牌化）与
// 公开分享页（B5 品牌头图）都要用同一个「图标 + 站点名」的组合，
// 各写一份就会出现「登录页图标换了、分享页还是老的」这种分叉。
import React, { useEffect, useMemo, useState } from "react";
import { Box } from "@mui/material";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";

/** 图标候选的等待上限：图标 API 卡住时不能让图标一直空着 */
const ICON_FALLBACK_MS = 3000;

/**
 * 站点图标候选，按序回落：
 *   1. 本站自带的 favicon.svg / favicon.ico —— 换域名部署图标自动跟着换，不用改代码；
 *   2. 默认图标 API 按当前域名抓一份（本地开发时 hostname 是 localhost，抓不到，跳过）；
 *   3. 都拿不到才回到锁图标。
 */
function buildIconCandidates(): string[] {
    if (typeof window === "undefined") return [];
    const list = ["/favicon.svg", "/favicon.ico"];
    const host = window.location.hostname;
    if (host && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host)) {
        list.push(`https://www.faviconextractor.com/favicon/${host}?larger=true`);
    }
    return list;
}

export const BrandMark: React.FC<{ size?: number }> = ({ size = 64 }) => {
    const candidates = useMemo(buildIconCandidates, []);
    const [index, setIndex] = useState(0);
    const [loaded, setLoaded] = useState(false);

    // 超时或加载失败都换下一个候选；加载成功就撤掉计时器，别把好图标换掉
    useEffect(() => {
        if (loaded || index >= candidates.length) return;
        const timer = window.setTimeout(() => {
            setLoaded(false);
            setIndex(i => i + 1);
        }, ICON_FALLBACK_MS);
        return () => window.clearTimeout(timer);
    }, [index, loaded, candidates.length]);

    const src = candidates[index];

    if (!src) {
        return (
            <Box
                sx={{
                    width: size,
                    height: size,
                    borderRadius: 2,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    bgcolor: "primary.main",
                    color: "common.white",
                }}
            >
                <LockOutlinedIcon fontSize='large' />
            </Box>
        );
    }

    return (
        <Box
            component='img'
            src={src}
            alt=''
            onLoad={() => setLoaded(true)}
            onError={() => {
                setLoaded(false);
                setIndex(i => i + 1);
            }}
            sx={{
                width: size,
                height: size,
                borderRadius: 2,
                objectFit: "contain",
                p: 0.5,
                bgcolor: "background.paper",
                border: "1px solid",
                borderColor: "divider",
            }}
        />
    );
};
