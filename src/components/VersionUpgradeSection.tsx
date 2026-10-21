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
import { localBuildVersion } from "../utils/buildVersion";
import { reloadWithFreshCache, waitForUpgrade } from "../utils/upgradeWait";

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
    /**
     * 「更新」按钮的三态结果：
     *  - true：升级命令已复制（回落路径）
     *  - false：复制失败（命令原文摆出来）
     *  - "upgrading"：网页直接升级已触发（自托管 + docker.sock）
     *  - null：没动作
     */
    const [copyState, setCopyState] = useState<boolean | "upgrading" | null>(null);
    /**
     * 网页升级的终局：跑完才知道成没成。
     * 以前点完只挂一句「升级中」，成了不吭声、败了也不说 —— 用户只能自己去刷新
     * 然后发现「还是原来版本」（2026-10-20 的报障就是这么来的）。
     * null = 还没结论（对应上面的 "upgrading"）。
     */
    const [upgradeOutcome, setUpgradeOutcome] = useState<
        { kind: "done" } | { kind: "failed"; message: string } | null
    >(null);
    /**
     * 「升级中」已经等了多少秒。
     * 2026-10-21 用户报「点更新又长时间没反应」—— 服务端那边现在会在几秒内给出结论
     * （见 dockerUpgradeSelf 的镜像 ID 比对），但只要还在跑，这一行就该**看得出在动**，
     * 否则跟卡死没区别。纯展示，不参与任何判断。
     */
    const [waitedSec, setWaitedSec] = useState(0);
    /** 按钮 + 结果行：结果 Alert 会把它撑高，出结果时滚进可视区（同 BackupDialog 的 webdavActionsRef 模式） */
    const rowRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (copyState !== "upgrading" || upgradeOutcome !== null) {
            setWaitedSec(0);
            return;
        }
        const timer = setInterval(() => setWaitedSec(n => n + 1), 1000);
        return () => clearInterval(timer);
    }, [copyState, upgradeOutcome]);

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

    /**
     * 升级触发后的跟进：等服务端换成新版本，再清缓存重载。
     *
     * 没有构建号（开发模式 / 老产物）时无从判断版本，只能停在「升级中」——
     * 这时用户自己刷新即可，不去猜。
     */
    const watchUpgrade = async () => {
        const local = localBuildVersion();
        if (!local) return;
        const result = await waitForUpgrade({ localVersion: local });
        if (result.kind === "upgraded") {
            setUpgradeOutcome({ kind: "done" });
            // 让「升级完成」先露一眼再刷，否则页面直接闪掉，用户看不出发生了什么
            await new Promise<void>(resolve => setTimeout(resolve, 1200));
            await reloadWithFreshCache();
            return;
        }
        // 失败/超时：把按钮放回可用状态（能重试），原因如实摆出来
        setCopyState(null);
        setUpgradeOutcome({
            kind: "failed",
            message:
                result.kind === "failed"
                    ? result.message
                    : "等了 2 分钟没检测到新版本：镜像可能还在构建（仓库版本比镜像早几分钟）。稍后刷新再看，或到服务器 compose 目录执行 docker compose pull && docker compose up -d --force-recreate。",
        });
    };

    /**
     * 「更新」按钮（2026-10-18 用户报「发现新版本能否加上一个更新按键」，
     * 再报「能否直接在网页升级版本」）：
     *  1. **优先网页直接升级**：POST /api/system/upgrade（自托管 + docker.sock
     *     才有；owner only）。服务端先响应再 detached 执行「拉镜像 → helper 容器
     *     里 compose 重建本容器」—— 约 10-30s 后服务短暂重启。
     *     拿到 200 后立刻开始跟进（watchUpgrade）：成功就自动刷到新版，
     *     失败就把服务端给的原因摆出来，不再让用户对着「升级中」干等。
     *  2. 回落：404（Workers 部署没有这个端点）/ 501（没挂 docker.sock）/
     *     任何网络错误 → 复制 docker pull 命令，用户到服务器粘贴执行；
     *     复制失败时命令原文直接摆出来。
     */
    const onUpdate = async () => {
        try {
            const res = await fetch("/api/system/upgrade", {
                method: "POST",
                credentials: "same-origin",
            });
            if (res.status === 404 || res.status === 501) throw new Error("unsupported");
            const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
            if (res.ok && data?.ok) {
                setCopyState("upgrading");
                setUpgradeOutcome(null);
                void watchUpgrade();
                return;
            }
            throw new Error("upgrade-failed");
        } catch {
            // 回落：复制命令（原路径）
            const cmd = UPGRADE_CMD;
            if (!navigator.clipboard?.writeText) {
                setCopyState(false);
                return;
            }
            void navigator.clipboard.writeText(cmd).then(
                () => setCopyState(true),
                () => setCopyState(false),
            );
        }
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
        <Section title='版本与升级' hint='只比对版本号，不上传任何数据。'>
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
                            onClick={() => void onUpdate()}
                            disabled={copyState === "upgrading"}
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
                            发现新版本 {state.version}，点「更新」自动升级。更新内容见
                            <a href={RELEASES_URL} target='_blank' rel='noreferrer'>
                                发版页
                            </a>
                            。
                        </Alert>
                    )}
                    {state.kind === "error" && (
                        <Alert severity='warning' data-update-result='error' sx={{ py: 0 }}>
                            检查失败：{state.message}
                        </Alert>
                    )}
                    {/* 「更新」按钮的反馈：网页升级有「进行中 / 完成 / 未完成」三态，
                        复制回落有「已复制 / 复制失败」两态 */}
                    {copyState === "upgrading" && upgradeOutcome === null && (
                        <Alert severity='info' data-update-running='1' sx={{ py: 0, flex: 1, minWidth: 220 }}>
                            升级中：正在拉取镜像并重建容器（已等 {waitedSec} 秒，最多 2 分钟会给结论）。
                            页面自动刷新前请勿关闭。
                        </Alert>
                    )}
                    {upgradeOutcome?.kind === "done" && (
                        <Alert severity='success' data-update-done='1' sx={{ py: 0, flex: 1, minWidth: 220 }}>
                            升级完成，正在刷新到新版本…
                        </Alert>
                    )}
                    {upgradeOutcome?.kind === "failed" && (
                        <Alert severity='warning' data-update-failed='1' sx={{ py: 0, flex: 1, minWidth: 220 }}>
                            升级未完成：{upgradeOutcome.message}
                        </Alert>
                    )}
                    {copyState === true && (
                        <Alert severity='success' data-update-copied='1' sx={{ py: 0 }}>
                            更新命令已复制，到服务器执行即可。
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
