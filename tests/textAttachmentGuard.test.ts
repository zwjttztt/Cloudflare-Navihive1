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
