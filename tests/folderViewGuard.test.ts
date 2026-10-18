// tests/folderViewGuard.test.ts
// 「点文件夹 = 切到该文件夹视图」的静态守卫（2026-10-18）。
//
// 用户报「标题名为 123 的笔记属于 123 文件夹但不在 123 文件夹下方」：
// 截图里左栏「全部 3」与「📁123」同时高亮 —— 点文件夹时 view 没切过去，
// 「全部 N」的计数与高亮都还在，中栏却只剩该文件夹的一条，视觉上像没切。
// 现在 NoteView 加了 "folder"：点文件夹/新建后选中都切 view，删当前文件夹回 all。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function projectDir(): string {
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

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const readSrc = (rel: string) =>
    stripComments(readFileSync(resolve(projectDir(), rel), "utf8"));

test("NoteView 必须有 folder 视图键（点文件夹时切过去）", () => {
    const src = readSrc("src/components/NotesPage.tsx");
    assert.match(src, /\| "folder"/, "NoteView 要含 folder 键");
});

test("点文件夹：选中切 folder 视图、清空回 all（防「全部」行双高亮）", () => {
    const src = readSrc("src/components/NotesPage.tsx");
    // FolderTagSection 的 onSelect
    assert.match(
        src,
        /setView\(id === null \? "all" : "folder"\)/,
        "点文件夹要切 folder 视图（非 null），清空回 all",
    );
    // 删除当前选中的文件夹时跟着回全部（原来只 reset activeFolder）
    assert.match(
        src,
        /setView\(cur => \(cur === "folder" \? "all" : cur\)\)/,
        "删当前文件夹要把 view 从 folder 拉回 all",
    );
    // 新建根目录文件夹后自动选中 = 同一条路径，一起切
    assert.match(
        src,
        /setActiveFolder\(created\.id\);\s*setView\("folder"\)/,
        "新建文件夹后选中也要切 folder 视图",
    );
});

test("中栏过滤：folder 视图靠 activeFolder 筛，且不进「未归类」特例", () => {
    const src = readSrc("src/components/NotesPage.tsx");
    // folder 视图没有专属分支，走默认（byView 里 activeFolder 已筛 folder_id）
    assert.doesNotMatch(
        src,
        /view === "folder"/,
        "filtered 不需要 folder 特例（activeFolder 已筛），加了反而两头判",
    );
});

