#!/usr/bin/env node
// script/uptime-check.mjs
// 外部拨测 + 5xx 告警：从**机器外面**看这个站还活不活。
//
// 为什么需要它（2026-10-29）：现在唯一的健康检查是 Dockerfile 里的容器内
// HEALTHCHECK（打 127.0.0.1 的 /api/init）。它只能回答「容器里的 Node 进程还活着吗」——
// 宿主网络挂了、DNS 错了、反代 502 了、证书过期了，它全都看不见（它跟服务在同一个
// 网络命名空间里，压根不经过那些环节）。而「网站打不开」这件事，用户是第一个知道的。
//
// 所以这个脚本要做的事只有三件，且必须是**零依赖纯 Node**（它要能在一台什么都没装的
// 小机器上、由 cron 每 5 分钟跑一次）：
//   1) 探 `/`：200 且页面里确实有 `id="root"`（防空壳 —— 反代把静态资源指错时，
//      nginx 默认页 / 404 页面也可能返回 200）；
//   2) 探 `/api/init`：200（这一条过了才说明后端与数据库都活着）；
//   3) 可选 `--container <名字>`：翻容器最近 N 分钟的访问日志，算 5xx 条数与占比。
//      抓不到（没装 docker、容器名不对、日志不是 JSON）就**跳过并说明**，绝不因此判失败
//      —— 拨测脚本自己误报一次，运维就会永久忽略它的告警。
//
// 用法：
//   node script/uptime-check.mjs --base https://home.example.com
//   node script/uptime-check.mjs --base https://home.example.com --container navihive
//   ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx \
//     node script/uptime-check.mjs --base https://home.example.com
//
// 退出码：0 = 全部通过；1 = 有失败；2 = 用法错误（参数不对，不是站点故障）。
//
// 告警：环境变量 ALERT_WEBHOOK 非空时 POST 一段 JSON（`{text, base, failures[], at}`，
// 通用形态，Slack / 飞书 / 自建 webhook 都能收）；为空就只打到 stdout（cron 会把
// stdout 发邮件，这也是一种告警）。
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
/** 5xx 判定阈值：条数与占比**任一**超了就算失败。小站一天几百请求，5 条就已经很吵了。 */
const DEFAULT_MAX_5XX = 5;
const DEFAULT_MAX_5XX_RATIO = 0.05;
const DEFAULT_LOG_MINUTES = 15;

const USAGE = `用法: node script/uptime-check.mjs --base <url> [选项]

必填:
  --base <url>          站点根地址，如 https://home.example.com

可选:
  --container <name>    顺便统计容器最近 N 分钟访问日志里的 5xx（需要本机有 docker）
  --minutes <n>         统计窗口，默认 ${DEFAULT_LOG_MINUTES} 分钟
  --timeout <ms>        单次探测超时，默认 ${DEFAULT_TIMEOUT_MS} ms
  --max-5xx <n>         5xx 条数阈值，默认 ${DEFAULT_MAX_5XX}
  --max-5xx-ratio <r>   5xx 占比阈值（0~1），默认 ${DEFAULT_MAX_5XX_RATIO}
  -h, --help            显示这段说明

环境变量:
  ALERT_WEBHOOK         非空时把失败 POST 过去（JSON: {text, base, failures[], at}）`;

/**
 * 解析命令行。只认 `--key value` / `--key=value` 两种写法，
 * 不做多余兼容 —— 这个脚本要长期在 cron 里跑，参数形状越少越不容易被改坏。
 */
