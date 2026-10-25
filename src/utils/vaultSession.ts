// src/utils/vaultSession.ts
// 保险库的**会话编排**：把传输层（client 的密文方法）与加密度（vaultCrypto）拼成高层操作。
//
// 设计底线（对齐 docs/password-manager-plan-B.md）：
//   · **DEK 只在内存**——本模块把它装进返回的 VaultSession 交给调用方（UI）持有，
//     自己不写任何存储；锁定 = 调用方丢掉 session。
//   · 主密码**独立**于登录密码；忘密码走**恢复码**找回（解出同一 DEK 后用新主密码重裹）。
//   · 传输层用 VaultTransport 接口注入（真身是 NavigationClient，测试用内存替身）——
//     这样整条客户端流程能在 Node 里用**真 WebCrypto**跑通，不依赖浏览器/DOM。
import {
    VAULT_KDF_ITERS,
    b64ToBytes,
    bytesToB64,
    decryptJson,
    deriveWrappingKey,
    encryptJson,
    generateDek,
    generateRecoveryCode,
    generateSalt,
    normalizeRecoveryCode,
    unwrapDek,
    wrapDek,
} from "./vaultCrypto";
import type { VaultEntryInput, VaultEntryRecord, VaultKeysInput, VaultKeysRecord } from "../API/types";

/** 解锁后持有的会话：DEK 只在内存，锁定即丢弃 */
export interface VaultSession {
    dek: CryptoKey;
}

/** 一个解密后的条目（明文只在内存，绝不落盘） */
export interface DecryptedEntry {
    id: number;
    title: string;
    username: string;
    password: string;
    notes: string;
    url: string;
    siteId: number | null;
    updatedAt?: string;
}

export interface VaultEntryDraft {
    id?: number;
    title: string;
    username: string;
    password: string;
    notes: string;
    url: string;
    siteId?: number | null;
}

/** 传输层契约：只要这几个密文方法（NavigationClient 结构上即满足） */
export interface VaultTransport {
    getVaultKeys(): Promise<VaultKeysRecord | null>;
    saveVaultKeys(input: VaultKeysInput): Promise<boolean | void>;
    listVaultEntries(): Promise<VaultEntryRecord[]>;
    saveVaultEntry(input: VaultEntryInput): Promise<VaultEntryRecord>;
    deleteVaultEntry(id: number): Promise<boolean | void>;
}

/** 有没有建过库 */
export async function vaultExists(transport: VaultTransport): Promise<boolean> {
    return (await transport.getVaultKeys()) !== null;
}

/**
 * 建库：随机 DEK + 盐，主密码与恢复码各包一份上传。
 * 返回**一次性恢复码** —— 只在这时看得到，之后服务端只剩密文，忘密码只能靠它。
 */
export async function setupVault(
    transport: VaultTransport,
    masterPassword: string
): Promise<{ recoveryCode: string }> {
    const dek = await generateDek();
    const salt = generateSalt();
    const mk = await deriveWrappingKey(masterPassword, salt, VAULT_KDF_ITERS);
    const recoveryCode = generateRecoveryCode();
    const rk = await deriveWrappingKey(normalizeRecoveryCode(recoveryCode), salt, VAULT_KDF_ITERS);
    const wrappedMaster = await wrapDek(dek, mk);
    const wrappedRecovery = await wrapDek(dek, rk);
    const ok = await transport.saveVaultKeys({
        kdf_salt: bytesToB64(salt),
        kdf_iterations: VAULT_KDF_ITERS,
        wrapped_dek_iv: bytesToB64(wrappedMaster.iv),
        wrapped_dek: bytesToB64(wrappedMaster.ciphertext),
        wrapped_dek_recovery_iv: bytesToB64(wrappedRecovery.iv),
        wrapped_dek_recovery: bytesToB64(wrappedRecovery.ciphertext),
    });
    if (ok === false) throw new Error("保存保险库密钥失败");
    return { recoveryCode };
}

/** 解锁：主密码 → MK → 解 DEK。密码错 → AES-GCM 认证失败 → 抛错。 */
export async function unlockVault(transport: VaultTransport, masterPassword: string): Promise<VaultSession> {
    const keys = await transport.getVaultKeys();
    if (!keys) throw new Error("尚未创建保险库");
    const mk = await deriveWrappingKey(masterPassword, b64ToBytes(keys.kdf_salt), keys.kdf_iterations);
    const dek = await unwrapDek(
        { iv: b64ToBytes(keys.wrapped_dek_iv), ciphertext: b64ToBytes(keys.wrapped_dek) },
        mk
    );
    return { dek };
}

