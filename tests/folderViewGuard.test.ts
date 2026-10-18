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
