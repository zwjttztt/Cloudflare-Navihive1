import {
    NavigationAPI,
    type LoginRequest,
    type ExportData,
    type Group,
    type Site,
} from "../src/API/http";

export default {
    async fetch(request: Request, env: Env) {
        const url = new URL(request.url);

        // API路由处理
        if (url.pathname.startsWith("/api/")) {
            const path = url.pathname.replace("/api/", "");
            const method = request.method;

            try {
                const api = new NavigationAPI(env);

                // 图标代理 - 公开路由，必须放在鉴权之前：
                // 浏览器用 <img src> 拉图标带不上 Authorization，被拦就是一片空白。
                // 作用是把第三方图标变成同源响应：跨域图片的 opaque response 读不出内容，
                // 前端的 IndexedDB blob 缓存用不上；走代理之后第一次抓完就存本地，
                // 二次打开图标零网络请求。
                if (path === "icon" && method === "GET") {
                    return await proxyIcon(request);
                }

                // 登录路由 - 不需要验证
                if (path === "login" && method === "POST") {
                    const loginData = (await request.json()) as LoginInput;

                    // 验证登录数据
                    const validation = validateLogin(loginData);
                    if (!validation.valid) {
                        return Response.json(
                            {
                                success: false,
                                message: `验证失败: ${validation.errors?.join(", ")}`,
                            },
                            { status: 400 }
                        );
                    }

                    // 还在锁定期就直接回绝，并告诉还要等多久
                    const guard = await readLoginGuard(api);
                    const now = Date.now();
                    if (guard.until > now) {
                        const waitSec = Math.ceil((guard.until - now) / 1000);
                        return Response.json(
                            {
                                success: false,
                                message: `登录尝试过于频繁，请 ${waitSec} 秒后再试`,
                            },
                            { status: 429, headers: { "Retry-After": String(waitSec) } }
                        );
                    }

                    const result = await api.login(loginData as LoginRequest);

                    if (result.success) {
                        // 登录成功就清零，别让之前的手滑一直累积
                        if (guard.count > 0) await writeLoginGuard(api, { count: 0, until: 0 });
                        return Response.json(result);
                    }

                    const count = guard.count + 1;
                    const over = count - LOGIN_FREE_ATTEMPTS;
                    const until =
                        over > 0
                            ? now +
                              Math.min(
                                  LOGIN_BASE_LOCK_MS * Math.pow(2, over - 1),
                                  LOGIN_MAX_LOCK_MS
                              )
                            : 0;
                    await writeLoginGuard(api, { count, until });

                    // 三种状态文案要分清楚：还能试几次 / 这是最后一次 / 已经锁了。
                    // （之前按「剩余次数」判断，第 5 次还没真锁上却说「已暂时锁定」）
                    const left = LOGIN_FREE_ATTEMPTS - count;
                    let message = result.message;
                    let status = 401;
                    if (until > 0) {
                        const waitSec = Math.ceil((until - now) / 1000);
                        message = `${result.message}，尝试次数过多，请 ${waitSec} 秒后再试`;
                        status = 429;
                    } else if (left > 0) {
                        message = `${result.message}（还可尝试 ${left} 次）`;
                    } else {
                        message = `${result.message}，已达尝试上限，再失败一次将被临时锁定`;
                    }

                    return Response.json(
                        { ...result, message },
                        {
                            status,
                            headers:
                                status === 429
                                    ? { "Retry-After": String(Math.ceil((until - now) / 1000)) }
                                    : undefined,
                        }
                    );
                }

                // 用应急重置码重设密码 - 不需要验证（忘了密码才用得到，本身就是登录页的入口）
                if (path === "auth/reset" && method === "POST") {
                    const data = (await request.json()) as ResetInput;

                    const code = typeof data.code === "string" ? data.code.trim() : "";
                    const newPassword = typeof data.newPassword === "string" ? data.newPassword : "";
                    const newUsername =
                        typeof data.newUsername === "string" ? data.newUsername.trim() : "";

                    if (!code || !newPassword) {
                        return Response.json(
                            { success: false, message: "请填写应急重置码和新密码" },
                            { status: 400 }
                        );
                    }

                    const clientKey =
                        request.headers.get("CF-Connecting-IP") ||
                        request.headers.get("X-Forwarded-For") ||
                        "unknown";

                    const result = await api.redeemResetCode(
                        code,
                        newUsername,
                        newPassword,
                        clientKey
                    );
                    return Response.json(result, { status: result.success ? 200 : 400 });
                }

                // 应急重置码是否已配置 - 不需要验证
                // 只返回一个布尔值，不下发码本身；登录页要在未登录时就知道该不该显示这个入口
                if (path === "auth/reset-code" && method === "GET") {
                    return Response.json({ configured: api.hasResetCode() });
                }

                // 初始化数据库接口 - 不需要验证
                if (path === "init" && method === "GET") {
                    const initResult = await api.initDB();
                    if (initResult.alreadyInitialized) {
                        return new Response("数据库已经初始化过，无需重复初始化", { status: 200 });
                    }
                    return new Response("数据库初始化成功", { status: 200 });
                }

                // 验证中间件 - 除登录接口和初始化接口外，所有请求都需要验证
                if (api.isAuthEnabled()) {
                    // 检查Authorization头部
                    const authHeader = request.headers.get("Authorization");

                    // 如果没有Authorization头部，返回401错误
                    if (!authHeader) {
                        return new Response("请先登录", {
                            status: 401,
                            headers: {
                                "WWW-Authenticate": "Bearer",
                            },
                        });
                    }

                    // 提取Token
                    const [authType, token] = authHeader.split(" ");

                    // 验证Token类型和内容
                    if (authType !== "Bearer" || !token) {
                        return new Response("无效的认证信息", { status: 401 });
                    }

                    // 验证Token有效性 - 改为异步调用
                    const verifyResult = await api.verifyToken(token);
                    if (!verifyResult.valid) {
                        return new Response("认证已过期或无效，请重新登录", { status: 401 });
                    }
                }

                // 确保数据库结构是最新的（迁移结果缓存在模块作用域，同一 isolate 内只执行一次）
                await api.migrate();

                // 路由匹配
                if (path === "bootstrap" && method === "GET") {
                    // 一次请求返回分组 + 站点 + 配置，供前端首屏与刷新使用。
                    // 带上弱 ETag：浏览器下次会在 If-None-Match 里回传，
                    // 数据没变就只回一个 304 空包，省掉整份 JSON 的下载与解析
                    // （站点多的时候这一份能到几百 KB）。
                    const data = await api.getBootstrap();
                    const body = JSON.stringify(data);
                    const etag = weakEtag(body);
                    // no-cache（每次都要问一趟服务器）而不是 no-store（不许存），
                    // 否则浏览器手头没有副本，ETag 也就无从比较
                    const headers = {
                        "Content-Type": "application/json; charset=utf-8",
                        ETag: etag,
                        "Cache-Control": "no-cache",
                    };
                    if (request.headers.get("if-none-match") === etag) {
                        return new Response(null, { status: 304, headers });
                    }
                    return new Response(body, { headers });
                } else if (path === "groups" && method === "GET") {
                    const groups = await api.getGroups();
                    return Response.json(groups);
                } else if (path.startsWith("groups/") && method === "GET") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }
                    const group = await api.getGroup(id);
                    return Response.json(group);
                } else if (path === "groups" && method === "POST") {
                    const data = (await request.json()) as GroupInput;

                    // 验证分组数据
                    const validation = validateGroup(data);
                    if (!validation.valid) {
                        return Response.json(
                            {
                                success: false,
                                message: `验证失败: ${validation.errors?.join(", ")}`,
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.createGroup(validation.sanitizedData as Group);
                    return Response.json(result);
                } else if (path.startsWith("groups/") && method === "PUT") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const data = (await request.json()) as Partial<Group>;
                    // 对修改的字段进行验证
                    if (
                        data.name !== undefined &&
                        (typeof data.name !== "string" || data.name.trim() === "")
                    ) {
                        return Response.json(
                            {
                                success: false,
                                message: "分组名称不能为空且必须是字符串",
                            },
                            { status: 400 }
                        );
                    }

                    if (data.order_num !== undefined && typeof data.order_num !== "number") {
                        return Response.json(
                            {
                                success: false,
                                message: "排序号必须是数字",
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.updateGroup(id, data);
                    return Response.json(result);
                } else if (path.startsWith("groups/") && method === "DELETE") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const result = await api.deleteGroup(id);
                    return Response.json({ success: result });
                }
                // 站点相关API
                else if (path === "sites" && method === "GET") {
                    const groupId = url.searchParams.get("groupId");
                    const sites = await api.getSites(groupId ? parseInt(groupId) : undefined);
                    return Response.json(sites);
                } else if (path.startsWith("sites/") && method === "GET") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const site = await api.getSite(id);
                    return Response.json(site);
                } else if (path === "sites" && method === "POST") {
                    const data = (await request.json()) as SiteInput;

                    // 验证站点数据
                    const validation = validateSite(data);
                    if (!validation.valid) {
                        return Response.json(
                            {
                                success: false,
                                message: `验证失败: ${validation.errors?.join(", ")}`,
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.createSite(validation.sanitizedData as Site);
                    return Response.json(result);
                } else if (path.startsWith("sites/") && method === "PUT") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const data = (await request.json()) as Partial<Site>;

                    // 验证更新的站点数据
                    if (data.url !== undefined) {
                        try {
                            new URL(data.url);
                        } catch {
                            return Response.json(
                                {
                                    success: false,
                                    message: "无效的URL格式",
                                },
                                { status: 400 }
                            );
                        }
                    }

                    if (data.icon !== undefined && data.icon !== "") {
                        try {
                            new URL(data.icon);
                        } catch {
                            return Response.json(
                                {
                                    success: false,
                                    message: "无效的图标URL格式",
                                },
                                { status: 400 }
                            );
                        }
                    }

                    if (data.username !== undefined && typeof data.username !== "string") {
                        return Response.json(
                            {
                                success: false,
                                message: "账号必须是字符串",
                            },
                            { status: 400 }
                        );
                    }

                    if (data.password !== undefined && typeof data.password !== "string") {
                        return Response.json(
                            {
                                success: false,
                                message: "密码必须是字符串",
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.updateSite(id, data);
                    return Response.json(result);
                } else if (path.startsWith("sites/") && method === "DELETE") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const result = await api.deleteSite(id);
                    return Response.json({ success: result });
                }
                // 批量更新排序
                else if (path === "group-orders" && method === "PUT") {
                    const data = (await request.json()) as Array<{ id: number; order_num: number }>;

                    // 验证排序数据
                    if (!Array.isArray(data)) {
                        return Response.json(
                            {
                                success: false,
                                message: "排序数据必须是数组",
                            },
                            { status: 400 }
                        );
                    }

                    for (const item of data) {
                        if (
                            !item.id ||
                            typeof item.id !== "number" ||
                            item.order_num === undefined ||
                            typeof item.order_num !== "number"
                        ) {
                            return Response.json(
                                {
                                    success: false,
                                    message: "排序数据格式无效，每个项目必须包含id和order_num",
                                },
                                { status: 400 }
                            );
                        }
                    }

                    const result = await api.updateGroupOrder(data);
                    return Response.json({ success: result });
                } else if (path === "site-orders" && method === "PUT") {
                    // 支持一次提交「顺序 + 所属分组」，拖拽跨组移动不必再逐个请求
                    const data = (await request.json()) as Array<{
                        id: number;
                        order_num: number;
                        group_id?: number;
                    }>;

                    // 验证排序数据
                    if (!Array.isArray(data)) {
                        return Response.json(
                            {
                                success: false,
                                message: "排序数据必须是数组",
                            },
                            { status: 400 }
                        );
                    }

                    for (const item of data) {
                        if (
                            !item.id ||
                            typeof item.id !== "number" ||
                            item.order_num === undefined ||
                            typeof item.order_num !== "number"
                        ) {
                            return Response.json(
                                {
                                    success: false,
                                    message: "排序数据格式无效，每个项目必须包含id和order_num",
                                },
                                { status: 400 }
                            );
                        }

                        if (item.group_id !== undefined && typeof item.group_id !== "number") {
                            return Response.json(
                                {
                                    success: false,
                                    message: "分组ID必须是数字",
                                },
                                { status: 400 }
                            );
                        }
                    }

                    const result = await api.updateSiteOrder(data);
                    return Response.json({ success: result });
                }
                // 配置相关API
                else if (path === "configs" && method === "GET") {
                    const configs = await api.getConfigs();
                    return Response.json(configs);
                }
                // 批量写入配置：保存网站设置时一次请求搞定，省掉 N 个网络往返
                else if (path === "configs/batch" && method === "POST") {
                    const data = (await request.json()) as { configs?: Record<string, string> };
                    const entries = Object.entries(data.configs || {});

                    if (entries.length === 0) {
                        return Response.json({ success: true, saved: 0 });
                    }

                    // 管理员凭据同样不允许在这里改（要走校验当前密码的专用接口）
                    const blocked = entries.find(([key]) => key.startsWith("auth."));
                    if (blocked) {
                        return Response.json(
                            {
                                success: false,
                                message: "管理员凭据请通过「网站设置 - 管理员账号与密码」修改",
                            },
                            { status: 403 }
                        );
                    }

                    const bad = entries.find(
                        ([, value]) => typeof value !== "string" || value === undefined
                    );
                    if (bad) {
                        return Response.json(
                            { success: false, message: `配置项 ${bad[0]} 的值不合法` },
                            { status: 400 }
                        );
                    }

                    const result = await api.setConfigs(Object.fromEntries(entries));
                    return Response.json({ success: result, saved: entries.length });
                }                 else if (path.startsWith("configs/") && method === "GET") {
                    const key = path.substring("configs/".length);
                    // 管理员凭据不允许读取
                    if (key.startsWith("auth.")) {
                        return Response.json(
                            { error: "管理员凭据不可读取" },
                            { status: 403 }
                        );
                    }
                    const value = await api.getConfig(key);
                    return Response.json({ key, value });
                } else if (path.startsWith("configs/") && method === "PUT") {
                    const key = path.substring("configs/".length);
                    // 管理员凭据只能通过 /api/auth/credentials 修改（需要校验当前密码）
                    if (key.startsWith("auth.")) {
                        return Response.json(
                            {
                                success: false,
                                message: "管理员凭据请通过「网站设置 - 管理员账号与密码」修改",
                            },
                            { status: 403 }
                        );
                    }
                    const data = (await request.json()) as ConfigInput;

                    // 验证配置数据
                    const validation = validateConfig(data);
                    if (!validation.valid) {
                        return Response.json(
                            {
                                success: false,
                                message: `验证失败: ${validation.errors?.join(", ")}`,
                            },
                            { status: 400 }
                        );
                    }

                    // 确保value存在
                    if (data.value === undefined) {
                        return Response.json(
                            {
                                success: false,
                                message: "配置值不能为空",
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.setConfig(key, data.value);
                    return Response.json({ success: result });
                } else if (path.startsWith("configs/") && method === "DELETE") {
                    const key = path.substring("configs/".length);
                    // 不允许删除管理员凭据，避免悄悄退化回默认密码
                    if (key.startsWith("auth.")) {
                        return Response.json({ success: false }, { status: 403 });
                    }
                    const result = await api.deleteConfig(key);
                    return Response.json({ success: result });
                }

                // 修改管理员账号密码（保存在数据库中，重新部署不会被覆盖）
                else if (path === "auth/credentials" && method === "PUT") {
                    const data = (await request.json()) as AuthCredentialsInput;

                    const username = typeof data.username === "string" ? data.username.trim() : "";
                    const password = typeof data.password === "string" ? data.password : "";
                    const currentPassword =
                        typeof data.currentPassword === "string" ? data.currentPassword : "";

                    if (!username && !password) {
                        return Response.json(
                            { success: false, message: "请填写新的管理员账号或新密码" },
                            { status: 400 }
                        );
                    }

                    const current = await api.getAuthCredentials();
                    if (currentPassword !== current.password) {
                        return Response.json(
                            { success: false, message: "当前密码不正确" },
                            { status: 403 }
                        );
                    }

                    // 留空的字段表示保持不变
                    const result = await api.updateAuthCredentials(
                        username || current.username,
                        password || current.password
                    );
                    return Response.json({
                        success: result,
                        message: result ? "管理员凭据已更新，请牢记新账号密码" : "保存管理员凭据失败",
                    });
                }

                // 数据导出路由
                else if (path === "export" && method === "GET") {
                    const data = await api.exportData();
                    return Response.json(data, {
                        headers: {
                            "Content-Disposition": "attachment; filename=navhive-data.json",
                            "Content-Type": "application/json",
                        },
                    });
                }

                // 数据导入路由
                else if (path === "import" && method === "POST") {
                    const data = (await request.json()) as ExportData;

                    // 验证导入数据（站点允许嵌套在分组中，兼容旧版备份格式）
                    if (
                        !data.groups ||
                        !Array.isArray(data.groups) ||
                        (data.configs !== undefined && typeof data.configs !== "object")
                    ) {
                        return Response.json(
                            {
                                success: false,
                                message: "导入数据格式无效",
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.importData(data as ExportData);
                    return Response.json({ success: result });
                }

                // ============ WebDAV 备份相关路由（由 Worker 代理，避免浏览器跨域限制） ============
                else if (path === "webdav/test" && method === "POST") {
                    const config = await resolveWebDavConfig(api, request);
                    const result = await webdavTest(config);
                    return Response.json(result);
                } else if (path === "webdav/upload" && method === "POST") {
                    const body = (await safeJson(request)) as {
                        filename?: string;
                        data?: ExportData;
                    };
                    const config = await resolveWebDavConfig(api, request, body);
                    // 上传成功后会顺带删掉上一次的备份，只保留最新一份
                    const stored = await readAllConfigs(api);
                    const result = await runWebDavBackup(
                        api,
                        config,
                        stored["webdav.lastBackup"] || "",
                        body.data
                    );
                    return Response.json(result);
                } else if (path === "webdav/list" && method === "POST") {
                    const config = await resolveWebDavConfig(api, request);
                    const result = await webdavList(config);
                    return Response.json(result);
                } else if (path === "webdav/download" && method === "POST") {
                    const body = (await safeJson(request)) as { filename?: string };
                    const config = await resolveWebDavConfig(api, request, body);
                    const result = await webdavDownload(config, body.filename || "");
                    return Response.json(result);
                } else if (path === "webdav/delete" && method === "POST") {
                    const body = (await safeJson(request)) as { filename?: string };
                    const config = await resolveWebDavConfig(api, request, body);
                    const result = await webdavDelete(config, body.filename || "");
                    return Response.json(result);
                }

                // 默认返回404
                return new Response("API路径不存在", { status: 404 });
            } catch (error) {
                // 安全处理错误，不暴露内部细节
                console.error(`API错误: ${error instanceof Error ? error.message : "未知错误"}`);
                return new Response(`处理请求时发生错误`, { status: 500 });
            }
        }

        // 非API路由默认返回404
        return new Response("Not Found", { status: 404 });
    },

    /**
     * 每周定时备份（由 wrangler.jsonc 的 triggers.crons 触发）。
     * 只有开启了「每周自动备份」且 WebDAV 已配置时才会真正执行。
     */
    async scheduled(_controller: unknown, env: Env): Promise<void> {
        try {
            const api = new NavigationAPI(env);
            const stored = await readAllConfigs(api);

            if (stored["webdav.autoBackup"] === "false") {
                return;
            }

            const config = configFromStored(stored);
            if (!config.url) {
                console.log("定时备份跳过：尚未配置 WebDAV");
                return;
            }

            const result = await runWebDavBackup(
                api,
                config,
                stored["webdav.lastBackup"] || ""
            );
            console.log(
                result.success
                    ? `定时备份完成：${result.data?.filename}`
                    : `定时备份失败：${result.message}`
            );
        } catch (error) {
            console.error("定时备份异常:", error);
        }
    },
} satisfies ExportedHandler;

// 环境变量接口
interface Env {
    DB: D1Database;
    AUTH_ENABLED?: string;
    AUTH_USERNAME?: string;
    AUTH_PASSWORD?: string;
    AUTH_SECRET?: string;
    AUTH_RESET_CODE?: string;
}

// 验证用接口
interface LoginInput {
    username?: string;
    password?: string;
    /** 勾选「记住我」时签发 30 天令牌 */
    remember?: boolean;
}

interface ResetInput {
    code?: string;
    newPassword?: string;
    newUsername?: string;
}

interface GroupInput {
    name?: string;
    order_num?: number;
}

interface SiteInput {
    group_id?: number;
    name?: string;
    url?: string;
    icon?: string;
    description?: string;
    notes?: string;
    username?: string;
    password?: string;
    order_num?: number;
}

interface ConfigInput {
    value?: string;
}

// 修改管理员凭据的请求体
interface AuthCredentialsInput {
    username?: string;
    password?: string;
    currentPassword?: string;
}

// 输入验证函数
function validateLogin(data: LoginInput): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    if (!data.username || typeof data.username !== "string") {
        errors.push("用户名不能为空且必须是字符串");
    }

    if (!data.password || typeof data.password !== "string") {
        errors.push("密码不能为空且必须是字符串");
    }

    return { valid: errors.length === 0, errors };
}

// ============ 登录失败限速 ============
// 连续输错会越等越久，避免密码被无限次猜。
// 计数存在 configs 表的 auth.loginGuard 里 —— auth. 前缀既不返回给前端、也不进备份文件。
const LOGIN_GUARD_KEY = "auth.loginGuard";
// 前 5 次给手滑留余地，之后每次等待时间翻倍
const LOGIN_FREE_ATTEMPTS = 5;
const LOGIN_BASE_LOCK_MS = 60_000; // 第 6 次起锁 1 分钟
const LOGIN_MAX_LOCK_MS = 30 * 60_000; // 最多 30 分钟

interface LoginGuard {
    count: number;
    /** 解锁时刻（毫秒时间戳）；0 表示当前不在锁定期 */
    until: number;
}

async function readLoginGuard(api: NavigationAPI): Promise<LoginGuard> {
    try {
        const raw = await api.getConfig(LOGIN_GUARD_KEY);
        if (!raw) return { count: 0, until: 0 };
        const parsed = JSON.parse(raw) as Partial<LoginGuard>;
        return {
            count: typeof parsed.count === "number" && parsed.count > 0 ? parsed.count : 0,
            until: typeof parsed.until === "number" && parsed.until > 0 ? parsed.until : 0,
        };
    } catch {
        // 读不出来就当没在锁定期：不能因为存储异常把正常用户挡在门外
        return { count: 0, until: 0 };
    }
}

async function writeLoginGuard(api: NavigationAPI, guard: LoginGuard): Promise<void> {
    try {
        await api.setConfig(LOGIN_GUARD_KEY, JSON.stringify(guard));
    } catch {
        // 写失败只影响限速强度，不影响登录本身
    }
}

function validateGroup(data: GroupInput): {
    valid: boolean;
    errors?: string[];
    sanitizedData?: Group;
} {
    const errors: string[] = [];
    const sanitizedData: Partial<Group> = {};

    // 验证名称
    if (!data.name || typeof data.name !== "string") {
        errors.push("分组名称不能为空且必须是字符串");
    } else {
        sanitizedData.name = data.name.trim().slice(0, 100); // 限制长度
    }

    // 验证排序号
    if (data.order_num === undefined || typeof data.order_num !== "number") {
        errors.push("排序号必须是数字");
    } else {
        sanitizedData.order_num = data.order_num;
    }

    return {
        valid: errors.length === 0,
        errors,
        sanitizedData: errors.length === 0 ? (sanitizedData as Group) : undefined,
    };
}

function validateSite(data: SiteInput): {
    valid: boolean;
    errors?: string[];
    sanitizedData?: Site;
} {
    const errors: string[] = [];
    const sanitizedData: Partial<Site> = {};

    // 验证分组ID
    if (!data.group_id || typeof data.group_id !== "number") {
        errors.push("分组ID必须是数字且不能为空");
    } else {
        sanitizedData.group_id = data.group_id;
    }

    // 验证名称
    if (!data.name || typeof data.name !== "string") {
        errors.push("站点名称不能为空且必须是字符串");
    } else {
        sanitizedData.name = data.name.trim().slice(0, 100); // 限制长度
    }

    // 验证URL
    if (!data.url || typeof data.url !== "string") {
        errors.push("URL不能为空且必须是字符串");
    } else {
        try {
            // 验证URL格式
            new URL(data.url);
            sanitizedData.url = data.url.trim();
        } catch {
            errors.push("无效的URL格式");
        }
    }

    // 验证图标URL (可选)
    if (data.icon !== undefined) {
        if (typeof data.icon !== "string") {
            errors.push("图标URL必须是字符串");
        } else if (data.icon) {
            try {
                // 验证URL格式
                new URL(data.icon);
                sanitizedData.icon = data.icon.trim();
            } catch {
                errors.push("无效的图标URL格式");
            }
        } else {
            sanitizedData.icon = "";
        }
    }

    // 验证描述 (可选)
    if (data.description !== undefined) {
        sanitizedData.description =
            typeof data.description === "string"
                ? data.description.trim().slice(0, 500) // 限制长度
                : "";
    }

    // 验证备注 (可选)
    if (data.notes !== undefined) {
        sanitizedData.notes =
            typeof data.notes === "string"
                ? data.notes.trim().slice(0, 1000) // 限制长度
                : "";
    }

    // 验证站点账号 (可选)
    if (data.username !== undefined) {
        sanitizedData.username =
            typeof data.username === "string"
                ? data.username.trim().slice(0, 200) // 限制长度
                : "";
    }

    // 验证站点密码 (可选)
    if (data.password !== undefined) {
        sanitizedData.password =
            typeof data.password === "string"
                ? data.password.slice(0, 500) // 限制长度，密码不做 trim，避免误改
                : "";
    }

    // 验证排序号
    if (data.order_num === undefined || typeof data.order_num !== "number") {
        errors.push("排序号必须是数字");
    } else {
        sanitizedData.order_num = data.order_num;
    }

    return {
        valid: errors.length === 0,
        errors,
        sanitizedData: errors.length === 0 ? (sanitizedData as Site) : undefined,
    };
}

// ============ WebDAV 备份相关工具函数 ============
// 说明：WebDAV 服务大多不返回 CORS 头，浏览器直连会被拦截，
// 因此所有 WebDAV 请求都由 Worker 代为发起。

const DEFAULT_WEBDAV_PATH = "navihive-backup";

interface WebDavConfig {
    url: string;
    username: string;
    password: string;
    path: string;
}

interface WebDavFile {
    name: string;
    size: number;
    lastModified: string;
}

interface WebDavResult<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message || fallback : fallback;
}

// 安全地读取请求体（无 body 时返回空对象）
async function safeJson(request: Request): Promise<Record<string, unknown>> {
    try {
        const body = (await request.json()) as unknown;
        return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

// 优先使用请求中传入的配置，缺失时回落到数据库中保存的配置
async function resolveWebDavConfig(
    api: NavigationAPI,
    request: Request,
    body?: Record<string, unknown>
): Promise<WebDavConfig> {
    const payload = body ?? (await safeJson(request));

    // 一次读回全部配置（原来要查四次，每次都是一次 D1 往返）
    let stored: Record<string, string> = {};
    try {
        stored = await api.getConfigs();
    } catch {
        stored = {};
    }

    const pick = (value: unknown, fallback: string): string =>
        typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;

    return {
        url: pick(payload.url, stored["webdav.url"] || ""),
        username: pick(payload.username, stored["webdav.username"] || ""),
        password: pick(payload.password, stored["webdav.password"] || ""),
        path: pick(payload.path, stored["webdav.path"] || "") || DEFAULT_WEBDAV_PATH,
    };
}

// 读取全部配置（供备份流程复用，避免重复查询）
async function readAllConfigs(api: NavigationAPI): Promise<Record<string, string>> {
    try {
        return await api.getConfigs();
    } catch {
        return {};
    }
}

function configFromStored(stored: Record<string, string>): WebDavConfig {
    return {
        url: stored["webdav.url"] || "",
        username: stored["webdav.username"] || "",
        password: stored["webdav.password"] || "",
        path: stored["webdav.path"] || DEFAULT_WEBDAV_PATH,
    };
}

/**
 * 执行一次完整备份：导出 → 压缩上传 → 删掉上一次的备份 → 记录本次文件名。
 * 手动备份和每周定时备份都走这里，行为保持一致。
 */
async function runWebDavBackup(
    api: NavigationAPI,
    config: WebDavConfig,
    previousFilename: string,
    data?: ExportData
): Promise<WebDavResult<{ filename: string; size: number }>> {
    const payload = data ?? (await api.exportData());
    const filename = buildBackupFileName();

    const result = await webdavUpload(config, filename, payload);
    if (!result.success) return result;

    // 只保留最新一份：删掉上一次的备份（删不掉也不算备份失败）
    await prunePreviousBackup(config, filename, previousFilename);

    try {
        await api.setConfig("webdav.lastBackup", filename);
        await api.setConfig("webdav.lastBackupAt", new Date().toISOString());
    } catch (error) {
        console.error("记录备份状态失败:", error);
    }

    return result;
}

// 删除上一次的备份文件；没有记录时列目录兜底，清掉除本次以外的所有备份
async function prunePreviousBackup(
    config: WebDavConfig,
    keepFilename: string,
    previousFilename?: string
): Promise<void> {
    try {
        if (previousFilename && previousFilename !== keepFilename) {
            await webdavDelete(config, previousFilename);
            return;
        }

        const list = await webdavList(config);
        for (const file of list.data || []) {
            if (file.name !== keepFilename) {
                await webdavDelete(config, file.name);
            }
        }
    } catch (error) {
        // 清理失败不影响本次备份结果
        console.error("清理旧备份失败:", error);
    }
}

// 支持中文密码的 Base64 编码
function base64Encode(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function buildWebDavFolderUrl(config: WebDavConfig): string {
    const base = (config.url || "").trim().replace(/\/+$/, "");
    if (!base) {
        throw new Error("请先填写 WebDAV 服务器地址");
    }
    if (!/^https?:\/\//i.test(base)) {
        throw new Error("WebDAV 服务器地址必须以 http:// 或 https:// 开头");
    }

    const folder = (config.path || DEFAULT_WEBDAV_PATH).trim().replace(/^\/+|\/+$/g, "");
    return folder ? `${base}/${folder}/` : `${base}/`;
}

function buildWebDavFileUrl(folderUrl: string, filename: string): string {
    return `${folderUrl}${encodeURIComponent(filename)}`;
}

function buildBackupFileName(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp =
        `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
        `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}` +
        // 带毫秒：同一秒内连续备份也不会重名，避免新备份把旧的覆盖掉
        `-${String(now.getUTCMilliseconds()).padStart(3, "0")}`;
    // 备份内容用 gzip 压缩后再上传，体积通常只有原来的十分之一
    return `navihive-backup-${stamp}.json.gz`;
}

// gzip 压缩（Workers 运行时原生支持 CompressionStream）
async function gzipBytes(input: string): Promise<Uint8Array> {
    const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

// gzip 解压：读取旧的压缩备份时用到
async function gunzipToString(bytes: ArrayBuffer): Promise<string> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
}

async function davFetch(
    url: string,
    method: string,
    config: WebDavConfig,
    body?: string | Uint8Array,
    extraHeaders?: Record<string, string>
): Promise<Response> {
    const headers: Record<string, string> = { ...(extraHeaders || {}) };

    if (config.username) {
        headers["Authorization"] = `Basic ${base64Encode(`${config.username}:${config.password}`)}`;
    }

    return fetch(url, {
        method,
        headers,
        body: body ?? undefined,
    });
}

// 逐级创建备份目录（已存在时服务器返回 405，忽略即可）
async function ensureWebDavFolder(config: WebDavConfig, folderUrl: string): Promise<void> {
    const base = (config.url || "").trim().replace(/\/+$/, "");
    const relative = folderUrl.slice(base.length).replace(/^\/+|\/+$/g, "");
    if (!relative) return;

    let current = base;
    for (const segment of relative.split("/").filter(Boolean)) {
        current = `${current}/${encodeURIComponent(segment)}`;
        try {
            await davFetch(`${current}/`, "MKCOL", config);
        } catch {
            // 目录已存在或无权创建，交由后续写入结果体现
        }
    }
}

// 解析 PROPFIND 返回的 XML 文件列表
function parseWebDavList(xml: string): WebDavFile[] {
    const files: WebDavFile[] = [];
    const blocks = xml.match(/<[A-Za-z0-9]*:?response\b[\s\S]*?<\/[A-Za-z0-9]*:?response>/gi) || [];

    for (const block of blocks) {
        const isCollection = /<[A-Za-z0-9]*:?collection\s*\/?>/i.test(block);
        if (isCollection) continue;

        const hrefMatch = block.match(/<[A-Za-z0-9]*:?href\b[^>]*>([\s\S]*?)<\/[A-Za-z0-9]*:?href>/i);
        if (!hrefMatch) continue;

        let name = hrefMatch[1].trim();
        try {
            name = decodeURIComponent(name);
        } catch {
            // 保持原始值
        }
        name = name.replace(/\/+$/, "").split("/").pop() || name;

        const sizeMatch = block.match(/<[A-Za-z0-9]*:?getcontentlength\b[^>]*>([\s\S]*?)</i);
        const modifiedMatch = block.match(/<[A-Za-z0-9]*:?getlastmodified\b[^>]*>([\s\S]*?)</i);

        files.push({
            name,
            size: sizeMatch ? Number(sizeMatch[1].trim()) || 0 : 0,
            lastModified: modifiedMatch ? modifiedMatch[1].trim() : "",
        });
    }

    return files.sort((a, b) => {
        const timeA = Date.parse(a.lastModified || "") || 0;
        const timeB = Date.parse(b.lastModified || "") || 0;
        return timeB - timeA;
    });
}

// 测试 WebDAV 连接
async function webdavTest(config: WebDavConfig): Promise<WebDavResult> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);
        let response = await davFetch(folderUrl, "PROPFIND", config, undefined, { Depth: "0" });

        if (response.status === 404 || response.status === 409) {
            await ensureWebDavFolder(config, folderUrl);
            response = await davFetch(folderUrl, "PROPFIND", config, undefined, { Depth: "0" });
        }

        if (response.ok) {
            return { success: true, message: "连接成功，备份目录可用" };
        }
        if (response.status === 401 || response.status === 403) {
            return { success: false, message: "认证失败，请检查 WebDAV 账号或应用密码" };
        }
        return { success: false, message: `连接失败：HTTP ${response.status}` };
    } catch (error) {
        return { success: false, message: errorMessage(error, "连接失败") };
    }
}

// 上传备份文件
async function webdavUpload(
    config: WebDavConfig,
    filename: string,
    data: ExportData
): Promise<WebDavResult<{ filename: string; size: number }>> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);

        // 不缩进 + gzip：比原来的「带缩进明文 JSON」小一个数量级，上传快得多
        const body = await gzipBytes(JSON.stringify(data));
        const putHeaders = { "Content-Type": "application/gzip" };

        let response = await davFetch(
            buildWebDavFileUrl(folderUrl, filename),
            "PUT",
            config,
            body,
            putHeaders
        );

        // 目录不存在时才补建，避免每次备份都先发一次 PROPFIND 预检
        if (response.status === 404 || response.status === 409) {
            await ensureWebDavFolder(config, folderUrl);
            response = await davFetch(
                buildWebDavFileUrl(folderUrl, filename),
                "PUT",
                config,
                body,
                putHeaders
            );
        }

        if (response.ok) {
            return {
                success: true,
                message: `已备份到 WebDAV：${filename}`,
                data: { filename, size: body.byteLength },
            };
        }
        if (response.status === 401 || response.status === 403) {
            return { success: false, message: "认证失败，请检查 WebDAV 账号或应用密码" };
        }

        const detail = await response.text().catch(() => "");
        return { success: false, message: `备份失败：HTTP ${response.status} ${detail.slice(0, 120)}` };
    } catch (error) {
        return { success: false, message: errorMessage(error, "备份失败") };
    }
}

// 列出远端备份文件
async function webdavList(config: WebDavConfig): Promise<WebDavResult<WebDavFile[]>> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);
        let response = await davFetch(folderUrl, "PROPFIND", config, undefined, { Depth: "1" });

        if (response.status === 404) {
            await ensureWebDavFolder(config, folderUrl);
            response = await davFetch(folderUrl, "PROPFIND", config, undefined, { Depth: "1" });
        }

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return { success: false, message: "认证失败，请检查 WebDAV 账号或应用密码" };
            }
            return { success: false, message: `获取备份列表失败：HTTP ${response.status}` };
        }

        const xml = await response.text();
        // 兼容压缩备份（.json.gz）与早期明文备份（.json）
        const files = parseWebDavList(xml).filter(file =>
            /\.json(\.gz)?$/i.test(file.name)
        );

        return { success: true, data: files };
    } catch (error) {
        return { success: false, message: errorMessage(error, "获取备份列表失败") };
    }
}

// 下载指定的远端备份
async function webdavDownload(config: WebDavConfig, filename: string): Promise<WebDavResult<ExportData>> {
    try {
        if (!filename) {
            return { success: false, message: "未指定备份文件" };
        }

        const folderUrl = buildWebDavFolderUrl(config);
        const response = await davFetch(buildWebDavFileUrl(folderUrl, filename), "GET", config);

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return { success: false, message: "认证失败，请检查 WebDAV 账号或应用密码" };
            }
            return { success: false, message: `下载备份失败：HTTP ${response.status}` };
        }

        // 压缩备份（.gz）先解压，明文备份（.json）直接读，两种格式都能恢复
        const raw = filename.toLowerCase().endsWith(".gz")
            ? await gunzipToString(await response.arrayBuffer())
            : await response.text();
        const text = raw.replace(/^\uFEFF/, "");
        const data = JSON.parse(text) as ExportData;

        return { success: true, data, message: filename };
    } catch (error) {
        return { success: false, message: errorMessage(error, "下载备份失败") };
    }
}

// 删除指定的远端备份
async function webdavDelete(config: WebDavConfig, filename: string): Promise<WebDavResult> {
    try {
        if (!filename) {
            return { success: false, message: "未指定备份文件" };
        }

        const folderUrl = buildWebDavFolderUrl(config);
        const response = await davFetch(buildWebDavFileUrl(folderUrl, filename), "DELETE", config);

        if (response.ok || response.status === 404) {
            return { success: true, message: `已删除 ${filename}` };
        }
        return { success: false, message: `删除失败：HTTP ${response.status}` };
    } catch (error) {
        return { success: false, message: errorMessage(error, "删除失败") };
    }
}

function validateConfig(data: ConfigInput): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    if (!data.value || typeof data.value !== "string") {
        errors.push("配置值不能为空且必须是字符串");
    }

    return { valid: errors.length === 0, errors };
}

// 声明ExportedHandler类型
// scheduled 是「每周自动备份」的定时入口，由 wrangler.jsonc 的 triggers.crons 触发
interface ExportedHandler {
    fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response>;
    scheduled?(controller: unknown, env: Env, ctx?: ExecutionContext): void | Promise<void>;
}

// 声明Cloudflare Workers的执行上下文类型
interface ExecutionContext {
    waitUntil(promise: Promise<any>): void;
    passThroughOnException(): void;
}

/**
 * 图标代理：把第三方 favicon 抓回来当同源响应发出去。
 *
 * 为什么需要它：跨域图片的响应是不透明的（opaque），前端读不到内容，
 * IndexedDB 里没法存成 blob，只能靠 Service Worker 缓存原始响应；
 * 走代理之后浏览器当成同源资源，前端的 blob 缓存就能生效。
 *
 * 安全限制：
 *   - 只接受 http/https，且只允许 80/443（顺手挡掉打内网服务的经典 SSRF）
 *   - 目标主机名解析到内网段的一律拒绝
 *   - 响应超过 512KB 直接丢掉，避免有人拿它当图床
 */
async function proxyIcon(request: Request): Promise<Response> {
    const target = request.url.includes("?")
        ? new URL(request.url).searchParams.get("u")
        : null;

    if (!target) return new Response("缺少 u 参数", { status: 400 });

    let targetUrl: URL;
    try {
        targetUrl = new URL(target);
    } catch {
        return new Response("图标地址不合法", { status: 400 });
    }

    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        return new Response("只支持 http/https 图标", { status: 400 });
    }

    // 端口白名单：非标准端口一律拒
    if (targetUrl.port && !["80", "443"].includes(targetUrl.port)) {
        return new Response("不支持的端口", { status: 400 });
    }

    // 内网地址黑名单（Cloudflare Worker 出网仍在我们的 VPC 视角里，挡一道更稳妥）
    const host = targetUrl.hostname.toLowerCase();
    const isPrivate =
        host === "localhost" ||
        host === "::1" ||
        host.endsWith(".local") ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^0\./.test(host);
    if (isPrivate) return new Response("不允许代理内网地址", { status: 400 });

    try {
        const upstream = await fetch(targetUrl.href, {
            redirect: "follow",
            headers: { Accept: "image/*,*/*;q=0.8" },
        });

        if (!upstream.ok || !upstream.body) {
            return new Response("上游取不到图标", { status: 404 });
        }

        const body = await upstream.arrayBuffer();
        if (body.byteLength > 512 * 1024) {
            return new Response("图标过大", { status: 413 });
        }

        const contentType = upstream.headers.get("content-type") || "";
        return new Response(body, {
            status: 200,
            headers: {
                "Content-Type": contentType.startsWith("image/")
                    ? contentType
                    : "image/x-icon",
                // 图标基本不会变，浏览器端缓存一年；前端还会再存一份 blob
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Icon-Target": targetUrl.hostname,
            },
        });
    } catch {
        return new Response("取图标失败", { status: 502 });
    }
}

// ============ 条件请求（ETag） ============

/**
 * 给响应体算一个弱 ETag（FNV-1a 哈希 + 长度，够用且不需要 crypto）。
 * 这里只用来判断「内容有没有变」，不是安全用途。
 */
function weakEtag(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `W/"${(hash >>> 0).toString(36)}-${text.length.toString(36)}"`;
}

// 声明D1数据库类型
interface D1Database {
    prepare(query: string): D1PreparedStatement;
    exec(query: string): Promise<D1Result>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface D1PreparedStatement {
    bind(...values: any[]): D1PreparedStatement;
    first<T = unknown>(column?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    error?: string;
    meta?: any;
}