/** 改主密码（已解锁）：用当前 DEK 重裹一份新 MK；恢复码包裹不变（仍是同一 DEK）。 */
export async function changeMasterPassword(
    transport: VaultTransport,
    session: VaultSession,
    newMasterPassword: string
): Promise<void> {
    const keys = await transport.getVaultKeys();
    if (!keys) throw new Error("尚未创建保险库");
    const salt = b64ToBytes(keys.kdf_salt);
    const mk = await deriveWrappingKey(newMasterPassword, salt, VAULT_KDF_ITERS);
    const rewrapped = await wrapDek(session.dek, mk);
    const ok = await transport.saveVaultKeys({
        kdf_salt: bytesToB64(salt),
        kdf_iterations: VAULT_KDF_ITERS,
        wrapped_dek_iv: bytesToB64(rewrapped.iv),
        wrapped_dek: bytesToB64(rewrapped.ciphertext),
        wrapped_dek_recovery_iv: keys.wrapped_dek_recovery_iv,
        wrapped_dek_recovery: keys.wrapped_dek_recovery,
    });
    if (ok === false) throw new Error("重设主密码失败");
}

/**
 * 找回（忘了主密码）：恢复码 → RK → 解出同一 DEK → 用新主密码重裹上传。
 * 恢复码包裹保持不变（仍是同一 DEK，下次还能再用它——若想作废得轮换恢复码，此处从简）。
 */
export async function recoverVault(
    transport: VaultTransport,
    recoveryCode: string,
    newMasterPassword: string
): Promise<VaultSession> {
    const keys = await transport.getVaultKeys();
    if (!keys) throw new Error("尚未创建保险库");
    const salt = b64ToBytes(keys.kdf_salt);
    const rk = await deriveWrappingKey(normalizeRecoveryCode(recoveryCode), salt, keys.kdf_iterations);
    const dek = await unwrapDek(
        { iv: b64ToBytes(keys.wrapped_dek_recovery_iv), ciphertext: b64ToBytes(keys.wrapped_dek_recovery) },
        rk
    );
    const mk = await deriveWrappingKey(newMasterPassword, salt, VAULT_KDF_ITERS);
    const rewrapped = await wrapDek(dek, mk);
    const ok = await transport.saveVaultKeys({
        kdf_salt: bytesToB64(salt),
        kdf_iterations: VAULT_KDF_ITERS,
        wrapped_dek_iv: bytesToB64(rewrapped.iv),
        wrapped_dek: bytesToB64(rewrapped.ciphertext),
        wrapped_dek_recovery_iv: keys.wrapped_dek_recovery_iv,
        wrapped_dek_recovery: keys.wrapped_dek_recovery,
    });
    if (ok === false) throw new Error("重设主密码失败");
    return { dek };
}

/** 列全部条目并解密（明文只在内存） */
export async function listDecryptedEntries(
    transport: VaultTransport,
    session: VaultSession
): Promise<DecryptedEntry[]> {
    const rows = await transport.listVaultEntries();
    const out: DecryptedEntry[] = [];
    for (const row of rows) {
        const plain = await decryptJson<Omit<DecryptedEntry, "id" | "siteId" | "updatedAt">>(session.dek, {
            iv: b64ToBytes(row.iv),
            ciphertext: b64ToBytes(row.ciphertext),
        });
        out.push({
            id: row.id,
            siteId: row.site_id,
            updatedAt: row.updated_at,
            title: plain.title ?? "",
            username: plain.username ?? "",
            password: plain.password ?? "",
            notes: plain.notes ?? "",
            url: plain.url ?? "",
        });
    }
    return out;
}

/** 加密保存一条（带 id = 更新） */
export async function saveEncryptedEntry(
    transport: VaultTransport,
    session: VaultSession,
    draft: VaultEntryDraft
): Promise<DecryptedEntry> {
    const blob = await encryptJson(session.dek, {
        title: draft.title,
        username: draft.username,
        password: draft.password,
        notes: draft.notes,
        url: draft.url,
    });
    const row = await transport.saveVaultEntry({
        id: draft.id,
        ciphertext: bytesToB64(blob.ciphertext),
        iv: bytesToB64(blob.iv),
        site_id: draft.siteId ?? null,
    });
    return {
        id: row.id,
        siteId: row.site_id,
        updatedAt: row.updated_at,
        title: draft.title,
        username: draft.username,
        password: draft.password,
        notes: draft.notes,
        url: draft.url,
    };
}

/** 删一条 */
export async function deleteEntry(transport: VaultTransport, id: number): Promise<void> {
    await transport.deleteVaultEntry(id);
}
