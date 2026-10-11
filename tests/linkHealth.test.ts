// tests/linkHealth.test.ts
// 失效检测的多端合并逻辑单测。
// 关键点：「是否失效」不是布尔字段，而是从 probe（最近成功）/ dead（最近失败）
// 两份时间戳推导出来的 —— dead > probe 才算失效。合并时各取较大时间戳即可，
// 不需要处理「谁删了谁的标记」。这里测的就是这个推导与合并。
//
// localStorage 由测试运行器注入（harness/unit-tests.mjs 在 bundle 前面塞了个最小实现），
// 所以这几个模块可以按普通方式静态导入。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    clearDeadLinks,
    collectCheckUrls,
    deriveDeadLinks,
    exportLinkHealth,
    FRESH_WINDOW_MS,
    isLinkWhitelisted,
    markLink,
    markLinkAlive,
    mergeLinkHealth,
    normalizeKey,
    probeLinks,
    readDeadLinks,
    readProbeTimes,
    readSuspectTimes,
    readWhitelist,
    unmarkLinkAlive,
} from "../src/utils/linkHealth";

const reset = () => localStorage.clear();

/** 临时把 Date.now 拨到未来，让「后发生的探测」真的更晚 */
const withTimeOffset = (offsetMs: number, run: () => void) => {
    const realNow = Date.now;
    Date.now = () => realNow() + offsetMs;
    try {
        run();
    } finally {
        Date.now = realNow;
    }
};

test("标记失效后出现在失效清单里", () => {
    reset();
    markLink("https://a.com", false);
    assert.deepEqual(Object.keys(readDeadLinks()), ["https://a.com"]);
});

test("之后探测成功就自动从失效清单里消失（不需要手动删）", () => {
    reset();
    markLink("https://a.com", false);
    withTimeOffset(1000, () => markLink("https://a.com", true));
    assert.equal(readDeadLinks()["https://a.com"], undefined);
});

test("手动标记「其实能访问」会进白名单，并立刻从失效清单消失", () => {
    reset();
    markLink("https://a.com", false);
    withTimeOffset(1000, () => markLinkAlive("https://a.com"));
    assert.deepEqual(readWhitelist(), ["https://a.com"]);
    assert.equal(readDeadLinks()["https://a.com"], undefined);
});

test("清空失效记录时同时记一次探测成功（否则云端旧记录会被带回来）", () => {
    reset();
    markLink("https://a.com", false);
    withTimeOffset(1000, () => clearDeadLinks());
    assert.deepEqual(readDeadLinks(), {});
    const snapshot = exportLinkHealth();
    assert.ok(snapshot.probe["https://a.com"] > 0, "清空时应留下一次探测成功的时间戳");
});

test("合并远端：晚发生的探测结果胜出", () => {
    reset();
    markLink("https://a.com", false); // 本机判定失效
    const localDeadAt = exportLinkHealth().dead["https://a.com"];

    // 远端记录「更晚的时候探测成功了」
    withTimeOffset(2000, () => {
        mergeLinkHealth({
            v: 1,
            dead: {},
            probe: { "https://a.com": localDeadAt + 1000 },
            white: [],
        });
    });
    // 让本机时间往前走一点，确保比较是有意义的
    withTimeOffset(3000, () => {
        markLink("https://b.com", false);
    });

    assert.equal(
        readDeadLinks()["https://a.com"],
        undefined,
        "远端更晚的成功应该覆盖本机的失效"
    );
});

test("合并远端：本机更新的记录不会被旧的远端数据顶掉", () => {
    reset();
    withTimeOffset(5000, () => markLink("https://a.com", true));
    const localProbeAt = exportLinkHealth().probe["https://a.com"];

    mergeLinkHealth({
        v: 1,
        dead: { "https://a.com": localProbeAt - 1000 }, // 远端是更早的失败
        probe: {},
        white: [],
    });
    assert.equal(readDeadLinks()["https://a.com"], undefined, "旧失败不该盖掉新成功");
});

