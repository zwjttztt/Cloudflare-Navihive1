#!/usr/bin/env node
// scripts/recovery-token.mjs
// 管理员密码「密钥恢复」的离线工具：私钥永远不进服务器，只有你能用它签发重置令牌。
//
// 用法：
//   1) 生成密钥对（只需一次）
//      node scripts/recovery-token.mjs generate
//      → 打印公钥（用于 `wrangler secret put AUTH_RECOVERY_PUBLIC_KEY`；
//        更推荐在「网站设置 → 账户安全」里点「生成并下载私钥」，公钥会自动入库）
//      → 把密钥文件写到 ./recovery-private.key（请离线保管，等同万能钥匙）
//
//   2) 忘记密码时，用私钥本地签发一个重置令牌
//      node scripts/recovery-token.mjs sign \
//          [--username admin] --password '新密码至少12位' \
//          [--key ./recovery-private.key] [--exp-hours 24] [--jti <可选随机串>]
//      → 打印 JWS 令牌，粘到登录页「用恢复密钥找回账号 → 粘贴恢复令牌」即可重置
//
// 算法：Ed25519 签名（JWS compact）。密码哈希用与后端完全相同的 PBKDF2-SHA256 /
// 10 万迭代 / 16 字节盐，所以令牌里的 passwordHash 后端能直接校验。
//
// 密钥文件格式（与网页端下载的私钥文件完全一致）：
//   {"v":1,"alg":"EdDSA","publicKey":"<SPKI base64url>","privateKey":"<PKCS8 base64url>","createdAt":"..."}
// 旧版「只有一行 base64url PKCS8 私钥」的文件仍然能读。

import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRIVATE_KEY_FILE = join(__dirname, "recovery-private.key");
const PBKDF2_ITERS = 100_000;
const PWD_PREFIX = "pbkdf2$";

const enc = new TextEncoder();

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

/** 读私钥文件：新版 JSON 与旧版裸 PKCS8 都认 */
function readKeyFile(keyFile) {
    const text = readFileSync(keyFile, "utf8").trim();
    if (text.startsWith("{")) {
        const data = JSON.parse(text);
        if (!data.alg || !data.privateKey) {
            throw new Error("私钥文件缺少 alg 或 privateKey 字段");
        }
        return { alg: data.alg, privateKey: data.privateKey, publicKey: data.publicKey || "" };
    }
    if (/^[A-Za-z0-9_-]+$/.test(text)) {
        return { alg: "EdDSA", privateKey: text, publicKey: "" };
    }
    throw new Error("无法识别的私钥文件格式");
}

async function generate() {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    // 公钥走 SPKI、私钥走 PKCS8：两种容器格式 Ed25519 与 ECDSA 都支持，
    // 网页端生成的是同一套格式，服务端可以统一导入。
    const pubSpki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));

    if (existsSync(PRIVATE_KEY_FILE)) {
        console.error(`\n[!] 私钥文件已存在：${PRIVATE_KEY_FILE}`);
        console.error("    如需重新生成，请先手动删除该文件（会令旧令牌全部失效）。");
        process.exit(1);
    }

    const keyFile = {
        v: 1,
        alg: "EdDSA",
        publicKey: b64url(pubSpki),
        privateKey: b64url(privPkcs8),
        createdAt: new Date().toISOString(),
    };
    writeFileSync(PRIVATE_KEY_FILE, JSON.stringify(keyFile, null, 2), { mode: 0o600 });

    console.log("\n=== 恢复公钥（复制到 Cloudflare Secret） ===\n");
    console.log(keyFile.publicKey);
    console.log("\n=== 部署命令 ===\n");
    console.log("wrangler secret put AUTH_RECOVERY_PUBLIC_KEY");
    console.log("# 然后粘贴上面那串公钥");
    console.log("\n=== 密钥已写入（请离线保管，切勿提交到 Git） ===\n");
    console.log(PRIVATE_KEY_FILE);
    console.log("\n提示：也可以直接在「网站设置 → 账户安全」点「生成并下载私钥」，公钥会自动存进数据库，不用配 secret。");
    console.log("\n生成重置令牌：");
    console.log(`node scripts/recovery-token.mjs sign --username <账号> --password '<新密码>'`);
}

async function sign(args) {
    const keyFile = args.key || PRIVATE_KEY_FILE;
    if (!existsSync(keyFile)) {
        console.error(`[!] 找不到私钥文件：${keyFile}`);
        console.error("    请先运行 `node scripts/recovery-token.mjs generate`，或用网页端下载私钥后加 --key 指定");
        process.exit(1);
    }
    const username = args.username || "";
    const password = args.password;
    if (!password) {
        console.error("[!] 必须提供 --password（--username 可省略，省略则只重置密码不改账号）");
        process.exit(1);
    }

    const { alg, privateKey } = readKeyFile(keyFile);
    const privKey = await crypto.subtle.importKey(
        "pkcs8",
        b64urlToBytes(privateKey),
        alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" },
        false,
        ["sign"]
    );

    const passwordHash = await hashPassword(password);
    const expHours = Number(args["exp-hours"] || "24");
    const jti = args.jti || b64url(crypto.getRandomValues(new Uint8Array(12)));
    const exp = Math.floor(Date.now() / 1000) + expHours * 3600;

    const header = b64url(enc.encode(JSON.stringify({ alg, typ: "JWS" })));
    const payload = b64url(
        enc.encode(JSON.stringify({ username, passwordHash, exp, jti }))
    );
    const signingInput = enc.encode(`${header}.${payload}`);
    const signParams =
        alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" };
    const sig = new Uint8Array(await crypto.subtle.sign(signParams, privKey, signingInput));

    const token = `${header}.${payload}.${b64url(sig)}`;

    if (args.out) {
        writeFileSync(args.out, token);
        console.log(`\n令牌已写入 ${args.out}（有效期 ${expHours} 小时）`);
    } else {
        console.log("\n=== 恢复令牌（粘贴到登录页「用恢复密钥找回账号 → 粘贴恢复令牌」） ===\n");
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
  node scripts/recovery-token.mjs generate              生成密钥对（私钥落 ./recovery-private.key）
  node scripts/recovery-token.mjs sign                 用私钥签发重置令牌
        --password '<新密码>' [--username <账号>]
        [--key <私钥文件，也认网页端下载的 json>] [--exp-hours 24] [--jti <串>] [--out <文件>]
`);
    process.exit(cmd ? 1 : 0);
}
