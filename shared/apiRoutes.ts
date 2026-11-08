// shared/apiRoutes.ts
// 端点清单（前后端共用）+ 请求超时档位的解析。
//
// 为什么要有这份文件（2026-11）：超时档位原来是**靠端点名猜**的 ——
//
//     /upload|download|backup|import|export|restore|icon/i.test(endpoint) ? 0 : 30s
//
// 于是「改个端点名」就等于「静默改掉超时语义」，而猜错的代价两头都疼：
//   · 猜成「不限时」→ 真卡死时前端永远等下去。现成的受害者是 `recycle/restore`
//     （回收站恢复，一次普通 DB 操作，几十毫秒该回来），它名字里有 restore，
//     就被划进了 0 —— 卡住时前端没有超时、没有报错，只有一个转不完的圈。
//   · 猜成「30 秒」→ 大文件上传必然超时，报出来的却是「请求超时（30 秒无响应）」，
//     用户会以为是服务器挂了。
//
// 现在档位是**数据**，不看端点名。
//
// ⚠️ 布局上的取舍（别「顺手合并」回去，会直接把首屏预算撑爆）：
//    这个文件被 src/API/client.ts import，**进首屏包**，而首屏只剩 ~1.4 KB 余量
//    （见 tests/bundleBudget.test.ts 的两条 5% 余量用例）。所以文件分成两层：
//
//      · **进包的那层**：`timeoutTierOf()` + 两张很小的例外清单（13 条路径、~300 B）。
//        它只回答「这个端点等多久」，不回答「这个端点存不存在」。
//      · **不进包的那层**：`API_ROUTES` 全量清单 + `resolveRouteTier()`（带 `known`）。
//        只有测试与 worker 侧用得到；client.ts 不 import 它们，打包时被树摇掉。
//
//    一开始是把 tier 写在清单每一条上的（`"notes/import": { …, timeout: "none" }`），
//    结果 63 条路径 + 解析器压到 1.6 KB，两条 5% 余量用例直接红 —— 而且那份清单
//    89% 的字节都花在「这个端点跟默认一样」上。拆两层之后，例外清单只有 13 条，
//    全量清单留在文件里照旧可读，两者**各说一件事、没有重复的真相**：
//      清单说有这个端点；例外清单说这条不等默认的 30 秒。
//
// tests/apiRoutesContract.test.ts 会双向钉住：清单里每条都能 resolveRouteTier（known）、
// 例外清单里每条都能在清单里精确找到（防手抖写错路径），且例外路径没有子路径
// （`timeoutTierOf` 是精确匹配，不是前缀匹配 —— 有子路径就会静默退回默认档）。

/** 超时档位。毫秒值不在这里 —— 常量留在 src/API/client.ts（那边已导出，测试直接 import） */
export type TimeoutTier = "default" | "none" | "attachment-upload";

// ============================================================================
// 第一层：进首屏包的部分（只回答「等多久」）
// ============================================================================

/**
 * 不设超时的端点（0 秒）。
 *
 * 共同点：**耗时由数据量决定，客户端预估不了** —— 整库导出、WebDAV 整包上传/下载、
 * 记事本整份导入、图标代理取远端图。给它们定时长，正常请求也会被判超时。
 *
 * 档位曾经是靠 `/upload|download|backup|import|export|restore|icon/` 猜的，
 * 结果 `recycle/restore`（回收站恢复，普通 DB 操作）被名字连累进了这一档 ——
 * 它现在是默认档，**别再加回来**。
 *
 * ⚠️ 这里一律是**精确路径**（timeoutTierOf 不做前缀匹配）。要加带子路径的端点，
 *    先想清楚它的子路径该不该跟着一起放宽 —— 附件本体与 `notes/attachments/{id}`
 *    就是活例子：本体要 240 秒，子路径必须留在默认档。
 */