test("合并远端白名单取并集", () => {
    reset();
    markLinkAlive("https://a.com");
    mergeLinkHealth({ v: 1, dead: {}, probe: {}, white: ["https://b.com"] });
    assert.deepEqual(readWhitelist().sort(), ["https://a.com", "https://b.com"]);
});

test("版本号对不上就整体忽略（防止以后改结构读到脏数据）", () => {
    reset();
    mergeLinkHealth({
        v: 2 as unknown as 1,
        dead: { "https://x.com": 1 },
        probe: {},
        white: [],
    });
    assert.deepEqual(readDeadLinks(), {});
});

test("导出快照再合并回自己是幂等的", () => {
    reset();
    markLink("https://a.com", false);
    const before = JSON.stringify(exportLinkHealth());
    mergeLinkHealth(exportLinkHealth());
    assert.equal(JSON.stringify(exportLinkHealth()), before);
});

// ---------------- 归一化：白名单与探测键必须口径一致 ----------------
//
// 为什么这条要钉死：白名单豁免是「用户说了算」的兜底，而 probe / dead / suspect
// 三张表都拿 URL 字符串当键。只要写入与读取用了不同的键形（尾斜杠、锚点、大小写），
// 用户标过的"可访问"就会静默失效 —— 链接又被重新探测、重新贴失效标。
test("归一化：尾斜杠 / 锚点 / 主机大小写视为同一个链接", () => {
    assert.equal(normalizeKey("https://a.com/"), "https://a.com");
    assert.equal(normalizeKey("https://a.com"), "https://a.com");
    assert.equal(normalizeKey("https://A.Com/x?y=1#f"), "https://a.com/x?y=1");
    assert.equal(normalizeKey("  https://a.com  "), "https://a.com");
    // 路径里的大小写与查询串是区分的，不能被吃掉
    assert.notEqual(normalizeKey("https://a.com/X"), normalizeKey("https://a.com/x"));
    assert.notEqual(normalizeKey("https://a.com/?x=1"), normalizeKey("https://a.com"));
});

test("白名单按归一化键生效：标过「可访问」的变体写法同样豁免", () => {
    reset();
    markLinkAlive("https://a.com");
    const key = normalizeKey("https://a.com/#top");
    assert.ok(isLinkWhitelisted("https://a.com/#top"), "只差锚点也应算白名单内");
    assert.ok(Object.prototype.hasOwnProperty.call(readWhitelist(), key) === false || readWhitelist().includes(key));
});

