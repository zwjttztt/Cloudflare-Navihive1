// src/API/responses.ts
// 后端各端点「成功时返回什么」的类型表。
//
// 以前 client.request<T = any>() 默认 any：外层方法写了 `Promise<Group[]>` 就直接放行，
// 服务端形状变了编译器一句话都不会说。这里把形状写死成类型，调用点显式传泛型，
// 于是「端点形状」和「调用方期望」两边任一处改动都会在 tsc 那一关卡住。
//
// 滚动收敛：新端点请顺手在这里登记；没登记的端点因为没有默认 any 可依赖，
// 不写泛型就是 unknown，编译过不去 —— 这正是留在这里的驱动力。
import type {
    AiStatus,
    AiSuggestResponse,
    AiTestResponse,
    BootstrapData,
    ExportData,
    Group,
    RecycleBatchRestoreResult,
    SessionInfo,
    Site,
    SiteBatchDeleteResult,
    SiteOrderUpdateResult,
    WebDavFile,
    WebDavResult,
} from "./http";
import type { SiteMetaSuggestion, TagSuggestion } from "../utils/aiMeta";

/** 只回 success 的那一类端点（批量写 / 删除 / 清空） */
export interface OkResponse {
    success?: boolean;
}

/** 带一句说明的操作结果（改密、吊销会话等） */
export interface MessageResponse extends OkResponse {
    message?: string;
}

/** 删掉一个分组 / 站点：成功之外还带回回收站条目 id，供「撤销」定位 */
export interface SoftDeleteResponse extends OkResponse {
    recycleId?: number;
}

/** GET configs：键 → 值 */
export type ConfigMapResponse = Record<string, string>;

/** GET configs/{key} */
export interface ConfigItemResponse {
    key: string;
    value?: string | null;
}

/** POST configs/batch */
export interface ConfigBatchResponse extends OkResponse {
    saved?: number;
}

/** PUT / DELETE configs/{key} */
export type ConfigWriteResponse = OkResponse;

/** GET auth/recovery-status */
export interface RecoveryStatusResponse {
    configured: boolean;
}

/** PUT auth/credentials（改管理员账号密码） */
export type AuthCredentialsResponse = MessageResponse;

/** PUT group-orders / site-orders（site-orders 兼容老服务端，字段可能缺失） */
export type GroupOrdersResponse = OkResponse;
export type SiteOrdersResponse = Partial<SiteOrderUpdateResult>;

/** POST sites/batch-delete */
export type SiteBatchDeleteResponse = SiteBatchDeleteResult;

/** AI：把站点文本换成向量 */
export interface AiEmbedResponse {
    success: boolean;
    done: number;
    total: number;
    model?: string;
    message?: string;
}

/** AI：抓站点元信息 */
export type AiSiteMetaResponse = AiSuggestResponse<{ suggestion: SiteMetaSuggestion }>;

/** AI：批量标签建议 */
export type AiSuggestTagsResponse = AiSuggestResponse<{ suggestions: TagSuggestion[] }>;

/** AI：语义搜索 */
export type AiSearchResponse = AiSuggestResponse<{
    results: { id: number; score: number }[];
    empty?: boolean;
}>;

/** AI：测试连接 */
export type AiTestResult = AiTestResponse;

/** GET ai/status */
export type AiStatusResponse = AiStatus;

/** GET export */
export type ExportResponse = ExportData;

/** WebDAV 各端点 */
export type WebDavTestResponse = WebDavResult;
export type WebDavUploadResponse = WebDavResult<{ filename: string; size: number }>;
export type WebDavListResponse = WebDavResult<WebDavFile[]>;
export type WebDavDownloadResponse = WebDavResult<ExportData>;
export type WebDavDeleteResponse = WebDavResult;

/** GET audit（owner 只读） */
export interface AuditLogResponse {
    success: boolean;
    log: Array<{
        id: number;
        action: string;
        actor: string;
        ip: string;
        detail: string;
        created_at: string;
    }>;
    hasMore: boolean;
}

/** GET client-errors（owner 只读，前端报错的聚合视图） */
export interface ClientErrorsResponse {
    success: boolean;
    groups: Array<{
        key: string;
        source: string;
        message: string;
        count: number;
        lastAt: string;
        paths: string[];
    }>;
}

/** GET recycle */
export interface RecycleListResponse {
    success: boolean;
    items: Array<{ id: number; kind: "site" | "group"; name: string; deletedAt: number }>;
}

/** POST recycle/restore、DELETE recycle */
export type RecycleSimpleResponse = OkResponse;

/** POST recycle/restore-batch（兼容老服务端，字段可能缺失） */
export type RecycleRestoreBatchResponse = Partial<RecycleBatchRestoreResult>;

/** POST recycle/purge-batch */
export interface RecyclePurgeBatchResponse {
    purged: number[];
}

/** GET sessions */
export interface SessionsResponse extends OkResponse {
    sessions?: SessionInfo[];
}

/** DELETE sessions/{jti} */
export type RevokeSessionResponse = MessageResponse;

/** POST sessions/revoke-others */
export interface RevokeOthersResponse extends OkResponse {
    revoked: number;
}

/** GET groups / GET sites / GET bootstrap 这些列表端点 */
export type GroupListResponse = Group[];
export type SiteListResponse = Site[];
export type BootstrapResponse = BootstrapData;
