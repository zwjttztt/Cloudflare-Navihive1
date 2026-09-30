// 鉴权中间件：验令牌、绑账号、查账号存活、挡跨站写。
//
// 从 worker/index.ts 拆出来。原来这段夹在公开路由与受保护路由中间，
// 谁也说不清「某个分支到底有没有过鉴权」——现在它是一个有名字的函数，
// 调用点只有 index.ts 里那一处，且必须过了它才会走到受保护路由。
//
// 返回 null = 放行；返回 Response = 就地拦截（401 / 403）。
// 放行时把当前令牌的 jti / exp 写回 session，退出登录与注销账号要用它拉黑。

import {TEXT_HEADERS, TOKEN_COOKIE, isSameOrigin, readCookie} from "../httpUtils";
import { securityHeaders } from "../util";
import type { RouteCtx } from "./types";

/** 当前令牌的身份信息，拉黑时要用 */
export interface TokenSession {
    jti: string;
    exp: number;
}

export async function enforceAuth(ctx: RouteCtx, session: TokenSession): Promise<Response | null> {
    const { request, path, method, api } = ctx;

    // 未启用鉴权的部署：整站公开，没有账号概念，直接放行
    if (!api.isAuthEnabled()) return null;

    // 令牌优先取 httpOnly cookie（浏览器主路径，JS 拿不到）；
    // 取不到再退回 Authorization 头，兼容历史客户端与自动化脚本。
    const cookieToken = readCookie(request, TOKEN_COOKIE);
    let token: string | null = cookieToken;

    if (!token) {
        const authHeader = request.headers.get("Authorization");
        if (authHeader) {
            const [authType, raw] = authHeader.split(" ");
            if (authType !== "Bearer" || !raw) {
                return new Response("无效的认证信息", {
                    status: 401,
                    headers: TEXT_HEADERS(),
                });
            }
            token = raw;
        }
    }

    if (!token) {
        return new Response("请先登录", {
            status: 401,
            headers: {
                "WWW-Authenticate": "Bearer",
            },
        });
    }

    const verifyResult = await api.verifyToken(token);
    if (!verifyResult.valid) {
        return new Response("认证已过期或无效，请重新登录", {
            status: 401,
            headers: TEXT_HEADERS(),
        });
    }
    session.jti =
        typeof verifyResult.payload?.jti === "string" ? verifyResult.payload.jti : "";
    session.exp =
        typeof verifyResult.payload?.exp === "number" ? verifyResult.payload.exp : 0;

    // 多账号：把当前账号绑到 API 实例上，之后所有分组/站点读写都只碰它的数据。
    //
    // ⚠️ 这里有一条硬约束：老令牌**可能没有 uid 字段**（多账号上线前签的）。
    // 一旦 setCurrentUser(null)，scopeSql 就不再加 user_id 条件，
    // 这张令牌能看到全站点的数据（含解密后的站点密码）——比普通越权严重得多。
    // 所以只要 users 表里已经有账号，缺 uid 的令牌一律拒绝，让它重新登录换一张。
    // （签发侧也已在 login 里堵住：users 表非空时不再走 configs 老凭据回落。）
    const uid = verifyResult.payload?.uid;
    if (typeof uid !== "number" && (await api.hasAnyUser())) {
        return new Response("登录状态已过期，请重新登录", {
            status: 401,
            headers: securityHeaders({
                "Content-Type": "text/plain; charset=utf-8",
            }),
        });
    }
    api.setCurrentUser(typeof uid === "number" ? uid : null);

    // 令牌是自包含的：账号中途被停用 / 被清除，它不会跟着失效
    // （「记住我」那张能活 30 天）。所以验签之后还要再问一句账号还在不在 ——
    // 否则停用形同虚设，被清除的账号还能继续写库、留下挂在不存在 user_id
    // 上的孤儿数据。退出登录要留着：被挡住的人至少能把自己登出去。
    if (typeof uid === "number" && path !== "logout") {
        const state = await api.getAccountSessionState(uid);
        if (state === "missing") {
            // 用 401：客户端见到 401 会清掉登录标记并退回登录页
            return Response.json(
                { success: false, message: "账号已不存在，请重新登录" },
                { status: 401 }
            );
        }
        if (state === "disabled") {
            return Response.json(
                {
                    success: false,
                    message:
                        "账号因长期未登录已被停用；可用恢复密钥找回，或联系站点所有者",
                },
                { status: 403 }
            );
        }
    }

    // 活跃时间：令牌一验过就算在用 —— 「记住我」的人每次回来只是静默恢复，
    // 根本不经过登录页，不在这里刷新就会被误判成沉睡账号。
    // 内部限频为每天最多写一次，不会每个请求都往 D1 落一行。
    if (typeof uid === "number") {
        await api.touchLastActive(uid);
    }

    // CSRF：令牌改成 cookie 后跨站请求会自动带上它，
    // 所以写操作必须确认是本站发起的（判据见 isSameOrigin 注释）。
    if (cookieToken && method !== "GET" && method !== "HEAD" && !isSameOrigin(request)) {
        return new Response("跨站请求已被拒绝", {
            status: 403,
            headers: TEXT_HEADERS(),
        });
    }

    return null;
}
