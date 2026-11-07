// 升级健康门禁（P1 #9）的守卫：钉死「是否回滚」的纯决策，并保证两条升级路径
// （spool 模式的 deploy/upgrader/upgrade-loop.sh + sock 模式的 entry.ts upgraderCommand）
// 使用了**相同**的回滚锚点 / 探活字段 / 回滚命令。
//
// ⚠️ 2026-11 变动：spool 那边的 shell 原先内联在 docker-compose.yml 的 `upgrader.command`
// 里，现在抽成了 `deploy/upgrader/upgrade-loop.sh`（compose 只是 exec 这个文件）。
// 所以下面凡是「spool 侧脚本」的断言，工具链从 composeYml 换成了 loopScript ——
// **断言本身一条没删、强度一点没降**（那组锚点是唯一防止两份实现对向漂移的绳子，
// 削弱它就等于让两份实现可以各自漂走而门禁全绿）。
//
// ⚠️ 本机没有 Docker daemon，shell 端到端行为无法本地验证；这里只钉住：
//   ① shouldRollback 纯决策；② TS 生成的 shell 与升级器脚本出现相同关键锚点。
//   （升级器脚本自己的**行为**由 tests/upgraderLoop.test.ts 用假 docker 真跑覆盖。）
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    shouldRollback,
    tagPreviousBeforeRecreate,
    healthGuardAfterRecreate,
    classifyRollback,
    classifyHelperExitCode,
    rollbackHelperExitCode,
    HELPER_EXIT_ROLLED_BACK,
    HELPER_EXIT_ROLLBACK_FAILED,
    HEALTHCHECK_MAX_ATTEMPTS,
    HEALTHCHECK_POLL_SECONDS,
    ROLLBACK_RECHECK_MAX_ATTEMPTS,
} from "../server/upgradeHealth";

const repoRoot = process.cwd();
const composeYml = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
const entryTs = readFileSync(resolve(repoRoot, "server/entry.ts"), "utf8");
/**
 * sock 路径的「命令拼装层」。2026-11 从 server/entry.ts 拆出（原文件 1500+ 行）——
 * `upgraderCommand` 所在的文件变了，锚点检查的对象也要跟着换，否则这条守卫会变成
 * 「检查一个已经不存在的地方」的假绿。拆分的背景见 server/upgrade/compose.ts 文件头。
 */
const upgradeComposeTs = readFileSync(resolve(repoRoot, "server/upgrade/compose.ts"), "utf8");
/**
 * 重建序列与状态机（退出码 → 相位类型的另一半）。同样在 2026-11 从 entry.ts 拆出，
 * 所以「退出码有没有真的从 helper 传到失败分支」要到这个文件里看。
 */
const selfUpgradeTs = readFileSync(resolve(repoRoot, "server/upgrade/selfUpgrade.ts"), "utf8");
/** spool 升级器的执行体（2026-11 从 compose 内联抽出来的那份） */
const loopScript = readFileSync(resolve(repoRoot, "deploy/upgrader/upgrade-loop.sh"), "utf8");

describe("shouldRollback 纯决策", () => {
    test("healthy 且未超时 → 不回滚", () => {
        assert.equal(shouldRollback("healthy", false), false);
    });
    test("unhealthy → 回滚", () => {
        assert.equal(shouldRollback("unhealthy", false), true);
    });
    test("一直 starting 直到超时 → 回滚", () => {
        assert.equal(shouldRollback("starting", true), true);
    });
    test("超时优先于 healthy（守护超时也算失败）", () => {
        assert.equal(shouldRollback("healthy", true), true);
    });
    test("未超时且非 unhealthy（仍 starting）→ 不回滚，继续等", () => {
        assert.equal(shouldRollback("starting", false), false);
    });
});

describe("TS 生成的升级 shell 锚点", () => {
    const tag = tagPreviousBeforeRecreate("navihive");
    const guard = healthGuardAfterRecreate("navihive", "navihive", "docker-compose.yml");

    test("升级前给旧镜像打 navihive:previous 锚点（inspect ImageID）", () => {
        assert.ok(tag.includes("navihive:previous"));
        assert.ok(tag.includes("{{.Image}}"));
    });

    test("重建后探活用 docker inspect 的 Health.Status", () => {
        assert.ok(guard.includes("{{.State.Health.Status}}"));
    });

    test("不健康/超时回滚：tag previous 再 compose 重建", () => {
        assert.ok(guard.includes("docker tag navihive:previous navihive:latest"));
        assert.ok(
            guard.includes(
                "docker compose -f docker-compose.yml -p navihive up -d --force-recreate --no-deps navihive"
            )
        );
    });
});