export const NO_TIMEOUT_ROUTES: readonly string[] = [
    // 整份数据搬进搬出
    "export",
    "notes/import",
    // WebDAV：传的是整个备份包
    "webdav/upload",
    "webdav/download",
    "webdav/notes/upload",
    "webdav/notes/download",
    // 图标代理：慢在别人家的服务器上
    "icon",
    // 已下线但历史档位被 tests/clientTimeout.test.ts 钉住的旧路径（见 RETIRED_ROUTES）
    "backup/upload",
    "backup/download",
    "notes/backup/upload",
    "notes/export",
    "transfer/export",
    "transfer/restore",
];

/**
 * 附件**本体**上传的路径（唯一走 `attachment-upload` 档的端点）。
 *
 * 240 秒的依据见 src/API/client.ts 的 ATTACHMENT_UPLOAD_TIMEOUT_MS：
 * 单文件上限 25MB，25MB/240s ≈ 107KB/s，覆盖到弱网的上行。
 *
 * ⚠️ 只认**精确**路径：`notes/attachments/list`（列元数据）、`notes/attachments/{id}`
 *    （删除 / 改名）、`/{id}/content`（改写）都只是几百字节的 JSON 往返 ——
 *    给它们 4 分钟等一个卡死的请求毫无意义，真卡住了就该 30 秒失败让用户重试。
 */
const ATTACHMENT_UPLOAD_PATH = "notes/attachments";

/**
 * 这个端点该走哪一档超时（不问「端点存不存在」，那是 resolveRouteTier 的事）。
 *
 * 精确匹配，不做前缀：非默认档的端点全是精确端点，而"前缀放宽"是最容易扩散的错 ——
 * `notes/attachments` 一旦按前缀匹配，整个附件的 CRUD 都会拿到 240 秒。
 *
 * @param endpoint 客户端要请求的端点，如 `notes/attachments?filename=a.png`
 *   （真实调用里 query 直接跟在路径后面，所以先剥 `?` 再比）。
 */
export function timeoutTierOf(endpoint: string): TimeoutTier {
    const query = endpoint.indexOf("?");
    const path = query < 0 ? endpoint : endpoint.slice(0, query);
    if (path === ATTACHMENT_UPLOAD_PATH) return "attachment-upload";
    return NO_TIMEOUT_ROUTES.includes(path) ? "none" : "default";
}

// ============================================================================
// 第二层：不进首屏包的部分（回答「这个端点登记过没有」）
//
// ⚠️ 下面这些只许测试与 worker 侧引用。**前端（src/ 下的运行时代码）不要 import** ——
//    一旦被 import，这 63 条路径会跟着进首屏包，把 1.4 KB 的余量吃到见底。
// ============================================================================

/**
 * 全量端点清单：路径 → 允许的方法。
 *
 * 这份清单存在的意义不是给超时用的（档位在 timeoutTierOf 那两张小表里），
 * 而是让「新端点忘了登记」变成一条会红的断言：resolveRouteTier 的 `known`
 * 直接查它，tests/apiRoutesContract.test.ts 再拿它去核 worker 侧有没有人认领。
 *
 * 方法列表只用于契约用例的正向覆盖，不参与超时判定（超时是按端点分的，
 * 同一端点的方法共用一档）。
 */
