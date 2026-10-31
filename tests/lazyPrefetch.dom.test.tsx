// tests/lazyPrefetch.dom.test.tsx
//
// 2026-10-17 首开延迟排查的修复件守卫：
// 「设置」菜单 / 卡片菜单 / 各弹窗全是条件挂载的 lazy 块，首次点击要现场
// 下载块，慢链路上数秒空窗且毫无反馈（用户实测「首次点击反馈延迟很久、关闭后
// 再次打开才恢复正常」）。修复是三层预取（同日用户要求去除 LazyFallback 转圈，
// ChunkBoundary fallback 已回退为 null，不加回），这里把每层都钉住：
//   1. prefetchChunk 的幂等 / 失败重试语义（lazyPrefetch.ts）；
//   2. 静态守卫：三层挂载点（App 空闲预取 / HeaderActions 悬停 / 「设置」中心
//      挂载时预取目标弹窗 / SiteCard 卡片设置悬停）与 dialogChunks 只含动态 import。
//      （2026-10-29：MoreMenu 下拉菜单已被 NavigationCenterDialog 取代，
//       这一层守卫跟着换到新文件，语义不变。）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { prefetchChunk, isPrefetched, prefetchOnIdle } from "../src/utils/lazyPrefetch";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const readSrc = (...parts: string[]) =>
    readFileSync(join(findProjectDir(), "src", ...parts), "utf8");

/** 剥注释（守卫扫源码的老规矩：注释里的示例代码不算实现） */
const strip = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

test("prefetchChunk：同 key 只取一次，失败后允许重试", async () => {
    let calls = 0;
    const load = () =>
        new Promise<unknown>((resolve, reject) => {
            calls += 1;
            if (calls === 1) reject(new Error("网络抖动"));
            else resolve({});
        });
    prefetchChunk("k1", load);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(calls, 1);
    assert.equal(isPrefetched("k1"), false, "失败要从集合里摘掉，允许重试");
    prefetchChunk("k1", load);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(calls, 2, "失败后的下一次调用要重新发起");
    assert.equal(isPrefetched("k1"), true);
    // 成功后同 key 不再重复取
    prefetchChunk("k1", load);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(calls, 2);
});

test("prefetchOnIdle：重复调度是幂等的，任务最终全部执行", async () => {
    // 没有 requestIdleCallback 的环境走 setTimeout 错峰
    let ran = "";
    prefetchOnIdle([
        ["t1", () => { ran += "1"; return Promise.resolve(); }],
        ["t2", () => { ran += "2"; return Promise.resolve(); }],
    ]);
    prefetchOnIdle([["t3", () => { ran += "3"; return Promise.resolve(); }]]);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(ran, "12", "第二次调度要被幂等吞掉；首个任务列表要全部跑完");
});

test("App：登录后有空闲预取，且覆盖「设置」菜单与常用弹窗", () => {
    const code = strip(readSrc("App.tsx"));
    assert.match(code, /prefetchOnIdle\(\[/, "App 要在登录后调度空闲预取");
    for (const key of [
        "navigationCenter", "siteCardContextMenu", "addSite", "siteSettings", "settings", "stats",
        "backup", "recycle", "confirm", "snackbar", "bulk", "aiSuggest", "deleteAccount",
        "tagBar", "siteSkeleton",
    ]) {
        assert.match(code, new RegExp(`\\["${key}", dialogChunks\\.${key}\\]`), `空闲预取清单缺 ${key}`);
    }
    assert.match(code, /if \(!isAuthenticated\) return;/, "访客视图不该预取管理弹窗");
});

test("HeaderActions：「设置」与「新增」按钮有悬停预取", () => {
    const code = strip(readSrc("components", "HeaderActions.tsx"));
    assert.match(code, /prefetchChunk\("navigationCenter", dialogChunks\.navigationCenter\)/);
    assert.match(code, /prefetchChunk\("addSite", dialogChunks\.addSite\)/);
});

test("「设置」中心：挂载时预取各面板的目标弹窗块", () => {
    const code = strip(readSrc("components", "NavigationCenterDialog.tsx"));
    assert.match(code, /useEffect\(\(\) => \{/, "预取要挂在中心挂载 effect 里");
    // editGroup 不在这张表里：原来菜单里的「新增分组」已归到顶栏主按钮，
    // 中心里没有对应的面板。
    for (const key of ["settings", "stats", "backup", "recycle", "audit", "aiAssistant", "account", "shortcuts"]) {
        assert.match(code, new RegExp(`prefetchChunk\\("${key}"`), `中心挂载预取缺 ${key}`);
    }
});

test("SiteCard：卡片设置按钮悬停预取 + 右键菜单展开预取目标弹窗", () => {
    const code = strip(readSrc("components", "SiteCard.tsx"));
    assert.match(code, /onPointerEnter=\{prefetchSiteSettings\}/);
    assert.match(code, /if \(menuPos !== null\) prefetchSiteSettings\(\);/, "右键菜单展开时要预取「编辑」的目标块");
});

test("dialogChunks：只允许动态 import（静态 import 会把全部弹窗焊回首屏）", () => {
    const code = strip(readSrc("utils", "dialogChunks.ts"));
    const staticImport = code.match(/import\s+[^;]*?from\s*["']\.\.\/components\//);
    assert.equal(
        staticImport,
        null,
        "dialogChunks.ts 里出现了对 components 的静态 import —— 这会把全部弹窗拖回首屏关键路径"
    );
    const dynamicCount = (code.match(/import\("\.\.\/components\//g) ?? []).length;
    assert.ok(dynamicCount >= 15, `动态预取入口应有 15+ 个，现在只有 ${dynamicCount}`);
});
