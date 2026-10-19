// tests/attachmentRoutes.test.ts
//
// 附件「重命名 / 原地编辑 / 下载头」三条新路径的行为用例（2026-10-19）。
//
// 为什么单独一个文件而不是塞进 noteRoutes：这三条都有**写盘副作用**（对象覆盖、
// 元数据改名），失败方式与「笔记 CRUD」完全不同，混在一起以后很难说清红线在哪。
//
// 这里钉死的四件事：
//   1. **扩展名锁定**：类型在上传那一刻按内容嗅探定死，改名不能让它漂移
//      （把 data.json 改成 data.txt 会让「名字说的」和「实际是」对不上）。
//   2. **路径分隔符 / 控制字符必须被净化**：文件名会进 Content-Disposition 响应头。
//   3. **只有 txt / json 能编辑**：前端藏着按钮不算数，服务端要自己拒。
//   4. **下载头必须带文件名**：只给裸 `inline` 的话「另存为」拿到的是 uuid，
//      重命名功能等于白做。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleDataRoutes } from "../worker/routes/data";
import { errorResponse } from "../worker/lib/apiError";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

const HOST = "https://nav.example.com";
const ATT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface Log {
    renamed: Array<{ id: string; filename: string }>;
    att: Record<string, unknown> | null;
}

/** 一个够用的 KV 替身：只实现附件读写用到的三个动作 */
function makeKv(store: Map<string, Uint8Array>) {
    return {
        async put(key: string, value: Uint8Array) {
            store.set(key, value);
        },
        async get(key: string, type?: string) {
            const bytes = store.get(key);
            if (!bytes) return null;
            if (type === "arrayBuffer") return bytes.buffer;
            return new TextDecoder().decode(bytes);
        },
        async delete(key: string) {
            store.delete(key);
        },
    };
}

function makeCtx(opts: {
    log: Log;
    path: string;
    method: string;
    body?: BodyInit | null;
    contentType?: string;
    store?: Map<string, Uint8Array>;
    kv?: boolean;
}): RouteCtx {
    const { log, path, method } = opts;
    const store = opts.store ?? new Map<string, Uint8Array>();
    const api = {
        getCurrentUserId: () => 1,
        currentUserId: 1,
        getAttachment: async () => log.att,
        renameAttachment: async (id: string, filename: string) => {
            log.renamed.push({ id, filename });
            return { ok: true as const, filename, updatedNotes: [{ id: 1, content: "x" }] };
        },
        deleteAttachment: async () => ({ ok: true as const, storage: "kv", objectKey: "k" }),
        listAttachments: async () => [],
    } as unknown as NavigationAPI;

    return {
        request: new Request(`${HOST}/api/${path}`, {
            method,
            headers: opts.contentType ? { "Content-Type": opts.contentType } : undefined,
            body: opts.body ?? undefined,
        }),
        url: new URL(`${HOST}/api/${path}`),
        path,
        method,
        api,
        ip: "203.0.113.9",
        writeGate: async () => null as Response | null,
        // 不配 FILES(R2) 时 readAttachmentObject / putAttachmentObject 走 KV 分支
        env: {
            FILES_KV: opts.kv === false ? undefined : makeKv(store),
            DB: {
                // ⚠️ first() 也要给：checkReplaceQuota 会先 SUM(size) 问一句已用量，
                // 只实现 run() 的话这里会 TypeError → 500（第一版就是这样红的）。
                prepare: () => ({
                    bind: () => ({
                        run: async () => ({ success: true }),
                        first: async () => ({ bytes: 0 }),
                    }),
                }),
            },
        } as never,
    } as unknown as RouteCtx;
}

async function call(opts: Parameters<typeof makeCtx>[0]): Promise<Response> {
    try {
        const res = await handleDataRoutes(makeCtx(opts));
        assert.ok(res, `路由没有处理 ${opts.method} ${opts.path}`);
        return res;
    } catch (error) {
        return errorResponse(error);
    }
}

const textAttachment = {
    id: ATT_ID,
    filename: "旧名字.json",
    mime: "application/json",
    size: 12,
    storage: "kv",
    object_key: `attach/1/${ATT_ID}`,
};

