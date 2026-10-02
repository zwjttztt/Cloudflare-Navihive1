// worker/safeFetch.ts
//
// 所有「Worker 代发请求」的入口（meta.ts 抓页面元信息、icon.ts 代理图标、webdav.ts 备份）
// 都通过本文件走。SSRF / DNS rebinding 防护都集中在这里：
//
//   - scheme 只放行 http/https
//   - 端口只放行 80/443
//   - hostname 每一跳都重新过 isBlockedHost（RFC1918、loopback、link-local、IPv6 ULA、
//     IPv4-mapped IPv6、组播/保留段等——见 util.ts 的注释）
//   - 手动跟随重定向（redirect:"manual"），每跳重验：redirect:"follow" 不会重验目标，
//     攻击者可借 302 把 Worker 引到 169.254.169.254 / 内网（SSRF）。上限 4 跳防无限循环
//   - 跨源重定向会剥掉凭据头（Authorization / Cookie / 各类 API key），
//     并且 301/302/303 跨源时把方法降级成 GET、丢掉 body ——
//     否则「A 站点的 302 → B 站点」会把给 A 的凭据原样交给 B
//   - 超时有两层：单跳 timeoutMs（默认 8s）+ 整段 totalTimeoutMs（默认 15s）。
//     只有单跳上限时，一串 302 可以把总耗时拖到 8s × 跳数
//   - Cloudflare Workers 的 egress 默认就会拦截已知内网段（RFC1918、loopback、link-local），
//     即使 hostname 通过 DNS rebinding 解析回内网 IP，底层也会被 Cloudflare 拦下；
//     上面的 hostname 黑名单是「纵深防御」层。两道加起来是「明文 hostname 不信 + 真实
//     出口 IP 不信」的双保险
//
// 调用方不要自己写 fetch + redirect loop —— 集中到这里是为了让所有出站请求共用同一套
// 安全策略，避免某条新路由忘了加校验。

import { isBlockedHost } from "./util";

/** 最大重定向跳数（防无限循环 / 跳板探测） */
const DEFAULT_MAX_REDIRECTS = 4;
/** 默认单跳超时 */
const DEFAULT_TIMEOUT_MS = 8_000;
/**
 * 默认整段总超时（含所有重定向跳）；0 表示不限。
 *
 * 取 max(单跳, 15000) 而不是写死 15000，是为了不把调用方放大的单跳砍短 ——
 * AI 补全的单跳就是 25s（模型慢），写死 15s 会把它从「慢但能成」变成「必超时」。
 * 它挡的是另一种情况：4 跳 × 8s = 32s 这种被重定向串起来的长尾。
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;

/**
 * 跨源重定向时必须剥掉的请求头：这些是「给上一个主机的凭据」，
 * 不该因为一次 302 就转手交给下一个主机。
 */
const CREDENTIAL_HEADERS = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "cookie2",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-csrf-token",
];

/** 剥掉凭据头；头名大小写不敏感，返回一份新对象（不改动调用方传入的 headers） */
function stripCredentials(
    headers?: Record<string, string>
): Record<string, string> | undefined {
    if (!headers) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (CREDENTIAL_HEADERS.includes(key.toLowerCase())) continue;
        out[key] = value;
    }
    return out;
}

export interface SafeFetchOptions {
    /** 自定义最大跳数（默认 4） */
    maxRedirects?: number;
    /** 自定义单次 fetch 超时（默认 8000ms）。设为 0 表示不限 */
    timeoutMs?: number;
    /**
     * 整段请求的总超时（默认 15000ms），从第一次发请求起算，覆盖所有重定向跳。
     * 设为 0 表示不限总时长。单跳 timeoutMs 与剩余预算取小的那个生效。
     */
    totalTimeoutMs?: number;
    /** 透传给 fetch 的 header（UA、Accept、Cookie 等） */
    headers?: Record<string, string>;
    /** fetch 选项透传（如 body、method）；默认 GET */
    fetchInit?: Omit<RequestInit, "redirect" | "headers" | "signal">;
}

/**
 * safeFetch 的返回。让调用方处理错误而不是抛异常 —— 出站请求里「目标不可达」是常态，
 * 抛出去会让 caller 写 try/catch 包裹，handler 末端还要 catch-all，这里把错误归一化。
 */
export type SafeFetchResult =
    | { ok: true; response: Response }
    | {
          ok: false;
          /** blocked: hostname 被黑名单拦下 / 端口非 80-443 / scheme 非 http(s) */
          kind: "blocked";
          status: 400;
          message: string;
      }
    | {
          ok: false;
          /** redirect: 跳数耗尽 / Location 缺失 / Location 不是合法 URL */
          kind: "redirect";
          status: 502;
          message: string;
      }
    | {
          ok: false;
          /** invalid: 起始 URL 不合法 */
          kind: "invalid";
          status: 400;
          message: string;
      }
    | {
          ok: false;
          /** timeout: fetch 超时 / 网络错 */
          kind: "timeout";
          status: 502;
          message: string;
      }
    | {
          ok: false;
          /** http: 拿到响应但 status 非 2xx */
          kind: "http";
          status: 502;
          message: string;
          upstreamStatus: number;
      };

