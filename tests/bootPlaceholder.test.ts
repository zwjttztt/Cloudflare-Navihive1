// tests/bootPlaceholder.test.ts
// index.html 里那段「HTML 一到就画出来」的启动占位的静态守卫。
//
// 为什么值得单测：这段东西只在「首屏 JS 还没下载完 / 根本没下载下来」时有意义 ——
// 那是所有常规用例都碰不到的现场（React 都没挂载）。改坏了没人会立刻发现，
// 用户却在弱网下先看到几秒白屏或一屏假卡片。
//
// 两条历史教训钉在这里：
//   1. 2026-10-29：这段占位是「React 挂没挂载」的判据（public/boot-guard.js 按
//      id="boot-skeleton" 找它，15 秒还在就清缓存 + 注销 SW + 刷新一次；
//      src/main.tsx 也按同一个 id 挂载后删除）。id 被谁顺手改个名，
//      两条自救链路会同时静默失效 —— 所以下面第一条用例盯着 id 与 aria-hidden。
//   2. 2026-11-06：用户反馈弱网下先看到一屏**假卡片**、再跳成转圈，观感像
//      「内容已经在加载了其实没有」。占位已改成「只给一个转圈」，
//      下面第二条用例防回潮：谁把 .bs-card / .bs-bar 那套骨架贴回来，立刻红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function readProjectFile(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

const HTML = readProjectFile("index.html");

/** 只取 <style> 块，避免把 JS 注释 / meta 里的同名字符串误当样式断言 */
function styleBlock(): string {
    const match = /<style>([\s\S]*?)<\/style>/u.exec(HTML);
    assert.ok(match, "index.html 里应当还有一段内联 <style>（启动占位靠它同帧画出来）");
    return match[1];
}

test("启动占位的 id 与 aria-hidden 一个都不能变（boot-guard 与 main.tsx 都按它找活）", () => {
    // boot-guard.js 的 SKELETON_ID = "boot-skeleton"：15 秒后还能 getElementById 到它，
    // 就判定「React 没挂载」，清缓存 + 注销 SW + 刷新一次。
    assert.match(
        HTML,
        /id="boot-skeleton"/u,
        "⛔ 这个 id 是首屏自救链路的判据（public/boot-guard.js 的 SKELETON_ID），不能改名"
    );
    assert.match(
        HTML,
        /id="boot-skeleton"[^>]*aria-hidden="true"/u,
        "占位纯装饰、无文本可读，必须 aria-hidden —— 否则读屏会念出一个空节点"
    );
    // main.tsx 的 requestAnimationFrame 里也按同一个 id 删节点
    const main = readProjectFile("src/main.tsx");
    assert.match(
        main,
        /getElementById\("boot-skeleton"\)/u,
        "main.tsx 挂载后要按 boot-skeleton 删掉占位，改 id 会让它永远压在界面下面"
    );
});

test("不再有假卡片骨架（2026-11-06 用户反馈：弱网下先看到假卡片，观感像已经在加载）", () => {
    const css = styleBlock();
    for (const dead of ["bs-card", "bs-bar", "bs-title", "bs-shimmer", "bs-grid", "bs-dot", "bs-search", "bs-sweep"]) {
        assert.ok(
            !css.includes(dead),
            `⛔ 样式里还有 .${dead} —— 2026-11-06 起启动占位只给一个转圈，别把骨架贴回来`
        );
        assert.ok(
            !HTML.includes(`class="bs-` + dead) && !new RegExp(`class="[^"]*\\b${dead}\\b`, "u").test(HTML),
            `⛔ 标记里还有 ${dead} —— 假卡片会让用户以为内容在加载`
        );
    }
});

test("启动占位是一个居中、indeterminate 旋转的圆环", () => {
    const css = styleBlock();
    assert.ok(
        /<div id="boot-skeleton" aria-hidden="true">\s*<div class="bs-spinner"><\/div>\s*<\/div>/u.test(HTML),
        "body 里应当只有「占位容器 + 一个 .bs-spinner」这层结构"
    );
    assert.match(css, /#boot-skeleton \.bs-spinner\s*\{/u, "缺 .bs-spinner 的样式");
    assert.match(css, /@keyframes bs-spin\s*\{/u, "缺 bs-spin 关键帧，转圈不会转");
    // 尺寸/节奏与 MUI CircularProgress 默认值对齐（40px / 0.9s 线性）：
    // 两边一致才不会在 React 接管的瞬间跳一下
    assert.match(css, /\.bs-spinner[^}]*width:\s*40px/u, "直径要 40px，与 CircularProgress 默认值一致");
    assert.match(css, /\.bs-spinner[^}]*animation:\s*bs-spin\s+0\.9s\s+linear\s+infinite/u, "0.9s 线性无限旋转，对齐 MUI 默认节奏");
    // 居中：容器自己就是居中盒，别指望内层元素自己定位
    assert.match(css, /#boot-skeleton\s*\{[^}]*display:\s*flex/u, "占位容器要是 flex 容器");
    assert.match(css, /#boot-skeleton\s*\{[^}]*justify-content:\s*center/u, "转圈要水平居中");
    assert.match(css, /#boot-skeleton\s*\{[^}]*align-items:\s*center/u, "转圈要垂直居中");
    // 「避免白屏」仍是这段存在的唯一理由：底色必须在
    assert.match(css, /#boot-skeleton\s*\{[^}]*background:\s*var\(--bs-bg\)/u, "占位必须自带底色，否则白屏照旧");
});

test("主题跟随与「减少动效」都还在（存过主题时以用户存的为准）", () => {
    const css = styleBlock();
    assert.match(css, /@media \(prefers-color-scheme: dark\)/u, "系统深色下要换成深底+浅色圆环");
    assert.match(
        css,
        /html\[data-boot-theme="dark"\] #boot-skeleton/u,
        "用户存过深色时以 data-boot-theme 为准（它的优先级比 @media 那条高）"
    );
    assert.match(
        css,
        /html\[data-boot-theme="light"\] #boot-skeleton/u,
        "用户存过浅色时同理 —— 存的是 system 时 head 里那段脚本不写属性"
    );
    // 晕动症：系统要求减少动效时不能还在转
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u, "缺 prefers-reduced-motion 分支");
    assert.match(
        css,
        /@media \(prefers-reduced-motion: reduce\)\s*\{\s*#boot-skeleton \.bs-spinner\s*\{\s*animation:\s*none;?\s*\}\s*\}/u,
        "减少动效时要停掉旋转，只留静态圆环"
    );
});