test("PATCH 附件重命名：扩展名跟着 mime 走，不跟着用户输入走", async () => {
    const log: Log = { renamed: [], att: { ...textAttachment } };
    const res = await call({
        log,
        path: `notes/attachments/${ATT_ID}`,
        method: "PATCH",
        body: JSON.stringify({ filename: "新名字.txt" }),
        contentType: "application/json",
    });
    assert.equal(res.status, 200);
    // json 附件改成 .txt → 强制回到 .json
    assert.deepEqual(log.renamed, [{ id: ATT_ID, filename: "新名字.json" }]);
    assert.deepEqual(await res.json(), { id: ATT_ID, filename: "新名字.json", updatedNotes: 1 });
});

test("PATCH 附件重命名：路径分隔符 / 控制字符被换成 '-'，不会进响应头", async () => {
    const log: Log = { renamed: [], att: { ...textAttachment } };
    const res = await call({
        log,
        path: `notes/attachments/${ATT_ID}`,
        method: "PATCH",
        body: JSON.stringify({ filename: "../坏/名字\r\n.json" }),
        contentType: "application/json",
    });
    assert.equal(res.status, 200);
    const name = log.renamed[0]?.filename ?? "";
    assert.doesNotMatch(name, /[/\\\r\n]/, `文件名里不能留分隔符或换行：${name}`);
    assert.match(name, /\.json$/, "扩展名仍然锁在 .json");
});

test("PATCH 附件重命名：空文件名直接 400，不要落库", async () => {
    const log: Log = { renamed: [], att: { ...textAttachment } };
    const res = await call({
        log,
        path: `notes/attachments/${ATT_ID}`,
        method: "PATCH",
        body: JSON.stringify({ filename: "   " }),
        contentType: "application/json",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(log.renamed, [], "被拒之后不该再去改库");
});

test("PATCH 附件重命名：附件不存在 → 404", async () => {
    const log: Log = { renamed: [], att: null };
    const res = await call({
        log,
        path: `notes/attachments/${ATT_ID}`,
        method: "PATCH",
        body: JSON.stringify({ filename: "x.json" }),
        contentType: "application/json",
    });
    assert.equal(res.status, 404);
    assert.deepEqual(log.renamed, []);
});

test("PUT 附件内容：图片一律拒（改内容没有意义，也不该是合法图片了）", async () => {
    const log: Log = {
        renamed: [],
        att: { ...textAttachment, filename: "图.png", mime: "image/png" },
    };
    const res = await call({
        log,
        path: `notes/attachments/${ATT_ID}/content`,
        method: "PUT",
        body: "hello",
        contentType: "text/plain",
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /txt \/ json/);
});

test("PUT 附件内容：空内容拒绝（避免把附件写成 0 字节）", async () => {
    const log: Log = { renamed: [], att: { ...textAttachment } };
    const res = await call({
        log,
        path: `notes/attachments/${ATT_ID}/content`,
        method: "PUT",
        body: "",
        contentType: "text/plain",
    });
    assert.equal(res.status, 400);
});

test("PUT 附件内容：txt 覆盖写进同一个对象 key（id 不变，正文链接不失效）", async () => {
    const log: Log = {
        renamed: [],
        att: { ...textAttachment, filename: "说明.txt", mime: "text/plain", size: 3 },
    };
    const store = new Map<string, Uint8Array>();
    const res = await call({
        log,
        path: `notes/attachments/${ATT_ID}/content`,
        method: "PUT",
        body: "改过的内容",
        contentType: "text/plain; charset=utf-8",
        store,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { size: number; mime: string };
    assert.equal(body.mime, "text/plain", "mime 不能因为这次内容变了就漂移");
    assert.ok(body.size > 0);
    const written = store.get(`attach/1/${ATT_ID}`);
    assert.ok(written, "必须写回**同一个** object_key");
    assert.equal(new TextDecoder().decode(written), "改过的内容");
});

test("GET 附件：下载头带上文件名（否则另存为拿到的是 uuid）", async () => {
    const log: Log = { renamed: [], att: { ...textAttachment } };
    const store = new Map<string, Uint8Array>();
    store.set(`attach/1/${ATT_ID}`, new TextEncoder().encode("{}"));
    const res = await call({
        log,
        path: `notes/attachments/${ATT_ID}`,
        method: "GET",
        store,
    });
    assert.equal(res.status, 200);
    const disposition = res.headers.get("Content-Disposition") ?? "";
    assert.match(disposition, /filename\*=UTF-8''/, "要带 RFC 5987 编码的文件名");
    assert.ok(disposition.includes(encodeURIComponent("旧名字.json")), disposition);
    assert.ok(!disposition.includes("attach/1/"), "不能把对象 key 泄漏进响应头");
});
