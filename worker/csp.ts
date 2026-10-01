// worker/csp.ts
// CSP 违规上报的接收端：浏览器遇到违反 Content-Security-Policy 的资源时，
// 会向 report-uri 指定的地址 POST 一份 JSON 报告（不带自定义头、不带凭据）。
// 这里只做「解析 + 打日志」，不落库 —— Workers 的 observability 已开启，
// console 输出可以直接在仪表盘里搜到，足以定位「哪条指令拦了什么」。

import { createMemoryLimiter } from "./rateLimit";
import { clientIp } from "./httpUtils";

// 这也是个公开端点：谁都能 POST，虽然只写日志不落库，但没有上限时
// 一堆报告能把 Workers 日志灌满，真正的违规反而被淹没。
// 用与错误上报同一套 isolate 内窗口，按来源 IP 分桶（刷子只会把自己刷出去）。
const cspLimiter = createMemoryLimiter({ windowMs: 10_000, max: 20, maxKeys: 2_000 });

/** 测试用：清空窗口计数（生产不会调） */
export function resetCspLimitForTest(): void {
    cspLimiter.reset();
}

export async function handleCspReport(request: Request): Promise<Response> {
    // 超窗静默丢弃：上报失败不该影响页面，也不该让刷报告的人学到任何东西
    if (!cspLimiter.allow(clientIp(request))) {
        return new Response(null, { status: 204 });
    }
    try {
        // 报告体积很小，设个上限防滥用；超限直接丢弃
        const raw = await request.text();
        if (raw.length <= 8192) {
            const parsed = JSON.parse(raw) as { "csp-report"?: Record<string, unknown> };
            const report = parsed["csp-report"];
            if (report && typeof report === "object") {
                const directive = String(
                    report["violated-directive"] || report["effective-directive"] || "?"
                );
                console.warn(
                    `[CSP] directive=${directive} blocked=${String(report["blocked-uri"] || "?")} ` +
                        `source=${String(report["source-file"] || "?")}:${String(report["line-number"] ?? "")}`
                );
            }
        }
    } catch {
        // 报告解析失败不影响响应
    }
    return new Response(null, { status: 204 });
}
