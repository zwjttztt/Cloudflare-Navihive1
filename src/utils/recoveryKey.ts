// src/utils/recoveryKey.ts
// 恢复密钥（忘记管理员密码时找回）的浏览器端工具。
//
// 安全前提：私钥只在用户自己的浏览器内存里出现，用来给恢复令牌签名，绝不发给服务器；
// 服务器只持有公钥（仅用于验签）。所以即便「找回密码」入口暴露在公网，
// 没有私钥的人也造不出合法令牌 —— 不像共享密钥那样能被暴力猜解。
//
// 算法优先 Ed25519（密钥短、签名快）；浏览器不支持时退回 ES256（ECDSA P-256，
// 所有现代浏览器都支持）。算法写在 JWS 头的 alg 里，服务端按 alg 选择验签方式。

import { hashPassword } from "../API/crypto";
import type { Bytes } from "../API/crypto";

export type RecoveryAlg = "EdDSA" | "ES256";

/** 私钥文件（下载到本地保存）的内容结构 */
export interface RecoveryKeyFile {
    v: 1;
    alg: RecoveryAlg;
    /** 公钥 SPKI，base64url —— 上传给服务器保存 */
    publicKey: string;
    /** 私钥 PKCS8，base64url —— 等同于万能钥匙，只留在本地 */
    privateKey: string;
    createdAt: string;
}

const enc = new TextEncoder();

/**
 * 检查当前浏览器环境是否能使用 Web Crypto（subtle）。
 * Web Crypto 只在「安全上下文」可用：HTTPS、localhost/127.0.0.1、file://（部分浏览器）。
 * 本地开发时如果通过 IP（如 http://192.168.x.x:5173）访问，subtle 会是 undefined。
 * 返回字符串表示不可用的原因；返回 null 表示可用。
 */
export function checkWebCryptoSupport(): string | null {
    if (typeof crypto === "undefined" || !crypto.subtle) {
        const protocol = typeof window !== "undefined" ? window.location.protocol : "";
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const secure = typeof window !== "undefined" ? window.isSecureContext : undefined;
        if (secure === false) {
            return `当前页面不是安全上下文，无法使用 Web Crypto（当前地址：${origin}）。请改用 https:// 访问，或本地开发时使用 http://localhost/127.0.0.1。`;
        }
        if (protocol === "http:" && origin && !origin.includes("localhost") && !origin.includes("127.0.0.1")) {
            return `当前 HTTP 地址 ${origin} 不支持 Web Crypto；请改用 http://localhost（或 https://）访问。`;
        }
        return `当前浏览器环境不支持 Web Crypto（需 HTTPS 或 localhost 访问）。`;
    }
    return null;
}

function b64urlEncode(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Bytes {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** 算法显示名，用于界面提示 */
export function algLabel(alg: RecoveryAlg): string {
    return alg === "EdDSA" ? "Ed25519 (EdDSA)" : "ECDSA P-256 (ES256)";
}

/**
 * 生成恢复密钥对。优先 Ed25519；浏览器不支持（较老版本）时自动退回 ES256。
 * 公钥用 SPKI 导出、私钥用 PKCS8 导出 —— 这两种容器格式两种算法都支持，
 * 服务端可以统一按 SPKI 导入，不用关心是哪种曲线。
 */
export async function generateRecoveryKeyPair(): Promise<{
    alg: RecoveryAlg;
    publicKey: string;
    privateKey: string;
}> {
    try {
        const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        return {
            alg: "EdDSA",
            publicKey: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey))),
            privateKey: b64urlEncode(
                new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))
            ),
        };
    } catch {
        // 浏览器不支持 Ed25519（Chrome 137 以下、部分 Safari/Firefox 版本）→ 退回 ES256
    }

    const kp = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
    )) as CryptoKeyPair;
    return {
        alg: "ES256",
        publicKey: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey))),
        privateKey: b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey))),
    };
}

async function importPrivateKey(alg: RecoveryAlg, privateKeyB64: string): Promise<CryptoKey> {
    const raw = b64urlDecode(privateKeyB64);
    if (alg === "EdDSA") {
        return crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
    }
    return crypto.subtle.importKey(
        "pkcs8",
        raw,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"]
    );
}

function randomId(): string {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export interface SignRecoveryOptions {
    /** 私钥文件内容里的 alg */
    alg: RecoveryAlg;
    /** 私钥 PKCS8，base64url */
    privateKey: string;
    /** 新管理员账号；留空表示不改动账号，只重置密码 */
    username?: string;
    /** 新密码明文 —— 在本地算成 PBKDF2 哈希后才放进令牌，明文不出浏览器 */
    password: string;
    /** 令牌有效期（小时），默认 1 小时 */
    expHours?: number;
}

/**
 * 本地签发恢复令牌（JWS compact）。payload 里带的是密码哈希而不是明文：
 * 服务端自始至终看不到新密码，只负责把哈希写进库。
 */
export async function signRecoveryToken(options: SignRecoveryOptions): Promise<string> {
    const { alg, privateKey, username = "", password, expHours = 1 } = options;
    const passwordHash = await hashPassword(password);
    const header = { alg, typ: "JWS" };
    const payload = {
        username,
        passwordHash,
        exp: Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expHours * 60 * 60)),
        jti: randomId(),
    };

    const headerB64 = b64urlEncode(enc.encode(JSON.stringify(header)));
    const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
    const signingInput = enc.encode(`${headerB64}.${payloadB64}`);

    const key = await importPrivateKey(alg, privateKey);
    const params = (
        alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" }
    ) as unknown as Algorithm;
    const sig = await crypto.subtle.sign(params, key, signingInput);

    return `${headerB64}.${payloadB64}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * 解析私钥文件。两种格式都认：
 * 1. 新版 JSON（{v:1, alg, publicKey, privateKey}）—— 网页端和脚本当前都写这个；
 * 2. 旧版纯文本：一行 base64url 的 PKCS8 私钥（早期脚本导出的 Ed25519 私钥）。
 */
export function parseRecoveryKeyFile(text: string): RecoveryKeyFile {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
        const data = JSON.parse(trimmed) as Partial<RecoveryKeyFile>;
        const alg = data.alg;
        if ((alg !== "EdDSA" && alg !== "ES256") || !data.privateKey) {
            throw new Error("私钥文件格式不正确：缺少 alg 或 privateKey");
        }
        return {
            v: 1,
            alg,
            publicKey: data.publicKey || "",
            privateKey: data.privateKey,
            createdAt: data.createdAt || "",
        };
    }
    // 旧版：裸 PKCS8（只可能是 Ed25519）
    if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
        return { v: 1, alg: "EdDSA", publicKey: "", privateKey: trimmed, createdAt: "" };
    }
    throw new Error("无法识别的私钥文件");
}

/** 触发浏览器下载：私钥只落到用户自己的磁盘上 */
export function downloadRecoveryKeyFile(alg: RecoveryAlg, publicKey: string, privateKey: string): string {
    const file: RecoveryKeyFile = {
        v: 1,
        alg,
        publicKey,
        privateKey,
        createdAt: new Date().toISOString(),
    };
    const content = JSON.stringify(file, null, 2);
    const stamp = file.createdAt.slice(0, 10);
    const filename = `navihive-recovery-key-${stamp}.json`;

    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻吊销会让部分浏览器下载失败，留一点余量
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return filename;
}
