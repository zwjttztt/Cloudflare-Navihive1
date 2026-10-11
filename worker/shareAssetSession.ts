const encoder = new TextEncoder();

async function signature(secret: string, value: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export async function issueShareAssetSession(token: string, passwordHash: string, now = Date.now()): Promise<string> {
    const expires = now + 30 * 60_000;
    return `${expires}.${await signature(passwordHash, `${token}:${expires}`)}`;
}

export async function verifyShareAssetSession(value: string | null, token: string, passwordHash: string, now = Date.now()): Promise<boolean> {
    if (!value || !/^\d{13}\.[a-f0-9]{64}$/.test(value)) return false;
    const [expires, mac] = value.split(".");
    if (Number(expires) <= now || Number(expires) > now + 30 * 60_000) return false;
    const expected = await signature(passwordHash, `${token}:${expires}`);
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
    return difference === 0;
}

export function shareAssetCookieName(token: string): string {
    return `nh_share_${token.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

// ---------------- 浏览计数防刷（2026-10-11） ----------------
//
// views 之前是「每次成功打开 +1」：F5 一次计一次，脚本刷一晚能刷出几万次，
// 「浏览 N 次」就失去了参考意义。去重用 cookie 打当日戳：同一浏览器同一天
// 只计一次，跨天/清 cookie 重新计。这是尽力而为的防刷（cookie 可清），
// 但成本为零、不建表不迁移，对「展示用计数」足够。
export function shareViewCookieName(kind: "note" | "group", token: string): string {
    return `nh_${kind}view_${token.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** UTC 当日戳（YYYY-MM-DD）：判定「同一天」用 UTC，与 Workers/DB 的时间口径一致 */
export function utcDayStamp(now = Date.now()): string {
    return new Date(now).toISOString().slice(0, 10);
}

/** 距下一个 UTC 零点的秒数（cookie 正好活到换天），下限 60 兜底 */
export function secondsUntilUtcMidnight(now = Date.now()): number {
    const d = new Date(now);
    const tomorrow = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    return Math.max(60, Math.ceil((tomorrow - now) / 1000));
}
