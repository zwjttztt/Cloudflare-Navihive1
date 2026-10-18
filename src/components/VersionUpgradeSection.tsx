// src/components/VersionUpgradeSection.tsx
// 网站设置里的「版本与升级」一节。
//
// 职责很小：显示当前运行版本（构建时烘进来的 `v{semver}+短哈希`，与右下角
// BuildBadge 同源），提供「检查更新」按钮去 GitHub 拉仓库 main 分支的
// package.json 比对版本号。它不碰本站 API —— 版本比对是纯前端行为，
// 跟设置草稿（tempConfigs）也无关，所以做成自包含组件，不需要任何 props。
//
// 为什么取 raw.githubusercontent.com 而不是 api.github.com：
//   - raw 域名带 Access-Control-Allow-Origin: *，浏览器直连无 CORS 问题；
//   - api.github.com 匿名额度（60 次/小时/IP）更容易被共享出口 IP 耗尽。
// 本站 CSP 的 connect-src 是 `'self' https:`，外域 https fetch 放行。
import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Typography } from "@mui/material";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import { Section } from "./dialogSection";
import { appVersion } from "../utils/appVersion";

/** 仓库 main 分支的 package.json：version 字段即最新发布版本 */
const UPSTREAM_PACKAGE_URL =
    "https://raw.githubusercontent.com/zwjttztt/Cloudflare-Navihive1/main/package.json";

/** 发版页：发现新版本时给用户一个直达入口 */
const RELEASES_URL = "https://github.com/zwjttztt/Cloudflare-Navihive1/releases";

type CheckState =
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "latest" }
    | { kind: "available"; version: string }
    | { kind: "error"; message: string };

/** 出结果了（latest / available / error） */
function hasResult(s: CheckState): boolean {
    return s.kind === "latest" || s.kind === "available" || s.kind === "error";
}

/** 自托管（Docker）的一键升级命令：「更新」按钮复制它 */
const UPGRADE_CMD = "docker pull ghcr.io/zwjttztt/navihive:latest";

/**
 * 从 `v3.4.0+abc123` / `3.4.0` 这类串里抽出 (major, minor, patch)。
 * Docker 无 .git 时构建号兜底形如 `v1234+...`，解析不出三段就返回 null，
 * 由调用方退化为「无法确定本地版本」的展示。
 */
export function parseSemver(raw: string): [number, number, number] | null {
    const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(
    a: [number, number, number],
    b: [number, number, number],
): number {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/**
 * 检查更新。独立导出以便单测直接驱动（不经过 MUI 渲染层）。
 * 拉不到 / 响应不是合法 JSON / 缺 version 字段，一律抛错由调用方兜住。
 */
export async function fetchUpstreamVersion(
    url: string = UPSTREAM_PACKAGE_URL,
): Promise<string> {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
        throw new Error(`GitHub 返回 ${res.status}`);
    }
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version !== "string" || !parseSemver(data.version)) {
        throw new Error("响应里没有可识别的版本号");
    }
    return data.version;
}

