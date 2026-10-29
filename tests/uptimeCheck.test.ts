// tests/uptimeCheck.test.ts
// 外部拨测脚本（script/uptime-check.mjs）的三条硬要求：
//   1) 站挂了 → 退出码 1（cron / 监控面板只认退出码，日志没人看）；
//   2) 站活着 → 退出码 0，并且**不许**因为旁证缺失（没装 docker / 抓不到日志）就报红；
//   3) 配了 ALERT_WEBHOOK 就把失败 POST 出去，没配就只打 stdout。
//
// 为什么对一个「运维脚本」也写单测：这个脚本自己误报一次，运维就会永久忽略它的告警，
// 之后真的挂了也没人看 —— 也就是说它的**可信度**就是它的功能。
// 全部用子进程真跑（不 import 它的内部函数），因为退出码是它的对外契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, rmSync, copyFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测被复制到 script/tmp-tests/ 下跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        if (existsSync(join(dir, "package.json"))) return dir;
        dir = dirname(dir);
    }
    throw new Error("找不到项目根目录");
}

const ROOT = findProjectDir();
const SCRIPT = join(ROOT, "script", "uptime-check.mjs");

interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * 真起一个子进程跑脚本，拿退出码与两路输出。
 *
 * `scriptPath` 可指定：用来验「脚本被别人改名 / 软链之后，行为必须一模一样」。
 * 这一组用例守的是入口守卫（`invokedDirectly`）—— 它一旦按文件名做匹配，
 * 改名就等于让整个脚本静默变成 `exit 0` 的空操作，而正常命名下永远测不出来。
 */
