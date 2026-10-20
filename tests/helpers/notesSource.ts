/**
 * 记事本源码读取助手（静态守卫用）。
 *
 * ⚠️ 为什么必须有这个助手：NotesPage.tsx 一直在按职责往外拆子组件
 * （markdownToolbar / sidebarSection / paneChrome / NotesListPane /
 * NotesEditorPane / NotesOverlayLayer …）。守卫如果只读某一个文件，
 * 代码一搬走就**假通过** —— 看着全绿，其实没人盯着，这比不写守卫更糟。
 *
 * 所以这里把「主文件 + src/components/notes/ 下所有文件」拼成一份字符串
 * 给守卫用：锚点切片在同一份串里仍连续，「不该出现 X」的断言也照样查得到
 * （搬走的代码只有一份，不会重复命中）。目录是动态扫的，以后再拆新文件
 * 守卫自动跟上，不用回来改清单。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 从任意文件往上找项目根目录（package.json 所在层）。
 * 默认用**本模块自己的位置**：用例会被 esbuild 打到 script/tmp-tests/ 下再跑，
 * 那时 cwd 不一定可靠，而本模块的位置一定在项目内。
 */
export function projectDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
    let dir = from;
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const NOTES_DIR = join("src", "components", "notes");
const MAIN_FILE = join("src", "components", "NotesPage.tsx");

/**
 * 记事本全部源码（主文件 + notes/ 目录下所有 .tsx/.ts），按文件名排序拼接。
 * 顺序固定，避免不同机器上 slice 窗口漂移。
 */
export function notesSource(from?: string): string {
    const dir = projectDir(from);
    const parts: string[] = [readFileSync(join(dir, MAIN_FILE), "utf-8")];

    let entries: string[] = [];
    try {
        entries = readdirSync(join(dir, NOTES_DIR));
    } catch {
        // 目录不存在（极端情况）就只回主文件，守卫会按老样子跑
    }
    for (const name of entries.sort()) {
        if (!/\.tsx?$/.test(name)) continue;
        parts.push(readFileSync(join(dir, NOTES_DIR, name), "utf-8"));
    }
    // ⚠️ **不剥注释**：一部分守卫是拿 JSX 注释 `{/* 主体：desktop */}` 当锚点的
    // （剥了就 indexOf 不到，切片变空字符串，守卫反而假失败）。
    // 要剥注释的调用点自己包 stripComments(notesSource())。
    return parts.join("\n");
}

/** 读 notes/ 下某个子组件（如 readNotesFile("NotesNavPanel.tsx")） */
export function readNotesFile(name: string, from?: string): string {
    return readFileSync(join(projectDir(from), NOTES_DIR, name), "utf-8");
}

/** 读任意源码文件（相对项目根） */
export function readSrcFile(rel: string, from?: string): string {
    return readFileSync(join(projectDir(from), rel), "utf-8");
}

/** 剥掉 // 行注释与 /* *\/ 块注释（避免拿注释里的中文当锚点） */
export function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}
