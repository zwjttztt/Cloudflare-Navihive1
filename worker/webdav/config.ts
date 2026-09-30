// 配置从哪来。
//
// 这一层最要紧的是那条安全约束：只有「测试连接」允许请求体临时指定一套地址，
// 真正会碰到数据的操作（上传 / 列表 / 下载 / 删除）一律只认库里存的那套 ——
// 否则任何登录账号都能临时指定目标，让 Worker 替它把请求发到内网去。
import type { NavigationAPI } from "../../src/API/http";
import { safeJson } from "../util";
import { DEFAULT_WEBDAV_PATH, type WebDavConfig } from "./types";

/** 布尔配置在 configs 表里按项目惯例存 "1"/"0" */
function parseBoolFlag(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const v = value.trim();
        if (v === "1" || v === "true") return true;
        if (v === "0" || v === "false" || v === "") return false;
    }
    return fallback;
}

/**
 * 解析本次要用哪套 WebDAV 配置。
 *
 * 「测试连接」允许请求体临时填一套（用户还没保存就想先试试，这条路径必须有）；
 * 但真正会碰到数据的操作（上传 / 列表 / 下载 / 删除）**一律只认已保存的配置**：
 * 过去它们也接受请求体里的一整套 url / 账号 / 密码 / allowPrivateNetwork，等于
 * 任何登录账号都能临时指定一个目标，让 Worker 替它把请求发出去 ——
 * 尤其 allowPrivateNetwork，光靠请求体一句话就能把内网开关拨开，
 * 而 list / download 还会把上游响应内容原样回传给调用方：一条完整的 SSRF 读内网路径。
 *
 * 唯一保留的例外是 backupPassword：上一轮修「别的账号传的加密备份无法恢复」时加的，
 * 恢复页需要就地输入一次口令才能解开那份备份，并且它只用于解密、不影响发往哪里。
 */
export async function resolveWebDavConfig(
    api: NavigationAPI,
    request: Request,
    body?: Record<string, unknown>,
    options: { allowBodyOverride?: boolean } = {}
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
    // 口令不能 trim：首尾空格可能是用户有意敲的，trim 掉会导致「自己设的密码解不开自己的备份」
    const pickRaw = (value: unknown, fallback: string): string =>
        typeof value === "string" && value !== "" ? value : fallback;

    // 只有 owner（或单账号部署）碰这个开关：
    // 内网直连是站点级特权，不该让普通账号借 owner 给 NAS 开的那道口子碰到内网
    const allowedPrivate = await canUsePrivateNetwork(api);
    // 真正影响数据操作的那个值：库里存了「允许」且当前账号有资格
    const allowPrivate = parseBoolFlag(stored["webdav.allowPrivateNetwork"], false) && allowedPrivate;

    if (options.allowBodyOverride) {
        return {
            url: pick(payload.url, stored["webdav.url"] || ""),
            username: pick(payload.username, stored["webdav.username"] || ""),
            password: pick(payload.password, stored["webdav.password"] || ""),
            path: pick(payload.path, stored["webdav.path"] || "") || DEFAULT_WEBDAV_PATH,
            backupPassword: pickRaw(
                payload.backupPassword,
                stored["webdav.backupPassword"] || ""
            ),
            // 测试连接时开关可以跟着界面临时拨动（填完还没保存就想先试是很常见的用法）；
            // 但「有没有资格」不由请求体决定 —— 没资格的人拨了也不生效
            allowPrivateNetwork:
                parseBoolFlag(payload.allowPrivateNetwork, allowPrivate) && allowedPrivate,
        };
    }

    // 其它路由：目标地址 / 账号 / 路径全部取自库里存的那一套，请求体一概不认
    return {
        url: stored["webdav.url"] || "",
        username: stored["webdav.username"] || "",
        password: stored["webdav.password"] || "",
        path: stored["webdav.path"] || DEFAULT_WEBDAV_PATH,
        // 唯一例外：备份口令。它只在本地用来加解密，不会被发往别处
        backupPassword: pickRaw(payload.backupPassword, stored["webdav.backupPassword"] || ""),
        allowPrivateNetwork: allowPrivate,
    };
}

/** 「允许内网地址」能不能用：站点所有者，或没有账号概念的单账号部署 */
async function canUsePrivateNetwork(api: NavigationAPI): Promise<boolean> {
    try {
        if (typeof api.canManageSharedConfigs !== "function") return true;
        return await api.canManageSharedConfigs();
    } catch {
        return false;
    }
}

// 读取全部配置（供备份流程复用，避免重复查询）
export async function readAllConfigs(api: NavigationAPI): Promise<Record<string, string>> {
    try {
        return await api.getConfigs();
    } catch {
        return {};
    }
}

export function configFromStored(stored: Record<string, string>): WebDavConfig {
    return {
        url: stored["webdav.url"] || "",
        username: stored["webdav.username"] || "",
        password: stored["webdav.password"] || "",
        path: stored["webdav.path"] || DEFAULT_WEBDAV_PATH,
        backupPassword: stored["webdav.backupPassword"] || "",
        allowPrivateNetwork: parseBoolFlag(stored["webdav.allowPrivateNetwork"], false),
    };
}