describe("两条升级路径锚点一致", () => {
    const guard = healthGuardAfterRecreate("navihive", "navihive", "docker-compose.yml");
    const tag = tagPreviousBeforeRecreate("navihive");

    // ⚠️ 这组断言是**整条绳子**：spool 路径（脚本里写的 shell）与 sock 路径（TS 生成的
    // shell）是两份独立实现，只有它们含同一组关键锚点，才谈得上「改一边必须同步另一边」。
    // 少了它，两边可以各自漂走而所有门禁全绿 —— 而这恰好是 2026-11-04 那次事故的形状
    //（线上跑的是三天前的旧脚本，没人发现两份实现已经不一致）。
    //
    // compose → 脚本 这一跳也要钉住：脚本抽出去之后，compose 只剩 exec，如果哪天有人
    // 把 exec 指向别的文件（或退回内联），锚点检查的对象就和线上跑的实物对不上了。
    test("docker-compose.yml 的 upgrader 真正执行那个脚本文件（compose → 脚本一跳）", () => {
        // 相对路径：脚本自己引用 compose 文件（-f docker-compose.yml）也是相对的，
        // 同一套「cwd == working_dir」前提；写绝对路径会把 selfhost.md 里
        // 「自定义目录只改两处」变成四处。
        assert.ok(
            composeYml.includes("exec /bin/sh deploy/upgrader/upgrade-loop.sh"),
            "compose 的 upgrader 没有执行 deploy/upgrader/upgrade-loop.sh",
        );
        assert.ok(
            !composeYml.includes("/home/docker/navihive/deploy/upgrader/upgrade-loop.sh"),
            "compose 里出现了脚本的绝对路径：entrypoint 应相对 working_dir",
        );
        assert.ok(
            !composeYml.includes("{{.State.Health.Status}}"),
            "compose 里又出现了内联的探活脚本：spool 路径的执行体只能在 upgrade-loop.sh 里",
        );
    });

    // 升级器脚本（spool upgrader）必须包含与 TS 生成 shell 相同的关键锚点
    for (const anchor of [
        "navihive:previous",
        "{{.Image}}",
        "{{.State.Health.Status}}",
        "docker compose -f docker-compose.yml -p navihive up -d --force-recreate --no-deps navihive",
    ]) {
        test(`deploy/upgrader/upgrade-loop.sh 含锚点：${anchor}`, () => {
            assert.ok(loopScript.includes(anchor), `upgrade-loop.sh 缺少锚点：${anchor}`);
        });
    }

    // 命令拼装层（sock helper）必须真正 import 并调用这两个生成函数，否则就是没接线。
    // ⚠️ 2026-11 起这条检查的是 server/upgrade/compose.ts —— 那两个函数连同整个
    // upgraderCommand 从 entry.ts 搬出去了（见该文件头）。entry.ts 只留路由。
    test("server/upgrade/compose.ts 接入了 upgradeHealth 的两个函数", () => {
        assert.ok(upgradeComposeTs.includes('from "../upgradeHealth"'));
        assert.ok(upgradeComposeTs.includes("tagPreviousBeforeRecreate("));
        assert.ok(upgradeComposeTs.includes("healthGuardAfterRecreate("));
    });

    test("TS 生成锚点与升级器脚本逐一吻合", () => {
        // 若任一侧改了回滚命令而另一侧没跟着改，这里直接红
        assert.ok(guard.includes("navihive:previous"));
        assert.ok(guard.includes("{{.State.Health.Status}}"));
        assert.ok(tag.includes("{{.Image}}"));
    });

    // 探活**预算**也算「锚点」：40 × 3s = 120s 门禁、20 × 3s = 60s 回滚后二次探活。
    // 两份实现如果一边改成 60 次、另一边还是 40 次，行为就分叉了（而锚点字符串仍然对得上），
    // 所以门槛值也要绑在一起。脚本侧的门槛走「默认值」断言（变量可注入，但默认必须相同）。
    test("两边的探活预算一致（次数与间隔），脚本侧看的是注入点的默认值", () => {
        assert.ok(
            loopScript.includes(`seq 1 ${HEALTHCHECK_MAX_ATTEMPTS}`),
            `升级器脚本的健康门禁次数应等于 HEALTHCHECK_MAX_ATTEMPTS=${HEALTHCHECK_MAX_ATTEMPTS}`,
        );
        assert.ok(
            loopScript.includes(`seq 1 ${ROLLBACK_RECHECK_MAX_ATTEMPTS}`),
            `升级器脚本的二次探活次数应等于 ROLLBACK_RECHECK_MAX_ATTEMPTS=${ROLLBACK_RECHECK_MAX_ATTEMPTS}`,
        );
        assert.ok(
            loopScript.includes(`NAVIHIVE_UPGRADER_HEALTH_POLL_SECONDS:-${HEALTHCHECK_POLL_SECONDS}`),
            `升级器脚本的探活间隔默认值应等于 HEALTHCHECK_POLL_SECONDS=${HEALTHCHECK_POLL_SECONDS}`,
        );
        assert.ok(
            guard.includes(`seq 1 ${HEALTHCHECK_MAX_ATTEMPTS}`),
            "TS 生成的 shell 门禁次数变了，升级器脚本却没跟着改",
        );
        assert.ok(guard.includes(`seq 1 ${ROLLBACK_RECHECK_MAX_ATTEMPTS}`));
        assert.ok(guard.includes(`sleep ${HEALTHCHECK_POLL_SECONDS}`));
    });
});

