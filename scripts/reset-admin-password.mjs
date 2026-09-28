#!/usr/bin/env node
// scripts/reset-admin-password.mjs
//
// 忘记管理员密码后的自助重置脚本（无需登录、无需记忆额外密钥）。
//
// 设计取舍：找回密码一律要求你能操作 Cloudflare / D1——也就是本来就能动部署的人，
// 不提供任何对公网开放的「填码找回」入口，避免多出一个任何人都能撞的攻击面。
//
// 用法：
//   node scripts/reset-admin-password.mjs --password '新密码'
//   node scripts/reset-admin-password.mjs --username admin --password '新密码'
//   node scripts/reset-admin-password.mjs                 # 交互式输入密码
//   node scripts/reset-admin-password.mjs --db 库名 --local   # 指定库 / 本地库
//
// 密码也可走环境变量 NEW_ADMIN_PASSWORD，避免写进 shell 历史。
// 依赖 wrangler 命令行（全局装了、或能 npx wrangler 即可），走你本机已有的 Cloudflare 登录态。

import { webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import process from "node:process";

const crypto = webcrypto;

// —— 必须与 src/API/crypto.ts 的 hashPassword 完全一致，否则新密码登录时验签不过 ——
const PBKDF2_ITERS = 100_000;
const PWD_PREFIX = "pbkdf2$";

function b64urlEncode(bytes) {
    // Buffer.from(uint8) 按二进制逐字节解释，等价于浏览器 btoa 的 charCode 字符串
    return Buffer.from(bytes)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

async function pbkdf2(password, salt, iterations, length) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
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
    return `${PWD_PREFIX}${PBKDF2_ITERS}$${b64urlEncode(salt)}$${b64urlEncode(derived)}`;
}

// 用户名白名单：只允许常见账号字符，杜绝 SQL 注入（哈希值本身只含 base64url 字符）
const USERNAME_RE = /^[A-Za-z0-9_@.\-]+$/;

function parseArgs(argv) {
    const args = { db: "navigation-db", local: false, username: "", password: "" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--db") args.db = argv[++i] || args.db;
        else if (a === "--username") args.username = argv[++i] || "";
        else if (a === "--password") args.password = argv[++i] || "";
        else if (a === "--local") args.local = true;
        else if (a === "-h" || a === "--help") {
            console.log("用法: node scripts/reset-admin-password.mjs [--db 库名] [--username 账号] [--password 密码] [--local]");
            process.exit(0);
        }
    }
    return args;
}

async function readPasswordInteractive() {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const p1 = await rl.question("请输入新的管理员密码: ");
        const p2 = await rl.question("请再次输入以确认: ");
        if (p1 !== p2) {
            console.error("两次输入不一致，已退出。");
            process.exit(1);
        }
        return p1;
    } finally {
        rl.close();
    }
}

function validatePassword(p) {
    if (p.length < 12) return "密码至少 12 位";
    if (/^(.)\1+$/.test(p)) return "密码不能由同一字符重复组成";
    return null;
}

function runWrangler(db, local, sql) {
    const base = ["d1", "execute", db, "--command", sql];
    if (local) base.splice(2, 0, "--local");
    // 先试直接 wrangler，失败再退回到 npx wrangler
    for (const useNpx of [false, true]) {
        const cmd = useNpx ? ["npx", "--yes", "wrangler", ...base] : ["wrangler", ...base];
        try {
            execFileSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
            return;
        } catch (e) {
            if (!useNpx) continue; // 直接调用失败，下一轮用 npx 重试
            console.error(`\n执行 wrangler 失败：${e.message || e}`);
            console.error("请确认已安装并登录 wrangler（wrangler login），且数据库名正确。");
            process.exit(1);
        }
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    let password = args.password || process.env.NEW_ADMIN_PASSWORD || "";
    if (!password) password = await readPasswordInteractive();

    const weak = validatePassword(password);
    if (weak) {
        console.error(`密码强度不足：${weak}`);
        process.exit(1);
    }

    const username = args.username.trim();
    if (username && !USERNAME_RE.test(username)) {
        console.error("用户名只能包含字母、数字及 _ @ . - 字符。");
        process.exit(1);
    }

    const hashed = await hashPassword(password);

    console.error(`正在更新数据库「${args.db}」…`);
    runWrangler(args.db, args.local,
        `UPDATE configs SET value='${hashed}' WHERE key='auth.password'`);
    if (username) {
        runWrangler(args.db, args.local,
            `UPDATE configs SET value='${username}' WHERE key='auth.username'`);
    }
    // 令牌版本 +1，让所有已签发的会话立即失效（服务端可吊销，登录后旧令牌作废）
    runWrangler(args.db, args.local,
        `INSERT INTO configs (key, value) VALUES ('auth.tokenVersion','1') ` +
        `ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`);

    console.error("✅ 管理员密码已重置。请刷新登录页用新密码登录（所有旧登录态已失效）。");
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
