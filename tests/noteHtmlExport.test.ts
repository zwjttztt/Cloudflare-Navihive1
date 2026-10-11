import test from "node:test";
import assert from "node:assert/strict";
import { renderNoteHtmlBody } from "../src/utils/noteHtmlExport";

test("HTML/PDF 私有图片内联、重复引用只取一次、不抓外部图片", async () => {
    const originalFetch = globalThis.fetch;
    const originalReader = globalThis.FileReader;
    const calls: string[] = [];
    class Reader {
        result = "";
        onload?: () => void;
        async readAsDataURL(blob: Blob) {
            this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString("base64")}`;
            this.onload?.();
        }
    }
    globalThis.FileReader = Reader as unknown as typeof FileReader;
    globalThis.fetch = async (input, init) => {
        calls.push(String(input));
        assert.equal(init?.credentials, "same-origin");
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
    };
    try {
        const html = await renderNoteHtmlBody("![a](/api/notes/attachments/abc)\n![b](/api/notes/attachments/abc)\n![c](https://example.com/x.png)");
        assert.deepEqual(calls, ["/api/notes/attachments/abc"]);
        assert.equal((html.match(/data:image\/png;base64,AQID/g) ?? []).length, 2);
        assert.ok(html.includes("https://example.com/x.png"));
        globalThis.fetch = async () => new Response("missing", { status: 404 });
        await assert.rejects(renderNoteHtmlBody("![a](/api/notes/attachments/missing)"), /导出图片失败/);
        globalThis.fetch = async () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } });
        await assert.rejects(renderNoteHtmlBody("![a](/api/notes/attachments/svg)"), /不是可导出的图片/);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.FileReader = originalReader;
    }
});
