// tests/syncNotifyGuard.test.ts
// 跨设备同步「误报提示」修复的静态守卫（2026-10-18 四连报）：
//   1. 每次刷新弹「其它设备删除了 N 张卡片」→ useSiteSync 游标持久化 + 首轮建基线；
//   2. 本设备删的卡片弹「其它设备删除了」→ client 删除成功埋点 + 提示前过滤；
//   3. 每次打开笔记弹「在其他设备被修改」→ useNotes 轮询按 rev 比对过滤本设备写入；
//   4. 右键笔记菜单关闭后残留白色圆圈（⋯ 按钮）→ 行内按钮显隐改 :has(:focus-visible)。
// 这几处都是「改提示逻辑」的小改动，重构时最容易被顺手删掉 —— 测试才是门槛。
// 剥注释 + 反向验证（注释里写正确写法不算数）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
    notesSource as notesSourceAll,
    projectDir as findProjectDir,
} from "./helpers/notesSource";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function projectDir(): string {
    return findProjectDir(here);
}

/** 剥掉块注释与整行行注释 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const readSrc = (rel: string) =>
    stripComments(readFileSync(resolve(projectDir(), rel), "utf8"));

/**
 * 前端 API 客户端的全部源码：client.ts + clientMethods/ 整个目录。
 *
 * ⚠️ 2026-10-22：client.ts 拆过了，业务方法体搬去了 src/API/clientMethods/*.ts。
 * 只读 client.ts 的话，搬走的方法就没人盯 —— 守卫会**假通过**（看着全绿其实没检查到）。
 * 与 tests/helpers/notesSource.ts 同样的教训：拆文件必须先查有没有守卫在扫老文件。
 */
function clientSource(): string {
    const dir = resolve(projectDir(), "src/API/clientMethods");
    const files = [
        "src/API/client.ts",
        ...readdirSync(dir)
            .filter(f => f.endsWith(".ts"))
            .map(f => `src/API/clientMethods/${f}`),
    ];
    return files.map(readSrc).join("\n");
}

test("useSiteSync：游标必须从 localStorage 恢复并随轮询落盘（否则每次刷新全量重放墓碑）", () => {
    const src = readSrc("src/hooks/useSiteSync.ts");
    assert.match(
        src,
        /useRef<string \| null>\(loadSiteSyncCursor\(\) \|\| null\)/,
        "sinceRef 的初值必须来自持久化游标",
    );
    assert.match(src, /saveSiteSyncCursor\(res\.since\)/, "每轮必须把新游标落盘");
    // 反向验证：剥注释后不允许还有写死的 5 秒首延迟以外的「纯内存游标」痕迹 ——
    // 即 sinceRef 初始化不得是字面量 null 而不带恢复
    assert.doesNotMatch(
        src,
        /useRef<string \| null>\(null\)/,
        "sinceRef 不得退化为纯内存态（刷新即丢）",
    );
});

test("useSiteSync：首轮（游标为空）只建基线不提示，且提示前必须过滤本设备删除", () => {
    const src = readSrc("src/hooks/useSiteSync.ts");
    assert.match(src, /firstRound/, "首轮判定必须存在");
    assert.match(
        src,
        /external\.length > 0 && !firstRound/,
        "提示条件必须带 !firstRound（历史墓碑不重弹）",
    );
    assert.match(src, /loadLocalSiteDeletes\(\)/, "提示前必须读本设备删除记录");
    assert.match(
        src,
        /res\.deleted\.filter\(id => !local\.has\(id\)\)/,
        "提示数量必须按过滤后的 external 计",
    );
});

test("client：单删/批删成功后必须记录本设备删除（防同步轮询误报）", () => {
    const src = clientSource();
    const deleteSite = src.match(/async deleteSite\([\s\S]*?\n\s{4}\}/)?.[0] ?? "";
    assert.match(deleteSite, /markLocalSiteDeletes\(\[id\]\)/, "单删成功后必须埋点");
    const deleteSites = src.match(/async deleteSites\([\s\S]*?\n\s{4}\}/)?.[0] ?? "";
    assert.match(deleteSites, /markLocalSiteDeletes/, "批删成功后必须埋点");
    assert.match(
        deleteSites,
        /result\.items\.map\(i => i\.id\)/,
        "批删只记 items 里真删掉的（failed 的不该记）",
    );
});

