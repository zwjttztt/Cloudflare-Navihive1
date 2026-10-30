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
