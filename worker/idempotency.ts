// worker/idempotency.ts
// 写操作的幂等闸门：认出「这一条其实已经做过了」，把上次的响应原样回放。
//
// 客户端（离线队列重放、超时重试）在 `Idempotency-Key` 头里带上一个不重复的 ID，
// 服务端按「账号 + 端点 + 这个 ID」记一条记录：
//
//   没见过      → 抢占位，抢到的人去真正执行，执行完把响应存下来
//   已完成      → 直接回放上次那份响应，不再产生任何副作用
//   还在执行中  → 回 409 让客户端稍后再问（并发的第二次补发落在这里）
//
// 两处刻意的保守：
//   - **拿不到锁就照常执行**。表还没建好、D1 抽风时 claim 会返回 false，
//     那时退回「不幂等」的老行为 —— 总比把一次正常的新建拦下来强。
//   - **只回放成功响应**。5xx 不缓存也不回放，那本来就该让客户端重试。

import type { NavigationAPI } from "../src/API/http";

/** 幂等 ID 的长度上限：UUID 是 36 字符，放宽到 128 够任何合理生成器，同时挡掉超长垃圾 */
const MAX_OP_ID_LEN = 128;

/** 只认这几种字符：ID 会进 SQL 参数与存储键，别让它带上奇怪的东西 */
const OP_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * 从请求头里取幂等 ID。不合法 / 缺失一律返回 null（= 这次不启用幂等）。
 *
 * 长度下限 8 是有意的：太短的字符串很可能不是幂等 ID 而是误传的其它东西，
 * 那种情况下「不启用」比「按一个可疑 ID 去合并请求」安全得多。
 */
export function readIdempotencyKey(request: Request): string | null {
    const raw = request.headers.get(IDEMPOTENCY_HEADER);
    if (!raw) return null;
    const key = raw.trim();
    if (key.length > MAX_OP_ID_LEN) return null;
    return OP_ID_PATTERN.test(key) ? key : null;
}

/** 幂等记录的作用域：账号 + 端点。不同账号 / 不同端点互不影响 */
export function idempotencyScope(api: NavigationAPI, endpoint: string): string {
    const uid = api.getCurrentUserId();
    return `u${uid === null ? "anon" : uid}:${endpoint}`;
}

/** 「已有同伴在跑」：不是错误，客户端稍后再问一次就能拿到结果 */
function inFlight(): Response {
    return Response.json(
        {
            success: false,
            message: "该操作正在处理中，请稍后重试",
            inFlight: true,
        },
        { status: 409, headers: { "Retry-After": "2" } }
    );
}

/**
 * 包住一次写操作。
 *
 * @param api     当前请求的 API 实例（带账号上下文）
 * @param endpoint 端点标识，如 "sites.POST"
 * @param key     客户端传来的幂等 ID，null 表示不启用
 * @param run     真正干活的那段
 */
export async function withIdempotency(
    api: NavigationAPI,
    endpoint: string,
    key: string | null,
    run: () => Promise<Response | null>
): Promise<Response | null> {
    // 没带幂等 ID：老老实实执行，行为与接入前完全一致
    if (!key || typeof api.claimIdempotency !== "function") return await run();

    const scope = idempotencyScope(api, endpoint);

    // 先看看有没有已经做过：有就直接回放，一次副作用都不产生
    const existing = await api.readIdempotency(scope, key).catch(() => null);
    if (existing?.state === "done") {
        const body = existing.body ?? "";
        return new Response(body, {
            status: existing.status ?? 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Idempotency-Replayed": "true",
            },
        });
    }
    if (existing?.state === "pending") {
        // 占位还在有效期内 → 同伴正在跑，别并发做第二遍
        if (Date.now() - existing.createdAt < 2 * 60 * 1000) return inFlight();
        // 占位太旧（上一次执行崩了没来得及清）→ 允许这一趟重来
        await api.releaseIdempotency(scope, key).catch(() => {});
    }

    const claimed = await api.claimIdempotency(scope, key).catch(() => false);
    // 抢不到：要么刚被同伴抢走（等它出结果），要么存储不可用（那就照常执行）
    if (!claimed) {
        const fresh = await api.readIdempotency(scope, key).catch(() => null);
        if (fresh?.state === "done") {
            return new Response(fresh.body ?? "", {
                status: fresh.status ?? 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Idempotency-Replayed": "true",
                },
            });
        }
        if (fresh?.state === "pending") return inFlight();
        // 读不到记录（多半是表/存储不可用）：退回不幂等，别把正常写操作拦下
        return await run();
    }

    let response: Response | null;
    try {
        response = await run();
    } catch (error) {
        // 执行失败：抹掉占位，让客户端下一次重试能真正重跑
        await api.releaseIdempotency(scope, key).catch(() => {});
        throw error;
    }

    // 路由没接（返回 null）：这不是一次执行，别占着记录
    if (response === null) {
        await api.releaseIdempotency(scope, key).catch(() => {});
        return null;
    }

    // 只缓存 2xx 与 4xx：4xx 是「参数不对」这类确定性结果，回放它没坏处；
    // 5xx 一律不缓存 —— 那本来就该让客户端再来一次
    if (response.status >= 200 && response.status < 500) {
        const body = await response.clone().text().catch(() => null);
        await api
            .completeIdempotency(scope, key, { status: response.status, body })
            .catch(() => {});
        // 缓存的是克隆体，原响应照原样返回给客户端
        return response;
    }

    await api.releaseIdempotency(scope, key).catch(() => {});
    return response;
}