test("useNotes：轮询提示必须按 rev 比对过滤本设备写入（否则自己保存也弹「其他设备改的」）", () => {
    const src = readSrc("src/hooks/useNotes.ts");
    assert.match(
        src,
        /const knownRevs = new Map\(revById\.current\)/,
        "reload 前必须快照本设备已知 rev",
    );
    assert.match(
        src,
        /latest !== known/,
        "reload 后必须按 rev 变化判定外部变更",
    );
    assert.match(
        src,
        /setLastSyncChangedIds\(externalIds\)/,
        "喂给上层的必须过滤后的 externalIds",
    );
    // 反向：不得再有「直接透传 changedNoteIds」的旧写法
    assert.doesNotMatch(
        src,
        /setLastSyncChangedIds\(shouldReload \? r\.changedNoteIds/,
        "旧的全量透传写法必须移除",
    );
});

test("NotesPage：行内 ⋯ 按钮显隐不得用 :focus-within（菜单关闭焦点还原会残留白圈）", () => {
    const src = readNotesSrc();
    assert.ok(
        !src.includes(":focus-within .note-row-actions"),
        ":focus-within 会被 Modal 的程序化焦点还原命中 → ⋯ 常显成白色圆圈",
    );
    assert.match(
        src,
        /:has\(\.note-row-actions:focus-visible\) \.note-row-actions/,
        "必须改用 :has(:focus-visible)：键盘可达保留、指针场景不残留",
    );
    // 右键时必须摘掉活动焦点（焦点在 ⋯ 按钮上时光 blur 行容器没用）
    assert.match(
        src,
        /document\.activeElement as HTMLElement \| null\)\?\.blur/,
        "右键 handler 必须先 blur 当前活动元素再开菜单",
    );
    // 焦点兜底：MUI Modal 关闭时把焦点还原给打开前的元素（onClose 里 blur 太早，
    // 还原在退出动画之后），必须挂 transition 的 onExited 摘掉落在 ⋯ 按钮上的还原焦点
    assert.match(
        src,
        /transition: \{\s*onExited:/,
        "行菜单必须挂 slotProps.transition.onExited（还原焦点兜底）",
    );
    assert.match(
        src,
        /classList\.contains\("note-row-actions"\)\) el\.blur\(\)/,
        "onExited 里要把落在 ⋯ 按钮上的焦点摘掉",
    );
    // 根治（2026-10-18 第四报「点其他位置关闭后瞬间还是出现白圈」）：
    // MUI Menu 会透传 disableRestoreFocus；指针菜单应禁用还原，同时保留
    // menuClosing effect 里的 focusin 捕获作为按钮菜单关闭窗口防护：
    // 还原到「⋯」上的焦点立即 blur，事件驱动不赌时序。
    assert.match(
        src,
        /document\.addEventListener\("focusin", onFocusIn, true\)/,
        "关闭窗口内必须捕获 focusin（还原到 ⋯ 的焦点立即 blur）",
    );
    assert.match(
        src,
        /disableRestoreFocus=\{!\(rowMenu\?\.el instanceof HTMLElement\)\}/,
        "右键菜单禁止焦点还原，按钮菜单保留键盘返回路径",
    );
    // 关闭动画期间（~200ms）rowMenu 还挂着、menuOpen 显式 opacity:1：
    // menuClosing 类把按钮硬压掉，防「弹窗消失的瞬间冒出白圈」
    assert.match(src, /menuClosing/, "关闭动画期要有 menuClosing 状态");
    assert.match(
        src,
        /note-row-actions\$\{menuClosing \? " note-row-actions--closing" : ""\}/,
        "closing 期间按钮要打 --closing 类",
    );
});

test("index.css：closing 类必须用 !important 压掉 hover/focus 显隐", () => {
    const src = readSrc("src/index.css");
    assert.match(
        src,
        /\.note-dense-row \.note-row-actions--closing \{\s*opacity: 0 !important;\s*\}/,
        "closing 类要 !important 压 opacity（hover / :has(:focus-visible) 特殊度再高也盖不住它）",
    );
});

/**
 * 读记事本全部源码（主文件 + notes/ 下所有子组件）。
 * ⚠️ 2026-10-21：NotesPage 已按职责拆出多个子组件，守卫只读主文件
 * 会因「代码搬走」而**假通过**（看着全绿其实没人盯）。
 */
const readNotesSrc = () => stripComments(notesSourceAll(here));
