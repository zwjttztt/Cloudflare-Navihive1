// tests/upgradeRollbackStatus.test.ts
// R05「升级状态协议」的前端接线守卫。
//
// 为什么用源码守卫而不是渲染用例：组件用例（tests/versionUpgrade.dom.test.tsx）里
// 没有烘进来的 __NAVIHIVE_BUILD_VERSION__，watchUpgrade() 会在第一行 early return，
// 驱动不到「升级已结束」的分支。所以这里退一步钉住**结构事实**：
//   ① upgradeWait 的否决判定排在版本号之前；
//   ② 只有 upgraded 才会 setUpgradeOutcome({kind:"done"})；
//   ③ 回滚场景有独立 Alert 且绝不出现「升级完成」；
//   ④ 既有 DOM 锚点一个没丢。
// 纯决策与轮询行为由 tests/upgradeWait.test.ts 逐例钉死，shell 锚点由
// tests/systemUpgradeGuard.test.ts 钉死，三者合起来覆盖两条升级路径。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function projectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录（6 层内没有 package.json）");
}

const ROOT = projectDir();
const readSrc = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** 剥注释：守卫断言不能被自己写的说明文字骗过去 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const waitSrc = stripComments(readSrc("src/utils/upgradeWait.ts"));
const uiSrc = stripComments(readSrc("src/components/VersionUpgradeSection.tsx"));

describe("upgradeWait：否决判定必须排在版本号之前", () => {
    test("两个新相位都进了显式否决表", () => {
        assert.ok(waitSrc.includes("rolled_back"));
        assert.ok(waitSrc.includes("rollback_failed"));
        assert.ok(waitSrc.includes("rollbackVeto("), "否决要抽成纯函数便于逐格钉死");
    });

    test("源码顺序：rollbackVeto 判定 → 才调用 fetchServerVersion", () => {
        const vetoAt = waitSrc.indexOf("const veto = rollbackVeto(status?.phase);");
        const versionAt = waitSrc.indexOf("const server = await fetchServerVersion(");
        assert.ok(vetoAt > 0, "找不到否决判定");
        assert.ok(versionAt > 0, "找不到版本号判定");
        assert.ok(
            vetoAt < versionAt,
            "必须先判 phase 再看版本号：新静态清单可能在回滚前就可读，反了就会误报 upgraded",
        );
    });

    test("否决命中时立即返回 failed，不落到 upgraded 分支", () => {
        const vetoAt = waitSrc.indexOf("const veto = rollbackVeto(status?.phase);");
        const upgradedAt = waitSrc.indexOf('return { kind: "upgraded" }');
        assert.ok(vetoAt > 0 && upgradedAt > vetoAt);
        const block = waitSrc.slice(vetoAt, upgradedAt);
        assert.match(block, /return \{ kind: "failed"/, "否决分支必须自己 return failed");
        assert.match(block, /rollback: veto\.phase/, "要带终态判别字段供 UI 分流");
    });
});

describe("VersionUpgradeSection：回滚场景绝不出现「升级完成」", () => {
    test("只有 upgraded 才 setUpgradeOutcome({kind:\"done\"})", () => {
        const doneAt = uiSrc.indexOf('setUpgradeOutcome({ kind: "done" })');
        assert.ok(doneAt > 0, "找不到 done 分支");
        const upgradedGuard = uiSrc.lastIndexOf('result.kind === "upgraded"', doneAt);
        assert.ok(
            upgradedGuard > 0 && upgradedGuard < doneAt,
            "done 必须写在 result.kind === \"upgraded\" 分支里",
        );
        const reloadAt = uiSrc.indexOf("await reloadWithFreshCache();", doneAt);
        assert.ok(reloadAt > 0, "done 之后才清缓存重载");
        assert.ok(uiSrc.indexOf('setUpgradeOutcome({ kind: "done" })', doneAt + 1) === -1, "done 只允许出现一次");
    });

    test("回滚终态走独立 outcome 与 data-update-rolled-back 锚点", () => {
        assert.ok(uiSrc.includes('data-update-rolled-back=\'1\''), "要有独立的回滚 Alert 锚点");
        assert.ok(uiSrc.includes('kind: "rolled_back"'), "要有独立的 rolled_back outcome");
        assert.ok(uiSrc.includes("result.rollback"), "UI 要靠结构化判别字段分流，不要去嗅探文案");
    });

    test("回滚 Alert 文案不含「升级完成」", () => {
        const at = uiSrc.indexOf("data-update-rolled-back='1'");
        assert.ok(at > 0);
        const block = uiSrc.slice(at, at + 400);
        assert.doesNotMatch(block, /升级完成/, "回滚提示里绝不能出现升级完成");
    });

    test("既有 DOM 锚点一个没丢", () => {
        for (const anchor of [
            "data-update-done='1'",
            "data-update-failed='1'",
            "data-update-running='1'",
            "data-update-copied='1'",
            "data-update-copy-failed='1'",
            "data-update-action='1'",
            "data-check-update='1'",
        ]) {
            assert.ok(uiSrc.includes(anchor), `丢了既有锚点：${anchor}`);
        }
    });
});
