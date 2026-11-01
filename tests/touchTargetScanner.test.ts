// tests/touchTargetScanner.test.ts
// 触控目标扫描器自身的守卫。
//
// 为什么需要它（2026-11-01）：同一份代码在本机 24.00、在 CI 被判「小于 24px」，
// 而**日志里打印的还是「24×24」** —— 判据比的是原始浮点，打印用的是取整，
// 两个数字不是同一个。浏览器布局单位是 LayoutUnit（1/64 px）叠加 DPR 贴齐，
// 24px 的盒子报成 23.98 完全正常，这不是缺陷而是渲染精度。
//
// 修法有两半，缺一不可：
//   ① 判据留亚像素容差（否则换个环境就假红，而「假红」会训练人忽略门禁）；
//   ② 打印被**判定**的那个数（否则红了你也没法从日志复现，只能重跑赌运气）。
// 这里把两半都钉住：容差被谁删掉、打印被谁改回取整，都必须红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，这里逐级向上找真正的脚本 */
function findScript(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, "script/a11y-audit.mjs"), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到 script/a11y-audit.mjs");
}
const src = findScript();

test("触控扫描器：24px 底线要留亚像素容差（否则换环境就假红）", () => {
    assert.match(
        src,
        /r\.height\s*<\s*24\s*-\s*EPS\s*\|\|\s*r\.width\s*<\s*24\s*-\s*EPS/,
        "24px 的判据退回了裸比较 `r.height < 24`：浏览器布局单位是 1/64 px，" +
            "24.00 在别的 Chrome/DPR 下会报成 23.98，门禁会随机假红一次"
    );
    assert.match(src, /const\s+EPS\s*=\s*0\.5/, "EPS 容差被删了或改了值（0.5 是刻意的：远大于舍入误差、远小于真实尺寸差）");
});

test("触控扫描器：打印的必须是被判定的那个数（不能一边取整一边比浮点）", () => {
    assert.match(
        src,
        /w:\s*\+r\.width\.toFixed\(2\)/,
        "打印宽度退回取整了：日志里会出现「打印 24、却判小于 24」这种没法复现的结论"
    );
    assert.match(src, /h:\s*\+r\.height\.toFixed\(2\)/, "打印高度退回取整了");
    assert.ok(
        !/w:\s*Math\.round\(r\.width\)/.test(src),
        "又用 Math.round 打印宽度了 —— 判据比浮点、打印取整，两个数字对不上"
    );
});

test("触控扫描器：提示档（24~31）与硬失败用同一把尺子", () => {
    assert.match(
        src,
        /r\.height\s*<\s*32\s*-\s*EPS\s*\|\|\s*r\.width\s*<\s*32\s*-\s*EPS/,
        "提示档没跟着用 EPS：会出现「既不算硬失败、也不算提示档」的黑洞区间"
    );
});
