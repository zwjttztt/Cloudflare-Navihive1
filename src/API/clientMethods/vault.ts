// src/API/clientMethods/vault.ts
// NavigationClient 的「vault」域（方案 B 保险库）—— **只搬密文的传输层**。
//
// 五个方法一一对应 worker/routes/vault.ts。加解密全在客户端上层做
// （utils/vaultCrypto + VaultDialog），这里只把密文原样发/收，不理解内容。
// 与 mock 的方法名对齐由 tests/apiMockParity.test.ts 盯；域是否混回原型由
// tests/clientSurface.test.ts 盯。
import type { ClientThis } from "../transport";
import type { VaultEntryInput, VaultEntryRecord, VaultKeysInput, VaultKeysRecord } from "../types";

export const vaultImpl = {
    /** 取当前账号的 vault_keys；没建库时服务端回 null */
    async getVaultKeys(this: ClientThis): Promise<VaultKeysRecord | null> {
        return this.request<VaultKeysRecord | null>("vault/keys");
    },
    /** 建库 / 改主密码：上传 KDF 参数 + 两份包好的 DEK（每账号一行 upsert） */
    async saveVaultKeys(this: ClientThis, input: VaultKeysInput): Promise<boolean> {
        const res = await this.request<{ success?: boolean }>("vault/keys", {
            method: "PUT",
            body: JSON.stringify(input),
        });
        return res?.success !== false;
    },
    /** 列当前账号全部条目（只有密文，按更新时间倒序） */
    async listVaultEntries(this: ClientThis): Promise<VaultEntryRecord[]> {
        const res = await this.request<VaultEntryRecord[]>("vault/entries");
        return Array.isArray(res) ? res : [];
    },
    /** 新建 / 更新一条（带 id = 更新）；回传落库后的行 */
    async saveVaultEntry(this: ClientThis, input: VaultEntryInput): Promise<VaultEntryRecord> {
        return this.request<VaultEntryRecord>("vault/entries", {
            method: "POST",
            body: JSON.stringify(input),
        });
    },
    /** 删一条 */
    async deleteVaultEntry(this: ClientThis, id: number): Promise<boolean> {
        const res = await this.request<{ success?: boolean }>(`vault/entries/${id}`, {
            method: "DELETE",
        });
        return res?.success !== false;
    },
};
