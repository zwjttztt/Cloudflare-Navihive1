import { test } from "node:test";
import assert from "node:assert/strict";
import { readImageSize } from "../worker/imageSize";

test("服务端图片尺寸读取及截断容错", () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, 640); view.setUint32(20, 480);
    assert.deepEqual(readImageSize(bytes, "image/png"), { width: 640, height: 480 });
    assert.equal(readImageSize(bytes.slice(0, 20), "image/png"), null);
    assert.equal(readImageSize(bytes, "image/svg+xml"), null);
    view.setUint32(16, 0);
    assert.equal(readImageSize(bytes, "image/png"), null);
});

/** 手工拼一个最小 AVIF：ftyp + meta(iprp(ipco(ispe)))，可注入尺寸与破坏点 */
function makeAvif(width: number, height: number): Uint8Array {
    const enc = new TextEncoder();
    const box = (type: string, body: Uint8Array, fullBox = false): Uint8Array => {
        const name = enc.encode(type);
        const extra = fullBox ? 4 : 0;
        const out = new Uint8Array(8 + extra + body.length);
        new DataView(out.buffer).setUint32(0, out.length);
        out.set(name, 4);
        out.set(body, 8 + extra);
        return out;
    };
    const ispeBody = new Uint8Array(8); // width(4) + height(4)；version/flags 由 box(fullBox) 统一补
    new DataView(ispeBody.buffer).setUint32(0, width);
    new DataView(ispeBody.buffer).setUint32(4, height);
    const ispe = box("ispe", ispeBody, true);
    const ipco = box("ipco", ispe);
    const iprp = box("iprp", ipco);
    const meta = box("meta", iprp, true);
    const ftyp = box("ftyp", enc.encode("avif"));
    const out = new Uint8Array(ftyp.length + meta.length);
    out.set(ftyp, 0);
    out.set(meta, ftyp.length);
    return out;
}

test("AVIF：ISO-BMFF 盒子树解析尺寸 + 越界/截断容错", () => {
    const bytes = makeAvif(1024, 768);
    assert.deepEqual(readImageSize(bytes, "image/avif"), { width: 1024, height: 768 });

    // 截断：缺尾巴解析不出就返回 null，绝不抛
    assert.equal(readImageSize(bytes.slice(0, 30), "image/avif"), null);
    // 尺寸为 0 视为失败
    assert.equal(readImageSize(makeAvif(0, 100), "image/avif"), null);
    // 假尺寸字段异常大的盒子（size 越界）不抛、返回 null：把 meta 的 size 改成超大
    const corrupt = makeAvif(10, 10);
    new DataView(corrupt.buffer).setUint32(12, 0xffffff); // meta 从文件偏移 12 开始
    assert.equal(readImageSize(corrupt, "image/avif"), null);
});
