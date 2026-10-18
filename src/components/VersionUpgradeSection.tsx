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
import { useState } from "react";
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

    // 版本号可注入（单测没有 vite define，appVersion() 是空串）；
    // 不传时走真实来源，与右下角 BuildBadge 同源。
    const localVersion = version ?? appVersion();
    const localSemver = parseSemver(localVersion);

    const onCheck = async () => {
        setState({ kind: "checking" });
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
                <Box sx={{ mt: 1, display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
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
                </Box>
                {state.kind === "latest" && (
                    <Alert severity='success' sx={{ mt: 1 }} data-update-result='latest'>
                        已是最新版本。
                    </Alert>
                )}
                {state.kind === "available" && (
                    <Alert severity='info' sx={{ mt: 1 }} data-update-result='available'>
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
                    <Alert severity='warning' sx={{ mt: 1 }} data-update-result='error'>
                        检查失败：{state.message}
                    </Alert>
                )}
            </Box>
        </Section>
    );
}
