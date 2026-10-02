// src/API/methods/ai.ts
// NavigationAPI 的「ai」域方法体：只管 site_embeddings 这张表的读写。
//
// 模型的调用在 worker/ai.ts（那儿才有网络），提示词与结果清洗在 utils/aiMeta.ts（纯函数），
// 这里只做数据库。分三处是因为三件事的失败方式完全不同：
// 表读写失败要重试、模型失败要给用户提示、解析失败要当没给。

import type { NavigationAPI } from "../http";

export interface EmbeddingRow {
    /** 站点 id（不是向量表自己的行号） */
    id: number;
    vec: number[];
}

export interface AiApi {
    /** 取当前账号可见站点的向量（只取指定模型那份，换模型等于换一批数据） */
    listEmbeddings(model: string): Promise<EmbeddingRow[]>;
    /** 整批替换：新向量写入 + 其它模型的旧向量作废，一次 batch 完成 */
    replaceEmbeddings(rows: { siteId: number; vec: number[] }[], model: string): Promise<number>;
    countEmbeddings(model: string): Promise<number>;
    /** 删掉指定站点的向量（站点被删时跟着清） */
    deleteEmbeddings(siteIds: number[]): Promise<number>;
}

/** JSON 里的向量是普通数组，读出来要确认它是数组而不是被塞进来的别的东西 */
function parseVec(raw: unknown): number[] {
    if (typeof raw !== "string") return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(n => typeof n === "number" && Number.isFinite(n));
    } catch {
        return [];
    }
}

export const aiImpl: AiApi = {
    listEmbeddings: async function (this: NavigationAPI, model: string): Promise<EmbeddingRow[]> {
        // 必须 JOIN sites：向量是按站点存的，而站点是按账号隔离的，
        // 不加这个条件 A 账号的搜索会命中 B 账号的卡片（虽然只回一个 id，但也是泄露）。
        const rows = await this.db
            .prepare(
                `SELECT e.site_id AS id, e.vec AS vec
                 FROM site_embeddings e
                 JOIN sites s ON s.id = e.site_id
                 WHERE e.model = ?${this.scopeSql(true)}`
            )
            .bind(...this.scopeParams([model]))
            .all<{ id: number; vec: string }>();
        const out: EmbeddingRow[] = [];
        for (const row of rows.results ?? []) {
            const vec = parseVec(row.vec);
            if (vec.length > 0) out.push({ id: row.id, vec });
        }
        return out;
    },

    replaceEmbeddings: async function (
        this: NavigationAPI,
        rows: { siteId: number; vec: number[] }[],
        model: string
    ): Promise<number> {
        if (rows.length === 0) return 0;
        const now = new Date().toISOString();
        const statements = rows
            .filter(row => row.vec.length > 0)
            .map(row =>
                this.db
                    .prepare(
                        `INSERT INTO site_embeddings (site_id, model, dim, vec, updated_at)
                         VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT(site_id)
                         DO UPDATE SET model = ?, dim = ?, vec = ?, updated_at = ?`
                    )
                    .bind(
                        row.siteId,
                        model,
                        row.vec.length,
                        JSON.stringify(row.vec),
                        now,
                        model,
                        row.vec.length,
                        JSON.stringify(row.vec),
                        now
                    )
            );
        if (statements.length === 0) return 0;
        // 换模型之后旧向量不能留着：不同模型的向量之间比较毫无意义，
        // 留着只会让搜索结果莫名其妙。删旧 + 写新在同一个 batch 里。
        const stale = this.db.prepare("DELETE FROM site_embeddings WHERE model != ?").bind(model);
        await this.db.batch([stale, ...statements]);
        return statements.length;
    },

    countEmbeddings: async function (this: NavigationAPI, model: string): Promise<number> {
        const row = await this.db
            .prepare(
                `SELECT COUNT(*) AS n FROM site_embeddings e
                 JOIN sites s ON s.id = e.site_id
                 WHERE e.model = ?${this.scopeSql(true)}`
            )
            .bind(...this.scopeParams([model]))
            .first<{ n: number }>();
        return Number(row?.n ?? 0);
    },

    deleteEmbeddings: async function (this: NavigationAPI, siteIds: number[]): Promise<number> {
        if (siteIds.length === 0) return 0;
        const ids = siteIds.filter(id => Number.isInteger(id));
        if (ids.length === 0) return 0;
        const placeholders = ids.map(() => "?").join(",");
        const result = (await this.db
            .prepare(`DELETE FROM site_embeddings WHERE site_id IN (${placeholders})`)
            .bind(...ids)
            .run()) as { meta?: { changes?: number } };
        return Number(result.meta?.changes ?? 0);
    },
};
