// tests/notesBackupFetch.test.ts
//
// 2026-10-16 用户报「笔记 WebDAV 恢复失败」的守卫。
//
// 服务端对 ZIP 备份（2026-10-11 起默认格式，含附件）**不解包**，
// 回的是顶层 `zipBase64`（webdav/notes/download）。NotesOverlay 要把后端返回值
// 换算成 NotesPage 要的形状时漏掉了这一个字段，于是设置弹窗里
// `payload` / `zipBase64` 双空 → 走 else 把 `message`（服务端这里放的是文件名）
// 当错误亮出来：界面上就一行红色文件名，看起来像「下载失败」。
//
// 换算逻辑抽成了 utils/notesBackupAdapter.ts 的 notesBackupFetchResult
// （否则只能对着组件源码做静态断言），这里直接按后端真实形状喂进去，逐字段钉死。
import test from "node:test";
import assert from "node:assert/strict";
import { notesBackupFetchResult } from "../src/utils/notesBackupAdapter";

test("ZIP 备份：zipBase64 必须原样透传（漏了它恢复一定失败）", () => {
    const out = notesBackupFetchResult({
        success: true,
        message: "navihive-notes-backup-manual-20261016-134504-491.zip",
        zipBase64: "UEsDBAoAAAAAAA==",
    });
    assert.equal(out.success, true, "成功标志要带上");
    assert.equal(
        out.zipBase64,
        "UEsDBAoAAAAAAA==",
        "zipBase64 必须原样透传给设置弹窗 —— 漏了就没有东西能交给 ZIP 导入链路，恢复必失败"
    );
    assert.equal(out.payload, undefined, "ZIP 备份后端不给 payload，别自己编一个");
    assert.equal(out.code, undefined);
});

test("旧备份格式：顶层 payload / code / message 三个字段都不能丢", () => {
    const payload = { notes: [], folders: [], tags: [], noteTags: {} } as never;
    const out = notesBackupFetchResult({
        success: true,
        message: "navihive-notes-backup-auto-20261001-030000-000.json.gz",
        payload,
    });
    assert.equal(out.payload, payload, "顶层 payload（request 不包 data 层）必须原样带上");
    assert.equal(out.message, "navihive-notes-backup-auto-20261001-030000-000.json.gz");

    // 加密 / 口令错：code 是前端弹口令框的唯一依据
    const enc = notesBackupFetchResult({ success: false, message: "这份备份是加密的", code: "encrypted" });
    assert.equal(enc.code, "encrypted", "code=encrypted 要带过去（前端据此弹口令框）");
    const bad = notesBackupFetchResult({ success: false, message: "密码不对", code: "badPassword" });
    assert.equal(bad.code, "badPassword", "code=badPassword 要带过去（前端据此留框重填）");
});

test("缺失字段要补默认：message 空串、success 原样", () => {
    const out = notesBackupFetchResult({ success: false });
    assert.equal(out.success, false);
    assert.equal(out.message, "", "message 缺失时补空串，别把 undefined 塞给界面");
    assert.equal(out.zipBase64, undefined);
    assert.equal(out.payload, undefined);
});
