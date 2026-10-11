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