function parseArgs(argv) {
    const out = {
        base: "",
        container: "",
        minutes: DEFAULT_LOG_MINUTES,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        max5xx: DEFAULT_MAX_5XX,
        max5xxRatio: DEFAULT_MAX_5XX_RATIO,
        help: false,
        errors: [],
    };
    const takeValue = (i, inline, name) => {
        if (inline !== undefined) return [inline, i];
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            out.errors.push(`${name} 缺少取值`);
            return ["", i];
        }
        return [next, i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i];
        const eq = raw.indexOf("=");
        const name = eq >= 0 ? raw.slice(0, eq) : raw;
        const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
        switch (name) {
            case "-h":
            case "--help":
                out.help = true;
                break;
            case "--base": {
                const [value, next] = takeValue(i, inline, "--base");
                out.base = value;
                i = next;
                break;
            }
            case "--container": {
                const [value, next] = takeValue(i, inline, "--container");
                out.container = value;
                i = next;
                break;
            }
            case "--minutes": {
                const [value, next] = takeValue(i, inline, "--minutes");
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) out.errors.push("--minutes 需要正数");
                else out.minutes = n;
                i = next;
                break;
            }
            case "--timeout": {
                const [value, next] = takeValue(i, inline, "--timeout");
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) out.errors.push("--timeout 需要正数（毫秒）");
                else out.timeoutMs = n;
                i = next;
                break;
            }
            case "--max-5xx": {
                const [value, next] = takeValue(i, inline, "--max-5xx");
                const n = Number(value);
                if (!Number.isFinite(n) || n < 0) out.errors.push("--max-5xx 需要非负整数");
                else out.max5xx = n;
                i = next;
                break;
            }
            case "--max-5xx-ratio": {
                const [value, next] = takeValue(i, inline, "--max-5xx-ratio");
                const n = Number(value);
                if (!Number.isFinite(n) || n < 0 || n > 1) {
                    out.errors.push("--max-5xx-ratio 需要 0~1 之间的小数");
                } else {
                    out.max5xxRatio = n;
                }
                i = next;
                break;
            }
            default:
                out.errors.push(`不认识的参数：${raw}`);
        }
    }
    if (!out.base && !out.help) out.errors.push("必须给 --base");
    if (out.base) {
        try {
            const url = new URL(out.base);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                out.errors.push("--base 只支持 http / https");
            }
            // 结尾的斜杠统一去掉：后面用 `${base}${path}` 拼，留着会变成 `//api/init`
            out.base = out.base.replace(/\/+$/, "");
        } catch {
            out.errors.push(`--base 不是合法 URL：${out.base}`);
        }
    }
    return out;
}

/**
 * 探一个地址：返回状态码、耗时、正文（只在需要时读）。
 *
 * 不抛异常：网络层失败（拒连 / 超时 / DNS）要被翻译成一条人能看懂的失败原因，
 * 而不是让脚本带着堆栈崩掉 —— cron 里的一次未捕获异常等于「什么也没说」。
 */
async function probe(base, path, timeoutMs) {
    const url = `${base}${path}`;
    const started = Date.now();
    try {
        const res = await fetch(url, {
            // 跟着重定向走：站点在自己的反代后面经常先 301 到带尾斜杠的形态
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
            headers: { "user-agent": "navihive-uptime-check/1", accept: "*/*" },
        });
        const text = await res.text();
        return {
            url,
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            ms: Date.now() - started,
            body: text,
            error: "",
        };
    } catch (error) {
        return {
            url,
            ok: false,
            status: 0,
            ms: Date.now() - started,
            body: "",
            error: describeFetchError(error, timeoutMs),
        };
    }
}

/** fetch 的失败原因在 Node 里套了两三层（TypeError: fetch failed → cause: ECONNREFUSED） */
function describeFetchError(error, timeoutMs) {
    if (!error) return "未知错误";
    const name = error.name || "";
    if (name === "TimeoutError" || name === "AbortError") return `${timeoutMs}ms 内没有响应（超时）`;
    const cause = error.cause;
    const code = cause && (cause.code || cause.errno);
    const detail = cause && cause.message ? cause.message : error.message;
    return code ? `${code}：${detail}` : String(detail || name || "未知错误");
}

/**
 * 翻容器访问日志，统计最近 N 分钟的 5xx。
 *
 * 抓不到就返回 `{ available: false, note }`，调用方**不据此判失败**。
 * 日志行按 JSON 解析，状态码认这几种键（各家反代 / 日志中间件写法不统一）：
 *   `s`（Cloudflare logpush）、`status`、`statusCode`、`status_code`。
 * 认不出的行只计入「无法解析」，不参与分母 —— 否则一行普通的启动日志就能
 * 把 5xx 占比稀释成 0，告警永远不会响。
 */
