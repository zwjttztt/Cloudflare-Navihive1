// tests/notesBackupZip.test.ts
//
// 阶段 1（2026-10-11）：自动 WebDAV 备份的附件闭环。
//
// 之前自动备份只打包 notes/folders/tags/noteTags（gzip JSON），附件二进制不在其中
// —— 手动 ZIP 能带附件不等于自动灾备也能。新格式是 ZIP（notes.json +
// attachments/<旧id>__<文件名>），与前端导出 zip 同一布局，恢复走前端那条
// 已测的「解包 → 附件回传 → 引用改写」链路。
//
// 这里钉死三件事：
//   1. 文件名规则（.zip 扩展名、前缀不变 —— 列目录/清理/恢复都靠前缀认亲）；
//   2. 引用收集：只备正文还引用着的附件，未引用的（GC 迟早清掉）不进去；
//   3. 真实 SQLite + 假 KV 上的条目组装：路径布局、账号隔离、预算跳过。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";
import { readZip, createZip } from "../src/utils/zip";
import {
    NOTES_BACKUP_ATTACHMENT_BUDGET_BYTES,
    collectReferencedAttachmentIds,
    readBackupAttachmentEntries,
} from "../worker/notesBackup";
import { buildNotesBackupZipFileName, isNotesAutoBackupFileName } from "../worker/webdav/naming";

// ============ 纯逻辑：文件名与引用收集 ============

test("ZIP 备份文件名：前缀不变、扩展名换 .zip，自动/手动两档都对", () => {
    const auto = buildNotesBackupZipFileName("auto");
    const manual = buildNotesBackupZipFileName("manual");
    assert.ok(auto.startsWith("navihive-notes-backup-auto-"), "自动备份前缀必须保留（清理靠它认亲）");
    assert.ok(manual.startsWith("navihive-notes-backup-"), "手动备份前缀必须保留");
    assert.ok(!manual.startsWith("navihive-notes-backup-auto-"), "手动备份不能被误认成自动备份");
    assert.ok(auto.endsWith(".zip"));
    assert.ok(manual.endsWith(".zip"));
    // 保留策略只清自动备份：ZIP 命名不能破坏这条铁律
    assert.ok(isNotesAutoBackupFileName(auto));
    assert.ok(!isNotesAutoBackupFileName(manual));
});

test("引用收集：只收 /api/notes/attachments/<id> 引用，跨笔记去重", () => {
    const ids = collectReferencedAttachmentIds([
        { content: "图一 ![a](/api/notes/attachments/aaa-bbb) 再引一次 ![b](/api/notes/attachments/aaa-bbb)" },
        { content: "图二 ![[/api/notes/attachments/ccc-ddd]]" },
        { content: "没有图片" },
        { content: null },
        {},
    ]);
    assert.deepEqual([...ids].sort(), ["aaa-bbb", "ccc-ddd"]);
    // 没有正文 / 空数组 → 空
    assert.equal(collectReferencedAttachmentIds([]).size, 0);
    assert.equal(collectReferencedAttachmentIds([{ content: "普通文字 [[双链]] 不是附件" }]).size, 0);
});

// ============ 真实 SQLite + 假 KV：条目组装 ============

/** 只实现 readAttachmentObject 用到的 KV 面（get/put/delete） */
function makeFakeEnv() {
    const objects = new Map<string, ArrayBuffer>();
    const env = {
        FILES_KV: {
            async get(key: string, type: string) {
                void type;
                return objects.get(key) ?? null;
            },
            async put(key: string, value: ArrayBuffer) {
                objects.set(key, value);
            },
            async delete(key: string) {
                objects.delete(key);
            },
        },
    };
    return { env: env as unknown as Parameters<typeof readBackupAttachmentEntries>[1], objects };
}

async function seed(api: NavigationAPI) {
    // 两条笔记：一条引用两个附件，一条不引用任何附件
    const note = await api.createNote({
        title: "带图笔记",
        content: "![x](/api/notes/attachments/att-1) ![y](/api/notes/attachments/att-2)",
    });
    await api.createNote({ title: "无图笔记", content: "纯文字" });
    await api.createAttachment({
        id: "att-1",
        note_id: note.id ?? null,
        filename: "one.png",
        mime: "image/png",
        size: 5,
        storage: "kv",
        object_key: "attach/test/att-1",
    });
    await api.createAttachment({
        id: "att-2",
        note_id: note.id ?? null,
        filename: "two.png",
        mime: "image/png",
        size: 3,
        storage: "kv",
        object_key: "attach/test/att-2",
    });
    // 未被任何正文引用的附件（GC 的候选）—— 不该进备份
    await api.createAttachment({
        id: "att-orphan",
        note_id: null,
        filename: "orphan.png",
        mime: "image/png",
        size: 9,
        storage: "kv",
        object_key: "attach/test/att-orphan",
    });
}

