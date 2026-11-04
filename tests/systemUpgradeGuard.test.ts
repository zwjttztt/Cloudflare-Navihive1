// 升级健康门禁（P1 #9）的守卫：钉死「是否回滚」的纯决策，并保证两条升级路径
// （spool 模式的 docker-compose.yml upgrader + sock 模式的 entry.ts upgraderCommand）
// 使用了**相同**的回滚锚点 / 探活字段 / 回滚命令。
//
// ⚠️ 本机没有 Docker daemon，shell 端到端行为无法本地验证；这里只钉住：
//   ① shouldRollback 纯决策；② TS 生成的 shell 与 docker-compose.yml 出现相同关键锚点。
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
} from "../server/upgradeHealth";

const repoRoot = process.cwd();
const composeYml = readFileSync(resolve(repoRoot, "docker-compose.yml"), "utf8");
const entryTs = readFileSync(resolve(repoRoot, "server/entry.ts"), "utf8");

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

    // docker-compose.yml（spool upgrader）必须包含与 TS 生成 shell 相同的关键锚点
    for (const anchor of [
        "navihive:previous",
        "{{.Image}}",
        "{{.State.Health.Status}}",
        "docker compose -f docker-compose.yml -p navihive up -d --force-recreate --no-deps navihive",
    ]) {
        test(`docker-compose.yml 含锚点：${anchor}`, () => {
            assert.ok(composeYml.includes(anchor), `docker-compose.yml 缺少锚点：${anchor}`);
        });
    }

    // entry.ts（sock helper）必须真正 import 并调用这两个生成函数，否则就是没接线
    test("entry.ts 接入了 upgradeHealth 的两个函数", () => {
        assert.ok(entryTs.includes('from "./upgradeHealth"'));
        assert.ok(entryTs.includes("tagPreviousBeforeRecreate("));
        assert.ok(entryTs.includes("healthGuardAfterRecreate("));
    });

    test("TS 生成锚点与 docker-compose.yml 逐一吻合", () => {
        // 若任一侧改了回滚命令而另一侧没跟着改，这里直接红
        assert.ok(guard.includes("navihive:previous"));
        assert.ok(guard.includes("{{.State.Health.Status}}"));
        assert.ok(tag.includes("{{.Image}}"));
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
        ["docker-compose.yml 的 spool upgrader command", composeYml],
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

    test("spool：只有 GUARD_OK 非空（健康门禁通过）才写 phase=done", () => {
        const guardAt = composeYml.indexOf('if [ -n "$$GUARD_OK" ]; then');
        const doneAt = composeYml.indexOf('"phase":"done"');
        assert.ok(guardAt > 0, "done 写入必须被 GUARD_OK 守卫");
        assert.ok(doneAt > guardAt, "done 必须写在 GUARD_OK 守卫里面");
    });

    test("spool：两个回滚终态都带人读 error 文案与 finishedAt", () => {
        assert.match(
            composeYml,
            /"phase":"%s","image":"","error":"%s","startedAt":%s,"finishedAt":%s}/,
            "state.json 的终态写入要带 error 与 finishedAt",
        );
        assert.ok(composeYml.includes("已自动回滚到上一版本"));
        assert.ok(composeYml.includes("需人工介入"));
    });

    test("spool：webhook 文案区分「已成功回滚」与「回滚失败，需人工介入」", () => {
        assert.ok(composeYml.includes("已成功回滚到上一版本"));
        assert.ok(composeYml.includes("回滚失败，需人工介入"));
        assert.ok(composeYml.includes("$$ALERT_TEXT"), "webhook 要发分类后的文案，不能还是那句无条件「已回滚」");
        assert.ok(!composeYml.includes('echo "[upgrader] 已回滚"'), "不许再无条件 echo 已回滚");
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

    test("entry.ts：失败分支真的用退出码反解相位（不是只写了个纯函数没人调）", () => {
        assert.ok(entryTs.includes("classifyHelperExitCode("), "entry.ts 没调用 classifyHelperExitCode");
        assert.ok(entryTs.includes("helperExitCode"), "helper 退出码没从 runUpgraderContainer 传到失败分支");
        assert.ok(
            entryTs.includes('"rolled_back" | "rollback_failed"'),
            "upgradeStatus.phase 联合类型没补两个终态",
        );
        assert.ok(entryTs.includes('from "./upgradeHealth"'));
    });
});
