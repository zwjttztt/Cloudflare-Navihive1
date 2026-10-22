// tests/visualRegressionGuard.test.ts
// 视觉回归（script/visual-regression.mjs + tests/visual-baseline/*.json）的守卫。
//
// 这个工具的价值全在「它报的差异是真的」。三种坏法必须提前钉住：
//   1. 脚本写库了 —— 那就不是只读探针，线上跑一次就是事故（与 prod-smoke 同款底线）；
//   2. 采了会自己抖的字段（opacity 的动画中间值）—— 同一份代码连跑两次也红，
//      于是没人信它，最后整条被关掉（实测过：差 0.03 就九个用例全飘红）；
//   3. 用了不稳定的选择器（emotion 生成的随机 class）—— 下次构建名字一变，
//      采到的元素个数从 3 变 0，报的全是噪音。
// 剥注释 + 反向验证（注释里写正确写法不算数）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function projectDir(): string {
    let dir = HERE;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        dir = path.dirname(dir);
    }
    throw new Error("找不到项目根目录");
}

const ROOT = projectDir();
const SCRIPT = path.join(ROOT, "script", "visual-regression.mjs");
const BASELINE_DIR = path.join(ROOT, "tests", "visual-baseline");

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const scriptSrc = () => stripComments(fs.readFileSync(SCRIPT, "utf8"));

test("只读：不写库、不带凭据（它会对着线上 URL 跑）", () => {
    const src = scriptSrc();
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
        assert.doesNotMatch(
            src,
            new RegExp(`method:\\s*"${verb}"`),
            `脚本里出现了 ${verb} 请求 —— 视觉回归必须是只读的`,
        );
    }
    for (const needle of ["Authorization", "Bearer", "AUTH_PASSWORD", "AUTH_SECRET", "secrets."]) {
        assert.ok(!src.includes(needle), `脚本里出现了 ${needle} —— 只读探针不该碰凭据`);
    }
});

test("不采 opacity：入场动画的中间值会让同一份代码连跑两次也红", () => {
    const src = scriptSrc();
    // 反向验证：注释里解释「为什么不采 opacity」是允许的，代码里真采了就不行
    assert.doesNotMatch(src, /cs\.opacity/, "采了 opacity —— 淡入动画每帧都不同，稳定的假红");
    assert.doesNotMatch(src, /opacity:\s*cs\./, "采了 opacity —— 同上");
});

test("选择器必须是在 index.css 里定义过的语义 class（emotion 随机 class 会随构建漂移）", () => {
    const src = scriptSrc();
    const block = src.match(/const BASE_SELECTORS = \[([\s\S]*?)\]/)?.[1] ?? "";
    const selectors = [...block.matchAll(/"(\.[a-z0-9-]+)"/gi)].map(m => m[1]);
    assert.ok(selectors.length >= 8, `只解析出 ${selectors.length} 个选择器（正则没匹配上？）`);

    const css = stripComments(fs.readFileSync(path.join(ROOT, "src", "index.css"), "utf8"));
    for (const sel of selectors) {
        assert.ok(
            new RegExp(`(^|[\\s,{}])${sel.replace(".", "\\.")}([\\s,{:.]|$)`).test(css),
            `${sel} 在 src/index.css 里没有定义 —— 换个稳定的语义 class`,
        );
    }
});

test("基线齐备且内容真实（全是空指纹的基线等于没有基线）", () => {
    assert.ok(fs.existsSync(BASELINE_DIR), "没有 tests/visual-baseline（先跑 npm run audit:visual -- --update）");
    const files = fs.readdirSync(BASELINE_DIR).filter(f => f.endsWith(".json"));
    assert.ok(files.length >= 9, `基线只有 ${files.length} 个文件（3 视口 × 3 场景 = 9）`);

    for (const f of files) {
        const fp = JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, f), "utf8"));
        assert.ok(fp.counts && typeof fp.counts.buttons === "number", `${f} 缺 counts`);
        assert.ok(
            fp.counts.buttons > 0 && fp.counts.cards > 0,
            `${f} 量到 0 个按钮 / 卡片 —— 那是骨架态，基线是假的`,
        );
        const measured = Object.values(fp.elements ?? {}).filter(
            (v): v is unknown[] => Array.isArray(v) && v.length > 0
        );
        assert.ok(measured.length >= 5, `${f} 只采到 ${measured.length} 类元素（选择器漂了？）`);
    }
});

test("深浅两档都录了：暗色 token 漏覆盖正是这类回归的典型", () => {
    const files = fs.readdirSync(BASELINE_DIR).filter(f => f.endsWith(".json"));
    const dark = files.filter(
        f => JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, f), "utf8")).dark === true
    );
    const light = files.filter(
        f => JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, f), "utf8")).dark === false
    );
    assert.ok(dark.length >= 3, `暗色基线只有 ${dark.length} 个（每个视口都该有一档）`);
    assert.ok(light.length >= 3, `亮色基线只有 ${light.length} 个`);
});