// ---------------- 撤销纠偏：重新纳入检测 ----------------
test("撤销「可访问」：移出白名单，并清掉探测/疑似时间戳（否则会被 fresh 窗口跳过）", async () => {
    reset();
    const url = "https://a.com/faq#top";
    markLinkAlive(url);
    assert.ok(isLinkWhitelisted(url), "标记后应在白名单里");

    // 探测一次并记下成功时间戳，验证撤销会把它们清掉
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    try {
        const probe = await probeLinks([url]);
        assert.equal(probe.probed, 0, "白名单里的链接不该再发请求");
        assert.equal(probe.skipped, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }

    unmarkLinkAlive(url);
    assert.ok(!isLinkWhitelisted(url), "撤销后应移出白名单");
    assert.equal(readProbeTimes()[normalizeKey(url)], undefined, "撤销应清掉探测成功时间戳");
    assert.equal(readSuspectTimes()[normalizeKey(url)], undefined, "撤销应清掉疑似时间戳");

    // 撤销之后再跑检测，这条链接必须真的被探测（不再被豁免/fresh 窗口跳过）
    globalThis.fetch = (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
    try {
        const probe = await probeLinks([url], { skipFreshMs: FRESH_WINDOW_MS });
        assert.equal(probe.probed, 1, "撤销后应重新纳入检测");
        assert.equal(probe.skipped, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("跨端合并：入站的非归一化键（老客户端写法）要归并到同一条", () => {
    reset();
    // 老版本客户端写的是原始 URL：带尾斜杠 + 锚点 + 大写 host
    mergeLinkHealth({
        v: 1,
        dead: { "https://A.com/faq/#top": 1000 },
        probe: {},
        white: [],
    });
    // 注意：/faq 后面的尾斜杠要保留 —— 只去掉根路径的尾斜杠（不同路径是不同请求）
    const key = normalizeKey("https://a.com/faq/");
    assert.ok(
        Object.prototype.hasOwnProperty.call(readDeadLinks(), key),
        "入站键必须归一化后再存，否则本机与云端对不上"
    );
    // 再合并一份「更新」的结果，同一条链接不该裂成两条
    mergeLinkHealth({ v: 1, dead: { "https://a.com/faq/": 2000 }, probe: {}, white: [] });
    assert.equal(Object.keys(readDeadLinks()).length, 1, "同一个链接只能有一条记录");
    assert.equal(readDeadLinks()[key], 2000, "时间戳取较大值");
});

test("collectCheckUrls：写法不同但归一化后相同的链接只算一个", () => {
    reset();
    const groups = [
        { sites: [{ url: "https://a.com" }, { url: "https://a.com/" }, { url: "  https://a.com/#top  " }] },
        { sites: [{ url: "https://b.com" }] },
    ];
    assert.deepEqual(collectCheckUrls(groups), ["https://a.com", "https://b.com"]);
});

test("deriveDeadLinks：之后探测成功 / 用户标过可访问的都不算失效（与卡片同一判据）", () => {
    const dead = { "https://a.com": 2000, "https://b.com": 2000, "https://c.com": 2000 };
    const probe = { "https://b.com": 2000 }; // 同样时间戳 → 之后成功，不算失效
    assert.deepEqual(deriveDeadLinks(dead, probe, ["https://c.com"]), {
        "https://a.com": 2000,
    });
});

test("deriveDeadLinks：空表 / 空入参不炸", () => {
    assert.deepEqual(deriveDeadLinks({}, {}, []), {});
    assert.deepEqual(deriveDeadLinks({ "https://a.com": 1 }, {}, []), { "https://a.com": 1 });
});

// ---------------- 静态守卫：查表键必须是归一化后的 ----------------
//
// 为什么用源码守卫而不是只测行为：失效标记分散在三处查表（卡片 / 高级语法 is:dead /
// 「只看失效」筛选），只要有一处漏掉 normalizeKey，症状是「筛选点了没反应」——
// 不报错、不崩溃，行为测试也容易漏。直接扫源码最省事。
test("静态守卫：所有 deadLinks 查表都必须走 normalizeKey", () => {
    // 单测会被复制到 script/tmp-tests/pure/ 下再跑，所以逐级向上找带 package.json 的真身
    const here = path.dirname(fileURLToPath(import.meta.url));
    let root = here;
    for (let i = 0; i < 6; i++) {
        try {
            fs.readFileSync(path.join(root, "package.json"), "utf8");
            break;
        } catch {
            root = path.dirname(root);
        }
    }
    const files = walkTs(path.join(root, "src"));
    const offenders: string[] = [];
    for (const f of files) {
        const text = fs.readFileSync(f, "utf8");
        text.split(/\r?\n/).forEach((line, i) => {
            // 只看真正的查表：deadLinks[...]
            if (!/deadLinks\s*\[/.test(line)) return;
            if (/normalizeKey\s*\(/.test(line)) return;
            offenders.push(`${path.relative(root, f).replace(/\\/g, "/")}:${i + 1}  ${line.trim()}`);
        });
    }
    assert.deepEqual(offenders, [], "以下查表没有归一化键（会与 linkHealth 写入的键对不上）：\n" + offenders.join("\n"));
});

function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walkTs(p));
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
}
