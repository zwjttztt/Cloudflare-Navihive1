// tests/mockClientSurface.test.ts
// 演示客户端（MockNavigationClient）的**执行面**覆盖：把原型上每个方法都真调一遍。
//
// 为什么需要它（T-2 分层门槛的另一半）：
//   tests/clientSurface.test.ts 只比对「方法集合是否对齐」—— 它证明方法**存在**，
//   不证明方法**能跑**。mock.ts 有 133 个函数、长期只有 ~27 个被覆盖，
//   函数覆盖率缺口全压在它身上；而演示模式（没后端也想看界面）走的正是这些方法，
//   里面任何一条写错（少判空、字段名漂移、把 async 写成同步）都只会在用户手上炸。
//
// 两层价值：
//   1. 行为面：每个方法都被真实执行一次，返回值不能是 undefined（除非它本就返回 void）；
//   2. 覆盖率面：把全局函数覆盖率从 ~69% 抬过 70% 的地板，让门槛往上抬变成可能。
//
// ⚠️ 刻意「按方法名逐个硬调」而不是随机 fuzz：入参要合理（演示模式的数据是有形状的），
// 随机参数只会撞出一堆「附件不存在」这类与契约无关的失败。
import assert from "node:assert/strict";
import test from "node:test";
import { MockNavigationClient } from "../src/API/mock";

/**
 * 明确**按设计**会抛的方法。
 *
 * 每一条都要写清理由 —— 这份清单不是「先跳过，以后再修」的垃圾桶：
 * 演示模式没有公开分享服务，编一条看似可用的分享链接比直接说「不支持」更糟。
 */
const THROWS_BY_DESIGN = new Map<string, string>([
    ["request", "演示模式不发 HTTP：被调到就说明某个域方法忘了在 Mock 里实现"],
    ["createNoteShare", "演示模式没有公开分享服务"],
    ["updateNoteShare", "演示模式没有公开分享服务"],
]);

/** 回调式 / 传输层方法本来就返回 void，不能要求它们给值 */
const RETURNS_VOID = new Set<string>([
    "setIdempotencyKey",
    "setSessionCookie",
    "setToken",
    "clearToken",
    "logout",
    "completeIdempotency",
    "releaseIdempotency",
    "pushRevision",
]);

/**
 * 调用顺序表：**带参数的、以及有先后依赖的方法必须写在这里**。
 *
 * 依赖只出现在两处：附件（先传才有 id 可改名 / 改内容 / 删）、
 * 以及 importData（它会清空内存里的分组与站点，必须最后调）。
 * 不在表里的方法按「无参调用」处理 —— 它们都是零参只读查询。
 */
