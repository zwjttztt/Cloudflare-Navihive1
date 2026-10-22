// src/API/clientMethods/system.ts
// NavigationClient 的「system」域方法体：配置、AI、WebDAV / 记事本备份、导入导出、审计、运维统计、回收站 —— 站点级能力。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: ClientThis` 让 TS 认得 this，再由 client.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationClient，也别在模块顶层读它的状态。
//
// 拆分的理由（P2-10）：client.ts 一个文件里塞了传输层与 90 个业务方法，
// 想改「笔记附件怎么传」要在 1500 行里翻。按域分开之后，每个域自己长得清楚，
// 传输层的改动（超时 / 幂等头 / 错误翻译）也不会再和业务方法混在一处。
// 范式照抄 src/API/http.ts + methods/*.ts —— 那套已经跑了很久，
// 并且有 tests/clientSurface.test.ts 盯着「域没混回原型」这类静默失效。

import {
    NotesImportPayload,
    ExportData,
    ImportResult,
    BootstrapData,
    WebDavConfig,
    WebDavErrorCode,
    WebDavFile,
    WebDavResult,
    RecycleBatchRestoreResult,
    ImportOptions,
    ImportProgress,
    IMPORT_PROGRESS_MEDIA,
    AiStatus,
    AiSuggestResponse,
    AiTestResponse,
} from "../http";
import type {
    AiEmbedResponse,
    AiSearchResponse,
    AiSiteMetaResponse,
    AiStatusResponse,
    AiSuggestTagsResponse,
    AiTestResult,
    AuditLogResponse,
    BootstrapResponse,
    ClientErrorsResponse,
    ConfigBatchResponse,
    ConfigItemResponse,
    ConfigMapResponse,
    ConfigWriteResponse,
    ExportResponse,
    OpsStatsResponse,
    RecycleListResponse,
    RecyclePurgeBatchResponse,
    RecycleRestoreBatchResponse,
    RecycleSimpleResponse,
    WebDavDeleteResponse,
    WebDavDownloadResponse,
    WebDavListResponse,
    WebDavTestResponse,
    WebDavUploadResponse,
} from "../responses";
import type {
    SiteMetaSuggestion,
    TagSuggestion,
} from "../../utils/aiMeta";
import { parseApiError } from "../apiError";
import type { ClientThis } from "../transport";

async function importError(client: ClientThis, response: Response): Promise<Error> {
    let reason: string;
    try {
        const payload = await response.json();
        // parseApiError 同时认新形状 {error:{code,message}} 与旧的 {message} / {error:"字符串"}
        reason = parseApiError(payload, response.status)?.message || "";
    } catch {
        reason = "";
    }
    if (response.status === 401) client.clearToken();
    return new Error(
        reason ? `${reason} (HTTP ${response.status})` : `API错误: ${response.status}`
    );
}

async function readImportStream(
    body: ReadableStream<Uint8Array>,
    onProgress?: (progress: ImportProgress) => void
    ): Promise<ImportResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: ImportResult | null = null;
    let failure: string | null = null;

    const handle = (line: string) => {
        let event: { type?: string; message?: string; result?: ImportResult } & Partial<ImportProgress>;
        try {
            event = JSON.parse(line);
        } catch {
            return; // 半行 / 无关内容，跳过
        }
        if (event.type === "result" && event.result) {
            result = event.result;
        } else if (event.type === "error") {
            failure = event.message || "导入失败";
        } else if (event.type === "progress" && event.stage) {
            onProgress?.({
                stage: event.stage,
                done: event.done ?? 0,
                total: event.total ?? 0,
            });
        }
    };

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf("\n");
            while (nl >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) handle(line);
                nl = buffer.indexOf("\n");
            }
        }
        if (buffer.trim()) handle(buffer.trim());
    } finally {
        reader.releaseLock();
    }

    if (failure) throw new Error(failure);
    if (!result) throw new Error("导入中断：服务端没有返回结果");
    return result;
}

