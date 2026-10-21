// tests/motionTokenGuard.test.ts
// A6「过渡动效规范化」的守卫（2026-10-22）。
//
// 背景：index.css 里散着 0.18s / 0.22s / 0.12s / 120ms 四五种「差不多」的时长，
// 同一个 hover 在不同组件里差 40ms 没人看得出来，但**同一个组件里两处差 40ms**
// 就会显得一顿一顿（卡片边框与阴影各走各的）。现在收成三档 token：
//   --dur-fast 130ms（纯视觉反馈）/ --dur-base 220ms（默认）/ --dur-slow 320ms（大面积）
//   --ease-out（进场）/ --ease-in-out（来回）
//
// 守卫钉两件事：
//   1. token 块必须完整（少一个，用它的地方会静默退化成「无过渡」——
//      var(--dur-slow) 取不到时整条 transition 声明无效，元素直接跳变）；
//   2. index.css 里不许再有硬编码的过渡时长。
//      ⚠️ 例外：backdrop-filter 那几处刻意写 0s —— 那个属性参与补间就会逐帧
//      重采样背后的像素，圆角边采样补不齐会透出一圈暗边（2026-10 修过的「外圈变黑」）。
//
// ⚠️ 只比字符串，别把 DOM 元素塞进断言失败路径（node:assert 会 util.inspect 它，
//    2026-10-21 踩过进程堆被打爆）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { projectDir as findProjectDir } from "./helpers/notesSource";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = () => findProjectDir(here);
const css = () => readFileSync(resolve(projectDir(), "src", "index.css"), "utf8");

/**
 * 取出**动效 token 所在的那个** :root 块。
 * ⚠️ 不能取第一个 :root —— 文件里 :root 出现多处（滚动条变量就是单独一块），
 *    取第一个会得到滚动条那块，于是「token 都在」这条断言永远是假的。
 */
function tokenBlock(): string {
    const src = css();
    let from = 0;
    while (true) {
        const i = src.indexOf(":root", from);
        if (i < 0) return "";
        const open = src.indexOf("{", i);
        let depth = 0;
        let end = src.length;
        for (let j = open; j < src.length; j++) {
            if (src[j] === "{") depth++;
            else if (src[j] === "}") {
                depth--;
                if (depth === 0) {
                    end = j;
                    break;
                }
            }
        }
        const block = src.slice(open + 1, end);
        if (block.includes("--dur-")) return block;
        from = end;
    }
}

test("动效 token 三档时长 + 两条曲线都在", () => {
    const root = tokenBlock();
    for (const name of ["--dur-fast", "--dur-base", "--dur-slow", "--ease-out", "--ease-in-out"]) {
        assert.match(root, new RegExp(`${name}\\s*:`), `:root 里要定义 ${name}`);
    }
    // 取值本身也要对：这是「成文」的一部分，改档必须同步改注释与文档
    assert.match(root, /--dur-fast:\s*130ms/, "fast = 130ms（纯视觉反馈）");
    assert.match(root, /--dur-base:\s*220ms/, "base = 220ms（默认档）");
    assert.match(root, /--dur-slow:\s*320ms/, "slow = 320ms（大面积/长距离）");
});

test("index.css 的 transition 不再写硬编码时长", () => {
    const src = css();
    const decls = [...src.matchAll(/transition:[^;{}]*;/g)].map(m => m[0]);
    const offenders = decls.filter(d => /(?<!var\()\b\d+(\.\d+)?(ms|s)\b/.test(d) && !/\b0s\b/.test(d));
    assert.equal(
        offenders.length,
        0,
        `这些 transition 还在写死时长，应改用 var(--dur-*): ${offenders.slice(0, 5).join(" | ")}`
    );
    // 反向验证：守卫本身要真能抓到硬编码（换个写法再验一次）
    const probe = "transition: opacity 0.18s ease;";
    assert.equal(
        /(?<!var\()\b\d+(\.\d+)?(ms|s)\b/.test(probe),
        true,
        "正则要能抓到硬编码时长，否则这条守卫是假的"
    );
});

test("减弱动效：全局压过渡，而不是每条各写一遍", () => {
    const src = css();
    assert.match(src, /prefers-reduced-motion:\s*reduce/, "要有减弱动效的媒体查询");
    const i = src.indexOf("prefers-reduced-motion: reduce");
    const block = src.slice(i, i + 700);
    assert.match(block, /transition-duration/, "要把 transition-duration 压到近乎瞬时");
});