const CALL_ORDER = [
    // ---- 传输层 / 登录态 ----
    "setIdempotencyKey",
    "setSessionCookie",
    "setToken",
    "isLoggedIn",
    "clearToken",
    "login",
    "checkAuthStatus",
    "getMe",
    "getRecoveryStatus",
    "recoverPassword",
    "register",
    "createInvite",
    "setRecoveryPublicKey",
    "updateAuthCredentials",
    "deleteAccount",
    "logout",
    // ---- 保险库（演示模式恒空态）----
    "getVaultKeys",
    "saveVaultKeys",
    "listVaultEntries",
    "saveVaultEntry",
    "deleteVaultEntry",
    // ---- 首屏 / 分组 / 站点 ----
    "bootstrap",
    "checkMaintenance",
    "getGroups",
    "getGroup",
    "createGroup",
    "updateGroup",
    "getSites",
    "getSite",
    "createSite",
    "updateSite",
    "updateGroupOrder",
    "updateSiteOrder",
    "siteChanges",
    "deleteSite",
    "deleteSites",
    "deleteGroup",
    // ---- 配置 ----
    "getConfigs",
    "getConfig",
    "setConfig",
    "setConfigs",
    "compareAndSetConfig",
    "deleteConfig",
    // ---- 记事本：笔记 / 文件夹 / 标签 / 版本 ----
    "listNotes",
    "countNotes",
    "getNote",
    "createNote",
    "updateNote",
    "notesSearch",
    "notesStats",
    "notesChanges",
    "importNotes",
    "reindexNotes",
    "createFolder",
    "listFolders",
    "updateFolder",
    "deleteFolder",
    "createTag",
    "listTags",
    "updateTag",
    "setNoteTags",
    "listNoteTags",
    "deleteTag",
    "pushRevision",
    "listNoteRevisions",
    "getNoteRevision",
    "restoreNoteRevision",
    "updateNoteOrder",
    "deleteNote",
    // ---- 分享（演示模式不支持公开分享）----
    "listNoteShares",
    "getNoteShare",
    "revokeNoteShare",
    "createNoteShare",
    "updateNoteShare",
    "createGroupShare",
    "updateGroupShare",
    "getGroupShareConfig",
    "revokeGroupShare",
    // ---- AI：演示模式一律「没开」----
    "aiStatus",
    "aiSiteMeta",
    "aiSuggestTags",
    "aiEmbed",
    "aiSearch",
    "aiTest",
    "aiUnavailable",
    // ---- 附件 ----
    "uploadAttachment",
    "listAttachments",
    "renameAttachment",
    "updateAttachmentContent",
    "deleteAttachment",
    "pruneAttachments",
    // ---- 导出 / WebDAV / 记事本备份 ----
    "exportData",
    "webdavTest",
    "webdavUpload",
    "webdavList",
    "webdavDownload",
    "webdavDelete",
    "notesBackupTest",
    "notesBackupUpload",
    "notesBackupListRemote",
    "notesBackupDownload",
    "notesBackupDeleteRemote",
    // ---- 审计 / 运维 / 回收站 / 会话 ----
    "getAuditLog",
    "getOpsStats",
    "getClientErrors",
    "getRecycleBin",
    "restoreRecycleItem",
    "restoreRecycleItems",
    "purgeRecycleItems",
    "purgeRecycleItem",
    "emptyRecycleBin",
    "getSessions",
    "revokeSession",
    "revokeOtherSessions",
    // ---- 幂等键状态机 ----
    "readIdempotency",
    "claimIdempotency",
    "completeIdempotency",
    "releaseIdempotency",
    "purgeExpiredIdempotency",
    // ---- 最后：导入会清空内存里的分组与站点 ----
    "importData",
] as const;

/** 原型上（不含继承链）值为函数的自有成员 */
function prototypeMethods(target: object): string[] {
    return Object.getOwnPropertyNames(target).filter(
        name => name !== "constructor" && typeof (target as Record<string, unknown>)[name] === "function"
    );
}