test("真实 SQLite：备份附件条目布局与前端导出 zip 一致，未引用的附件不进去", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    const { env, objects } = makeFakeEnv();
    await seed(api);
    objects.set("attach/test/att-1", new TextEncoder().encode("AAAAA").buffer as ArrayBuffer);
    objects.set("attach/test/att-2", new TextEncoder().encode("CCC").buffer as ArrayBuffer);

    const payload = await api.exportNotesData();
    const { entries, skipped, bytes } = await readBackupAttachmentEntries(api, env, payload);

    assert.equal(skipped, 0);
    assert.equal(bytes, 8);
    const paths = entries.map(e => e.path).sort();
    assert.deepEqual(paths, ["attachments/att-1__one.png", "attachments/att-2__two.png"]);
    const one = entries.find(e => e.path === "attachments/att-1__one.png");
    assert.equal(new TextDecoder().decode(one!.data), "AAAAA");

    // 端到端拼一次 ZIP，确认恢复端（readZip + notes.json）能原样读回
    const zip = createZip([
        { path: "notes.json", data: new TextEncoder().encode(JSON.stringify(payload)) },
        ...entries,
    ]);
    const round = await readZip(zip);
    assert.ok(round.some(e => e.path === "notes.json"));
    assert.ok(round.some(e => e.path === "attachments/att-1__one.png"));
});

test("真实 SQLite：附件字节超出预算时跳过并计数，不让备份整体失败", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    const { env, objects } = makeFakeEnv();
    await seed(api);
    objects.set("attach/test/att-1", new TextEncoder().encode("AAAAA").buffer as ArrayBuffer);
    objects.set("attach/test/att-2", new TextEncoder().encode("CCC").buffer as ArrayBuffer);

    const payload = await api.exportNotesData();
    // 预算只够一个附件：多出来的那个必须被跳过并计数，而不是抛错
    const { entries, skipped, bytes } = await readBackupAttachmentEntries(api, env, payload, 4);
    assert.equal(entries.length, 1);
    assert.equal(skipped, 1);
    assert.equal(bytes, 3);
    assert.ok(NOTES_BACKUP_ATTACHMENT_BUDGET_BYTES > 0);
});

test("真实 SQLite：账号隔离 —— 正文引用到的附件属于别人时，不打包、记跳过", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    const { env, objects } = makeFakeEnv();

    // 账号 1 的附件（正常路径，顺带验证 currentUserId 会落到行上）
    api.setCurrentUser(1);
    await seed(api);
    objects.set("attach/test/att-1", new TextEncoder().encode("AAAAA").buffer as ArrayBuffer);
    const ownerCount = await db
        .prepare("SELECT COUNT(*) AS n FROM attachments WHERE user_id = 1")
        .first<{ n: number }>();
    assert.ok((ownerCount?.n ?? 0) >= 3, "createAttachment 必须把 currentUserId 落到行上");

    // 账号 2 的正文里出现了账号 1 的附件 id（uuid 泄漏 / 库被折腾过都可能）。
    // uuid 有主键约束不会跨账号重复，这个过滤是纵深防御：就算行在，也绝不能打包出去。
    await db.prepare(
        "INSERT INTO notes (user_id, uuid, title, content) VALUES (2, 'note-evil', '别人的笔记', '![x](/api/notes/attachments/att-1)')"
    ).run();
    api.setCurrentUser(2);
    const payload = await api.exportNotesData();
    assert.ok((payload.notes ?? []).some(n => n.content?.includes("att-1")), "前置：账号2的正文确实引用了 att-1");
    const { entries, skipped } = await readBackupAttachmentEntries(api, env, payload);
    assert.equal(entries.length, 0, "别人的附件绝不能进我的备份");
    assert.equal(skipped, 1, "引用到了但行不属于我 → 计入跳过，如实反映");
});
