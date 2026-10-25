// src/API/methods/vault.ts
// 保险库（方案 B，端到端加密）的服务端方法体。
//
// ⚠️ **这里只搬密文，绝不做加解密**：所有方法存/取的都是 base64 密文字段，
// 服务端（以及任何拿到数据库的人）解不出明文，也数不出条目内容。
// 明文的加解密全在客户端 utils/vaultCrypto.ts 做；服务端连「条目叫什么」都不知道。
// 账号隔离沿用 scopeSql/scopeParams（单账号部署 uid 可能是 NULL，用 `IS ?` 兼容，见 data.ts）。
//
// 与其它域同一套约定：`this: NavigationAPI` + migrate + withSchemaRetry，由 navigationApi.ts 混回原型。
import type { NavigationAPI } from "../http";
import type { VaultEntryInput, VaultEntryRecord, VaultKeysInput, VaultKeysRecord } from "../types";

export interface VaultApi {
    /** 取当前账号的 vault_keys（没有则 null = 还没建库） */
    getVaultKeys(): Promise<VaultKeysRecord | null>;
    /** 建库 / 改主密码：上传 KDF 参数 + 两份包好的 DEK（每账号一行，upsert） */
    saveVaultKeys(input: VaultKeysInput): Promise<void>;
    /** 列当前账号的全部条目（只有密文，按更新时间倒序） */
    listVaultEntries(): Promise<VaultEntryRecord[]>;
    /** 新建 / 更新一条（带 id = 更新）；回传落库后的行 */
    saveVaultEntry(input: VaultEntryInput): Promise<VaultEntryRecord>;
    /** 删一条 */
    deleteVaultEntry(id: number): Promise<{ success: boolean }>;
}

export const vaultImpl: VaultApi = {
    getVaultKeys: async function (this: NavigationAPI): Promise<VaultKeysRecord | null> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(
                    `SELECT kdf_salt, kdf_iterations, wrapped_dek_iv, wrapped_dek,
                            wrapped_dek_recovery_iv, wrapped_dek_recovery, updated_at
                     FROM vault_keys${this.scopeSql(false)}`
                )
                .bind(...this.scopeParams([]))
                .first<VaultKeysRecord>();
            return row ?? null;
        });
    },

    saveVaultKeys: async function (this: NavigationAPI, input: VaultKeysInput): Promise<void> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            // 每账号一行：有则更新（改主密码就是重裹 wrapped_dek），无则插入。
            const existing = await this.db
                .prepare(`SELECT id FROM vault_keys${this.scopeSql(false)}`)
                .bind(...this.scopeParams([]))
                .first<{ id: number }>();
            if (existing) {
                await this.db
                    .prepare(
                        `UPDATE vault_keys
                         SET kdf_salt = ?, kdf_iterations = ?, wrapped_dek_iv = ?, wrapped_dek = ?,
                             wrapped_dek_recovery_iv = ?, wrapped_dek_recovery = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?${this.scopeSql(true)}`
                    )
                    .bind(
                        ...this.scopeParams([
                            input.kdf_salt,
                            input.kdf_iterations,
                            input.wrapped_dek_iv,
                            input.wrapped_dek,
                            input.wrapped_dek_recovery_iv,
                            input.wrapped_dek_recovery,
                            existing.id,
                        ])
                    )
                    .run();
            } else {
                await this.db
                    .prepare(
                        `INSERT INTO vault_keys
                            (user_id, kdf_salt, kdf_iterations, wrapped_dek_iv, wrapped_dek,
                             wrapped_dek_recovery_iv, wrapped_dek_recovery)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`
                    )
                    .bind(
                        this.currentUserId,
                        input.kdf_salt,
                        input.kdf_iterations,
                        input.wrapped_dek_iv,
                        input.wrapped_dek,
                        input.wrapped_dek_recovery_iv,
                        input.wrapped_dek_recovery
                    )
                    .run();
            }
        });
    },

    listVaultEntries: async function (this: NavigationAPI): Promise<VaultEntryRecord[]> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const result = await this.db
                .prepare(
                    `SELECT id, ciphertext, iv, site_id, created_at, updated_at
                     FROM vault_entries${this.scopeSql(false)}
                     ORDER BY updated_at DESC, id DESC`
                )
                .bind(...this.scopeParams([]))
                .all<VaultEntryRecord>();
            return result.results || [];
        });
    },

    saveVaultEntry: async function (this: NavigationAPI, input: VaultEntryInput): Promise<VaultEntryRecord> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            if (typeof input.id === "number") {
                // 更新：带账号隔离，改不到别人的条目（改 0 行 → 不存在/越权）
                const row = await this.db
                    .prepare(
                        `UPDATE vault_entries
                         SET ciphertext = ?, iv = ?, site_id = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?${this.scopeSql(true)}
                         RETURNING id, ciphertext, iv, site_id, created_at, updated_at`
                    )
                    .bind(...this.scopeParams([input.ciphertext, input.iv, input.site_id ?? null, input.id]))
                    .all<VaultEntryRecord>();
                if (row.results?.length) return row.results[0];
                throw new Error("保险库条目不存在或不属于当前账号");
            }
            const row = await this.db
                .prepare(
                    `INSERT INTO vault_entries (user_id, ciphertext, iv, site_id)
                     VALUES (?, ?, ?, ?)
                     RETURNING id, ciphertext, iv, site_id, created_at, updated_at`
                )
                .bind(this.currentUserId, input.ciphertext, input.iv, input.site_id ?? null)
                .all<VaultEntryRecord>();
            if (!row.results?.length) throw new Error("保存保险库条目失败");
            return row.results[0];
        });
    },

    deleteVaultEntry: async function (this: NavigationAPI, id: number): Promise<{ success: boolean }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            await this.db
                .prepare(`DELETE FROM vault_entries WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run();
            return { success: true };
        });
    },
};