export const API_ROUTES = {
    // ---- 账号 / 会话 ----
    "auth/credentials": "PUT",
    "auth/recovery-status": "GET",
    sessions: "GET",
    "sessions/revoke-others": "POST",
    // ---- 首屏 / 配置 ----
    bootstrap: "GET",
    init: "GET",
    configs: "GET",
    "configs/batch": "POST",
    // ---- 分组 / 站点 ----
    groups: "GET,POST",
    sites: "GET,POST",
    "sites/changes": "GET",
    "sites/batch-delete": "POST",
    "group-orders": "PUT",
    "site-orders": "PUT",
    // ---- 记事本 ----
    notes: "GET,POST",
    // 多选删除：一次请求搬完（逐条 DELETE 在 N 条时要等 N 个串行 RTT，界面一条条消失）。
    // 默认 30s 档即可 —— 别加进 NO_TIMEOUT_ROUTES，耗时不是「由数据量决定、客户端预估不了」的整库搬运。
    "notes/batch-delete": "POST",
    "note-orders": "PUT",
    "notes/changes": "GET",
    "notes/count": "GET",
    "notes/stats": "GET",
    "notes/search": "POST",
    "notes/shares": "GET",
    "notes/reindex": "POST",
    "notes/folders": "GET,POST",
    "notes/tags": "GET,POST",
    "notes/tag-links": "GET",
    "notes/attachments": "POST",
    "notes/attachments/list": "GET",
    "notes/attachments/prune": "POST",
    "notes/import": "POST",
    // ---- 回收站 ----
    recycle: "GET,DELETE",
    "recycle/restore": "POST",
    "recycle/restore-batch": "POST",
    "recycle/purge": "POST",
    "recycle/purge-batch": "POST",
    // ---- 备份 / WebDAV ----
    export: "GET",
    "webdav/test": "POST",
    "webdav/list": "POST",
    "webdav/delete": "POST",
    "webdav/upload": "POST",
    "webdav/download": "POST",
    "webdav/notes/test": "POST",
    "webdav/notes/list": "POST",
    "webdav/notes/delete": "POST",
    "webdav/notes/upload": "POST",
    "webdav/notes/download": "POST",
    // ---- AI ----
    "ai/status": "GET",
    "ai/test": "POST",
    "ai/site-meta": "POST",
    "ai/suggest-tags": "POST",
    "ai/embed": "POST",
    "ai/search": "POST",
    // ---- 运维 ----
    audit: "GET",
    "client-errors": "GET",
    stats: "GET",
    // ---- 图标代理 ----
    icon: "GET",
    // ---- 保险库 ----
    "vault/keys": "GET,PUT",
    "vault/entries": "GET,POST",
} as const;

/**
 * 客户端历史上用过、**服务端早已没有对应分支**的路径。
 *
 * 它们只被一处引用：tests/clientTimeout.test.ts 用它们钉住「搬整份数据的端点不设超时」
 * 这条历史结论（所以这 6 条也在 NO_TIMEOUT_ROUTES 里）。留着是为了让那批断言继续成立，
 * 不是给新端点留后门 —— 新端点必须进 API_ROUTES，否则 `known=false` 会让契约用例变红。
 *
 * ⚠️ 这 6 条是**死路径**，别照着它们加新条目：真实端点已经改名
 * （备份上传/下载走 `webdav/upload`、`webdav/download`，整库导出走 `export`）。
 */
export const RETIRED_ROUTES = [
    "backup/upload",
    "backup/download",
    "notes/backup/upload",
    "notes/export",
    "transfer/export",
    "transfer/restore",
] as const;

/**
 * 把一个端点解析成「档位 + 这个端点登记过没有」。
 *
 * ⚠️ 只有测试 / worker 侧用它。前端用 timeoutTierOf —— 那个不带全量清单，
 *    才不会把清单打进首屏包（本文件顶部那段注释讲了为什么不许合并）。
 *
 * `known` 的用处只有一个：让「新端点忘了登记」变成一条会红的断言，而不是静默
 * 退化到默认档。运行时不看它（未知路径按默认档走 —— 注意是默认档而不是不限时档，
 * 退化方向必须是「更早失败」）。
 *
 * 前缀语义只影响 `known`（`sites` 也算 `sites/12` 的归宿），不影响档位：
 * 档位永远是精确匹配，见 timeoutTierOf。
 *
 * ⚠️ 别把 `Object.keys(API_ROUTES)` 提到模块顶层存成一个常量（"省一次调用"）——
 *    那是一次带副作用的顶层求值，打包器会认为它不可省，于是整份清单**跟着进首屏包**。
 *    实测：提成顶层常量后首屏 index chunk +0.24 KB，正好把 5% 余量顶穿。
 */
export function resolveRouteTier(endpoint: string): { tier: TimeoutTier; known: boolean } {
    const query = endpoint.indexOf("?");
    const path = query < 0 ? endpoint : endpoint.slice(0, query);
    const known =
        Object.keys(API_ROUTES).some((key) => path === key || path.startsWith(`${key}/`)) ||
        RETIRED_ROUTES.some((key) => path === key || path.startsWith(`${key}/`));
    return { tier: timeoutTierOf(path), known };
}
