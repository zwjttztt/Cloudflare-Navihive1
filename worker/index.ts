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

                    const result = await api.login(loginData as LoginRequest);
                    return Response.json(result);
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

                // 确保数据库结构是最新的（例如补齐站点账号密码字段）
                await api.migrate();

                // 路由匹配
                if (path === "groups" && method === "GET") {
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

                    const result = await api.updateSiteOrder(data);
                    return Response.json({ success: result });
                }
                // 配置相关API
                else if (path === "configs" && method === "GET") {
                    const configs = await api.getConfigs();
                    return Response.json(configs);
                } else if (path.startsWith("configs/") && method === "GET") {
                    const key = path.substring("configs/".length);
                    const value = await api.getConfig(key);
                    return Response.json({ key, value });
                } else if (path.startsWith("configs/") && method === "PUT") {
                    const key = path.substring("configs/".length);
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
                    const result = await api.deleteConfig(key);
                    return Response.json({ success: result });
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
                    const payload = body.data ?? (await api.exportData());
                    const filename = body.filename || buildBackupFileName();
                    const result = await webdavUpload(config, filename, payload);
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
} satisfies ExportedHandler;

// 环境变量接口
interface Env {
    DB: D1Database;
    AUTH_ENABLED?: string;
    AUTH_USERNAME?: string;
    AUTH_PASSWORD?: string;
    AUTH_SECRET?: string;
}

// 验证用接口
interface LoginInput {
    username?: string;
    password?: string;
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

    const readConfig = async (key: string): Promise<string> => {
        try {
            return (await api.getConfig(key)) || "";
        } catch {
            return "";
        }
    };

    const pick = (value: unknown, fallback: string): string =>
        typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;

    return {
        url: pick(payload.url, await readConfig("webdav.url")),
        username: pick(payload.username, await readConfig("webdav.username")),
        password: pick(payload.password, await readConfig("webdav.password")),
        path: pick(payload.path, await readConfig("webdav.path")) || DEFAULT_WEBDAV_PATH,
    };
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
        `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    return `navihive-backup-${stamp}.json`;
}

async function davFetch(
    url: string,
    method: string,
    config: WebDavConfig,
    body?: string,
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
        await ensureWebDavFolder(config, folderUrl);

        const content = JSON.stringify(data, null, 2);
        const response = await davFetch(buildWebDavFileUrl(folderUrl, filename), "PUT", config, content, {
            "Content-Type": "application/json; charset=utf-8",
        });

        if (response.ok) {
            return {
                success: true,
                message: `已备份到 WebDAV：${filename}`,
                data: { filename, size: content.length },
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
        const files = parseWebDavList(xml).filter(file => file.name.toLowerCase().endsWith(".json"));

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

        const text = (await response.text()).replace(/^\uFEFF/, "");
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
interface ExportedHandler {
    fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response>;
}

// 声明Cloudflare Workers的执行上下文类型
interface ExecutionContext {
    waitUntil(promise: Promise<any>): void;
    passThroughOnException(): void;
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
