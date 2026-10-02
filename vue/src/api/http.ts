// 极简 API 客户端：只做样板要用的那几个端点，但请求约定与 React 版完全一致：
//   - baseUrl 固定 /api
//   - 凭据走 httpOnly cookie，credentials: same-origin（令牌不落在 JS 里）
//   - 非 2xx 优先取服务端 message，401 单独识别以便上层跳登录
import type { BootstrapData, Group, Site, SiteMeta } from "./types";

const BASE = "/api";

export class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE}/${endpoint}`, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        ...options,
    });

    if (response.ok) {
        return (await response.json()) as T;
    }

    let payload: { message?: string; error?: string } = {};
    try {
        payload = (await response.json()) as { message?: string; error?: string };
    } catch {
        payload = {};
    }
    const reason = payload.message || payload.error || "";

    if (response.status === 401) {
        throw new ApiError(401, reason ? `认证失败：${reason}` : "认证已过期或无效，请重新登录");
    }
    throw new ApiError(
        response.status,
        reason ? `${reason} (HTTP ${response.status})` : `API错误: ${response.status}`
    );
}

/** 首屏一次性拿全：分组 + 平铺站点 + 全站配置 */
export function fetchBootstrap(): Promise<BootstrapData> {
    return request<BootstrapData>("bootstrap");
}

export function createGroup(body: Group): Promise<Group> {
    return request<Group>("group", { method: "POST", body: JSON.stringify(body) });
}

export function createSite(body: Site): Promise<Site> {
    return request<Site>("site", { method: "POST", body: JSON.stringify(body) });
}

export function updateSite(body: Site): Promise<Site> {
    return request<Site>("site", { method: "PUT", body: JSON.stringify(body) });
}

/** 根据链接抓取标题 / 描述 / 图标（新增站点框里的「抓取」按钮） */
export function fetchSiteMeta(url: string): Promise<SiteMeta> {
    return request<SiteMeta>(`meta?url=${encodeURIComponent(url)}`);
}