/**
 * 给目标 URL 做一次「过黑名单 + 手动 redirect + 超时」的 fetch。
 *
 * 返回 ok=true 时 response.body 仍然可读（不会被消费）；调用方负责处理大小限制、
 * 编码解析等。
 */
export async function safeFetch(
    target: URL,
    options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const totalTimeoutMs =
        options.totalTimeoutMs ??
        // 单跳不限（timeoutMs=0，icon 代理大文件）时总时长也不限，
        // 否则沿用调用方的意图，只是不让多跳把它叠加放大
        (timeoutMs > 0 ? Math.max(timeoutMs, DEFAULT_TOTAL_TIMEOUT_MS) : 0);

    // 初始 URL 已经做过 new URL，传进来肯定是合法的，这里只判 scheme / port / host
    let current = target;
    let upstream: Response | null = null;
    // 跨源跳转后要剥掉凭据、必要时降级方法，所以这两样是可变的
    let headers = options.headers;
    let method = options.fetchInit?.method ?? "GET";
    let body = options.fetchInit?.body;
    const startedAt = Date.now();

    for (let hop = 0; hop <= maxRedirects; hop++) {
        // 每跳都重新校验（hostname 才是关键，不要相信 Location 头里的 scheme/port）
        if (current.protocol !== "http:" && current.protocol !== "https:") {
            return {
                ok: false,
                kind: "blocked",
                status: 400,
                message: "只支持 http/https",
            };
        }
        if (current.port && !["80", "443"].includes(current.port)) {
            return {
                ok: false,
                kind: "blocked",
                status: 400,
                message: "不支持的端口",
            };
        }
        if (isBlockedHost(current.hostname)) {
            return {
                ok: false,
                kind: "blocked",
                status: 400,
                message: "不允许访问内网地址",
            };
        }

        // 整段预算：先扣掉已经花掉的时间，剩下的才是这一跳能用的。
        // 只有单跳上限时，一串 302 可以把总耗时拖到 timeoutMs × 跳数。
        let perHopTimeout = timeoutMs;
        if (totalTimeoutMs > 0) {
            const remaining = totalTimeoutMs - (Date.now() - startedAt);
            if (remaining <= 0) {
                return {
                    ok: false,
                    kind: "timeout",
                    status: 502,
                    message: "整段请求超时",
                };
            }
            perHopTimeout = timeoutMs > 0 ? Math.min(timeoutMs, remaining) : remaining;
        }

        // 组装 fetch 选项。timeoutMs=0 且 totalTimeoutMs=0 表示不限超时（icon 代理偶尔大文件需要）
        const init: RequestInit = {
            redirect: "manual",
            ...(options.fetchInit ?? {}),
            headers,
            method,
            body,
        };
        if (perHopTimeout > 0) {
            init.signal = AbortSignal.timeout(perHopTimeout);
        }

        let res: Response;
        try {
            res = await fetch(current.href, init);
        } catch (error) {
            const isTimeout =
                error instanceof DOMException &&
                (error.name === "TimeoutError" || error.name === "AbortError");
            return {
                ok: false,
                kind: isTimeout ? "timeout" : "timeout",
                status: 502,
                message: isTimeout ? "抓取超时" : "抓取失败",
            };
        }

        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) {
                return {
                    ok: false,
                    kind: "redirect",
                    status: 502,
                    message: "重定向缺少 Location",
                };
            }
            if (hop === maxRedirects) {
                return {
                    ok: false,
                    kind: "redirect",
                    status: 502,
                    message: "重定向次数过多或被跳板",
                };
            }
            let next: URL;
            try {
                next = new URL(loc, current.href);
            } catch {
                return {
                    ok: false,
                    kind: "redirect",
                    status: 502,
                    message: "重定向地址不合法",
                };
            }

            // 跨主机跳转：给上一个主机的凭据不能跟着走
            if (next.origin !== current.origin) {
                headers = stripCredentials(headers);
                // 301/302/303 的标准语义就是「用 GET 重新取」，跨源时更要丢掉 body，
                // 否则一次跳转就把 POST 的内容发到了另一个主机
                if (res.status === 301 || res.status === 302 || res.status === 303) {
                    if (method !== "GET") method = "GET";
                    body = undefined;
                }
            }
            current = next;
            continue;
        }

        upstream = res;
        break;
    }

    if (!upstream) {
        return {
            ok: false,
            kind: "redirect",
            status: 502,
            message: "未能拿到上游响应",
        };
    }

    if (!upstream.ok) {
        return {
            ok: false,
            kind: "http",
            status: 502,
            message: `目标返回 ${upstream.status}`,
            upstreamStatus: upstream.status,
        };
    }

    return { ok: true, response: upstream };
}