export default function VersionUpgradeSection({ version }: { version?: string }) {
    const [state, setState] = useState<CheckState>({ kind: "idle" });
    /** 「更新」按钮的复制结果：true=已复制 / false=复制失败（给命令原文手动复制） */
    const [copyState, setCopyState] = useState<boolean | null>(null);
    /** 按钮 + 结果行：结果 Alert 会把它撑高，出结果时滚进可视区（同 BackupDialog 的 webdavActionsRef 模式） */
    const rowRef = useRef<HTMLDivElement>(null);

    // 版本号可注入（单测没有 vite define，appVersion() 是空串）；
    // 不传时走真实来源，与右下角 BuildBadge 同源。
    const localVersion = version ?? appVersion();
    const localSemver = parseSemver(localVersion);

    // 检查更新结果出现时，把这一行滚进弹窗可视区：网站设置是长得最长的弹窗，
    // 「版本与升级」在最底部，结果 Alert 不滚的话停在内容折叠线下面（用户报
    // 「点检查更新后弹出的提示框还要往下移动很不方便」）。
    useEffect(() => {
        if (!hasResult(state)) return;
        const el = rowRef.current;
        if (!el) return;
        const scroller = el.closest(".MuiDialogContent-root");
        // scrollTo 在 jsdom 等环境不存在：防御一下，别让「滚动兜底」本身抛错
        if (scroller && typeof scroller.scrollTo === "function") {
            scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
        } else if (typeof el.scrollIntoView === "function") {
            el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }, [state]);

    /** 「更新」按钮（2026-10-18 用户报「发现新版本能否加上一个更新按键」）：
     *  自托管部署 = 复制 docker pull 命令，用户到服务器粘贴执行（前端点不到
     *  用户的服务器，这是能做的最短路径）；复制失败时命令原文直接摆出来。
     *  Workers 部署不用操作（推 main 即自动构建），命令区的文字指引里已说明。 */
    const onUpdate = () => {
        const cmd = UPGRADE_CMD;
        if (!navigator.clipboard?.writeText) {
            setCopyState(false);
            return;
        }
        void navigator.clipboard.writeText(cmd).then(
            () => setCopyState(true),
            () => setCopyState(false),
        );
    };

    const onCheck = async () => {
        setState({ kind: "checking" });
        setCopyState(null);
        try {
            const remote = await fetchUpstreamVersion();
            const remoteSemver = parseSemver(remote);
            if (!remoteSemver || !localSemver) {
                // 本地是构建号兜底（Docker 无 .git）或远端格式异常时比不了，
                // 给出「去发版页看」的出口而不是空话。
                setState({ kind: "error", message: `无法比较版本（远端 ${remote}），可到发版页确认。` });
                return;
            }
            setState(
                compareSemver(remoteSemver, localSemver) > 0
                    ? { kind: "available", version: remote }
                    : { kind: "latest" },
            );
        } catch (err) {
            setState({
                kind: "error",
                message: err instanceof Error ? err.message : "网络请求失败",
            });
        }
    };

    return (
        <Section title='版本与升级' hint='检查更新会向 GitHub 发一次匿名请求，只取最新版本号。'>
            <Box data-version-section='1'>
                <Typography variant='body2' component='div'>
                    当前版本：
                    <Typography
                        component='span'
                        variant='body2'
                        sx={{ fontWeight: 600 }}
                        title={localVersion || undefined}
                        data-current-version={
                            (localVersion ? localVersion.split("+")[0] : "") || "dev"
                        }
                    >
                        {/* 只显示语义版本（v3.5.0）：+短哈希/构建号收进 title 悬浮提示，
                            与右下角徽标同口径 —— 「常驻要短」的尺子是同一把 */}
                        {localVersion ? localVersion.split("+")[0] : "开发模式（未构建）"}
                    </Typography>
                </Typography>
                <Box sx={{ mt: 1, display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }} ref={rowRef}>
                    <Button
                        size='small'
                        variant='outlined'
                        startIcon={<SystemUpdateAltIcon fontSize='small' />}
                        onClick={onCheck}
                        disabled={state.kind === "checking"}
                        data-check-update='1'
                    >
                        {state.kind === "checking" ? "检查中…" : "检查更新"}
                    </Button>
                    {/* 「更新」按钮：只在发现新版本时出现（2026-10-18 用户报
                        「发现新版本能否加上一个更新按键」）。一键复制升级命令 ——
                        自托管部署到服务器粘贴执行即可；Workers 部署推 main
                        自动构建、无需操作（下方指引里有说明）。 */}
                    {state.kind === "available" && (
                        <Button
                            size='small'
                            variant='contained'
                            startIcon={<SystemUpdateAltIcon fontSize='small' />}
                            onClick={onUpdate}
                            data-update-action='1'
                            sx={{ flexShrink: 0 }}
                        >
                            更新
                        </Button>
                    )}
                    {/* 结果与按钮同一行：原来 Alert 排在按钮正下方，网站设置弹窗
                        长、本节又在最底部，结果停在内容折叠线下面要手动滚 */}
                    {state.kind === "latest" && (
                        <Alert severity='success' data-update-result='latest' sx={{ py: 0 }}>
                            已是最新版本。
                        </Alert>
                    )}
                    {state.kind === "available" && (
                        <Alert severity='info' data-update-result='available' sx={{ py: 0, flex: 1, minWidth: 220 }}>
                            发现新版本 {state.version}。
                            <Box component='span' sx={{ display: "block", mt: 0.5 }}>
                                Docker 部署：在服务器上执行
                                <Box
                                    component='code'
                                    sx={{ mx: 0.5, px: 0.5, bgcolor: "action.hover", borderRadius: 0.5 }}
                                >
                                    docker pull ghcr.io/zwjttztt/navihive:latest
                                </Box>
                                然后重建容器即可。
                                Workers 部署：推送 main 分支后由 Cloudflare 自动构建，无需手动操作。
                                更新内容见
                                <a href={RELEASES_URL} target='_blank' rel='noreferrer'>
                                    发版页
                                </a>
                                。
                            </Box>
                        </Alert>
                    )}
                    {state.kind === "error" && (
                        <Alert severity='warning' data-update-result='error' sx={{ py: 0 }}>
                            检查失败：{state.message}
                        </Alert>
                    )}
                    {/* 「更新」按钮的复制反馈：成功一句确认；失败把命令原文
                        摆出来（用户还能手动复制）*/}
                    {copyState === true && (
                        <Alert severity='success' data-update-copied='1' sx={{ py: 0 }}>
                            更新命令已复制，到服务器粘贴执行；Workers 部署推送 main 即自动构建。
                        </Alert>
                    )}
                    {copyState === false && (
                        <Alert severity='warning' data-update-copy-failed='1' sx={{ py: 0 }}>
                            复制失败，请手动复制：<Box component='code' sx={{ px: 0.5 }}>{UPGRADE_CMD}</Box>
                        </Alert>
                    )}
                </Box>
            </Box>
        </Section>
    );
}
