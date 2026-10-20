// tests/textAttachmentGuard.test.ts
// 纯文本附件（txt/json）上传的静态守卫（2026-10-18 用户要「笔记里上传 txt/json」）。
// 后端 sniff 的行为由 tests/textAttachmentSniff.test.ts 单测钉住；这里盯前端
// 入口（accept 放行两类文本、按类型选插入形态）与后端放行分支。
// 剥注释 + 反向验证（注释里写正确写法不算数）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
    notesSource as notesSourceAll,
    projectDir as findProjectDir,
} from "./helpers/notesSource";

const here = dirname(fileURLToPath(import.meta.url));

function projectDir(): string {
    return findProjectDir(here);
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

test("上传入口 accept 放行图片 + 两类纯文本", () => {
    const src = readSrc("src/components/notes/markdownToolbar.tsx");
    const m = /accept='([^']+)'/.exec(src);
    assert.ok(m, "上传 input 要有 accept");
    const accept = m[1];
    for (const part of ["image/png", "text/plain", ".txt", "application/json", ".json"]) {
        assert.ok(accept.includes(part), `accept 要含 ${part}（当前：${accept}）`);
    }
    // 反向：HTML/SVG 不能进（SVG 带脚本、HTML 无正向用途）
    assert.ok(!accept.includes("text/html"), "accept 不得含 text/html");
    assert.ok(!accept.includes("svg"), "accept 不得含 svg");
});

test("按类型选插入形态：文本插下载链接，图片仍插 markdown 图片", () => {
    const src = readSrc("src/components/notes/markdownToolbar.tsx");
    assert.match(src, /file\.type === "text\/plain" \|\| file\.type === "application\/json"/, "要按 file.type 判文本");
    assert.match(src, /onInsert\(`\[\$\{filename\}\]\(/, "文本要插 [文件名](url) 下载链接");
    assert.match(src, /onInsert\(`!\[\$\{filename\}\]\(/, "图片仍插 ![文件名](url)");
    assert.match(
        src,
        /isText \? `已插入文件[^`]*` : `已插入图片/,
        "提示文案要按类型区分（文本说明可下载）",
    );
});

test("后端放行分支：图片嗅探不过时试文本嗅探，两者都不过才拒", () => {
    const src = readSrc("worker/routes/data.ts");
    assert.match(src, /sniffTextMime\(bytes\)/, "上传路由要试文本嗅探");
    assert.match(src, /textExtension\(textMime\)/, "文本类要过扩展名白名单");
    assert.match(
        src,
        /只支持 PNG \/ JPEG \/ GIF \/ WebP \/ AVIF 图片与 txt \/ json 纯文本/,
        "拒绝文案要更新成「图片 + 纯文本」",
    );
});

test("下载端点：文本附件补 charset=utf-8（否则中文乱码）", () => {
    const src = readSrc("worker/routes/data.ts");
    assert.match(
        src,
        /found\.mime\.startsWith\("text\/"\)[\s\S]{0,120}charset=utf-8/,
        "text/* 的 Content-Type 要补 charset=utf-8",
    );
});

test("工具栏「添加附件」按键：真附件上传后在当前笔记插入可见链接", () => {
    const tb = readSrc("src/components/notes/markdownToolbar.tsx");
    // 按钮与选择框存在
    assert.match(tb, /data-tool='attach'/, "工具栏要有「添加附件」按钮");
    assert.match(tb, /data-attach-input='1'/, "要有附件隐藏选择框");
    assert.match(tb, /AttachFileIcon/, "要用回形针图标");
    // 附件选择框只收 txt/json（与上传图片的 accept 分开）
    const attachAccept = /ref=\{attachInputRef\}[\s\S]{0,300}?accept='([^']+)'/.exec(tb);
    assert.ok(attachAccept, "附件 input 要有 accept");
    for (const part of ["text/plain", ".txt", "application/json", ".json"]) {
        assert.ok(attachAccept[1].includes(part), `附件 accept 要含 ${part}`);
    }
    assert.ok(!attachAccept[1].includes("image/"), "附件入口不收图片（那是上传图片的事）");
    // 附件仍走独立上传回调，但 NotesPage 必须将返回链接插入当前笔记正文。
    const page = readNotesSrc();
    assert.match(page, /handleAttach\(file, noteId, false\)/, "主工具栏绑定主编辑器");
    assert.match(page, /handleAttach\(file, noteId, true\)/, "侧工具栏绑定侧编辑器");
    assert.ok(page.includes("[${safeFilename}](<${uploaded.url}>)"), "上传完成要生成可见下载链接");
    assert.match(page, /ref\.current === editor/, "异步上传后检查原编辑器身份");
    assert.match(page, /并在笔记中插入下载链接/, "成功提示要说明正文已插入链接");
});

/**
 * 读记事本全部源码（主文件 + notes/ 下所有子组件）。
 * ⚠️ 2026-10-21：NotesPage 已按职责拆出多个子组件，守卫只读主文件
 * 会因「代码搬走」而**假通过**（看着全绿其实没人盯）。
 */
const readNotesSrc = () => stripComments(notesSourceAll(here));