function collectContainer5xx(container, minutes) {
    return new Promise(resolve => {
        execFile(
            "docker",
            ["logs", "--since", `${minutes}m`, container],
            { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 },
            (error, stdout, stderr) => {
                // docker logs 把容器 stdout 给 stdout、stderr 给 stderr，
                // 两路都要看（不少中间件把访问日志打到 stderr）
                const raw = `${stdout || ""}${stderr || ""}`;
                if (error && !raw.trim()) {
                    resolve({
                        available: false,
                        note: `docker logs 不可用（${error.message.split("\n")[0]}），已跳过 5xx 统计`,
                    });
                    return;
                }
                const result = countStatuses(raw);
                resolve({ available: true, ...result });
            }
        );
    });
}

/** 纯解析：从日志文本里数出 5xx 与总数（抽成独立函数，方便脚本自己 selftest） */
export function countStatuses(raw) {
    let total = 0;
    let fiveXx = 0;
    let unparsed = 0;
    for (const line of String(raw || "").split("\n")) {
        const text = line.trim();
        if (!text) continue;
        let parsed = null;
        // docker logs 可能带时间戳前缀（"2026-10-29T12:00:00.000Z {...}"），先剥一层
        const jsonStart = text.indexOf("{");
        if (jsonStart < 0) {
            unparsed += 1;
            continue;
        }
        try {
            parsed = JSON.parse(text.slice(jsonStart));
        } catch {
            unparsed += 1;
            continue;
        }
        if (!parsed || typeof parsed !== "object") {
            unparsed += 1;
            continue;
        }
        const rawStatus =
            parsed.s ?? parsed.status ?? parsed.statusCode ?? parsed.status_code ?? null;
        const status = Number(rawStatus);
        if (!Number.isFinite(status) || status < 100 || status > 599) {
            unparsed += 1;
            continue;
        }
        total += 1;
        if (status >= 500) fiveXx += 1;
    }
    return { total, fiveXx, unparsed, ratio: total > 0 ? fiveXx / total : 0 };
}

/** 组装一句给人看的话：告警文本、stdout、退出码三处共用同一份事实 */
function buildReport(base, failures, notes) {
    const header = failures.length === 0 ? `[NavHive] 拨测通过 ${base}` : `[NavHive] 拨测失败 ${base}`;
    const lines = [header];
    for (const line of notes) lines.push(`- ${line}`);
    for (const f of failures) lines.push(`✗ ${f}`);
    lines.push(`时间：${new Date().toISOString()}`);
    return lines.join("\n");
}