// ============ R05：升级状态协议（让升级/回滚结果真实可信） ============

describe("classifyRollback 纯决策（回滚命令返回码 × 二次探活结果 → 终态）", () => {
    test("回滚命令 0 + 二次探活 healthy + 未超时 → rolled_back", () => {
        assert.equal(classifyRollback(0, "healthy", false), "rolled_back");
    });

    test("回滚命令非 0：即便二次探活 healthy 也是 rollback_failed", () => {
        assert.equal(classifyRollback(1, "healthy", false), "rollback_failed");
        assert.equal(classifyRollback(21, "healthy", false), "rollback_failed");
        assert.equal(classifyRollback(-1, "healthy", false), "rollback_failed");
    });

    test("回滚命令 0 但二次探活 unhealthy / starting / 超时 → rollback_failed", () => {
        assert.equal(classifyRollback(0, "unhealthy", false), "rollback_failed");
        assert.equal(classifyRollback(0, "starting", false), "rollback_failed");
        assert.equal(classifyRollback(0, "starting", true), "rollback_failed");
        assert.equal(classifyRollback(0, "unknown", true), "rollback_failed");
    });

    test("超时优先于 healthy（防御：探活循环耗尽也算失败）", () => {
        assert.equal(classifyRollback(0, "healthy", true), "rollback_failed");
    });

    test("全组合穷举：只有 (0, healthy, false) 是 rolled_back", () => {
        const codes = [0, 1, 21, 41];
        const statuses = ["healthy", "unhealthy", "starting", "unknown"];
        for (const code of codes) {
            for (const st of statuses) {
                for (const timedOut of [false, true]) {
                    const expected =
                        code === 0 && st === "healthy" && !timedOut ? "rolled_back" : "rollback_failed";
                    assert.equal(
                        classifyRollback(code, st, timedOut),
                        expected,
                        `code=${code} status=${st} timedOut=${timedOut}`,
                    );
                }
            }
        }
    });
});

describe("helper 退出码 ↔ 终态相位（sock 模式把结论传给 entry.ts）", () => {
    test("两个终态各有一个稳定的非 0 退出码，且不撞脚本里已有的 1/21/22", () => {
        assert.equal(rollbackHelperExitCode("rolled_back"), HELPER_EXIT_ROLLED_BACK);
        assert.equal(rollbackHelperExitCode("rollback_failed"), HELPER_EXIT_ROLLBACK_FAILED);
        assert.notEqual(HELPER_EXIT_ROLLED_BACK, 0);
        assert.notEqual(HELPER_EXIT_ROLLBACK_FAILED, 0);
        assert.notEqual(HELPER_EXIT_ROLLED_BACK, HELPER_EXIT_ROLLBACK_FAILED);
        for (const reserved of [1, 21, 22]) {
            assert.notEqual(HELPER_EXIT_ROLLED_BACK, reserved);
            assert.notEqual(HELPER_EXIT_ROLLBACK_FAILED, reserved);
        }
    });

    test("退出码能反解回相位，其它非 0 码一律 null（按普通失败处理）", () => {
        assert.equal(classifyHelperExitCode(HELPER_EXIT_ROLLED_BACK), "rolled_back");
        assert.equal(classifyHelperExitCode(HELPER_EXIT_ROLLBACK_FAILED), "rollback_failed");
        assert.equal(classifyHelperExitCode(0), null);
        assert.equal(classifyHelperExitCode(1), null);
        assert.equal(classifyHelperExitCode(21), null);
        assert.equal(classifyHelperExitCode(22), null);
        assert.equal(classifyHelperExitCode(99), null);
    });
});