test("前/后移动后必须重排 folders 数组（树按数组顺序 DFS，只改 order_num 看不见）", () => {
    // 2026-10-18 第六批用户报「文件夹向前后实际位置没换」：reorder 换了
    // order_num 但 setFolders 只 map 不 sort，树渲染按数组顺序 → 纹丝不动。
    const src = readSrc("src/hooks/useNotes.ts");
    const i = src.indexOf("const reorderFolder");
    assert.ok(i > 0, "要能定位 reorderFolder");
    const block = src.slice(i, i + 1800);
    assert.match(block, /\.map\([\s\S]{0,200}\.sort\(sortFolders\)/, "setFolders 要 map 后再 sort(sortFolders)");
});

test("左栏文件夹内联笔记字号 12.5（font:inherit 会继承正文号，用户报「过大」）", () => {
    const src = readSrc("src/components/notes/sidebarSection.tsx");
    const i = src.indexOf("data-folder-note=");
    assert.ok(i > 0, "要能定位内联笔记行");
    const block = src.slice(i, i + 2500);
    assert.match(block, /fontSize: 12\.5/, "内联笔记行要显式 12.5px");
});

test("代码块横向滚动：cm-content 钳宽 + pre maxWidth（渲染块不再撑宽被裁）", () => {
    // 2026-10-18 第六批用户报「开启渲染后代码长度过长未出现横向滚轮」：
    // cm-content 是 flex 子项（min-width:auto）会被撑开 → pre 等宽 →
    // 内部 overflow-x 永不触发，长代码被 cm-scroller 的 overflow-x:hidden 裁掉。
    const editor = readSrc("src/components/NoteEditor.tsx");
    assert.match(editor, /".cm-content"[\s\S]{0,300}maxWidth: "100%"/, "cm-content 要钳 maxWidth:100%");
    const md = readSrc("src/utils/markdownToReact.tsx");
    const preAt = md.indexOf("const PRE_STYLE");
    const preBlock = md.slice(preAt, preAt + 400);
    assert.match(preBlock, /maxWidth: "100%"/, "PRE_STYLE 要钳 maxWidth:100%");
    assert.match(preBlock, /overflowX: "auto"/, "PRE_STYLE 要有横向滚动");
});

test("行菜单关闭后悬停显隐按行抑制（防「关闭瞬间在右键点位闪白圈」）", () => {
    const src = readSrc("src/components/NotesPage.tsx");
    assert.match(src, /rowActionsSuppressed/, "要有行级抑制状态");
    // 关闭路径统一走 closeRowMenu（置抑制 + menuClosing）
    assert.match(src, /const closeRowMenu = useCallback/, "要有统一关闭助手");
    const closeAt = src.indexOf("const closeRowMenu");
    const closeBlock = src.slice(closeAt, closeAt + 400);
    assert.match(closeBlock, /setRowActionsSuppressed\(/, "关闭时要置抑制行");
    assert.match(closeBlock, /setMenuClosing\(true\)/, "关闭时要置 menuClosing");
    // hover 显隐按抑制行分化；离开该行清除抑制
    assert.match(
        src,
        /"&:hover \.note-row-actions":\s*\{\s*opacity: rowActionsSuppressed === note\.id \? 0 : 1/,
        "hover 显隐要对被抑制行失效",
    );
    assert.match(src, /onMouseLeave=\{\(\) => \{\s*setRowActionsSuppressed/, "离开行要清除抑制");
});

test("文件夹/标签计数必须一次遍历（原 O(文件夹×笔记) 是置顶卡顿来源之一）", () => {
    // 2026-10-18 第六批用户报「文件夹下方置顶笔记等操作卡顿」：
    // folderCounts = folders × notes.filter(...)，tagCounts 还每条现开一个 Set，
    // notes 每变一次（置顶/保存/移动的乐观更新）这里就全量重算一遍。
    const src = readSrc("src/components/NotesPage.tsx");
    for (const name of ["folderCounts", "tagCounts"]) {
        const at = src.indexOf(`const ${name} = useMemo`);
        assert.ok(at > 0, `要能定位 ${name}`);
        const block = src.slice(at, at + 900);
        assert.match(block, /for \(const n of notes\)/, `${name} 要外层遍历 notes`);
        assert.doesNotMatch(block, /notes\.filter\(/, `${name} 不能在循环里再 filter 全量 notes`);
    }
});

test("总字数/附件引用计数只在数据面板打开时算（不挡置顶这类即时操作）", () => {
    const src = readSrc("src/components/NotesPage.tsx");
    const wordAt = src.indexOf("const noteWordTotal = useMemo");
    assert.ok(wordAt > 0, "要能定位 noteWordTotal");
    assert.match(src.slice(wordAt, wordAt + 500), /settingsOpen/, "总字数要有 settingsOpen 闸门");
    const refAt = src.indexOf("const attachmentRefCounts = useMemo");
    assert.ok(refAt > 0, "要能定位 attachmentRefCounts");
    const refBlock = src.slice(refAt, refAt + 400);
    assert.match(refBlock, /settingsOpen/, "附件引用计数要有 settingsOpen 闸门");
    assert.match(refBlock, /content\.includes\("\/>|includes\("\/api\/notes\/attachments\/"\)/, "正则前先用 includes 兜一道");
});

test("左栏内联笔记走分组表 notesByFolder（引用稳定、不每次 filter+sort）", () => {
    const src = readSrc("src/components/NotesPage.tsx");
    assert.match(src, /const notesByFolder = useMemo/, "要按 folder_id 一次分组");
    const at = src.indexOf("const notesInFolder = useCallback");
    assert.ok(at > 0, "要能定位 notesInFolder");
    const block = src.slice(at, at + 400);
    assert.match(block, /notesByFolder\.get\(folderId\)/, "notesInFolder 要从分组表取");
    assert.doesNotMatch(block, /notes\s*\n?\s*\.filter\(/, "notesInFolder 不能再 filter 全量 notes");
});
