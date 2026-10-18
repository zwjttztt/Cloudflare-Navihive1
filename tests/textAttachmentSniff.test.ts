// tests/textAttachmentSniff.test.ts
// 纯文本附件（txt/json）的类型嗅探（2026-10-18 用户要「笔记里上传 txt/json」）。
//
// 判据全部按**文件内容**，不信扩展名与 Content-Type：
//   - application/json：UTF-8 可解码、首非空字符 { / [、整体 JSON.parse 通过；
//   - text/plain：UTF-8 可解码、无 NUL、控制字符占比不超 10%；
//   - 二进制（含 NUL / 控制字符超限 / 非法 UTF-8）一律拒。
// ⚠️ 安全边界：文本附件下载按 text/plain;charset=utf-8 出，浏览器只当纯文本；
// SVG / HTML 不收（SVG 能带脚本）。这些用例钉住「该收的收、该拒的拒」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffTextMime, textExtension } from "../worker/attachments";

const bytes = (s: string) => new TextEncoder().encode(s);

test("合法 JSON → application/json（含 BOM、前后空白、嵌套）", () => {
    assert.equal(sniffTextMime(bytes('{"a":1,"b":[1,2,3]}')), "application/json");
    assert.equal(sniffTextMime(bytes("  \n\t [1, 2, 3]  ")), "application/json");
    assert.equal(sniffTextMime(bytes("\uFEFF{\"x\":true}")), "application/json");
    assert.equal(sniffTextMime(bytes('{"nested":{"deep":{"k":"中文值"}}}')), "application/json");
});

test("超大 JSON（超过 64KB 嗅探窗口）按 json 收：后半截只会是更多同类文本", () => {
    const big = '{"k":"' + "x".repeat(70 * 1024) + '"}';
    assert.equal(sniffTextMime(bytes(big)), "application/json");
});

test("首字符像 JSON 但 parse 不过 → 退化成 text/plain（用户粘了半截也合理）", () => {
    assert.equal(sniffTextMime(bytes('{"a": 1,')), "text/plain");
    assert.equal(sniffTextMime(bytes("[1, 2,")), "text/plain");
});

test("普通文本 → text/plain（含中文、制表符、换行）", () => {
    assert.equal(sniffTextMime(bytes("hello world")), "text/plain");
    assert.equal(sniffTextMime(bytes("第一行\n第二行\t制表符")), "text/plain");
    assert.equal(sniffTextMime(bytes("12345")), "text/plain");
});

test("二进制一律拒：NUL / 控制字符超限 / 非法 UTF-8", () => {
    assert.equal(sniffTextMime(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])), null, "ZIP 头含 NUL");
    const ctrl = new Uint8Array(1000).fill(0x01);
    assert.equal(sniffTextMime(ctrl), null, "全控制字符");
    assert.equal(sniffTextMime(new Uint8Array([0xff, 0xfe, 0xfa])), null, "非法 UTF-8");
    assert.equal(sniffTextMime(new Uint8Array(0)), null, "空文件");
});

test("扩展名映射：text/plain→txt、application/json→json，其余 null", () => {
    assert.equal(textExtension("text/plain"), "txt");
    assert.equal(textExtension("application/json"), "json");
    assert.equal(textExtension("image/png"), null, "文本表不认图片");
    assert.equal(textExtension("text/html"), null, "HTML 不在白名单");
});
