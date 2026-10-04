// script/e2eEnv.mjs
// 两个端到端脚本（api-e2e / webdav-e2e）共用的那部分：找产物配置、挑端口、起 wrangler。
//
// 抽出来的理由是**不能各写一份**：api-e2e.mjs 里曾经写死 dist/myhomepage，
// CI 干净检出时直接找不到文件、本地又因为旧目录侥幸能跑（跑的还是几天前的旧包）。
// 这种「定位逻辑」一旦有两份，修好一份另一份照样踩。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const isWin = process.platform === "win32";

/**
 * 构建出来的 worker 产物配置在哪。
 *
 * 目录名**不能写死**：@cloudflare/vite-plugin 把 worker 产物放在 dist/<worker 名>/
 * 下，而 worker 名就是 wrangler.jsonc 里的 "name"。项目改名之后
 * （myhomepage → cloudflare-navihive1）目录名跟着变了，于是：
 *   - CI 上是干净检出，dist 里只有新目录 → 写死旧名字的那份直接找不到文件；
 *   - 本地反而「能跑」，因为旧目录还留着 —— 但它跑的是改名前的旧包，
 *     全绿其实什么都没验到。
 *
 * 所以在 dist 下找 wrangler.json，而不是猜目录名。找到多份说明历次构建的
 * 旧目录没被覆盖（目录名不同就不会被清理），取最新的那份并把忽略掉的列出来。
 */
export function resolveWorkerConfig() {
    const dist = path.join(ROOT, "dist");
    if (!fs.existsSync(dist)) {
        return { error: `找不到 ${dist}，先跑 npm run build` };
    }
    const candidates = fs
        .readdirSync(dist, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== "client")
        .map(d => path.join(dist, d.name, "wrangler.json"))
        .filter(p => fs.existsSync(p))
        .map(p => ({ path: p, mtime: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    if (!candidates.length) {
        return { error: `${dist} 下没有找到任何 <目录>/wrangler.json，先跑 npm run build` };
    }
    return { config: candidates[0].path, stale: candidates.slice(1) };
}

/** 产物是不是比源码还旧（本地改完忘 build 时会全绿地跑上一版代码） */
export function warnIfStale(config) {
    const newestUnder = dir => {
        let newest = 0;
        const walk = d => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else newest = Math.max(newest, fs.statSync(p).mtimeMs);
            }
        };
        walk(dir);
        return newest;
    };
    const srcNewest = newestUnder(path.join(ROOT, "worker"));
    return srcNewest > fs.statSync(config).mtimeMs;
}

/** 挑一个空闲端口：上一次没退干净的 wrangler 会让「登录失败」变成误报 */
export async function pickPort(envName = "E2E_PORT") {
    const fixed = process.env[envName] ? Number(process.env[envName]) : 0;
    const busy = async port => {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/init`);
            return res.ok || res.status === 404;
        } catch {
            return false;
        }
    };
    for (let i = 0; i < 10; i++) {
        const candidate = fixed || 8800 + Math.floor(Math.random() * 400);
        if (!(await busy(candidate))) return candidate;
        if (fixed) {
            console.error(
                `端口 ${fixed} 上已经有服务在跑了（多半是上一次没退干净的 wrangler）。\n` +
                    `先结束它，或者不设 ${envName} 让脚本自己挑一个空闲端口。`
            );
            process.exit(1);
        }
    }
    console.error("试了 10 次都没找到空闲端口");
    process.exit(1);
}

/**
 * 起一个 wrangler dev（本地 D1）。
 *
 * 返回 { stop, logFile, ready }：调用方自己决定怎么等就绪、怎么打断言。
 * 杀进程必须杀**整棵进程树**：shell 模式下 kill 掉的是 cmd.exe，真正的 wrangler
 * 会留下来占着端口、锁着 sqlite，下一次跑就表现为「登录失败 + 数据跨次累积」。
 */
export function startWrangler({ config, port, persistDir, vars, logName }) {
    const args = ["wrangler", "dev", "-c", config, "--local", "--port", String(port), "--persist-to", persistDir];
    for (const [key, value] of Object.entries(vars)) args.push("--var", `${key}:${value}`);

    const child = spawn("npx", args, {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: isWin,
    });

    const logFile = path.join(os.tmpdir(), logName);
    fs.writeFileSync(logFile, "");
    let log = "";
    const append = text => {
        log += text;
        try {
            fs.appendFileSync(logFile, text);
        } catch {
            // 落盘失败不影响跑
        }
    };
    child.stdout?.on("data", d => append(d.toString()));
    child.stderr?.on("data", d => append(d.toString()));

    const stop = () => {
        try {
            if (isWin) {
                spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
            } else {
                child.kill("SIGTERM");
            }
        } catch {
            // 已经退了
        }
    };
    const stopAndWait = async () => {
        stop();
        await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(3000)]);
    };

    return { child, stop, stopAndWait, logFile, getLog: () => log };
}

/** 等 /api/init 有响应（worker 起来 + D1 迁移跑完） */
export async function waitReady(base, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${base}/init`);
            if (res.ok) return true;
        } catch {
            // 还没起来
        }
        await sleep(500);
    }
    return false;
}

/** 极简断言计数器：两个脚本用的输出格式一致，CI 日志才好看 */
export function createChecker() {
    const state = { checks: 0, failures: 0 };
    const check = (label, ok, detail = "") => {
        state.checks += 1;
        if (ok) {
            console.log(`  PASS ${label}${detail ? `  ${detail}` : ""}`);
        } else {
            state.failures += 1;
            console.log(`  FAIL ${label}${detail ? `  ${detail}` : ""}`);
        }
        return ok;
    };
    return { state, check };
}
