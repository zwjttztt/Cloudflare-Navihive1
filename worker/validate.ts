// worker/validate.ts
// 各写路由的请求体校验：返回错误列表 + 清洗后的数据（trim、截断超长字段、URL 格式校验）。

import { normalizeUrl } from "../src/utils/url";
import type { Group, Site } from "../src/API/http";
import { sanitizeIconUrl } from "../src/API/http";
import type { ConfigInput, GroupInput, LoginInput, SiteInput } from "./types";

export function validateLogin(data: LoginInput): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    if (!data.username || typeof data.username !== "string") {
        errors.push("用户名不能为空且必须是字符串");
    }

    if (!data.password || typeof data.password !== "string") {
        errors.push("密码不能为空且必须是字符串");
    }

    return { valid: errors.length === 0, errors };
}
export function validateGroup(data: GroupInput): {
    valid: boolean;
    errors?: string[];
    sanitizedData?: Group;
} {
    const errors: string[] = [];
    const sanitizedData: Partial<Group> = {};

    // 验证名称
    if (typeof data.name !== "string" || !data.name.trim()) {
        errors.push("分组名称不能为空且必须是字符串");
    } else {
        sanitizedData.name = data.name.trim().slice(0, 100); // 限制长度
    }

    // 验证排序号
    if (data.order_num === undefined || !Number.isSafeInteger(data.order_num)) {
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
/**
 * 站点网址的入库校验：必须能规范化成 http/https，且不接受明显不是域名的裸串。
 *
 * 直接吃 `normalizeUrl` 的结果是不够的：它会给任何没写协议的输入补 `https://`，
 * 于是手滑敲进去的 "not-a-url" 也会被当成 https://not-a-url 放进来。
 * 所以额外要求：没写协议的输入，主机名里必须有点（`baidu.com` 这种省略协议的写法
 * 要继续放行，前台表单本来也依赖这种宽容）。写了协议的一律按协议白名单走。
 */
function strictSiteUrl(raw: string): string | null {
    const normalized = normalizeUrl(raw);
    if (!normalized.ok) return null;
    const trimmed = raw.trim();
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
    if (hasScheme) return normalized.url;
    try {
        return /\./.test(new URL(normalized.url).hostname) ? normalized.url : null;
    } catch {
        return null;
    }
}
export function validateSite(data: SiteInput): {
    valid: boolean;
    errors?: string[];
    sanitizedData?: Site;
} {
    const errors: string[] = [];
    const sanitizedData: Partial<Site> = {};

    // 验证分组ID
    if (!Number.isSafeInteger(data.group_id) || (data.group_id ?? 0) <= 0) {
        errors.push("分组ID必须是数字且不能为空");
    } else {
        sanitizedData.group_id = data.group_id;
    }

    // 验证名称
    if (typeof data.name !== "string" || !data.name.trim()) {
        errors.push("站点名称不能为空且必须是字符串");
    } else {
        sanitizedData.name = data.name.trim().slice(0, 100); // 限制长度
    }

    // 验证URL
    if (!data.url || typeof data.url !== "string") {
        errors.push("URL不能为空且必须是字符串");
    } else {
        const normalized = strictSiteUrl(data.url);
        if (normalized) sanitizedData.url = normalized;
        else errors.push("无效的URL格式：只支持 http/https");
    }

    // 验证图标URL (可选)
    if (data.icon !== undefined) {
        if (typeof data.icon !== "string") {
            errors.push("图标URL必须是字符串");
        } else if (data.icon) {
            try {
                // 验证URL格式
                new URL(data.icon);
                // L1：挡掉 javascript:/vbscript:/file:/data:text/html 这类可执行 / 危险协议
                // （data:text/html 能过 new URL 校验，但作为图标渲染是风险点，统一清掉）。
                // 与导入路径（normalizeImportData）保持同一套清洗规则。
                sanitizedData.icon = sanitizeIconUrl(data.icon.trim());
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
    if (data.order_num === undefined || !Number.isSafeInteger(data.order_num)) {
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
export function validateConfig(data: ConfigInput): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    if (!data.value || typeof data.value !== "string") {
        errors.push("配置值不能为空且必须是字符串");
    }

    return { valid: errors.length === 0, errors };
}
