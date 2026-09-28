// src/utils/firstPaintCache.ts
// 首屏数据缓存（stale-while-revalidate）：
// 上次打开时拉过的 bootstrap 数据留在 sessionStorage 里，这次一进来就先用它渲染，
// 同时照常发请求拿最新数据覆盖。这样二次打开基本没有白屏，代价是最多几百毫秒的旧内容。
import { BootstrapData } from "../API/http";

const KEY = "navihive:bootstrap-cache";
// 缓存超过 7 天就不用了（避免长期停在某个旧快照上）
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// 数据量太大就不缓存，免得 sessionStorage 被撑爆
const MAX_SITES = 2000;

type CachedBootstrap = { ts: number; data: BootstrapData };

const isUsable = (parsed: CachedBootstrap | null): parsed is CachedBootstrap =>
    Boolean(
        parsed &&
            parsed.data &&
            Array.isArray(parsed.data.groups) &&
            Array.isArray(parsed.data.sites) &&
            Date.now() - parsed.ts < MAX_AGE_MS &&
            parsed.data.sites.length <= MAX_SITES
    );

export function readBootstrapCache(): BootstrapData | null {
    try {
        const raw = sessionStorage.getItem(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachedBootstrap;
        return isUsable(parsed) ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * 写缓存前先把站点登录凭据剔掉。
 *
 * bootstrap 为了让「复制密码」这类操作开箱可用，返回的是**已解密的明文密码**。
 * 缓存是为了少白屏几百毫秒的临时快照，没必要（也不该）连带把一份明文凭据
 * 留在 sessionStorage 里 —— 同源的 JS 都能读它，XSS 或恶意扩展一伸手就能拿到全站密码。
 * 缺的那两个字段几十毫秒后就被真数据覆盖，界面上不会有任何差别。
 */
function stripCredentials(data: BootstrapData): BootstrapData {
    return {
        ...data,
        sites: (data.sites || []).map(site => ({ ...site, username: "", password: "" })),
    };
}

export function writeBootstrapCache(data: BootstrapData): void {
    try {
        if ((data.sites || []).length > MAX_SITES) return;
        sessionStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), data: stripCredentials(data) }));
    } catch {
        // 隐私模式/配额不够时静默跳过，不影响正常使用
    }
}

export function clearBootstrapCache(): void {
    try {
        sessionStorage.removeItem(KEY);
    } catch {
        // 同上
    }
}
