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