export const systemImpl = {
    async bootstrap(this: ClientThis): Promise<BootstrapData> {
        return this.request<BootstrapResponse>("bootstrap?full=1");
    },
    async checkMaintenance(this: ClientThis): Promise<boolean> {
        try {
            const res = await this.request<{ maintenance?: boolean }>("init");
            return res?.maintenance === true;
        } catch {
            // 探测失败不打扰用户：下个周期再试
            return false;
        }
    },
    async getConfigs(this: ClientThis): Promise<Record<string, string>> {
        return this.request<ConfigMapResponse>("configs");
    },
    async setConfigs(this: ClientThis, configs: Record<string, string>): Promise<boolean> {
        const result = await this.request<ConfigBatchResponse>("configs/batch", {
            method: "POST",
            body: JSON.stringify({ configs }),
        });
        return result?.success !== false;
    },
    async getConfig(this: ClientThis, key: string): Promise<string | null> {
        try {
            const response = await this.request<ConfigItemResponse>(`configs/${key}`);
            // 没配过的键服务端给 null / 干脆不给，这里统一成 null
            return response?.value ?? null;
        } catch {
            return null;
        }
    },
    async setConfig(this: ClientThis, key: string, value: string): Promise<boolean> {
        const response = await this.request<ConfigWriteResponse>(`configs/${key}`, {
            method: "PUT",
            body: JSON.stringify({ value }),
        });
        return response?.success !== false;
    },
    async deleteConfig(this: ClientThis, key: string): Promise<boolean> {
        const response = await this.request<ConfigWriteResponse>(`configs/${key}`, {
            method: "DELETE",
        });
        return response?.success !== false;
    },
    async compareAndSetConfig(this: ClientThis, key: string, expected: string | null, next: string): Promise<boolean> {
        const current = await this.getConfig(key);
        if (current !== expected) return false;
        return this.setConfig(key, next);
    },
    async aiStatus(this: ClientThis): Promise<AiStatus> {
        return this.request<AiStatusResponse>("ai/status");
    },
    async aiSiteMeta(this: ClientThis, payload: {
        url: string;
        name?: string;
        groups: string[];
        tags: string[];
    }): Promise<AiSuggestResponse<{ suggestion: SiteMetaSuggestion }>> {
        return this.request<AiSiteMetaResponse>("ai/site-meta", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    },
    async aiSuggestTags(this: ClientThis, payload: {
        sites: { id: number; name: string; url: string; description?: string }[];
        groups: string[];
        tags: string[];
    }): Promise<AiSuggestResponse<{ suggestions: TagSuggestion[] }>> {
        return this.request<AiSuggestTagsResponse>("ai/suggest-tags", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    },
    async aiEmbed(this: ClientThis, force = false): Promise<{
        success: boolean;
        done: number;
        total: number;
        model?: string;
        message?: string;
    }> {
        return this.request<AiEmbedResponse>("ai/embed", {
            method: "POST",
            body: JSON.stringify({ force }),
        });
    },
    async aiSearch(this: ClientThis, query: string, limit = 20): Promise<
        AiSuggestResponse<{ results: { id: number; score: number }[]; empty?: boolean }>
    > {
        return this.request<AiSearchResponse>("ai/search", {
            method: "POST",
            body: JSON.stringify({ query, limit }),
        });
    },
    async aiTest(this: ClientThis, settings: Partial<Record<string, string>>): Promise<AiTestResponse> {
        return this.request<AiTestResult>("ai/test", {
            method: "POST",
            body: JSON.stringify(settings),
        });
    },
    async exportData(this: ClientThis): Promise<ExportData> {
        return this.request<ExportResponse>("export");
    },
    async importData(this: ClientThis, data: ExportData, opts?: ImportOptions): Promise<ImportResult> {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.idempotencyKey) {
            headers["Idempotency-Key"] = this.idempotencyKey;
            this.idempotencyKey = null;
        }
        if (opts?.onProgress) headers["Accept"] = IMPORT_PROGRESS_MEDIA;

        // 模式走 query 而不是塞进 body：body 是备份文件原文，多一个字段就会让
        // 文件里那道内容摘要对不上（integrity 是对整份 payload 算的），好文件也被拦。
        const mode = opts?.mode === "overwrite" ? "overwrite" : "merge";
        const response = await fetch(
            `${this.baseUrl}/import${mode === "overwrite" ? "?mode=overwrite" : ""}`,
            {
                method: "POST",
                credentials: "same-origin",
                headers,
                body: JSON.stringify(data),
            }
        );

        const isStream =
            !!response.body &&
            (response.headers.get("Content-Type") || "").includes(IMPORT_PROGRESS_MEDIA);

        if (!isStream) {
            if (!response.ok) throw await importError(this, response);
            return (await response.json()) as ImportResult;
        }

        // 流式分支：HTTP 状态码已经在响应头里（2xx 才开始跑导入），
        // 真正的失败是流里最后那行 error
        return readImportStream(response.body, opts?.onProgress);
    },

    async webdavTest(this: ClientThis, config: Partial<WebDavConfig> = {}): Promise<WebDavResult> {
        return this.request<WebDavTestResponse>("webdav/test", {
            method: "POST",
            body: JSON.stringify(config),
        });
    },
    async webdavUpload(this: ClientThis, 
        config: Partial<WebDavConfig> = {},
        data?: ExportData,
        filename?: string
    ): Promise<WebDavResult<{ filename: string; size: number }>> {
        return this.request<WebDavUploadResponse>("webdav/upload", {
            method: "POST",
            body: JSON.stringify({ ...config, filename, data }),
        });
    },
    async webdavList(this: ClientThis, config: Partial<WebDavConfig> = {}): Promise<WebDavResult<WebDavFile[]>> {
        return this.request<WebDavListResponse>("webdav/list", {
            method: "POST",
            body: JSON.stringify(config),
        });
    },
    async webdavDownload(this: ClientThis, 
        filename: string,
        config: Partial<WebDavConfig> = {}
    ): Promise<WebDavResult<ExportData>> {
        return this.request<WebDavDownloadResponse>("webdav/download", {
            method: "POST",
            body: JSON.stringify({ ...config, filename }),
        });
    },
    async webdavDelete(this: ClientThis, filename: string, config: Partial<WebDavConfig> = {}): Promise<WebDavResult> {
        return this.request<WebDavDeleteResponse>("webdav/delete", {
            method: "POST",
            body: JSON.stringify({ ...config, filename }),
        });
    },
    async notesBackupTest(this: ClientThis): Promise<WebDavResult> {
        return this.request<WebDavTestResponse>("webdav/notes/test", {
            method: "POST",
            body: "{}",
        });
    },
    async notesBackupUpload(this: ClientThis): Promise<WebDavResult<{ filename: string; size: number }>> {
        return this.request<WebDavUploadResponse>("webdav/notes/upload", {
            method: "POST",
            body: "{}",
        });
    },
    async notesBackupListRemote(this: ClientThis): Promise<{
        success: boolean;
        message?: string;
        code?: WebDavErrorCode;
        files?: { name: string; size: number; lastModified: string }[];
    }> {
        return this.request<{
            success: boolean;
            message?: string;
            code?: WebDavErrorCode;
            files?: { name: string; size: number; lastModified: string }[];
        }>("webdav/notes/list", { method: "POST", body: "{}" });
    },
    async notesBackupDownload(this: ClientThis, 
        filename: string,
        password?: string
    ): Promise<{
        success: boolean;
        code?: WebDavErrorCode;
        message?: string;
        payload?: NotesImportPayload;
        /** ZIP 备份（2026-10-11 起，含附件）：服务端不解包，回 base64 由前端走附件回传导入 */
        zipBase64?: string;
    }> {
        return this.request<{
            success: boolean;
            code?: WebDavErrorCode;
            message?: string;
            payload?: NotesImportPayload;
            zipBase64?: string;
        }>("webdav/notes/download", {
            method: "POST",
            body: JSON.stringify({ filename, password: password || "" }),
        });
    },
    async notesBackupDeleteRemote(this: ClientThis, filename: string): Promise<WebDavResult> {
        return this.request<WebDavDeleteResponse>("webdav/notes/delete", {
            method: "POST",
            body: JSON.stringify({ filename }),
        });
    },
    async getAuditLog(this: ClientThis, opts: { limit?: number; offset?: number; actor?: string } = {}): Promise<{
        success: boolean;
        log: Array<{ id: number; action: string; actor: string; ip: string; detail: string; created_at: string }>;
        hasMore: boolean;
    }> {
        const params = new URLSearchParams();
        if (opts.limit) params.set("limit", String(opts.limit));
        if (opts.offset) params.set("offset", String(opts.offset));
        if (opts.actor) params.set("actor", opts.actor);
        return this.request<AuditLogResponse>(`audit?${params.toString()}`);
    },
    async getClientErrors(this: ClientThis, limit = 200): Promise<{
        success: boolean;
        groups: Array<{
            key: string;
            source: string;
            message: string;
            count: number;
            lastAt: string;
            paths: string[];
        }>;
    }> {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        return this.request<ClientErrorsResponse>(`client-errors?${params.toString()}`);
    },
    async getOpsStats(this: ClientThis): Promise<OpsStatsResponse> {
        return this.request<OpsStatsResponse>("stats");
    },
    async getRecycleBin(this: ClientThis, scope?: "nav" | "note"): Promise<{
        success: boolean;
        items: Array<{ id: number; kind: "site" | "group" | "note"; name: string; deletedAt: number }>;
    }> {
        return this.request<RecycleListResponse>(
            scope ? `recycle?kind=${scope}` : "recycle"
        );
    },
    async restoreRecycleItem(this: ClientThis, id: number): Promise<{ success: boolean }> {
        const res = await this.request<RecycleSimpleResponse>("recycle/restore", {
            method: "POST",
            body: JSON.stringify({ id }),
        });
        // 服务端没回 success 字段时按成功算：HTTP 200 就说明删/还原走通了
        return { success: res?.success !== false };
    },
    async purgeRecycleItem(this: ClientThis, id: number): Promise<{ success: boolean }> {
        const res = await this.request<RecycleSimpleResponse>("recycle/purge", {
            method: "POST",
            body: JSON.stringify({ id }),
        });
        return { success: res?.success !== false };
    },
    async restoreRecycleItems(this: ClientThis, ids: number[]): Promise<RecycleBatchRestoreResult> {
        const result = await this.request<RecycleRestoreBatchResponse>("recycle/restore-batch", {
            method: "POST",
            body: JSON.stringify({ ids }),
        });
        return {
            restored: Array.isArray(result?.restored) ? result.restored : [],
            failed: Array.isArray(result?.failed) ? result.failed : ids,
        };
    },
    async purgeRecycleItems(this: ClientThis, ids: number[]): Promise<{ purged: number[] }> {
        return this.request<RecyclePurgeBatchResponse>("recycle/purge-batch", {
            method: "POST",
            body: JSON.stringify({ ids }),
        });
    },
    async emptyRecycleBin(this: ClientThis, scope?: "nav" | "note"): Promise<{ success: boolean }> {
        const res = await this.request<RecycleSimpleResponse>(
            scope ? `recycle?kind=${scope}` : "recycle",
            { method: "DELETE" }
        );
        return { success: res?.success !== false };
    },
};
