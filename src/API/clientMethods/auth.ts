// src/API/clientMethods/auth.ts
// NavigationClient 的「auth」域方法体：登录 / 注册 / 邀请码 / 注销账号 / 恢复密钥 / 会话列表 —— 与「我是谁」有关的那组。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: ClientThis` 让 TS 认得 this，再由 client.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationClient，也别在模块顶层读它的状态。
//
// 拆分的理由（P2-10）：client.ts 一个文件里塞了传输层与 90 个业务方法，
// 想改「笔记附件怎么传」要在 1500 行里翻。按域分开之后，每个域自己长得清楚，
// 传输层的改动（超时 / 幂等头 / 错误翻译）也不会再和业务方法混在一处。
// 范式照抄 src/API/http.ts + methods/*.ts —— 那套已经跑了很久，
// 并且有 tests/clientSurface.test.ts 盯着「域没混回原型」这类静默失效。

import {
    LoginResponse,
    SessionInfo,
    DEFAULT_TOKEN_TTL,
    REMEMBER_TOKEN_TTL,
} from "../http";
import type {
    AuthCredentialsResponse,
    RecoveryStatusResponse,
    RevokeOthersResponse,
    RevokeSessionResponse,
    SessionsResponse,
} from "../responses";
import { deviceIdField } from "../../utils/deviceId";
import { reportError } from "../../utils/errorReporter";
import { rawError, setSessionCookie } from "../transport";
import type { ClientThis } from "../transport";
import { isAuthError } from "../apiError";