function runScriptAt(
    scriptPath: string,
    args: string[],
    env: Record<string, string> = {}
): Promise<RunResult> {
    return new Promise(resolvePromise => {
        execFile(
            process.execPath,
            [scriptPath, ...args],
            {
                cwd: ROOT,
                timeout: 30_000,
                env: { ...process.env, ALERT_WEBHOOK: "", ...env },
            },
            (error, stdout, stderr) => {
                const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
                resolvePromise({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
            }
        );
    });
}

/** 用仓库里那份脚本真跑一次（绝大多数用例走这条） */
function runScript(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
    return runScriptAt(SCRIPT, args, env);
}

/** 起一个「健康站点」：首页 200 带挂载点，/api/init 200。端口由系统分配 */
function startHealthySite(): Promise<{ server: Server; base: string }> {
    return new Promise(resolvePromise => {
        const server = createServer((req, res) => {
            if (req.url === "/api/init") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end('{"success":true}');
                return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end('<!doctype html><html><body><div id="root"></div></body></html>');
        });
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            resolvePromise({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

/** 起一个「空壳站点」：200 但没有 id="root"（反代指错目录时就是这样） */
function startHollowSite(): Promise<{ server: Server; base: string }> {
    return new Promise(resolvePromise => {
        const server = createServer((req, res) => {
            if (req.url === "/api/init") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end('{"success":true}');
                return;
            }
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<html><body><h1>Welcome to nginx!</h1></body></html>");
        });
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            resolvePromise({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

const stop = (server: Server) => new Promise<void>(r => server.close(() => r()));

test("站点连不上：退出码 1，且不抛未捕获异常", async () => {
    // 127.0.0.1:1 必然拒连（Node 的 fetch 直接判 bad port）
    const result = await runScript(["--base", "http://127.0.0.1:1"]);
    assert.equal(result.code, 1, "站挂了就必须退出 1 —— 退出码是 cron 唯一能看的信号");
    assert.match(result.stderr, /拨测失败/);
    assert.match(result.stderr, /\/api\/init/, "两条探测各自要给出结论");
    assert.doesNotMatch(result.stderr, /拨测脚本自身异常/, "失败路径不许出现脚本自身的堆栈");
});

test("站点健康：退出码 0，并报出两条探测的耗时", async () => {
    const { server, base } = await startHealthySite();
    try {
        const result = await runScript(["--base", base]);
        assert.equal(result.code, 0, `健康的站点不该报红：${result.stderr}`);
        assert.match(result.stdout, /拨测通过/);
        assert.match(result.stdout, /GET \/ 200/);
        assert.match(result.stdout, /GET \/api\/init 200/);
    } finally {
        await stop(server);
    }
});

test("返回 200 但页面是空壳（没有 id=\"root\"）：算失败", async () => {
    const { server, base } = await startHollowSite();
    try {
        const result = await runScript(["--base", base]);
        assert.equal(result.code, 1, "反代指错目录时 nginx 默认页也是 200，必须判失败");
        assert.match(result.stderr, /id="root"/);
    } finally {
        await stop(server);
    }
});

test("抓不到容器日志：跳过并说明，绝不因此判失败", async () => {
    const { server, base } = await startHealthySite();
    try {
        // 容器名故意不存在 / 本机没 docker，两种都走「抓不到」这条路
        const result = await runScript(["--base", base, "--container", "definitely-not-a-container"]);
        assert.equal(result.code, 0, `旁证缺失不该把健康的站点判成故障：${result.stderr}`);
        assert.match(result.stdout, /跳过|没有可解析/, "要说清为什么没统计 5xx");
    } finally {
        await stop(server);
    }
});

test("配了 ALERT_WEBHOOK：失败时把 {text, base, failures, at} POST 出去", async () => {
    const received: Array<Record<string, unknown>> = [];
    const hook = createServer((req, res) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
        });
        req.on("end", () => {
            try {
                received.push(JSON.parse(body) as Record<string, unknown>);
            } catch {
                received.push({ raw: body });
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"ok":true}');
        });
    });
    await new Promise<void>(r => hook.listen(0, "127.0.0.1", () => r()));
    const addr = hook.address();
    const hookPort = typeof addr === "object" && addr ? addr.port : 0;

    try {
        const result = await runScript(["--base", "http://127.0.0.1:1"], {
            ALERT_WEBHOOK: `http://127.0.0.1:${hookPort}/hook`,
        });
        assert.equal(result.code, 1);
        assert.equal(received.length, 1, "失败时必须真的发一次告警");
        const payload = received[0];
        assert.equal(typeof payload.text, "string", "通用形态只要 {text} 就能被 Slack / 飞书识别");
        assert.match(String(payload.text), /拨测失败/);
        assert.equal(payload.base, "http://127.0.0.1:1");
        assert.ok(Array.isArray(payload.failures) && payload.failures.length >= 1, "要带上失败明细");
        assert.equal(typeof payload.at, "string");
    } finally {
        await stop(hook);
    }
});

test("没配 ALERT_WEBHOOK：失败只打 stdout/stderr，不试图外发", async () => {
    const result = await runScript(["--base", "http://127.0.0.1:1"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /拨测失败/);
    assert.doesNotMatch(result.stderr, /告警发送失败/, "没配 webhook 就不该尝试发送");
});

test("参数不对：退出码 2（用法错误与站点故障要能分开看）", async () => {
    const missing = await runScript([]);
    assert.equal(missing.code, 2, "缺 --base 是用法错误");
    assert.match(missing.stderr, /用法/);

    const help = await runScript(["--help"]);
    assert.equal(help.code, 0, "--help 不是错误");
    assert.match(help.stdout, /ALERT_WEBHOOK/, "说明里要讲清告警怎么配");
});

// ---------------------------------------------------------------------------
// 入口守卫：**脚本改名 / 走软链之后，行为必须一模一样**
// ---------------------------------------------------------------------------
//
// 现场事故（2026-10-29，VPS 容器内实测）：守卫原来是
//   `/uptime-check\.mjs$/.test(process.argv[1])`
// 按**文件名**匹配。于是把同一份字节存成 `/tmp/uc.mjs` 或装成
// `/usr/local/bin/healthcheck`，`main()` 就永不执行 —— 零输出、退出码 0：
//
//   $ node /tmp/uc.mjs --base https://home.zwjttzt.com   →  [exit=0]（什么都没有）
//   $ node /tmp/uptime-check.mjs --base https://…        →  拨测通过 …（正常）
//
// 对监控脚本来说这是最坏的失败形态：cron 每 5 分钟跑、永远 exit 0、永远没声音，
// 运维以为站点一直健康，直到用户来投诉。而且**正常命名下永远不会暴露** ——
// 所以必须靠下面这两条用例守，不能靠人工跑。
test("脚本被改名后照样要跑：退出码 1（不是 0），且必须有输出", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navihive-uptime-renamed-"));
    const renamed = join(dir, "uptime-check-renamed.mjs");
    try {
        copyFileSync(SCRIPT, renamed);
        const result = await runScriptAt(renamed, ["--base", "http://127.0.0.1:1"]);

        // (a) 退出码：站挂了就是 1。若是 0，说明 main() 压根没跑 —— 这正是那个 bug
        assert.equal(
            result.code,
            1,
            "改名后仍必须真的执行并判失败。退出码 0 意味着入口守卫按文件名匹配了，" +
                `整个脚本变成静默空操作：stdout=${JSON.stringify(result.stdout)}`
        );
        // (b) 必须有输出：静默 exit 0 是这次事故的核心症状
        assert.ok(
            (result.stdout + result.stderr).trim().length > 0,
            "改名后不许零输出 —— cron 里零输出 + exit 0 等于「一切正常」，会盖住真故障"
        );
        assert.match(result.stderr, /拨测失败/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("改名后用法校验照样生效：缺 --base 仍然退出 2 并打用法", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navihive-uptime-renamed-usage-"));
    const renamed = join(dir, "healthcheck.mjs");
    try {
        // 换个名字（模拟装成 /usr/local/bin/healthcheck、或手滑存成 navihive-uptime.mjs）。
        // 后缀仍然保留 .mjs：无后缀文件能否按 ESM 解析取决于 Node 版本（≥22.7 默认开启
        // 模块类型探测，更早的版本会当 CJS 解析 import 直接报 SyntaxError），
        // 那条差异与本用例要守的东西无关 —— 这里只需要「名字变了」这一个变量。
        copyFileSync(SCRIPT, renamed);
        const result = await runScriptAt(renamed, []);

        assert.equal(result.code, 2, "用法错误是 2，与「站点故障 = 1」必须能分开");
        assert.match(result.stderr, /用法/, "要打 USAGE，不能静默退出");
        assert.match(result.stderr, /--base/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("通过软链调用也要跑（argv[1] 是软链，realpath 之后才算得出同一个文件）", async t => {
    const dir = mkdtempSync(join(tmpdir(), "navihive-uptime-symlink-"));
    const link = join(dir, "healthcheck-link.mjs");
    try {
        try {
            symlinkSync(SCRIPT, link, "file");
        } catch (error) {
            // Windows 非管理员 / 未开开发者模式时建不了软链。跳过不算失败 ——
            // 这条只是加固，上面两条「改名」用例才是主守卫。
            t.skip(`本机不允许建软链，跳过：${(error as Error).message}`);
            return;
        }
        const result = await runScriptAt(link, ["--base", "http://127.0.0.1:1"]);
        assert.equal(result.code, 1, "通过软链调用与直接调用必须是同一份行为");
        assert.match(result.stderr, /拨测失败/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("脚本只依赖 Node 内置模块（要能在什么都没装的小机器上跑）", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const imports = [...text.matchAll(/^import\s+[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
    assert.ok(imports.length > 0, "应该有 import");
    for (const mod of imports) {
        assert.match(mod, /^node:/, `只允许 node: 内置模块，发现了 ${mod}`);
    }
});

// ---------------------------------------------------------------------------
// 访问日志解析：**用线上真实的那一行**验
// ---------------------------------------------------------------------------
//
// 为什么这几条单独写：`--container` 那一段的价值全在「解析得准」。解析不出来时
// 脚本会安静地「跳过统计、不判失败」—— 那是按设计走的，所以**它坏了不会红**，
// 只会永远没有 5xx 指标，而且没人会发现。
//
// 日志格式是 `server/entry.ts` 里 `res.on("finish")` 打的那一行（自托管形态）：
//   {"t":"…","rid":"5956a934","m":"GET","p":"/api/init","s":200,"ms":11,"ip":"127.0.0.1","ua":"node"}
// 也就是说状态码字段是 `s`，且它前面紧跟 `{` 或 `,`（不用正则匹配边界，
// 脚本是先找到行里第一个 `{` 再整行 JSON.parse —— JSON 里的引号/逗号都不用猜）。

/** 解析器是脚本里的纯函数 `countStatuses`。用子进程桥一下：不 import .mjs，避免动 tsconfig */
function countStatuses(raw: string): Promise<{ total: number; fiveXx: number; unparsed: number; ratio: number }> {
    const file = join(tmpdir(), `navihive-uptime-logs-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
    writeFileSync(file, raw, "utf8");
    const code = [
        `import { countStatuses } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};`,
        `import { readFileSync } from "node:fs";`,
        `process.stdout.write(JSON.stringify(countStatuses(readFileSync(process.argv[1], "utf8"))));`,
    ].join(" ");
    return new Promise((resolvePromise, rejectPromise) => {
        execFile(
            process.execPath,
            ["--input-type=module", "-e", code, file],
            { cwd: ROOT, timeout: 20_000 },
            (error, stdout, stderr) => {
                try {
                    rmSync(file, { force: true });
                } catch {
                    /* 临时文件删不掉不影响结论 */
                }
                if (error) {
                    rejectPromise(new Error(`解析器没跑起来：${String(stderr || error.message)}`));
                    return;
                }
                resolvePromise(JSON.parse(String(stdout)) as { total: number; fiveXx: number; unparsed: number; ratio: number });
            }
        );
    });
}

/** 线上真实样本（2026-10-29 从容器里抓的，字段顺序与 server/entry.ts 一致） */
const REAL_200 =
    '{"t":"2026-10-29T13:06:47.575Z","rid":"5956a934","m":"GET","p":"/api/init","s":200,"ms":11,"ip":"127.0.0.1","ua":"node"}';

test("真实访问日志行（\"s\":200）能被解析，且不算 5xx", async () => {
    const stats = await countStatuses(REAL_200);
    assert.equal(stats.total, 1, `这一行必须被认成一条访问日志，实际 ${JSON.stringify(stats)}`);
    assert.equal(stats.fiveXx, 0);
    assert.equal(stats.unparsed, 0);
});

test("5xx 行被算进去（\"s\":503），比例按可解析的访问日志算", async () => {
    const five = REAL_200.replace('"s":200', '"s":503');
    const stats = await countStatuses([REAL_200, REAL_200, five, five].join("\n"));
    assert.equal(stats.total, 4);
    assert.equal(stats.fiveXx, 2);
    assert.equal(stats.ratio, 0.5);
});

test("docker logs 带时间戳前缀时也能解析（-t / json-file 驱动的常见形态）", async () => {
    const prefixed = `2026-10-29T13:06:47.575000000Z ${REAL_200}`;
    const stats = await countStatuses(prefixed);
    assert.equal(stats.total, 1, "时间戳前缀不能被当成「认不出的行」丢掉");
    assert.equal(stats.fiveXx, 0);
});

test("静态资源的纯文本慢请求行 / 非访问日志的 JSON 行：只计「无法解析」，不进分母", async () => {
    const stats = await countStatuses(
        [
            REAL_200,
            // server/entry.ts 对静态资源只打这一行纯文本（没有 JSON，也没有 rid）
            "慢请求 GET /assets/index-abc.js 200 1234ms",
            // 应用自己的 JSON 日志（没有状态码字段）：绝不能进分母，否则 5xx 占比被稀释
            '{"level":"error","msg":"db busy","at":"2026-10-29T13:00:00.000Z"}',
            fiveXxLine(),
            "",
        ].join("\n")
    );
    assert.equal(stats.total, 2, `只有两条真访问日志（含 5xx 那条），实际 ${JSON.stringify(stats)}`);
    assert.equal(stats.fiveXx, 1);
    assert.ok(stats.unparsed >= 2, "纯文本行与无状态码的 JSON 都要计入 unparsed，好让输出能解释清楚");
});

test("状态码是字符串 / 别的键名也认（各家日志中间件写法不统一）", async () => {
    const stats = await countStatuses(
        [
            '{"status":"500"}',
            '{"statusCode":204}',
            '{"status_code":429}',
            '{"t":"2026-10-29T13:00:00.000Z","s":301}',
        ].join("\n")
    );
    assert.equal(stats.total, 4);
    assert.equal(stats.fiveXx, 1, "500 算 5xx；204/429/301 都不算");
});

function fiveXxLine(): string {
    return REAL_200.replace('"s":200', '"s":500').replace("/api/init", "/api/sites");
}