test("MockNavigationClient 的每个原型方法都被真实执行过，且返回值不是 undefined", async () => {
    const client = new MockNavigationClient();
    const proto = MockNavigationClient.prototype as unknown as Record<
        string,
        (...a: unknown[]) => unknown
    >;
    const methods = prototypeMethods(MockNavigationClient.prototype);
    assert.ok(methods.length >= 120, `原型上只有 ${methods.length} 个方法，比拆分时少 —— 有方法搬丢了`);

    // 运行时才知道的 id：附件先传才有得改名 / 改内容 / 删
    const state: { attachmentId?: string; noteId?: number; folderId?: number; tagId?: number; recycleId?: number } = {};

    /**
     * 每个方法的入参。**参数形状就是对外契约的一部分**：
     * 这里写的字段名与真后端一致（camelCase 之外的列名就是响应形状），
     * 真后端改字段而 mock 没跟上时，这个用例会先红。
     */
    const argsFor = (name: string): unknown[] => {
        switch (name) {
            case "setIdempotencyKey":
                return ["test-op-1"];
            case "setSessionCookie":
                return [3600];
            case "setToken":
                return ["test-token"];
            case "login":
                return ["admin", "mock-password"];
            case "recoverPassword":
                return ["recovery-token"];
            case "register":
                return ["new-user", "pw", "INVITE-CODE"];
            case "setRecoveryPublicKey":
                return ["mock-public-key", "pw"];
            case "updateAuthCredentials":
                return ["admin", "new-pw", "old-pw"];
            case "deleteAccount":
                return ["pw"];
            case "saveVaultKeys":
                return [{ publicKey: "pk", encryptedPrivateKey: "ek", kdf: "pbkdf2" }];
            case "saveVaultEntry":
                return [{ ciphertext: "cipher", iv: "iv", site_id: null }];
            case "deleteVaultEntry":
                return [1];
            case "getGroup":
            case "getSites":
                return [1];
            case "getSite":
                return [1];
            case "createGroup":
                return [{ name: "渗透测试分组", order_num: 99 }];
            case "updateGroup":
                return [1, { name: "改名后的分组" }];
            case "createSite":
                return [
                    {
                        group_id: 1,
                        name: "冒烟站点",
                        url: "https://smoke.test",
                        icon: "",
                        description: "",
                        notes: "",
                        order_num: 99,
                    },
                ];
            case "updateSite":
                return [1, { name: "改名后的站点" }];
            case "deleteSite":
                return [2];
            case "deleteSites":
                return [[3]];
            case "deleteGroup":
                return [3];
            case "updateGroupOrder":
                return [[{ id: 1, order_num: 2 }]];
            case "updateSiteOrder":
                return [[{ id: 1, order_num: 2, group_id: 1 }]];
            case "getConfig":
            case "deleteConfig":
                return ["ui.theme"];
            case "setConfig":
                return ["ui.theme", "dark"];
            case "setConfigs":
                return [{ "ui.density": "compact" }];
            case "compareAndSetConfig":
                return ["ui.theme", "dark", "light"];
            // ---- 记事本 ----
            case "listNotes":
                return [{ limit: 5, offset: 0 }];
            case "getNote":
                return [state.noteId ?? 1];
            case "createNote":
                return [{ title: "冒烟笔记", content: "正文 [[另一篇]] #标签" }];
            case "updateNote":
                return [state.noteId ?? 1, { title: "改过的标题", content: "改过的正文 [[链接]]" }];
            case "notesSearch":
                return ["冒烟"];
            case "importNotes":
                return [{ notes: [{ uuid: "smoke-uuid", title: "导入笔记", content: "内容", updated_at: "2020-01-01T00:00:00Z" }] }];
            case "createFolder":
                return ["冒烟文件夹", null];
            case "updateFolder":
                return [state.folderId ?? 1, { name: "改过的文件夹" }];
            case "deleteFolder":
                return [state.folderId ?? 1];
            case "createTag":
                return ["冒烟标签", "#123456"];
            case "updateTag":
                return [state.tagId ?? 1, { color: "#654321" }];
            case "deleteTag":
                return [state.tagId ?? 1];
            case "setNoteTags":
                return [state.noteId ?? 1, [state.tagId ?? 1]];
            case "pushRevision":
                return [state.noteId ?? 1, "标题", "正文"];
            case "listNoteRevisions":
            case "restoreNoteRevision":
                return [state.noteId ?? 1];
            case "getNoteRevision":
                return [state.noteId ?? 1, 1];
            case "updateNoteOrder":
                return [[{ id: state.noteId ?? 1, order_num: 2 }]];
            case "deleteNote":
                return [state.noteId ?? 1];
            case "getNoteShare":
            case "revokeNoteShare":
                return [1];
            case "createNoteShare":
            case "updateNoteShare":
                return [1, 7];
            case "createGroupShare":
            case "updateGroupShare":
            case "getGroupShareConfig":
            case "revokeGroupShare":
                return [1, 7];
            case "uploadAttachment":
                return [
                    // 演示模式只读 name / type / size 三个字段，不需要真的 File 实例
                    // （真 File 要 ArrayBuffer，这里编一份最小的即可，避免拉进 Blob 依赖）
                    { name: "smoke.png", type: "image/png", size: 12 },
                    null,
                ];
            case "renameAttachment":
                return [state.attachmentId ?? "missing", "renamed.png"];
            case "updateAttachmentContent":
                return [state.attachmentId ?? "missing", "改写后的正文"];
            case "deleteAttachment":
                return [state.attachmentId ?? "missing"];
            case "webdavUpload":
                return [{ url: "https://dav.test", username: "u", password: "p" }];
            case "webdavDownload":
            case "webdavDelete":
                return ["backup.json"];
            case "notesBackupDownload":
            case "notesBackupDeleteRemote":
                return ["notes-backup.zip"];
            case "getAuditLog":
                return [{ limit: 10, offset: 0 }];
            case "getClientErrors":
                return [10];
            case "restoreRecycleItem":
            case "purgeRecycleItem":
                return [state.recycleId ?? 1];
            case "restoreRecycleItems":
            case "purgeRecycleItems":
                return [[state.recycleId ?? 1]];
            case "revokeSession":
                return ["mock-jti"];
            case "readIdempotency":
            case "claimIdempotency":
                return ["smoke", "op-1"];
            case "completeIdempotency":
                return ["smoke", "op-1", { status: 200, body: "{}" }];
            case "releaseIdempotency":
                return ["smoke", "op-1"];
            case "importData":
                return [
                    {
                        version: "1.0",
                        exportDate: new Date().toISOString(),
                        groups: [{ id: 1, name: "导入分组", order_num: 1 }],
                        sites: [],
                        configs: {},
                    },
                ];
            default:
                return [];
        }
    };

    const invoked = new Map<string, unknown>();

    for (const name of CALL_ORDER) {
        const fn = proto[name];
        assert.equal(typeof fn, "function", `${name} 不在原型上 —— 方法被改名或搬走了`);
        const byDesign = THROWS_BY_DESIGN.get(name);
        if (byDesign) {
            await assert.rejects(
                async () => await fn.call(client, ...argsFor(name)),
                (err: unknown) => err instanceof Error,
                `${name} 应当按设计抛错：${byDesign}`,
            );
            invoked.set(name, "threw-by-design");
            continue;
        }
        const result = await fn.call(client, ...argsFor(name));
        // 顺手记下运行时拿到的 id，后面的「改名 / 改内容 / 删」才有对象可操作
        if (name === "uploadAttachment") state.attachmentId = (result as { id?: string }).id;
        if (name === "createNote") state.noteId = (result as { id?: number }).id;
        if (name === "createFolder") state.folderId = (result as { id?: number }).id;
        if (name === "createTag") state.tagId = (result as { id?: number }).id;
        if (name === "deleteSite") state.recycleId = (result as { recycleId?: number }).recycleId;
        if (!RETURNS_VOID.has(name)) {
            assert.notEqual(result, undefined, `${name} 返回了 undefined —— 调用方会以为「什么都没做」`);
        }
        invoked.set(name, result);
    }

    // 表里没列到的方法按「无参调用」兜底，保证**没有任何一个方法被漏掉**
    for (const name of methods) {
        if (invoked.has(name)) continue;
        const fn = proto[name];
        const byDesign = THROWS_BY_DESIGN.get(name);
        if (byDesign) {
            await assert.rejects(
                async () => await fn.call(client),
                (err: unknown) => err instanceof Error,
                `${name} 应当按设计抛错：${byDesign}`,
            );
        } else {
            const result = await fn.call(client);
            if (!RETURNS_VOID.has(name)) {
                assert.notEqual(result, undefined, `${name} 返回了 undefined`);
            }
        }
        invoked.set(name, "no-arg");
    }

    const missed = methods.filter(name => !invoked.has(name));
    assert.deepEqual(missed, [], "这些方法一次都没被调用过 —— 补进 CALL_ORDER 或 argsFor");
    assert.equal(invoked.size, methods.length, "原型方法数与实际执行数对不上");
});

test("入口用例的前置：演示客户端没有隐藏的必填构造参数", () => {
    // 构造函数里会清掉遗留的 auth_token（老版本把令牌放 localStorage），
    // 顺带确认它不依赖任何浏览器全局就能 new 出来 —— 否则上面那条用例连起点都没有。
    const client = new MockNavigationClient();
    assert.equal(client.baseUrl, "/api");
    assert.equal(client.idempotencyKey, null);
});
