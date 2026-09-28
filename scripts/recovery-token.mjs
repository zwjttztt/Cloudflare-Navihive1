#!/usr/bin/env node
// scripts/recovery-token.mjs
// 管理员密码「密钥恢复」的离线工具：私钥永远不进服务器，只有你能用它签发重置令牌。
//
// 用法：
//   1) 生成密钥对（只需一次）
//      node scripts/recovery-token.mjs generate
//      → 打印公钥（用于 `wrangler secret put AUTH_RECOVERY_PUBLIC_KEY`）
//      → 把私钥写到 ./recovery-private.key（请离线保管，等同万能钥匙）
//
//   2) 忘记密码时，用私钥本地签发一个重置令牌
//      node scripts/recovery-token.mjs sign \
//          --username admin --password '新密码至少12位' \
//          [--key ./recovery-private.key] [--exp-hours 24] [--jti <可选随机串>]
//      → 打印 JWS 令牌，粘到登录页「用恢复密钥找回账号」即可重置
//
// 算法：Ed25519 签名（JWS compact）。密码哈希用与后端完全相同的 PBKDF2-SHA256 /
// 10 万迭代 / 16 字节盐，所以令牌里的 passwordHash 后端能直接校验。

import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRIVATE_KEY_FILE = join(__dirname, "recovery-private.key");
const PBKDF2_ITERS = 100_000;
const PWD_PREFIX = "pbkdf2$";

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    return new Uint8Array(Buffer.from(b64 + pad, "base64"));
}

async function pbkdf2(password, salt, iterations, length) {
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        key,
        length * 8
    );
    return new Uint8Array(bits);
}

async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derived = await pbkdf2(password, salt, PBKDF2_ITERS, 32);
    return `${PWD_PREFIX}${PBKDF2_ITERS}$${b64url(salt)}$${b64url(derived)}`;
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                out[key] = next;
                i++;
            } else {
                out[key] = true;
            }
        }
    }
    return out;
}

async function generate() {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    // 私钥用 pkcs8 导出（Node 的 WebCrypto 不支持 raw 私钥导出；公钥仍用 raw，服务端 raw 导入即可）
    const privRaw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));

    if (existsSync(PRIVATE_KEY_FILE)) {
        console.error(`\n[!] 私钥文件已存在：${PRIVATE_KEY_FILE}`);
        console.error("    如需重新生成，请先手动删除该文件（会令旧令牌全部失效）。");
        process.exit(1);
    }
    writeFileSync(PRIVATE_KEY_FILE, b64url(privRaw), { mode: 0o600 });

    console.log("\n=== 恢复公钥（复制到 Cloudflare Secret） ===\n");
    console.log(b64url(pubRaw));
    console.log("\n=== 部署命令 ===\n");
    console.log("wrangler secret put AUTH_RECOVERY_PUBLIC_KEY");
    console.log(`# 然后粘贴上面那串公钥`);
    console.log("\n=== 私钥已写入（请离线保管，切勿提交到 Git） ===\n");
    console.log(PRIVATE_KEY_FILE);
    console.log("\n生成重置令牌：");
    console.log(`node scripts/recovery-token.mjs sign --username <账号> --password '<新密码>'`);
}

async function sign(args) {
    const keyFile = args.key || PRIVATE_KEY_FILE;
    if (!existsSync(keyFile)) {
        console.error(`[!] 找不到私钥文件：${keyFile}`);
        console.error("    请先运行 `node scripts/recovery-token.mjs generate`");
        process.exit(1);
    }
    const username = args.username;
    const password = args.password;
    if (!username || !password) {
        console.error("[!] 必须提供 --username 和 --password");
        process.exit(1);
    }

    const privRaw = b64urlToBytes(readFileSync(keyFile, "utf8").trim());
    const privKey = await crypto.subtle.importKey("pkcs8", privRaw, { name: "Ed25519" }, false, ["sign"]);

    const passwordHash = await hashPassword(password);
    const expHours = Number(args["exp-hours"] || "24");
    const jti = args.jti || b64url(crypto.getRandomValues(new Uint8Array(12)));
    const exp = Math.floor(Date.now() / 1000) + expHours * 3600;

    const header = b64url(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWS" })));
    const payload = b64url(
        enc.encode(JSON.stringify({ username, passwordHash, exp, jti }))
    );
    const signingInput = enc.encode(`${header}.${payload}`);
    const sig = new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, privKey, signingInput)
    );

    const token = `${header}.${payload}.${b64url(sig)}`;

    if (args.out) {
        writeFileSync(args.out, token);
        console.log(`\n令牌已写入 ${args.out}（有效期 ${expHours} 小时）`);
    } else {
        console.log("\n=== 恢复令牌（粘贴到登录页「用恢复密钥找回账号」） ===\n");
        console.log(token);
        console.log(`\n（有效期 ${expHours} 小时，一次性使用）`);
    }
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (cmd === "generate") {
    await generate();
} else if (cmd === "sign") {
    await sign(args);
} else {
    console.log(`用法：
  node scripts/recovery-token.mjs generate              生成 Ed25519 密钥对
  node scripts/recovery-token.mjs sign                 用私钥签发重置令牌
        --username <账号> --password '<新密码>'
        [--key <私钥文件>] [--exp-hours 24] [--jti <串>] [--out <文件>]
`);
    process.exit(cmd ? 1 : 0);
}
