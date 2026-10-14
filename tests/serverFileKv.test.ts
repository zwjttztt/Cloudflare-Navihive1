// tests/serverFileKv.test.ts
//
// server/file-kv.ts 的行为钉子：把本地目录包成 KVNamespaceLike 顶掉 Cloudflare KV
// （全仓库只有 worker/attachments.ts 四个调用，装笔记图片，key 形如 attach/<userId>/<uuid>）。
//
// 钉三件事：
//   1) 往返语义：string / Uint8Array / ArrayBuffer / DataView 写进去，读回来字节一致；
//      **写入必须拷贝**——调用方复用底层缓冲时不能把已落盘的内容改掉。
//   2) 读回的 arrayBuffer 只含本 key 的字节：Buffer 的底层 ArrayBuffer 可能比它自己大
//      （Node 的缓冲池），直接回 buf.buffer 会把池里别人的字节带出去。
//   3) 路径穿越一律抛错：key 是逻辑路径，不是文件系统路径。
//
// ⚠️ CI 跑在 ubuntu 上，本机是 Windows：凡是「哪种字符串算绝对路径」的断言
//    两边结论不同（POSIX 上反斜杠只是普通文件名字符），一律按平台跳过，
//    不能让用例在另一个系统上假红/假绿。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFileKv } from "../server/file-kv";

/** base 建在临时目录的**子目录**里，好往隔壁放穿越诱饵 */
function tempKv(): { kv: ReturnType<typeof makeFileKv>; parent: string; root: string; cleanup: () => void } {
    const parent = mkdtempSync(path.join(tmpdir(), "nh-kv-"));
    const root = path.join(parent, "base");
    return {
        kv: makeFileKv(root),
        parent,
        root,
        cleanup: () => rmSync(parent, { recursive: true, force: true }),
    };
}

test("字符串往返，子目录 key 自动建层", async () => {
    const { kv, cleanup } = tempKv();
    try {
        await kv.put("attach/12/9f3c-uuid", "hello 附件");
        assert.equal(await kv.get("attach/12/9f3c-uuid"), "hello 附件");
        // 覆盖写
        await kv.put("attach/12/9f3c-uuid", "第二版");
        assert.equal(await kv.get("attach/12/9f3c-uuid"), "第二版");
    } finally {
        cleanup();
    }
});

test("Uint8Array / ArrayBuffer / DataView 写进去，读回来字节一致", async () => {
    const { kv, cleanup } = tempKv();
    try {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
        await kv.put("a/bytes", bytes);
        await kv.put("a/buffer", bytes.buffer);
        // DataView 指向一块更大的缓冲，只圈中间三个字节
        const pool = new Uint8Array([9, 9, 1, 2, 3, 9]);
        await kv.put("a/view", new DataView(pool.buffer, 2, 3));

        const readBytes = await kv.get("a/bytes", "arrayBuffer");
        assert.deepEqual([...new Uint8Array(readBytes!)], [...bytes]);

        const readBuffer = await kv.get("a/buffer", "arrayBuffer");
        assert.deepEqual([...new Uint8Array(readBuffer!)], [...bytes]);

        const readView = await kv.get("a/view", "arrayBuffer");
        assert.deepEqual([...new Uint8Array(readView!)], [1, 2, 3]);
    } finally {
        cleanup();
    }
});

test("写入是拷贝：落盘后改调用方的缓冲，读回来还是旧字节", async () => {
    const { kv, cleanup } = tempKv();
    try {
        const bytes = new Uint8Array([1, 2, 3]);
        await kv.put("copy", bytes.buffer);
        bytes[0] = 9;
        bytes[1] = 9;
        const back = await kv.get("copy", "arrayBuffer");
        assert.deepEqual([...new Uint8Array(back!)], [1, 2, 3], "共享内存会把已落盘的内容改掉");
    } finally {
        cleanup();
    }
});

test("读回的 arrayBuffer 不带缓冲池里的别人的字节", async () => {
    const { kv, cleanup } = tempKv();
    try {
        await kv.put("small", new Uint8Array([7, 7, 7]));
        const back = await kv.get("small", "arrayBuffer");
        assert.equal(back!.byteLength, 3, "byteLength 必须正好是文件大小");
        assert.deepEqual([...new Uint8Array(back!)], [7, 7, 7]);
    } finally {
        cleanup();
    }
});

test("delete 之后读不到；delete 不存在的 key 不抛错", async () => {
    const { kv, cleanup } = tempKv();
    try {
        await kv.put("gone", "x");
        await kv.delete("gone");
        assert.equal(await kv.get("gone"), null);
        await kv.delete("gone"); // 幂等
        await kv.delete("attach/999/nope");
    } finally {
        cleanup();
    }
});

test("读不存在的 key 回 null；key 位置上是个目录也回 null", async () => {
    const { kv, cleanup } = tempKv();
    try {
        assert.equal(await kv.get("no/such/key"), null);
        await kv.put("dir/file", "x");
        assert.equal(await kv.get("dir"), null, "readFile 目录回 EISDIR，按「不存在」处理");
    } finally {
        cleanup();
    }
});

test("路径穿越一律抛错：.. / 嵌套 .. / 绝对路径 / 空 key", async () => {
    const { kv, parent, cleanup } = tempKv();
    try {
        // 在 base 隔壁放一个诱饵文件：穿越成功就会被读到
        const decoy = path.join(parent, "decoy.txt");
        writeFileSync(decoy, "secret");
        const cases: Array<[string, string]> = [
            ["../decoy.txt", "父目录"],
            ["a/../../decoy.txt", "嵌套 .."],
            ["/decoy.txt", "leading slash"],
            ["", "空 key"],
        ];
        for (const [key, label] of cases) {
            await assert.rejects(kv.get(key), /非法的 KV key/, `get ${label}`);
            await assert.rejects(kv.put(key, "x"), /非法的 KV key/, `put ${label}`);
            await assert.rejects(kv.delete(key), /非法的 KV key/, `delete ${label}`);
        }
        // 兜底：诱饵没被碰过
        assert.equal(await kv.get("decoy"), null);
    } finally {
        cleanup();
    }
});

test("Windows 盘符 / 反斜杠形式的 key 也越不出根目录", {
    skip: process.platform !== "win32" ? "只在 Windows 上有意义：POSIX 上反斜杠是普通文件名字符，落进 base 里并不穿越" : false,
}, async () => {
    const { kv, cleanup } = tempKv();
    try {
        // 反斜杠路径在 Windows 上 resolve 会变成绝对路径（C:\…），必须被 relative 判据拦下
        await assert.rejects(kv.get("C:\\Windows\\win.ini"), /越出根目录/);
        await assert.rejects(kv.get("..\\..\\decoy"), /越出根目录/);
        await assert.rejects(kv.put("C:\\evil", "x"), /越出根目录/);
    } finally {
        cleanup();
    }
});

test("key 位置上是目录时 get(arrayBuffer) 同样回 null（不会把目录读成二进制）", async () => {
    const { kv, root, cleanup } = tempKv();
    try {
        mkdirSync(path.join(root, "adir"), { recursive: true });
        assert.equal(await kv.get("adir", "arrayBuffer"), null);
    } finally {
        cleanup();
    }
});
