// tests/focusRingScanner.test.ts
// 「焦点环看得见」这条判据的守卫（2026-11-01）。
//
// 为什么需要它：以前 `a11y-audit.mjs` 只判「有没有环」（outlineWidth>0 或
// boxShadow≠none）。可 WCAG 1.4.11 要的是**非文本对比 ≥ 3:1** —— 一圈与底色
// 几乎同色的细环，对键盘用户等于没有。这两件事的差别是「有环」和「环看得见」，
// 少了对比度这一半，审计会在环变淡时保持全绿。
//
// 同一条铁律：判据被删掉 / 被放宽时，审计只会变绿不会变红 —— 它自己发现不了。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function readScript(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

const src = readScript("script/a11y-audit.mjs");

test("焦点环：环色要按它自己的 alpha 混到身后底色上（不能当纯色算）", () => {
    assert.match(src, /const ringOf = raw =>/, "ringOf 被删了：焦点环又回到「只判有没有」");
    const body = src.slice(src.indexOf("const ringOf = raw =>"), src.indexOf("need: 3"));
    assert.ok(body.length > 30, "ringOf 函数体没截出来，守卫等于空转");
    assert.match(body, /NH\.alphaOf\(raw\)/, "没读环色自身的 alpha：rgba 半透明环会被算成纯色，比值虚高");
    assert.match(
        body,
        /v \* a \+ bg\[k\] \* \(1 - a\)/,
        "环色没往背景上混 —— 半透明环（比如主色 40%）必须混算，否则假绿"
    );
    assert.match(body, /NH\.bgBehind\(/, "背景没走 NH.bgBehind：环压在哪层底上会算错");
});

test("焦点环：判据是 3:1（WCAG 1.4.11 非文本对比），不是随手指定的数", () => {
    assert.match(src, /need: 3\b/, "ring.need 不是 3 了：非文本对比的线就是 3:1");
    assert.match(
        src,
        /f\.ring\.ratio < f\.ring\.need/,
        "首页没有拿 ring.ratio 跟 need 比：这一半判据等于没接上"
    );
    assert.match(src, /notesDimRing/, "记事本的焦点环对比度没接进判据（首页有、记事本没有）");
});

test("焦点环：输入框认聚焦边框，环色取 fieldset 的边框色", () => {
    // 输入框刻意不补外圈 outline（会与 MUI 聚焦边框叠成双红圈），
    // 它的焦点指示是「边框 1px 灰 → 2px 主色」。环色必须取 fieldset，
    // 否则这一类的 ring 恒为 null —— 判据对输入框就永远不生效。
    assert.match(
        src,
        /ring: via === 'focus-border' && fs \? ringOf\(getComputedStyle\(fs\)\.borderTopColor\) : null/,
        "输入框的环色没取 fieldset 边框色：整类输入框的焦点环对比度会静默漏测"
    );
});

test("焦点环：数学核心与对比度审计共用一份（不许在这里另写一套）", () => {
    assert.match(
        src,
        /import \{[^}]*CONTRAST_CORE[^}]*\} from "\.\/auditEnv\.mjs"/s,
        "a11y-audit.mjs 没引用 CONTRAST_CORE：环色比值与文字比值会各算一套，早晚漂开"
    );
    assert.match(src, /\$\{CONTRAST_CORE\}/, "SCAN_FOCUS 里没注入 CONTRAST_CORE");
});
