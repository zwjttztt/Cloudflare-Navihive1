// tests/upgraderLoop.test.ts
// 升级器循环（deploy/upgrader/upgrade-loop.sh）的**行为**测试 —— 真的执行那个文件。
//
// 为什么必须有这个文件（2026-11 抽取）：升级器是**唯一持有 docker.sock 的特权组件**，
// 而它的 shell 在此之前是内联在 docker-compose.yml 的 `upgrader.command` 里的：
//   · 内联字符串没法被任何测试真正执行，tests/systemUpgradeGuard.test.ts 只能数
//     「{{.State.Health.Status}} 出现几次」这种文本锚点；
//   · 于是 R05 的三个终局（done / rolled_back / rollback_failed）**零行为覆盖** ——
//     线上出过一次真事：2026-11-04 部署 30.0.0 时 compose 不随镜像更新，宿主机跑的
//     还是三天前的旧脚本，回滚终态协议根本没生效，而所有门禁全绿。
// 现在脚本是仓库文件，这里用「假 docker + PATH 前置」把它真跑一遍。
//
// 做法（不改脚本、不用 sed 改写文本 —— 测的必须是仓库里那份真文件）：
//   1. mkdtemp 出一个独立目录：bin/docker（假 docker）、spool/（请求与状态）、calls.log；
//   2. 由脚本自带的**测试注入点**（环境变量，默认值 = 线上值）把它收成「只跑一轮、
//      轮询间隔 0 秒」：NAVIHIVE_UPGRADER_ONCE / _SPOOL / _POLL_SECONDS /
//      _HEALTH_POLL_SECONDS（见脚本文件头的说明）；
//   3. 假 docker 按剧本回放 Health.Status、按剧本给 `compose up` 返回码，并把每次
//      调用记账到 calls.log（用来证明「拉取失败时根本没有发起重建」这类否定断言）；
//   4. 跑完读 state.json，只断言 phase 与 error 文案 —— **不断言时间戳具体值**
//      （脚本用 `date +%s`，每次都不一样）。
//
// 平台差异：Windows 本机常常没有 bash，或无法让假 docker 可执行 → 用例 t.skip 并打印
// 原因；Linux CI 上必须真跑（skip 只是给本机的台阶，不是掩盖手段）。
// 并行安全：每个用例各自 mkdtemp，不共用任何固定路径（单测跑在 --test-concurrency=4）。
import { test, describe } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** 仓库里的脚本相对路径（唯一事实来源） */
const SCRIPT_REL = "deploy/upgrader/upgrade-loop.sh";
/**
 * compose 里给 entrypoint 用的路径：**相对 working_dir**（`/home/docker/navihive`）。
 * 用相对路径的理由见 compose 注释：脚本自己引用 compose 文件也是相对路径
 *（`-f docker-compose.yml`），同一套 cwd 前提；而相对路径让「自定义部署目录的人」
 * 只需要改 working_dir + 绑定挂载两处，不用跟着改 entrypoint。
 */
const CONTAINER_SCRIPT_PATH = SCRIPT_REL;
/** 回滚用的那条完整命令（与 docs / 锚点测试里的写法保持一致） */
const RECREATE_CMD = "docker compose -f docker-compose.yml -p navihive up -d --force-recreate --no-deps navihive";

/**
 * 从 bundle 所在位置逐级向上找仓库根（单测会把用例打包到 script/tmp-tests/ 下再跑）。
 * 找不到 docker-compose.yml 就退回 cwd —— 那时下面的断言会明确报错，而不是静默 skip。
 */
function findRepoRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
        if (existsSync(join(dir, "docker-compose.yml"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return process.cwd();
}

const repoRoot = findRepoRoot();
const scriptPath = join(repoRoot, SCRIPT_REL);
const composeText = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
const scriptText = readFileSync(scriptPath, "utf8");

/**
 * 给 bash 的路径：Windows 上转成 POSIX 盘符形态（`C:\x\y` → `/c/x/y`）。
 *
 * ⚠️ 必须是 `/c/...` 而不是 `C:/...`（2026-11 实测，Git for Windows 的 bash）：
 * `C:/...` 这种形态可以直接当文件参数用（ls / 重定向都行），但**放进 PATH 里查不到
 * 可执行文件** —— `PATH="C:/x/bin:$PATH"; docker` 会报 command not found（rc=127），
 * 换成 `/c/x/bin` 立刻就好。假 docker 全靠 PATH 顶替真 docker，所以这里统一转。
 * UNC 路径（`\\server\share`）没法这么转，探针会失败并如实 skip。
 */
function toShellPath(p: string): string {
    if (process.platform !== "win32") return p;
    const forward = p.replace(/\\/g, "/");
    const drive = /^([A-Za-z]):(\/.*)$/.exec(forward);
    if (drive) return `/${drive[1].toLowerCase()}${drive[2]}`;
    return forward;
}

/**
 * 假 docker 的源码（逐行数组，避免模板字符串的转义噪音）。
 *
 * 协议：靠环境变量驱动剧本，把每次调用原样 append 到 $FAKE_CALL_LOG。
 *   pull      → 退出码 FAKE_PULL_RC
 *   tag       → 0（锚点打标签不参与判定）
 *   inspect   → 带 Health.Status 时输出当前健康剧本；否则输出一个假 ImageID
 *               健康剧本分两段：回滚 compose 发生**之前**用 FAKE_HEALTH_BEFORE，
 *               之后用 FAKE_HEALTH_AFTER_ROLLBACK。用「回滚是否发生过」而不是
 *               「第几次探活」来分段，这样断言的语义是「回滚之后探活结果」，不会
 *               因为脚本把 40 次上限改成 60 次就假红。
 *   compose   → 第一次（重建）返回 FAKE_COMPOSE_RECREATE_RC；第二次（回滚）
 *               先落下 rolled-back 标记（切健康剧本），再返回 FAKE_COMPOSE_ROLLBACK_RC。
 *   probe     → 预检用：确认这个假可执行文件在本机**真的能被 exec**
 */
const FAKE_DOCKER_SOURCE: readonly string[] = [
    "#!/bin/sh",
    "# 假 docker：由 tests/upgraderLoop.test.ts 生成，只回放剧本，不碰真实 daemon。",
    'echo "$*" >> "$FAKE_CALL_LOG"',
    'cmd="$1"',
    "shift",
    'case "$cmd" in',
    "  probe)",
    '    echo "fake-docker-ok"',
    "    exit 0",
    "    ;;",
    "  pull)",
    '    exit "$FAKE_PULL_RC"',
    "    ;;",
    "  tag)",
    "    exit 0",
    "    ;;",
    "  inspect)",
    '    case "$*" in',
    "      *State.Health.Status*)",
    '        if [ -f "$FAKE_DIR/rolled-back" ]; then',
    '          echo "$FAKE_HEALTH_AFTER_ROLLBACK"',
    "        else",
    '          echo "$FAKE_HEALTH_BEFORE"',
    "        fi",
    "        ;;",
    "      *)",
    '        echo "sha256:0000previous"',
    "        ;;",
    "    esac",
    "    exit 0",
    "    ;;",
    "  compose)",
    '    n=$(cat "$FAKE_DIR/compose-count" 2>/dev/null || echo 0)',
    "    n=$((n + 1))",
    '    echo "$n" > "$FAKE_DIR/compose-count"',
    '    if [ "$n" -ge 2 ]; then',
    '      : > "$FAKE_DIR/rolled-back"',
    '      exit "$FAKE_COMPOSE_ROLLBACK_RC"',
    "    fi",
    '    exit "$FAKE_COMPOSE_RECREATE_RC"',
    "    ;;",
    "  *)",
    "    exit 0",
    "    ;;",
    "esac",
];

/** 一次推演的剧本 */
interface LoopOptions {
    /** `docker pull` 的返回码：0 成功，非 0 走「拉取失败」终局 */
    pullRc: number;
    /** 回滚发生**之前**探活拿到的 Health.Status（healthy = 首轮就过门禁） */
    healthBefore: string;
    /** 回滚发生**之后**探活拿到的 Health.Status（只有 healthy 才算回滚成功） */
    healthAfterRollback: string;
    /** 重建那次 `compose up` 的返回码，默认 0 */
    recreateRc?: number;
    /** 回滚那次 `compose up` 的返回码，默认 0 */
    rollbackRc?: number;
    /** 用哪个 shell 跑脚本（默认 bash；生产入口是 /bin/sh） */
    runnerShell?: string;
}

/** 一次推演的结果（state.json 解析后的内容 + 调用流水） */
interface LoopResult {
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    state: UpgradeState | null;
    stateRaw: string;
    calls: readonly string[];
    dir: string;
}

interface UpgradeState {
    phase: string;
    image: string;
    error: string;
    startedAt: number;
    finishedAt: number;
}

/** 探针结论：本机能不能真跑（不能就 skip，不许假绿） */
interface Probe {
    ok: boolean;
    reason: string;
    bash: string;
}

let cachedProbe: Probe | null = null;

/** 最小的环境变量集合：显式构造，避免 Windows 上 PATH / Path 双键互相覆盖 */
function buildEnv(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
        LANG: "C",
    };
    if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    return { ...env, ...extra };
}

/**
 * 本机可跑性预检（结果缓存）：
 *   ① 能不能找到 bash；
 *   ② 临时目录里的假 docker 能不能被 exec（Windows 上 chmod 不总是生效）。
 */
function probeEnvironment(): Probe {
    if (cachedProbe) return cachedProbe;
    const bashProbe = spawnSync("bash", ["-c", "printf probe-ok"], { encoding: "utf8" });
    if (bashProbe.error || bashProbe.status !== 0 || bashProbe.stdout.trim() !== "probe-ok") {
        cachedProbe = {
            ok: false,
            reason: "本机无 bash（Windows 默认 PATH 里通常没有）：行为测试跳过，Linux CI 上会真跑",
            bash: "bash",
        };
        return cachedProbe;
    }
    const dir = mkdtempSync(join(tmpdir(), "navihive-upgrader-probe-"));
    try {
        const binDir = join(dir, "bin");
        mkdirSync(binDir);
        const fakeDocker = join(binDir, "docker");
        writeFileSync(fakeDocker, `${FAKE_DOCKER_SOURCE.join("\n")}\n`);
        chmodSync(fakeDocker, 0o755);
        const probe = spawnSync(
            "bash",
            [
                "-c",
                'export PATH="$NAVIHIVE_FAKE_BIN:/usr/bin:/bin:$PATH"; exec docker probe',
            ],
            { encoding: "utf8", env: buildEnv({ NAVIHIVE_FAKE_BIN: toShellPath(binDir) }) },
        );
        const ok = !probe.error && probe.status === 0 && probe.stdout.trim() === "fake-docker-ok";
        cachedProbe = {
            ok,
            reason: ok
                ? ""
                : `本机无法让临时目录里的假 docker 可执行（${probe.stderr.trim() || probe.error?.message || "未知原因"}）：行为测试跳过，Linux CI 上会真跑`,
            bash: "bash",
        };
        return cachedProbe;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** 按剧本把一个完整的升级轮次推演出来（独立临时目录，结束由调用方 cleanup） */
function runLoop(options: LoopOptions): LoopResult {
    const dir = mkdtempSync(join(tmpdir(), "navihive-upgrader-"));
    const binDir = join(dir, "bin");
    const spoolDir = join(dir, "spool");
    mkdirSync(binDir);
    mkdirSync(spoolDir);
    const callLog = join(dir, "calls.log");
    writeFileSync(callLog, "");
    // 应用容器写下的请求文件：脚本看到它才会开始干活（否则一直等）
    writeFileSync(join(spoolDir, "request"), "{}");
    const fakeDocker = join(binDir, "docker");
    writeFileSync(fakeDocker, `${FAKE_DOCKER_SOURCE.join("\n")}\n`);
    chmodSync(fakeDocker, 0o755);

    const env = buildEnv({
        NAVIHIVE_IMAGE: "ghcr.io/example/navihive:upgrader-test",
        ALERT_WEBHOOK: "",
        // ---- 脚本的测试注入点（默认值才是线上值，这里全部收窄以便真跑）----
        NAVIHIVE_UPGRADER_SPOOL: toShellPath(spoolDir),
        NAVIHIVE_UPGRADER_POLL_SECONDS: "0",
        NAVIHIVE_UPGRADER_HEALTH_POLL_SECONDS: "0",
        NAVIHIVE_UPGRADER_ONCE: "1",
        // ---- 假 docker 的剧本 ----
        NAVIHIVE_FAKE_BIN: toShellPath(binDir),
        FAKE_CALL_LOG: toShellPath(callLog),
        FAKE_DIR: toShellPath(dir),
        FAKE_PULL_RC: String(options.pullRc),
        FAKE_HEALTH_BEFORE: options.healthBefore,
        FAKE_HEALTH_AFTER_ROLLBACK: options.healthAfterRollback,
        FAKE_COMPOSE_RECREATE_RC: String(options.recreateRc ?? 0),
        FAKE_COMPOSE_ROLLBACK_RC: String(options.rollbackRc ?? 0),
        NAVIHIVE_UPGRADE_SCRIPT: toShellPath(scriptPath),
        NAVIHIVE_RUNNER_SHELL: options.runnerShell ?? "bash",
    });

    // 外层用 bash 只为把假 docker 目录前置进 PATH（Windows 上 PATH 的路径形态
    // 由 bash 自己转，交给 Node 拼容易踩盘符/分隔符的坑）；真正执行脚本的是
    // $NAVIHIVE_RUNNER_SHELL —— 默认 bash，生产等价的用例给 /bin/sh。
    const result = spawnSync(
        "bash",
        ["-c", 'export PATH="$NAVIHIVE_FAKE_BIN:/usr/bin:/bin:$PATH"; exec "$NAVIHIVE_RUNNER_SHELL" "$NAVIHIVE_UPGRADE_SCRIPT"'],
        { cwd: repoRoot, env, encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL" },
    );

    const statePath = join(spoolDir, "state.json");
    const stateRaw = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
    let state: UpgradeState | null = null;
    if (stateRaw) {
        try {
            state = JSON.parse(stateRaw) as UpgradeState;
        } catch {
            state = null;
        }
    }
    return {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        state,
        stateRaw,
        calls: readFileSync(callLog, "utf8").split("\n").filter(line => line.trim() !== ""),
        dir,
    };
}

function cleanup(result: LoopResult): void {
    rmSync(result.dir, { recursive: true, force: true });
}

/**
 * 所有 `docker inspect` 都必须打在 **navihive** 上。
 *
 * ⚠️ 为什么必须在调用流水上断言：假 docker 只按 `--format` 的**形态**回放剧本
 *（`*State.Health.Status*` → 当前健康剧本），**不看容器名**。所以把门禁的探活目标
 * 从 `navihive` 写成 `navihive-upgrader`（打错容器）时，剧本仍然照常回放、
 * 三个终态照样正确 —— 变异测试实测 11/11 全绿。这条断言把这个盲区堵上：
 * 探活打错容器 → 门禁在给错的容器判生死，线上必然误回滚/假成功。
 */
function assertInspectsTargetNavihive(result: LoopResult): void {
    const inspects = result.calls.filter(call => call.startsWith("inspect"));
    assert.ok(inspects.length > 0, `一次 inspect 都没有：${result.calls.join(" | ")}`);
    assert.ok(
        inspects.every(call => call.endsWith(" navihive")),
        `有 inspect 打在了别的容器上（必须全是 navihive）：\n${inspects.join("\n")}`,
    );
}

/** 「脚本跑完了一轮、退出码 0」这个前提，失败时把 stderr 一起带出来 */
function assertCleanExit(result: LoopResult): void {
    assert.equal(
        result.status,
        0,
        `脚本没正常收尾（status=${String(result.status)} signal=${String(result.signal)}）\n` +
            `stderr: ${result.stderr}\nstdout: ${result.stdout}`,
    );
}

/** 需要真跑却又跑不了的用例统一走这里：打印原因并 skip，不假绿 */
function skipUnlessRunnable(t: TestContext): boolean {
    const probe = probeEnvironment();
    if (probe.ok) return false;
    t.skip(probe.reason);
    return true;
}

/**
 * 找一条能跑脚本的「生产等价 shell」：优先 `/bin/dash`，退到 `/bin/sh`。
 *
 * ⚠️ 为什么不再按 `process.platform === "win32"` 一刀切 skip（2026-11 修）：
 * 那条理由写的是「Windows 上只有 cygwin 的 /bin/sh，与 alpine ash 不等价」，实测不成立 ——
 * 本机 `/bin/sh` 是 GNU bash 5.3.15 的 sh 模式，而且**还有 /bin/dash**（比 bash-as-sh
 * 更接近 alpine 的 ash：同样不认 bash 专有语法）。无条件 skip 等于白丢一个信号。
 * 改为能力探测：跑得起来就真跑，跑不起来才 skip 并打印原因。
 */
function findProductionShell(): { shell: string; ok: boolean; reason: string } {
    const failures: string[] = [];
    for (const shell of ["/bin/dash", "/bin/sh"]) {
        // 特意**经由 bash 去 exec 候选 shell**：Windows 上 Node 直接 spawn("/bin/dash")
        // 是 ENOENT（那不是 Windows 路径），而 bash 会把它解析成本机的 /bin/dash。
        // 这也正是后面 runLoop 里执行脚本的方式（`exec "$NAVIHIVE_RUNNER_SHELL"`），
        // 探针与实跑走同一条路，探针说行、实跑就不会打脸。
        const probe = spawnSync("bash", ["-c", 'exec "$NAVIHIVE_PROBE_SHELL" -c "printf shell-ok"'], {
            encoding: "utf8",
            env: buildEnv({ NAVIHIVE_PROBE_SHELL: shell }),
        });
        if (!probe.error && probe.status === 0 && probe.stdout.trim() === "shell-ok") {
            return { shell, ok: true, reason: "" };
        }
        const why = probe.error?.message ?? (probe.stderr.trim() || `退出码 ${String(probe.status)}`);
        failures.push(`${shell}（${why}）`);
    }
    return {
        shell: "",
        ok: false,
        reason: `本机既没有可用的 /bin/dash 也没有 /bin/sh：${failures.join("、")} —— 跳过，Linux CI 上会真跑`,
    };
}

describe("升级器循环的静态接线（compose ↔ 脚本）", () => {
    test("compose 的 upgrader 执行仓库里的脚本，且不再有内联脚本", () => {
        assert.ok(
            composeText.includes(`exec /bin/sh ${CONTAINER_SCRIPT_PATH}`),
            `docker-compose.yml 的 upgrader 没 exec ${CONTAINER_SCRIPT_PATH}`,
        );
        assert.ok(
            composeText.includes(`[ ! -f ${CONTAINER_SCRIPT_PATH} ]`),
            "存在性检查那一行必须和 exec 用同一个（相对）路径，否则一个改了一个没改",
        );
        // 相对路径是这个设计的要点：写死绝对路径会把「自定义部署目录要改两处」
        //（working_dir + 绑定挂载，见 selfhost.md）变成四处。这里反向钉住。
        assert.ok(
            !composeText.includes(`/home/docker/navihive/${CONTAINER_SCRIPT_PATH}`),
            "compose 里又出现脚本的绝对路径了：entrypoint 应保持相对 working_dir",
        );
        assert.ok(!composeText.includes("while true; do"), "compose 里还残留内联的升级循环");
        assert.ok(!composeText.includes("state.json"), "compose 里还残留内联的 state.json 写入");
    });

    test("compose 仍保留那条「宿主原路径同名挂载」（脚本路径写死的前提）", () => {
        assert.ok(
            composeText.includes("- /home/docker/navihive:/home/docker/navihive"),
            "宿主原路径同名挂载被改掉了：compose 标签会写歪，第二轮升级必失败",
        );
        assert.ok(composeText.includes("working_dir: /home/docker/navihive"), "working_dir 丢了");
    });

    test("脚本保留 set -u，并且四个测试注入点的默认值没被人悄悄改掉", () => {
        assert.match(scriptText, /^set -u$/m, "脚本必须以 set -u 开头（未定义变量直接失败）");
        assert.ok(scriptText.includes('NAVIHIVE_UPGRADER_SPOOL:-/spool'), "spool 目录默认值必须是 /spool");
        assert.ok(scriptText.includes("NAVIHIVE_UPGRADER_POLL_SECONDS:-2"), "等请求的轮询间隔默认必须是 2s");
        assert.ok(scriptText.includes("NAVIHIVE_UPGRADER_HEALTH_POLL_SECONDS:-3"), "探活间隔默认必须是 3s");
        assert.ok(scriptText.includes("NAVIHIVE_UPGRADER_ONCE"), "缺 ONCE 注入点，行为测试就没法让主循环只跑一轮");
    });

    test("脚本覆盖全部六个相位（UI 依赖这组枚举）", () => {
        for (const phase of ["pulling", "recreating", "done", "failed", "rolled_back", "rollback_failed"]) {
            assert.ok(scriptText.includes(phase), `脚本里缺相位 ${phase}`);
        }
    });
});

describe("场景 E：脚本文本本身（CRLF 会把 sh -c 毒死）", () => {
    test("deploy/upgrader/upgrade-loop.sh 不含 \\r（必须是 LF）", () => {
        const bytes = readFileSync(scriptPath);
        assert.equal(bytes.filter(b => b === 13).length, 0, "脚本里有 CR：容器里 /bin/sh 会报 \\r: not found");
        assert.ok(bytes.length > 0, "脚本是空的？");
    });

    test("脚本里没有残留的 compose 转义 $$（抽取时每处都要还原成单个 $）", () => {
        assert.equal((scriptText.match(/\$\$/g) ?? []).length, 0, "还有 $$ 残留：compose 插值转义没还原干净");
        // 反向钉子：还原后的关键形态必须存在
        assert.ok(scriptText.includes('IMAGE="${NAVIHIVE_IMAGE}"'), "$$IMAGE 没还原成 $IMAGE");
        assert.ok(scriptText.includes('"${ALERT_WEBHOOK:-}"'), "${ALERT_WEBHOOK:-} 没还原成单 $");
    });
});

describe("升级器循环的行为（假 docker + 真脚本）", () => {
    test("A 成功升级：pull 成功、重建 rc=0、首轮探活 healthy → phase=done", t => {
        if (skipUnlessRunnable(t)) return;
        const result = runLoop({ pullRc: 0, healthBefore: "healthy", healthAfterRollback: "starting" });
        try {
            assertCleanExit(result);
            assert.equal(result.state?.phase, "done", `state.json=${result.stateRaw}\nstderr=${result.stderr}`);
            assertInspectsTargetNavihive(result);
            assert.equal(result.state?.error, "", "成功的 state.json 不该带 error 文案");
            assert.equal(result.state?.image, "", "终态写入的 image 字段本来就是空串（与原内联版逐字一致）");
            // 升级前必须给旧镜像打回滚锚点，否则回滚无从谈起
            assert.ok(
                result.calls.some(call => call === "tag sha256:0000previous navihive:previous"),
                `没有给旧 ImageID 打 navihive:previous 锚点：${result.calls.join(" | ")}`,
            );
            // 只有一次重建：门禁通过就不该再 compose 一次（那是回滚）
            assert.equal(
                result.calls.filter(call => call.startsWith("compose")).length,
                1,
                `门禁通过却发起了回滚：${result.calls.join(" | ")}`,
            );
            assert.ok(result.stdout.includes("[upgrader] 完成"), `缺完成日志：${result.stdout}`);
        } finally {
            cleanup(result);
        }
    });

    test("B 回滚成功：新容器始终不 healthy、回滚 compose rc=0、二次探活 healthy → phase=rolled_back", t => {
        if (skipUnlessRunnable(t)) return;
        // healthBefore=starting 让门禁 40 次探活全部不 healthy（不 unhealthy，走的是超时分支）
        const result = runLoop({ pullRc: 0, healthBefore: "starting", healthAfterRollback: "healthy" });
        try {
            assertCleanExit(result);
            assert.equal(
                result.state?.phase,
                "rolled_back",
                `state.json=${result.stateRaw}\nstderr=${result.stderr}`,
            );
            assert.ok(
                (result.state?.error ?? "").includes("已自动回滚"),
                `rolled_back 的 error 文案丢了：${result.state?.error ?? "(空)"}`,
            );
            assertInspectsTargetNavihive(result);
            // 回滚命令必须真的跑了一次（第一次重建 + 第二次回滚 = 2 次 compose）
            const composeCalls = result.calls.filter(call => call.startsWith("compose"));
            assert.equal(composeCalls.length, 2, `compose 调用次数不对：${result.calls.join(" | ")}`);
            assert.equal(composeCalls[1], RECREATE_CMD.replace("docker ", ""), "回滚那次没走完整的 compose 重建命令");
            // 回滚成功绝不能落到「完成」上 —— 那正是 R05 要消灭的假成功
            assert.ok(!result.stdout.includes("[upgrader] 完成"), `回滚后又报了完成：${result.stdout}`);
            assert.ok(result.stdout.includes("rolled_back"), `缺终态日志：${result.stdout}`);
        } finally {
            cleanup(result);
        }
    });

    test("C1 回滚失败（回滚 compose rc≠0）→ phase=rollback_failed，文案含「需人工介入」", t => {
        if (skipUnlessRunnable(t)) return;
        const result = runLoop({
            pullRc: 0,
            healthBefore: "starting",
            healthAfterRollback: "healthy",
            rollbackRc: 1,
        });
        try {
            assertCleanExit(result);
            assert.equal(
                result.state?.phase,
                "rollback_failed",
                `state.json=${result.stateRaw}\nstderr=${result.stderr}`,
            );
            const error = result.state?.error ?? "";
            assert.ok(error.includes("需人工介入"), `rollback_failed 的 error 文案丢了：${error || "(空)"}`);
            assert.ok(error.includes("退出码 1"), `error 里没带出处（回滚退出码）：${error || "(空)"}`);
            assertInspectsTargetNavihive(result);
            assert.ok(!result.stdout.includes("[upgrader] 完成"), `回滚失败后还报完成：${result.stdout}`);
        } finally {
            cleanup(result);
        }
    });

    test("C2 回滚失败（回滚 rc=0 但二次探活始终不 healthy）→ phase=rollback_failed", t => {
        if (skipUnlessRunnable(t)) return;
        // 这里特意和 B/C1 走**不同的门禁出口**：healthBefore=unhealthy 让门禁第 1 次探活就
        // break（不用等满 40 次超时），healthAfterRollback=starting 让二次探活耗尽 20 次仍
        // 拿不到 healthy —— 两条 exit 路径都覆盖到，跑得也快。
        const result = runLoop({
            pullRc: 0,
            healthBefore: "unhealthy",
            healthAfterRollback: "starting",
            rollbackRc: 0,
        });
        try {
            assertCleanExit(result);
            assert.equal(
                result.state?.phase,
                "rollback_failed",
                `state.json=${result.stateRaw}\nstderr=${result.stderr}`,
            );
            const error = result.state?.error ?? "";
            assert.ok(error.includes("需人工介入"), `rollback_failed 的 error 文案丢了：${error || "(空)"}`);
            assert.ok(error.includes("starting"), `error 里没带二次探活的最后状态：${error || "(空)"}`);
            assertInspectsTargetNavihive(result);
        } finally {
            cleanup(result);
        }
    });

    test("D2 重建失败（compose rc≠0）→ phase=failed，且不再探活", t => {
        if (skipUnlessRunnable(t)) return;
        // ⚠️ 这条补的是第六个相位：脚本里「重建本身失败」是一条独立的 else 分支
        //（`if docker compose ... up ...; then … else 写 failed fi`），与「拉取失败」不同。
        // 补之前它是零覆盖：把那条分支里的 "phase":"failed" 改成 "phase":"done"
        //（= 重建失败却报升级成功），11 个用例全绿、锚点测试也全绿 —— 又一个假成功出口。
        const result = runLoop({
            pullRc: 0,
            healthBefore: "healthy",
            healthAfterRollback: "healthy",
            recreateRc: 1,
        });
        try {
            assertCleanExit(result);
            assert.equal(
                result.state?.phase,
                "failed",
                `重建失败必须是 failed（不是 done）：state.json=${result.stateRaw}\nstderr=${result.stderr}`,
            );
            const error = result.state?.error ?? "";
            assert.ok(error.includes("重建失败"), `failed 的 error 文案丢了：${error || "(空)"}`);
            // 与「拉取失败」区分开：这条分支的文案不是拉取那句（防止两条 else 被合并/挪错）
            assert.ok(!error.includes("拉取镜像失败"), `重建失败却用了拉取失败的文案：${error}`);
            assert.equal(
                result.calls.filter(call => call.startsWith("compose")).length,
                1,
                `重建只该发起一次（失败后不该再 compose 一次）：${result.calls.join(" | ")}`,
            );
            // 重建都没成功，就不该进入健康探活。注意这里只钉 `State.Health.Status`
            // 那种探活 —— 重建**之前**那次 `--format={{.Image}}` 的 inspect 是回滚锚点，
            // 它本来就该发生（重建失败也不影响它已经打过 navihive:previous）。
            assert.deepEqual(
                result.calls.filter(call => call.includes("State.Health.Status")),
                [],
                `重建失败后还在探活（门禁不该跑）：${result.calls.join(" | ")}`,
            );
            assert.equal(
                result.calls.filter(call => call.includes("{{.Image}}")).length,
                1,
                `重建前那次「取旧 ImageID 打 previous 锚点」应该发生且只发生一次：${result.calls.join(" | ")}`,
            );
            assert.ok(!result.stdout.includes("[upgrader] 完成"), `重建失败却报了完成：${result.stdout}`);
        } finally {
            cleanup(result);
        }
    });

    test("D 拉取失败：phase=failed，且**没有**发起重建（假 docker 记账为证）", t => {
        if (skipUnlessRunnable(t)) return;
        const result = runLoop({ pullRc: 1, healthBefore: "healthy", healthAfterRollback: "healthy" });
        try {
            assertCleanExit(result);
            assert.equal(result.state?.phase, "failed", `state.json=${result.stateRaw}\nstderr=${result.stderr}`);
            assert.ok(
                (result.state?.error ?? "").includes("拉取镜像失败"),
                `failed 的 error 文案丢了：${result.state?.error ?? "(空)"}`,
            );
            assert.equal(
                result.calls.filter(call => call.startsWith("pull")).length,
                1,
                `pull 应该只试一次：${result.calls.join(" | ")}`,
            );
            assert.deepEqual(
                result.calls.filter(call => call.startsWith("compose")),
                [],
                `拉取失败后居然还发起了 compose（等于用旧镜像重建）：${result.calls.join(" | ")}`,
            );
            assert.deepEqual(
                result.calls.filter(call => call.startsWith("inspect")),
                [],
                `拉取失败后还在探活：${result.calls.join(" | ")}`,
            );
        } finally {
            cleanup(result);
        }
    });

    test("F 生产入口等价：用 /bin/dash（其次 /bin/sh）跑 A 场景也得到 phase=done", t => {
        // 生产入口是 alpine 的 `/bin/sh`（busybox ash）。本机能找到的最接近的东西是
        // `/bin/dash`（同为 Debian-alike 的 POSIX shell，比 bash 的 sh 模式更能抓出
        // bash 特有的语法），没有才退到 `/bin/sh`。两者都不可用才 skip。
        const production = findProductionShell();
        if (!production.ok) return t.skip(production.reason);
        if (skipUnlessRunnable(t)) return;
        const result = runLoop({
            pullRc: 0,
            healthBefore: "healthy",
            healthAfterRollback: "starting",
            runnerShell: production.shell,
        });
        try {
            assertCleanExit(result);
            assert.equal(
                result.state?.phase,
                "done",
                `用 ${production.shell} 跑出来的结果与 bash 不一致（脚本里有 bash 专有语法？）：` +
                    `state.json=${result.stateRaw}\nstderr=${result.stderr}`,
            );
        } finally {
            cleanup(result);
        }
    });
});
