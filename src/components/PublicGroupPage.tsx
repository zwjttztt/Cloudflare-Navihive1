// src/components/PublicGroupPage.tsx
// 公开分组页（2026-10-11 阶段④）：/sg/<token> 的只读书签集合页。
//
// 与 PublicNotePage 同一套交互：GET 直读；受口令的分享回 need-password，
// 就地弹口令框改走 POST。响应结构上就不含站点密码/用户名（服务端 SELECT 脱敏）。
import { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { PublicGroupAccess } from "../API/types";

export default function PublicGroupPage({ token }: { token: string }) {
    const [state, setState] = useState<"loading" | PublicGroupAccess["status"]>("loading");
    const [data, setData] = useState<Extract<PublicGroupAccess, { status: "ok" }> | null>(null);
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [notFound, setNotFound] = useState(false);

    const load = useCallback(
        async (pwd?: string) => {
            setBusy(true);
            try {
                const response = await fetch(`/api/group-shares/${encodeURIComponent(token)}`, {
                    method: pwd === undefined ? "GET" : "POST",
                    headers: { "Content-Type": "application/json" },
                    body: pwd === undefined ? undefined : JSON.stringify({ password: pwd }),
                });
                const result = (await response.json()) as PublicGroupAccess;
                if (result.status === "ok") {
                    setData(result);
                    setState("ok");
                } else {
                    setState(result.status);
                    if (result.status === "not-found") setNotFound(true);
                }
            } catch {
                // ⚠️ 必须同时改 state：只 setNotFound(true) 的话，渲染分支第一条
                // 就是 `if (state === "loading")`，state 仍是 "loading" → 页面永远
                // 停在「正在加载分享…」，访客看到一个转不完的加载态。
                // 这条是 tests/publicGroupPage.dom.test.tsx 的「网络层抛错」
                // 钉住的（与 GroupShareDialog 的 loadedOnce 是同一类坑）。
                setNotFound(true);
                setState("not-found");
            } finally {
                setBusy(false);
            }
        },
        [token]
    );

    useEffect(() => {
        void load();
    }, [load]);

    if (state === "loading") {
        return (
            <Centered>
                <Typography color='text.secondary'>正在加载分享…</Typography>
            </Centered>
        );
    }
    if (state === "not-found" || notFound) {
        return (
            <Centered>
                <Typography variant='h6'>分享不存在或已过期</Typography>
                <Typography variant='body2' color='text.secondary'>
                    链接可能已被撤销，或内容已被删除。
                </Typography>
            </Centered>
        );
    }
    if (state === "need-password") {
        return (
            <Centered>
                <Typography variant='h6'>此分享受访问口令保护</Typography>
                <form
                    onSubmit={e => {
                        e.preventDefault();
                        if (password) void load(password);
                    }}
                >
                    <TextField
                        type='password'
                        label='访问口令'
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        size='small'
                        fullWidth
                        slotProps={{ input: { "aria-label": "访问口令" } }}
                        sx={{ my: 1.5, minWidth: 260 }}
                    />
                    <Button variant='contained' type='submit' disabled={busy || !password}>
                        打开
                    </Button>
                </form>
            </Centered>
        );
    }

    const group = data!.group;
    const sites = data!.sites;
    return (
        <Box sx={{ maxWidth: 720, mx: "auto", px: 2, py: 4 }} data-public-group='1'>
            <Typography variant='h5' sx={{ fontWeight: 700, mb: 0.5 }}>
                {group.name || "分享的分组"}
            </Typography>
            <Typography variant='caption' color='text.secondary' sx={{ display: "block", mb: 2 }}>
                {sites.length} 个链接 · 浏览 {data!.views} 次
            </Typography>
            <Box sx={{ display: "grid", gap: 1 }}>
                {sites.map((site, i) => (
                    <Box
                        key={`${site.url}-${i}`}
                        component='a'
                        href={site.url}
                        target='_blank'
                        rel='noopener noreferrer nofollow'
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1.5,
                            p: 1.25,
                            borderRadius: 2,
                            border: "1px solid rgba(128,128,128,0.2)",
                            textDecoration: "none",
                            color: "inherit",
                        }}
                    >
                        {site.icon ? (
                            <Box
                                component='img'
                                src={site.icon}
                                alt=''
                                sx={{ width: 20, height: 20, objectFit: "contain", flexShrink: 0 }}
                            />
                        ) : (
                            <Box sx={{ width: 20, flexShrink: 0 }} />
                        )}
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography variant='body2' sx={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {site.name || site.url}
                            </Typography>
                            {site.description && (
                                <Typography variant='caption' color='text.secondary' sx={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {site.description}
                                </Typography>
                            )}
                        </Box>
                    </Box>
                ))}
            </Box>
        </Box>
    );
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box sx={{ minHeight: "60vh", display: "grid", placeItems: "center", textAlign: "center", px: 2 }}>
            <Box>{children}</Box>
        </Box>
    );
}
