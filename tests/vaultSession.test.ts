// tests/vaultSession.test.ts
// 保险库**客户端全流程**在 Node 里用真 WebCrypto 跑一遍（传输层用内存替身）。
//
// 为什么值得单测：B4 的 UI（VaultDialog）本身难在 jsdom 里跑真 crypto.subtle，
// 但"建库→解锁→加改删→忘密码靠恢复码找回→改密"这条链是安全核心，必须在真加密下证明。
// 这里绕开 DOM，直接测 vaultSession 编排 + 真 vaultCrypto，传输层注入内存替身。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    setupVault,
    unlockVault,
    recoverVault,
    changeMasterPassword,
    listDecryptedEntries,
    saveEncryptedEntry,
    deleteEntry,
    vaultExists,
    type VaultTransport,
} from "../src/utils/vaultSession";
import type { VaultEntryInput, VaultEntryRecord, VaultKeysInput, VaultKeysRecord } from "../src/API/types";

/** 内存替身传输层：keys 一行 + entries 多行，行为对齐服务端（upsert / RETURNING / 隔离无关，这里单账号） */
function makeTransport() {
    let keys: VaultKeysRecord | null = null;
    let seq = 0;
    const entries: VaultEntryRecord[] = [];
    const t: VaultTransport = {
        async getVaultKeys() { return keys; },
        async saveVaultKeys(input: VaultKeysInput) { keys = { ...input, updated_at: new Date().toISOString() }; return true; },
        async listVaultEntries() {
            return [...entries].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
        },
        async saveVaultEntry(input: VaultEntryInput): Promise<VaultEntryRecord> {
            if (typeof input.id === "number") {
                const e = entries.find(x => x.id === input.id);
                if (!e) throw new Error("not found");
                e.ciphertext = input.ciphertext; e.iv = input.iv; e.site_id = input.site_id ?? null;
                seq += 1; e.updated_at = new Date(Date.now() + seq).toISOString();
                return { ...e };
            }
            seq += 1;
            const now = new Date(Date.now() + seq).toISOString();
            const row: VaultEntryRecord = { id: seq, ciphertext: input.ciphertext, iv: input.iv, site_id: input.site_id ?? null, created_at: now, updated_at: now };
            entries.push(row);
            return { ...row };
        },
        async deleteVaultEntry(id: number) {
            const i = entries.findIndex(x => x.id === id);
            if (i >= 0) entries.splice(i, 1);
            return true;
        },
    };
    return t;
}

const MASTER = "correct horse battery staple";

test("建库 → 解锁 → 加/改/列/删 全流程", async () => {
    const t = makeTransport();
    assert.equal(await vaultExists(t), false, "一开始没有库");

    const { recoveryCode } = await setupVault(t, MASTER);
    assert.match(recoveryCode, /^[0-9A-F]{5}(-[0-9A-F]{5}){9}$/, "恢复码格式");
    assert.equal(await vaultExists(t), true, "建库后存在");

    const session = await unlockVault(t, MASTER);
    const created = await saveEncryptedEntry(t, session, {
        title: "GitHub", username: "me", password: "s3cr3t!", notes: "2FA", url: "https://github.com",
    });
    assert.ok(created.id > 0);

    const updated = await saveEncryptedEntry(t, session, {
        id: created.id, title: "GitHub", username: "me", password: "new-pass-123", notes: "", url: "https://github.com",
    });
    assert.equal(updated.id, created.id);

    let list = await listDecryptedEntries(t, session);
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "GitHub");
    assert.equal(list[0].password, "new-pass-123", "更新后的密码应解出来");

    // 新开一个会话（重新解锁）也能解出同一条 —— 证明密文确实落库、可重复解密
    const session2 = await unlockVault(t, MASTER);
    list = await listDecryptedEntries(t, session2);
    assert.equal(list[0].password, "new-pass-123");

    await deleteEntry(t, created.id);
    assert.equal((await listDecryptedEntries(t, session2)).length, 0, "删完为空");
});

test("错主密码解不开（抛错，不会静默给空会话）", async () => {
    const t = makeTransport();
    await setupVault(t, MASTER);
    await assert.rejects(() => unlockVault(t, "wrong password"), "错主密码必须抛错");
});

test("🔴 忘了主密码：恢复码找回 → 解出同一 DEK → 数据一条不少 → 之后用新主密码", async () => {
    const t = makeTransport();
    const { recoveryCode } = await setupVault(t, MASTER);
    const s0 = await unlockVault(t, MASTER);
    await saveEncryptedEntry(t, s0, { title: "银行", username: "alice", password: "p@ss", notes: "", url: "" });
    await saveEncryptedEntry(t, s0, { title: "邮箱", username: "bob", password: "mail-pass", notes: "", url: "" });

    // 忘主密码 → 用恢复码 + 设一个新主密码
    const recovered = await recoverVault(t, recoveryCode, "brand-new-master-2026");
    const list = await listDecryptedEntries(t, recovered);
    assert.equal(list.length, 2, "找回后两条数据都还在");
    const titles = list.map(e => e.title);
    assert.equal(titles.length, 2);
    assert.ok(titles.includes("银行") && titles.includes("邮箱"), `找回后应含两条，实际 ${JSON.stringify(titles)}`);

    // 找回后：新主密码能解锁，旧主密码失效
    const sNew = await unlockVault(t, "brand-new-master-2026");
    assert.equal((await listDecryptedEntries(t, sNew)).length, 2);
    await assert.rejects(() => unlockVault(t, MASTER), "旧主密码应已失效");
});

test("改主密码（已解锁）：新密码能解、旧密码失效、数据不变", async () => {
    const t = makeTransport();
    await setupVault(t, MASTER);
    const s = await unlockVault(t, MASTER);
    await saveEncryptedEntry(t, s, { title: "SSH", username: "root", password: "key-pass", notes: "", url: "" });

    await changeMasterPassword(t, s, "rotated-master-999");
    const s2 = await unlockVault(t, "rotated-master-999");
    const list = await listDecryptedEntries(t, s2);
    assert.equal(list.length, 1);
    assert.equal(list[0].password, "key-pass", "改密不丢数据");
    await assert.rejects(() => unlockVault(t, MASTER), "旧主密码应失效");
});