export const authImpl = {
    async login(this: ClientThis, username: string, password: string, remember = false): Promise<LoginResponse> {
        try {
            const response = await fetch(`${this.baseUrl}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password, remember, ...deviceIdField() })
            });

            // 先取文本再自己解析：登录页要能分清「账号密码不对」和「压根没连上服务器」。
            // 直接 response.json() 的话，被网络拦截时返回的是代理/拦截页的 HTML，
            // 解析抛错后会掉进下面的 catch，报成「检查网络连接」——看起来像密码错了，
            // 其实是网络问题，方向完全相反。
            const raw = await response.text();
            let data: LoginResponse;
            try {
                data = JSON.parse(raw) as LoginResponse;
            } catch {
                return {
                    success: false,
                    message: `登录没有成功：服务器返回的不是正常响应（HTTP ${response.status}）。可能是网络被拦截、DNS 解析到了错误地址，或站点正在更新，请换个网络或稍后再试。`,
                };
            }

            // 服务端已通过 httpOnly cookie 下发令牌，响应体里不一定还带 token，
            // 所以判据是「登录成功」而不是「拿到了 token」
            if (data.success) {
                setSessionCookie(remember ? REMEMBER_TOKEN_TTL : DEFAULT_TOKEN_TTL);
                return data;
            }

            // 失败：服务端迁移后回的是 { error: { code, message } }，而调用方
            // （useAccountSession 等）只认 success / message。统一翻成旧形状，
            // 免得「账号密码不对」变成一句空话。
            return {
                success: false,
                message: rawError(data, response.status) || "登录失败，请检查账号密码",
            };
        } catch (error) {
            reportError(error, { source: "auth-login" });
            // 走到这里说明 fetch 本身就没成功（DNS、TLS、断网、被拦截），
            // 和服务端返回的「密码不对」不是一回事，别再笼统地说一句「检查网络连接」
            return {
                success: false,
                message:
                    '连不上服务器（请求没能发出去）。常见于 DNS 把站点解析到了错误地址、代理或防火墙拦截；可以换个网络、关掉代理后再试。',
            };
        }
    },
    async logout(this: ClientThis): Promise<void> {
        try {
            await fetch(`${this.baseUrl}/logout`, {
                method: "POST",
                credentials: "same-origin",
            });
        } catch {
            // 网络失败也要把本地状态清掉，否则界面一直显示已登录
        }
        this.clearToken();
    },
    async register(this: ClientThis, 
        username: string,
        password: string,
        inviteCode: string,
        remember = false
    ): Promise<{ success: boolean; message?: string; username?: string }> {
        try {
            const response = await fetch(`${this.baseUrl}/auth/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ username, password, inviteCode, remember, ...deviceIdField() }),
            });
            const data = await response.json().catch(() => ({ success: false }));
            if (data.success) {
                setSessionCookie(remember ? REMEMBER_TOKEN_TTL : DEFAULT_TOKEN_TTL);
                return { success: true, message: data.message || "注册成功", username: data.user?.username };
            }
            return { success: false, message: rawError(data, response.status) || "注册失败，请稍后再试" };
        } catch (error) {
            reportError(error, { source: "auth-register" });
            return { success: false, message: "注册请求失败，请检查网络连接" };
        }
    },
    async createInvite(this: ClientThis): Promise<{ success: boolean; message?: string; code?: string; expiresAt?: number }> {
        try {
            const response = await fetch(`${this.baseUrl}/auth/invite`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
            });
            const data = await response.json().catch(() => ({ success: false }));
            if (!data.success) {
                return { success: false, message: rawError(data, response.status) || "生成邀请码失败，请稍后再试" };
            }
            return { success: true, code: data.code, expiresAt: data.expiresAt, message: data.message };
        } catch (error) {
            reportError(error, { source: "invite-code" });
            return { success: false, message: "生成邀请码请求失败，请检查网络连接" };
        }
    },
    async deleteAccount(this: ClientThis, 
        currentPassword: string
    ): Promise<{ success: boolean; message?: string }> {
        try {
            const response = await fetch(`${this.baseUrl}/account`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ currentPassword }),
            });
            const data = await response.json().catch(() => ({ success: false }));
            if (data.success) this.clearToken();
            return {
                success: !!data.success,
                message: rawError(data, response.status)
                    || (data.success ? "账号已注销" : "注销失败，请稍后再试"),
            };
        } catch (error) {
            reportError(error, { source: "account-delete" });
            return { success: false, message: "注销请求失败，请检查网络连接" };
        }
    },
    async getMe(this: ClientThis): Promise<{
        id: number;
        username: string;
        role: "owner" | "user";
    } | null> {
        try {
            const response = await fetch(`${this.baseUrl}/auth/me`, {
                credentials: "same-origin",
            });
            if (!response.ok) return null;
            const data = (await response.json()) as {
                id?: number;
                username?: string;
                role?: string;
            };
            if (typeof data.username !== "string") return null;
            return {
                id: typeof data.id === "number" && Number.isSafeInteger(data.id) ? data.id : 0,
                username: data.username,
                role: data.role === "owner" ? "owner" : "user",
            };
        } catch {
            return null;
        }
    },
    async recoverPassword(this: ClientThis, token: string): Promise<{ success: boolean; message?: string }> {
        try {
            const response = await fetch(`${this.baseUrl}/auth/recover`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
            });
            const data = await response.json().catch(() => ({ success: false }));
            const reason = rawError(data, response.status);
            if (!response.ok && !reason) {
                return { success: false, message: "恢复失败，请稍后再试" };
            }
            // 失败时服务端回新形状，调用方只认 success / message，统一翻过去
            return response.ok ? data : { success: false, message: reason };
        } catch (error) {
            reportError(error, { source: "auth-recover" });
            return { success: false, message: "恢复请求失败，请检查网络连接" };
        }
    },
    async getRecoveryStatus(this: ClientThis): Promise<{ configured: boolean }> {
        return this.request<RecoveryStatusResponse>("auth/recovery-status");
    },
    async setRecoveryPublicKey(this: ClientThis, 
        publicKey: string,
        currentPassword: string
    ): Promise<{ success: boolean; message?: string }> {
        try {
            const response = await fetch(`${this.baseUrl}/auth/recovery-key`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ publicKey, currentPassword }),
            });
            const data = await response.json().catch(() => ({ success: false }));
            if (!response.ok && !data.message) {
                return { success: false, message: "保存恢复公钥失败，请稍后再试" };
            }
            return data;
        } catch (error) {
            reportError(error, { source: "recovery-key-save" });
            return { success: false, message: "保存恢复公钥请求失败，请检查网络连接" };
        }
    },
    async checkAuthStatus(this: ClientThis): Promise<boolean> {
        try {
            // ⚠️ 2026-10-21：**标记没了也照样问一次服务端**，不再直接判未登录。
            //
            // 那个 JS 可读的 navihive_session 只是「刷新后能立刻知道已登录」的附属物，
            // 真正的会话在 httpOnly 的 navihive_token 里（「记住我」30 天）。
            // 两者一旦不同步，老逻辑会把还有一个好会话的用户直接挡在登录页外：
            //   - 隐私工具 / 「退出时清除 Cookie」只清掉非 HttpOnly 的那条；
            //   - 两条 cookie 的写入时机差了一拍（服务端 Set-Cookie 与前端
            //     document.cookie 各写一次），任一条没落盘就少一个；
            //   - 换防火墙策略 / 换浏览器配置后规则与老 cookie 不匹配。
            // 用户描述的现象正是「隔一夜回来就要重新登录」—— 令牌多半还有效，
            // 死的只是那个标记。所以：先问服务端，问得动就说明会话还活着，
            // 顺手把标记补回来，用户根本看不到登录页。
            //
            // 代价是「真的未登录」时多一个必然 401 的请求：登录页本来就在转圈
            // （isAuthChecking），这一个请求换来的确定性是值得的。
            await this.getConfigs();
            // 会话还有效但标记不在：补上。时长取「记住我」那一档 —— 那是登录页
            // 复选框的默认勾选状态；真令牌只剩一天时它会在下次 401 时被清掉，
            // 结局与今天一样（回登录页），不会把已失效的会话伪装成有效。
            if (!this.isLoggedIn()) setSessionCookie(REMEMBER_TOKEN_TTL);
            return true;
        } catch (error) {
            // 不往外打日志：离线 / 网络抖动时这里每次启动都会走一遍，
            // 控制台噪声会把真正的问题淹掉。是否失效只看下面的错误类型判定。
            // 判据是 ApiError 的 code（不是 message 文案）—— getConfigs 走 request()，
            // 抛出来的必然是这个客户端自己的 ApiError，能拿到实例。
            if (isAuthError(error)) {
                this.clearToken();
                return false;
            }

            // 其他错误不影响认证状态，本地有登录标记就认为已认证
            return this.isLoggedIn();
        }
    },
    async updateAuthCredentials(this: ClientThis, 
        username: string,
        password: string,
        currentPassword: string
    ): Promise<{ success: boolean; message?: string }> {
        const res = await this.request<AuthCredentialsResponse>("auth/credentials", {
            method: "PUT",
            body: JSON.stringify({ username, password, currentPassword }),
        });
        // 失败一律走 4xx（会抛异常），所以 200 就是改成了；message 只在有话要说时出现
        return { success: res?.success !== false, message: res?.message };
    },
    async getSessions(this: ClientThis): Promise<SessionInfo[]> {
        const res = await this.request<SessionsResponse>("sessions");
        return Array.isArray(res?.sessions) ? res.sessions : [];
    },
    async revokeSession(this: ClientThis, jti: string): Promise<{ success: boolean; message?: string }> {
        const res = await this.request<RevokeSessionResponse>(`sessions/${encodeURIComponent(jti)}`, { method: "DELETE" });
        return { success: res?.success !== false, message: res?.message };
    },
    async revokeOtherSessions(this: ClientThis): Promise<{
        success: boolean;
        revoked: number;
        message?: string;
    }> {
        const res = await this.request<RevokeOthersResponse>("sessions/revoke-others", { method: "POST" });
        return {
            success: res?.success !== false,
            revoked: typeof res?.revoked === "number" ? res.revoked : 0,
        };
    },
};