describe("R05：两条升级路径都写回滚终态 / 查回滚命令返回码 / 回滚后二次探活", () => {
    const guard = healthGuardAfterRecreate("navihive", "navihive", "docker-compose.yml");
    const scripts: Array<[string, string]> = [
        ["TS 生成的 sock helper shell", guard],
        ["deploy/upgrader/upgrade-loop.sh 的 spool 升级器", loopScript],
    ];

    for (const [label, script] of scripts) {
        test(`${label}：出现 rolled_back / rollback_failed 两个终态`, () => {
            assert.ok(script.includes("rolled_back"), `${label} 缺 rolled_back`);
            assert.ok(script.includes("rollback_failed"), `${label} 缺 rollback_failed`);
        });

        test(`${label}：回滚 compose 命令的返回码被捕获且参与判定`, () => {
            assert.match(script, /RB_CODE\s*=\s*\$+\?/, `${label} 没捕获回滚 compose 的退出码`);
            assert.ok(script.includes("-eq 0"), `${label} 没检查 RB_CODE 是否为 0`);
            assert.ok(
                script.includes("docker compose -f docker-compose.yml -p navihive up -d --force-recreate --no-deps navihive"),
                `${label} 回滚命令锚点丢了`,
            );
        });

        test(`${label}：回滚后有第二轮 Health.Status 探活（至少两处 docker inspect）`, () => {
            const probes = script.split("{{.State.Health.Status}}").length - 1;
            assert.ok(probes >= 2, `${label} 探活字段只出现 ${probes} 次，应有重建门禁 + 回滚后二次探活`);
            const inspects = script.split("docker inspect").length - 1;
            assert.ok(inspects >= 2, `${label} docker inspect 只出现 ${inspects} 次`);
            assert.ok(script.includes("RB_OK"), `${label} 缺二次探活的 healthy 标记`);
        });
    }

/**
 * 从 shell 脚本里切出「`opener` 那一行 → 与之配对的 `fi`」之间的整段（含首尾）。
 *
 * 为什么需要按结构切、不能只比 indexOf 大小（2026-11 修）：原来那条断言是
 * `doneAt > guardAt`，而它能被**与守卫无关的**写法满足 —— 变异测试把别处（重建失败的
 * else 分支）的 `"phase":"failed"` 改成 `"phase":"done"`，`"phase":"done"` 的首次出现
 * 依然在 guardAt 之后，于是「done 写在守卫里」照样绿。顺序比较证明不了「在块内」。
 *
 * 深度计数：块内每行以 `if `/`if (`/`if[` 开头算开一层（`elif` / `else` 不算），
 * 单独一行的 `fi` 关一层；关到 0 就是配对的那一行。
 */
function extractShellBlock(script: string, opener: string): string {
    const lines = script.split("\n");
    const start = lines.findIndex(line => line.trim() === opener);
    assert.ok(start >= 0, `脚本里找不到块起始行：${opener}`);
    let depth = 0;
    for (let i = start; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        if (/^if(\s|\(|\[)/.test(trimmed)) depth += 1;
        if (trimmed === "fi") {
            depth -= 1;
            if (depth === 0) return lines.slice(start, i + 1).join("\n");
        }
    }
    assert.fail(`脚本里的 if 块没有闭合：${opener}`);
}

    describe("spool：done 的写入位置（守卫块内外都要钉）", () => {
        const guardBlock = extractShellBlock(loopScript, 'if [ -n "$GUARD_OK" ]; then');

        test("done 的 printf 与「完成」回显都落在 GUARD_OK 守卫块**内部**", () => {
            assert.ok(
                guardBlock.includes('"phase":"done"'),
                `GUARD_OK 守卫块里没有写 done —— 这等于门禁没过也能报升级成功：\n${guardBlock}`,
            );
            assert.ok(
                guardBlock.includes("[upgrader] 完成"),
                `「完成」回显要跟着 done 一起在守卫块里：\n${guardBlock}`,
            );
        });

        test("守卫块之外没有第二处写 done（块是唯一出口）", () => {
            // 这条才是真正能证伪 M7 的那半：别处（例如重建失败的 else 分支）
            // 一旦也写 done，就出现了第二个「假成功」出口。
            const outside = loopScript.split(guardBlock).join("");
            assert.ok(
                !outside.includes('"phase":"done"'),
                "GUARD_OK 守卫块之外还有写 done 的地方：门禁没通过也可能报升级成功",
            );
        });

        test("守卫块确实是「GUARD_OK 非空」这一个条件（不是恒真）", () => {
            const openerLine = guardBlock.split("\n")[0].trim();
            assert.equal(openerLine, 'if [ -n "$GUARD_OK" ]; then', `守卫条件被改了：${openerLine}`);
            assert.ok(guardBlock.trimEnd().endsWith("fi"), "切出来的块没有闭合到 fi");
        });
    });
    test("spool：两个回滚终态都带人读 error 文案与 finishedAt", () => {
        assert.match(
            loopScript,
            /"phase":"%s","image":"","error":"%s","startedAt":%s,"finishedAt":%s}/,
            "state.json 的终态写入要带 error 与 finishedAt",
        );
        assert.ok(loopScript.includes("已自动回滚到上一版本"));
        assert.ok(loopScript.includes("需人工介入"));
    });

    test("spool：webhook 文案区分「已成功回滚」与「回滚失败，需人工介入」", () => {
        assert.ok(loopScript.includes("已成功回滚到上一版本"));
        assert.ok(loopScript.includes("回滚失败，需人工介入"));
        // 抽取后是单 $（原 compose 里写作 $$ALERT_TEXT）；先断言“没有 $$ 残留”再把单 $ 钉住，
        // 这样既保留了原来那条语义，也顺手堵住「抽取时漏还原转义」这类错误。
        assert.equal((loopScript.match(/\$\$/g) ?? []).length, 0, "脚本里还有 compose 转义 $$ 残留");
        assert.ok(loopScript.includes("$ALERT_TEXT"), "webhook 要发分类后的文案，不能还是那句无条件「已回滚」");
        assert.ok(!loopScript.includes('echo "[upgrader] 已回滚"'), "不许再无条件 echo 已回滚");
    });

    test("sock：回滚以非 0 退出（40/41），不会落到「完成」回显", () => {
        assert.ok(guard.includes("exit 40"), "rolled_back 必须让 helper 非 0 退出");
        assert.ok(guard.includes("exit 41"), "rollback_failed 必须让 helper 非 0 退出");
        assert.ok(guard.includes("[upgrader] ROLLBACK_RESULT=rolled_back"));
        assert.ok(guard.includes("[upgrader] ROLLBACK_RESULT=rollback_failed"));
        assert.ok(
            guard.indexOf("exit 40") > 0 && guard.indexOf("exit 41") > guard.indexOf("exit 40"),
            "两个 exit 都要在回滚分支里",
        );
    });

    test("两条链路都把 helper 退出码反解成相位（不是只写了个纯函数没人调）", () => {
        // 反解动作留在了路由层（entry.ts 的失败分支），退出码的产生与相位类型
        // 随实现搬到了 server/upgrade/selfUpgrade.ts（2026-11 拆分，见该文件头）。
        assert.ok(entryTs.includes("classifyHelperExitCode("), "entry.ts 没调用 classifyHelperExitCode");
        assert.ok(
            selfUpgradeTs.includes("helperExitCode"),
            "helper 退出码没从 runUpgraderContainer 传到失败分支",
        );
        assert.ok(
            selfUpgradeTs.includes('"rolled_back" | "rollback_failed"'),
            "upgradeStatus.phase 联合类型没补两个终态",
        );
        assert.ok(entryTs.includes('from "./upgradeHealth"'), "entry.ts 仍要 import upgradeHealth（反解在那里调）");
    });
});
