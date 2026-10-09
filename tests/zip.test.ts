// tests/zip.test.ts
//
// 自实现的 zip 读写（2026-10-09 照 inkstone 的 shared/zip.ts）。
// 打包侧不压缩（method 0），解包侧认 0 和 8。三条必须钉死：
//   ① 打出来的包能原样读回来（往返一致，含中文文件名）；
//   ② 校验和能发现「文件被动过手脚」；
//   ③ zip slip / zip 炸弹挡得住 —— 这是解包唯一真正危险的地方。
import assert from "node:assert/strict";
import test from "node:test";
import { crc32, createZip, normalizeZipPath, readZip } from "../src/utils/zip";

const bytes = (s: string) => new TextEncoder().encode(s);

test("往返：打出来能原样读回来（含中文文件名）", async () => {
    const entries = [
        { path: "notes.json", data: bytes('{"notes":[]}') },
        { path: "attachments/图片 一.png", data: new Uint8Array([1, 2, 3, 4, 5]) },
    ];
    const packed = createZip(entries);
    const out = await readZip(packed);
    assert.equal(out.length, 2);
    const byPath = new Map(out.map(e => [e.path, e.data]));
    assert.equal(new TextDecoder().decode(byPath.get("notes.json")!), '{"notes":[]}');
    assert.deepEqual([...byPath.get("attachments/图片 一.png")!], [1, 2, 3, 4, 5]);
});

test("crc32：与已知值一致（改动一个字节就会变）", () => {
    // "The quick brown fox jumps over the lazy dog" 的 CRC32 是 0x414FA339
    assert.equal(crc32(bytes("The quick brown fox jumps over the lazy dog")), 0x414fa339);
    assert.notEqual(crc32(bytes("abc")), crc32(bytes("abd")));
});

test("校验和：内容被改过要报错，不能静默返回坏数据", async () => {
    const packed = createZip([{ path: "a.txt", data: bytes("hello world") }]);
    // 把数据区（第 31 字节起，前面是 30 字节局部头 + 文件名 a.txt）改一个字节
    const tampered = packed.slice();
    const dataStart = 30 + "a.txt".length;
    tampered[dataStart] = tampered[dataStart] ^ 0xff;
    await assert.rejects(
        () => readZip(tampered),
        /校验失败/,
        "改过的数据必须被 CRC 挡下"
    );
});

test("重复文件名：打包时就拒绝（读回来两条同名不知道该听谁的）", () => {
    assert.throws(
        () =>
            createZip([
                { path: "a.txt", data: bytes("1") },
                { path: "A.txt", data: bytes("2") },
            ]),
        /重复/
    );
});

test("zip slip：`..` 与绝对路径一律拒绝", () => {
    assert.throws(() => normalizeZipPath("../../etc/passwd"), /向上跳转/);
    assert.throws(() => normalizeZipPath("/etc/passwd"), /绝对路径/);
    assert.throws(() => normalizeZipPath("C:/windows/system32"), /绝对路径/);
    // 正常路径要能过，且把分隔符统一成 /
    assert.equal(normalizeZipPath("a\\b/c.txt"), "a/b/c.txt");
    assert.equal(normalizeZipPath("./a//b.txt"), "a/b.txt");
});

test("zip 炸弹：条目数超上限直接拒（不等展开）", async () => {
    // 中央目录里声称 3000 条 → 超过默认 2500 上限
    const many = Array.from({ length: 40 }, (_, i) => ({
        path: `f${i}.txt`,
        data: bytes("x"),
    }));
    const packed = createZip(many);
    await assert.rejects(
        () => readZip(packed, { maxEntries: 10 }),
        /条目超过上限/,
        "条目数上限要在读中央目录时就生效"
    );
});

test("不是 zip / 空文件：给出人话错误，不抛裸异常", async () => {
    await assert.rejects(() => readZip(new Uint8Array(0)), /不是.*zip|有效/);
    await assert.rejects(() => readZip(bytes("这根本不是 zip")), /不是.*zip|有效/);
});

test("只挑想要的条目（include）：省得把整包都读进内存", async () => {
    const packed = createZip([
        { path: "notes.json", data: bytes("{}") },
        { path: "attachments/a.png", data: bytes("a") },
        { path: "attachments/b.png", data: bytes("b") },
    ]);
    const out = await readZip(packed, { include: p => p.startsWith("attachments/") });
    assert.deepEqual(out.map(e => e.path), ["attachments/a.png", "attachments/b.png"]);
});
