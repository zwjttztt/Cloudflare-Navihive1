// tests/siteSyncHook.dom.test.tsx
// useSiteSync（卡片侧跨设备删除同步）的行为钉子。
//
// 修的问题（2026-10-18 用户报「每次刷新都弹『其它设备删除了 N 张卡片，已同步』」）：
//   1. 游标原来只在内存 ref → 刷新后首轮全量重放墓碑 → 每次刷新弹一遍；
//      现在游标持久化（utils/siteSync.ts），remount 后接着上次的位置增量；
//   2. 游标为空的「第一次」只建基线不提示；
//   3. 本设备自己删的（deleteSite 成功时已埋点）从提示里过滤掉。
//
// 驱动方式：每轮轮询在 siteChanges 处挂闸（deferred gate），测试手动放行，
// 「先过一轮 → 埋删除记录 → 再过一轮」的时序完全确定，不靠 sleep 猜。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSiteSync } from "../src/hooks/useSiteSync";
import { setActiveAccount, clearActiveAccount } from "../src/utils/accountScope";
import { markLocalSiteDeletes } from "../src/utils/siteSync";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
    if (root) {
        act(() => root!.unmount());
        root = null;
    }
    if (host) {
        host.remove();
        host = null;
    }
    document.body.innerHTML = "";
    globalThis.localStorage?.clear();
    clearActiveAccount();
});

async function mountSync(opts: {
    /** 每轮轮询依次出牌；出完兜底「无删除」 */
    deleted: number[][];
}) {
    const notifies: string[] = [];
    const removed: number[][] = [];
    const sinceSeen: Array<string | undefined> = [];
    let calls = 0;
    let round = 0;
    let release: (() => void) | null = null;
    // ⚠️ api / 回调定义在 Probe 外（身份一变 effect 重跑 → 轮询重置）
    const api = {
        siteChanges: async (since?: string) => {
            sinceSeen.push(since);
            const deleted = opts.deleted[round] ?? [];
            round += 1;
            calls += 1;
            await new Promise<void>(r => {
                release = r;
            });
            return { deleted, since: `2026-01-01 00:00:${String(round).padStart(2, "0")}` };
        },
    };
    const removeSitesLocally = (ids: number[]) => removed.push(ids);
    const onNotify = (m: string) => notifies.push(m);
    function Probe() {
        useSiteSync({
            api,
            enabled: true,
            removeSitesLocally,
            onNotify,
            firstDelayMs: 5,
            intervalMs: 5,
        });
        return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<Probe />);
    });

    /** 等第 n 轮轮询挂到闸上，然后放行并等这轮处理完（含 setState） */
    async function step(n: number) {
        const deadline = Date.now() + 2000;
        while (calls < n || release === null) {
            if (Date.now() > deadline) throw new Error(`轮询没到第 ${n} 轮（当前 ${calls}）`);
            await sleep(1);
        }
        const r = release;
        release = null;
        await act(async () => {
            r?.();
            await sleep(5);
        });
    }

    return {
        notifies,
        sinceSeen,
        removed,
        get calls() {
            return calls;
        },
        step,
    };
}

test("首轮（游标为空）只建基线：有删除也只应用、不提示", async () => {
    setActiveAccount(1);
    const h = await mountSync({ deleted: [[1, 2]] });
    await h.step(1);
    assert.deepEqual(h.removed.flat(), [1, 2], "删除要应用到本地（历史墓碑兜底摘除）");
    assert.deepEqual(
        h.notifies.filter(m => m.includes("其它设备删除了")),
        [],
        "首轮不应弹「其它设备删除了 N 张卡片」",
    );
});

test("游标持久化：重新挂载后接着上次的游标增量轮询", async () => {
    setActiveAccount(1);
    const first = await mountSync({ deleted: [[1]] });
    await first.step(1);
    act(() => root!.unmount());
    root = null;

    // 重新挂载（模拟刷新页面）：siteChanges 收到的 since 必须是持久化的值。
    // 第二挂载没有任何新删除 → 不应再有提示（修复前游标丢失会全量重放墓碑，
    // 把第一次挂载已见过的删除再弹一遍）
    const second = await mountSync({ deleted: [[]] });
    await second.step(1);
    assert.equal(
        second.sinceSeen[0],
        "2026-01-01 00:00:01",
        "刷新后首轮应携带持久化游标（不再全量重放）",
    );
    assert.ok(
        !second.notifies.some(m => m.includes("其它设备删除了")),
        "没有新删除就不应再弹提示（修复前每次刷新都弹）",
    );
});

test("本设备自己删的卡片不弹「其它设备删除了」", async () => {
    setActiveAccount(1);
    const h = await mountSync({ deleted: [[], [7, 8]] });
    await h.step(1); // 第一轮空跑：建基线，游标落地
    markLocalSiteDeletes([7]); // 轮询间隙里用户删了卡片 7（删除成功时已埋点）
    await h.step(2); // 第二轮：变更窗口命中 7（自己的）和 8（外部的）
    const tips = h.notifies.filter(m => m.includes("其它设备删除了"));
    assert.equal(tips.length, 1, "只有外部删除（8）才提示");
    assert.ok(tips[0].includes("1 张"), "提示数量是过滤后的 1 张，不是 2 张");
    assert.deepEqual(h.removed.flat(), [7, 8], "应用删除不过滤（本地没有的 id 无操作）");
});