async function sendAlert(webhook, payload, text) {
    if (!webhook) return;
    try {
        const res = await fetch(webhook, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...payload, text }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) console.error(`告警发送失败：HTTP ${res.status}`);
        else console.log("告警已发送");
    } catch (error) {
        // 告警发不出去不能让退出码变样：站点的失败已经反映在 exit 1 上了
        console.error(`告警发送失败：${describeFetchError(error, 10_000)}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(USAGE);
        return 0;
    }
    if (args.errors.length > 0) {
        console.error(args.errors.join("\n"));
        console.error(`\n${USAGE}`);
        return 2;
    }

    const failures = [];
    const notes = [];

    // ---- 1. 首页：200 且真的有挂载点 ----
    const home = await probe(args.base, "/", args.timeoutMs);
    if (home.status !== 200) {
        failures.push(
            `GET / 期望 200，实际 ${home.status || "连不上"}${home.error ? `（${home.error}）` : ""}`
        );
    } else if (!home.body.includes('id="root"')) {
        // 防「空壳 200」：反代指错目录时返回的默认页也是 200，但它没有我们的挂载点
        failures.push(`GET / 返回 200，但页面里没有 id="root"（可能是反代指错了目录，或返回了空壳页）`);
    } else {
        notes.push(`GET / 200，${home.ms}ms`);
    }

    // ---- 2. 接口：/api/init 是登录前也能打的探针 ----
    const init = await probe(args.base, "/api/init", args.timeoutMs);
    if (init.status !== 200) {
        failures.push(
            `GET /api/init 期望 200，实际 ${init.status || "连不上"}${
                init.error ? `（${init.error}）` : ""
            }`
        );
    } else {
        notes.push(`GET /api/init 200，${init.ms}ms`);
    }

    // ---- 3. 可选：容器访问日志里的 5xx ----
    if (args.container) {
        const stats = await collectContainer5xx(args.container, args.minutes);
        if (!stats.available) {
            // 抓不到就明说，不判失败：拨测脚本误报一次，运维就会永久忽略它
            notes.push(stats.note);
        } else if (stats.total === 0) {
            notes.push(
                `容器 ${args.container} 最近 ${args.minutes} 分钟没有可解析的访问日志（跳过 5xx 统计）`
            );
        } else {
            const percent = (stats.ratio * 100).toFixed(1);
            const line = `容器 ${args.container} 最近 ${args.minutes} 分钟：${stats.total} 条请求，5xx ${stats.fiveXx} 条（${percent}%）`;
            if (stats.fiveXx > args.max5xx || stats.ratio > args.max5xxRatio) {
                failures.push(
                    `${line}，超过阈值（${args.max5xx} 条 / ${(args.max5xxRatio * 100).toFixed(0)}%）`
                );
            } else {
                notes.push(line);
            }
            if (stats.unparsed > 0) {
                notes.push(`另有 ${stats.unparsed} 行日志不是可解析的访问日志，未计入分母`);
            }
        }
    }

    const payload = {
        base: args.base,
        failures,
        at: new Date().toISOString(),
    };
    const text = buildReport(args.base, failures, notes);
    // stdout / stderr 都留一份：cron 通常只把 stderr 发给运维，而通过时也该留下记录
    if (failures.length > 0) console.error(text);
    else console.log(text);

    if (failures.length > 0) {
        await sendAlert(process.env.ALERT_WEBHOOK || "", payload, text);
        return 1;
    }
    return 0;
}

// 只有直接执行时才跑 main（被当模块 import 时，只为了拿 countStatuses 自测）。
//
// ⚠️ 这段判据必须与**文件名无关**。原来写的是 `/uptime-check\.mjs$/.test(process.argv[1])`，
// 于是任何人把脚本改名（装成 /usr/local/bin/healthcheck、做软链、或者手滑存成
// navihive-uptime.mjs）都会让 main() 永不执行 —— 零输出、退出码 0。对监控脚本来说
// 这是最坏的失败形态：cron 每 5 分钟跑一次、永远 exit 0、永远没声音，运维会以为站点
// 一直健康，直到用户来投诉。而且这个坑在「名字恰好对」时永远不会暴露。
//
// 正确做法是比较**模块自己的 URL** 与 argv[1] 的真实路径：
//   1) realpathSync：argv[1] 指向的可能是软链（`ln -s ... /usr/local/bin/healthcheck`），
//      不解析就读不到同一个文件，比较必然不等 → 又变成静默退出；
//   2) pathToFileURL：把文件路径转成 `file:///...` 形状，才能与 import.meta.url 同构比较。
//      手拼 `file://${path}` 在 Windows（盘符、反斜杠、中文路径）和带空格/井号的路径上都会错。
// catch 里返回 false 是刻意的：realpath 失败（文件已被删、无权限）说明 argv[1] 不是本模块，
// 这时不该跑 main —— 但下面 tests/uptimeCheck.test.ts 有一条用例专门守着「改名后仍然要跑」，
// 别把这里改回按文件名匹配。
const invokedDirectly = (() => {
    if (!process.argv[1]) return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    } catch {
        return false;
    }
})();
if (invokedDirectly) {
    main()
        .then(code => {
            process.exitCode = code;
        })
        .catch(error => {
            // 走到这里说明脚本自己出了 bug（不是站点故障）。也要有输出，别静默退出
            console.error(`拨测脚本自身异常：${error && error.stack ? error.stack : error}`);
            process.exitCode = 1;
        });
}
