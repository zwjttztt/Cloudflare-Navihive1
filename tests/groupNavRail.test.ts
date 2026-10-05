// 分组锚点导航条（GroupNavRail）的展开行为。
//
// 踩过的坑：窄窗口下「展开」按钮是 **disabled** 的，tooltip 写着
// 「窗口再宽一点才能展开，否则会挡住卡片」。用户反馈就是「分组栏不能展开」——
// 按钮在那儿、鼠标放上去还有提示，就是点了没反应。
// 现在改成：任何宽度下都能展开，空间不够时把内容整体右移让出位置
// （往 body 上写 --nav-rail-push），而不是禁用按钮。
//
// 这里用静态源码守卫：rail 的可见性完全由 CSS 媒体查询决定（useMediaQuery），
// jsdom 里没有布局、算不出视口，渲染出来的分支恒定，测「点了会不会展开」没有意义。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const railSource = () =>
    readFileSync(join(findProjectDir(), "src", "components", "GroupNavRail.tsx"), "utf-8");
const appSource = () =>
    readFileSync(join(findProjectDir(), "src", "App.tsx"), "utf-8");

test("展开按钮不能是 disabled —— 窄窗口下也应该能展开", () => {
    const source = railSource();
    // 只盯收起态那一支里的展开按钮：它以前长这样
    //   <Tooltip title='窗口再宽一点才能展开…'><span><IconButton disabled …>
    assert.ok(
        !/aria-label='展开分组栏'[\s\S]{0,400}?\sdisabled/.test(source),
        "展开按钮又变回 disabled 了 —— 窄窗口下用户点了没反应，正是这次要修的毛病"
    );
    assert.ok(
        !source.includes("窗口再宽一点才能展开"),
        "还留着「窗口再宽一点才能展开」的提示 —— 说明走的是禁止展开那条路"
    );
});

test("展开按钮始终绑着 setRailCollapsed(false)", () => {
    const source = railSource();
    assert.match(
        source,
        /aria-label='展开分组栏'[\s\S]{0,400}?onClick=\{\(\) => setRailCollapsed\(false\)\}/,
        "收起态的展开按钮没有绑 setRailCollapsed(false)"
    );
});

test("空间不够时靠 --nav-rail-push 把内容让开，而不是禁用按钮", () => {
    const source = railSource();
    // 1) 有个根据「够不够宽」算出来的 pushing
    assert.match(
        source,
        /pushing\s*=\s*railVisible\s*&&\s*!railCollapsed\s*&&\s*!spaceForExpanded/,
        "找不到 pushing 的判定 —— 窄视口下靠什么决定要不要让内容？"
    );
    // 2) effect 把它写到 body 上，且卸载 / 不需要时清掉
    assert.match(
        source,
        /style\.setProperty\("--nav-rail-push"/,
        "没有往 body 上写 --nav-rail-push"
    );
    assert.match(
        source,
        /removeProperty\("--nav-rail-push"\)/,
        "没有清理 --nav-rail-push —— 收起分组栏后内容会一直偏着"
    );
});

test("内容区读 --nav-rail-push，并且保住原来的左边距", () => {
    const source = appSource();
    assert.match(
        source,
        /pl:\s*\{[\s\S]{0,300}?--nav-rail-push/,
        "Container 没有用 --nav-rail-push 调整左内边距 —— 展开后内容还是会被压住"
    );
    // 用 max() 而不是直接赋值：栏收起时变量不存在，必须退回原来 16/24/32 的左边距，
    // 否则这一处会把移动端布局挤窄。
    assert.match(source, /max\(var\(--nav-rail-push, 0px\)/, "左边距没用 max() 兜底，会挤窄移动端");
    for (const px of ["16px", "24px", "32px"]) {
        assert.ok(
            source.includes(`--nav-rail-push, 0px), ${px}`),
            `某个断点没有保住原来的 ${px} 左边距`
        );
    }
});
