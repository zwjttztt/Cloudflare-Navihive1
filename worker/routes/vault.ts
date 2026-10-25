// 保险库路由（方案 B）：vault/keys 与 vault/entries 的读 / 写 / 删。
//
// ⚠️ 服务端**只搬密文**：请求体里的 ciphertext / iv / wrapped_dek 都是客户端加好的密文，
// 路由不做任何加解密、也不理解内容，原样交给 api.* 落库。账号隔离由 api 层的 scopeSql 保证，
// 登录门槛由 PROTECTED_ROUTES（index.ts）统一给 —— 这个文件只管路径分发 + 形状校验。
import { ApiError, errorResponse } from "../lib/apiError";
import type { VaultEntryInput, VaultKeysInput } from "../../src/API/types";
import type { RouteCtx } from "./types";
import { readJsonBody } from "./jsonBody";
import { enforceWriteGuard, writeBucket } from "../loginGuard";

const ENTRIES_PREFIX = "vault/entries/";

export async function handleVaultRoutes(ctx: RouteCtx): Promise<Response | null> {
    const { path, method, api, request, trustXFF } = ctx;

    // 写操作限速（与 data.ts 同一把 writeGate）：改主密码 / 建改删条目都走它。
    // 必须在任何写分支落库前拦一道 —— 否则一个泄露的令牌能反复改写保险库。
    const writeGate = (): Promise<Response | null> =>
        enforceWriteGuard(api, writeBucket(request, api.getCurrentUserId(), trustXFF));

    // ---- vault/keys：读 KDF 参数 + 两份包好的 DEK；写 = 建库 / 改主密码（upsert 一行）----
    if (path === "vault/keys" && method === "GET") {
        return Response.json(await api.getVaultKeys());
    }
    if (path === "vault/keys" && (method === "PUT" || method === "POST")) {
        const limited = await writeGate();
        if (limited) return limited;
        const body = await readJsonBody<VaultKeysInput>(request);
        const ok =
            typeof body.kdf_salt === "string" && body.kdf_salt.length > 0 &&
            Number.isInteger(body.kdf_iterations) && body.kdf_iterations > 0 &&
            typeof body.wrapped_dek === "string" && body.wrapped_dek.length > 0 &&
            typeof body.wrapped_dek_iv === "string" && body.wrapped_dek_iv.length > 0 &&
            typeof body.wrapped_dek_recovery === "string" && body.wrapped_dek_recovery.length > 0 &&
            typeof body.wrapped_dek_recovery_iv === "string" && body.wrapped_dek_recovery_iv.length > 0;
        if (!ok) return errorResponse(ApiError.badRequest("vault_keys 形状不完整"));
        await api.saveVaultKeys(body);
        return Response.json({ success: true });
    }

    // ---- vault/entries：列 / 建·改 / 删 ----
    if (path === "vault/entries" && method === "GET") {
        return Response.json(await api.listVaultEntries());
    }
    if (path === "vault/entries" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const body = await readJsonBody<VaultEntryInput>(request);
        if (typeof body.ciphertext !== "string" || body.ciphertext.length === 0 ||
            typeof body.iv !== "string" || body.iv.length === 0) {
            return errorResponse(ApiError.badRequest("vault 条目缺少 ciphertext / iv"));
        }
        if (body.id !== undefined && !Number.isInteger(body.id)) {
            return errorResponse(ApiError.badRequest("vault 条目 id 非法"));
        }
        const record = await api.saveVaultEntry(body);
        return Response.json(record);
    }
    if (path.startsWith(ENTRIES_PREFIX) && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;
        const id = Number(path.slice(ENTRIES_PREFIX.length));
        if (!Number.isInteger(id) || id <= 0) {
            return errorResponse(ApiError.badRequest("vault 条目 id 非法"));
        }
        return Response.json(await api.deleteVaultEntry(id));
    }

    return null;
}
