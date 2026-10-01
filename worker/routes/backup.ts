// 备份与恢复路由：导出、导入、WebDAV 网盘。
//
// 从 worker/index.ts 拆出来。导出是「拿到会话后收益最大」的接口（整站数据 + 解密后的
// 站点密码），导入是「一觉醒来整站被换掉」的入口，所以两者的限速 / 体积上限都在这儿。
import type { ExportData, Group } from "../../src/API/http";
import {
    bumpGuard,
    computeLockAfterFailure,
    EXPORT_BASE_LOCK_MS,
    EXPORT_COUNT_RESET_MS,
    EXPORT_FREE_ATTEMPTS,
    EXPORT_GUARD_KEY,
    EXPORT_MAX_LOCK_MS,
    exportBucket,
    enforceWriteGuard,
    nextDecayedCount,
    nextExportCount,
    readExportGuard,
    writeBucket,
} from "../loginGuard";
import { isBodyTooLarge, safeJson } from "../util";
import {
    readAllConfigs,
    resolveWebDavConfig,
    runWebDavBackup,
    webdavDelete,
    webdavDownload,
    webdavList,
    webdavTest,
} from "../webdav";
import type { RouteCtx } from "./types";

/**
 * 单次导入的条数上限。
 *
 * 光限体积（10MB）不够：全是短记录的 JSON 能塞进几万条，整批 INSERT 会把 D1
 * 单次请求顶满，写一半失败还得回滚。正常备份远到不了这个量级，真超了多半是文件不对劲。
 */
const MAX_IMPORT_GROUPS = 2_000;
const MAX_IMPORT_SITES = 20_000;

export async function handleBackupRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        path,
        method,
        api,
        trustXFF,
        
    } = ctx;

    // 数据导出路由
    if (path === "export" && method === "GET") {
        // 一次导出 = 整站数据 + 解密后的站点密码，是拿到会话后收益最大的接口。
        // 先过一道限速（按账号 + 来源 IP 分桶），别让一个令牌把全站反复拖走
        const eBucket = exportBucket(request, api.getCurrentUserId(), trustXFF);
        const exportGuard = await readExportGuard(api, eBucket);
        const nowMs = Date.now();

        const rejectExport = (ms: number) =>
            Response.json(
                {
                    success: false,
                    message: `导出太频繁，请 ${Math.ceil(ms / 1000)} 秒后再试`,
                },
                { status: 429 }
            );

        // 还在上一次的锁定期里：直接挡回去
        if (exportGuard.until > nowMs) {
            return rejectExport(exportGuard.until - nowMs);
        }

        // 成功也计数：每次导出都是一次全量读取 + 逐条解密，成本是真的。
        // 但隔开一小时以上就从第 1 次重新数 —— 天天手动备份的人不该被越锁越久。
        //
        // 计数放进 CAS 循环里算（bumpGuard）：导出是最贵的一个接口，
        // 并发时若各自拿旧值覆盖写回，额度就会被反复刷新成小值，限不住。
        const bumped = await bumpGuard(api, EXPORT_GUARD_KEY, eBucket, prev => {
            const seen = prev.seen ?? 0;
            const count = nextDecayedCount({ ...prev, seen }, EXPORT_COUNT_RESET_MS, nowMs);
            const lock = computeLockAfterFailure(
                count,
                EXPORT_FREE_ATTEMPTS,
                EXPORT_BASE_LOCK_MS,
                EXPORT_MAX_LOCK_MS
            );
            // 超了额度就只记锁定时刻、不再往上加计数 ——
            // 否则「被拦了还一直点」会把等待时间越点越长
            return lock > 0
                ? { count: prev.count, until: nowMs + lock }
                : { count, until: 0 };
        });
        const exportCount = bumped?.count ?? nextExportCount(exportGuard, nowMs);
        if (bumped && bumped.until > nowMs) {
            return rejectExport(bumped.until - nowMs);
        }

        const data = await api.exportData();

        // 导出审计：整站数据 + 解密后的站点密码一次带走，值得留痕（与限速互补——
        // 限速挡频率，审计留证据）。失败不影响导出本身。
        try {
            const uid = api.getCurrentUserId();
            const ip =
                request.headers.get("CF-Connecting-IP") ||
                request.headers.get("X-Forwarded-For") ||
                "";
            await api.writeAudit(
                "data-export",
                uid === null ? "anonymous" : String(uid),
                ip,
                JSON.stringify({ count: exportCount })
            );
        } catch {
            // 审计写入失败不影响导出结果
        }

        // 引号包住文件名：RFC 6266 推荐，且文件名带空格/中文时不被截断
        return Response.json(data, {
            headers: {
                "Content-Disposition": 'attachment; filename="navihive-data.json"',
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            },
        });
    }

    // 数据导入路由
    else if (path === "import" && method === "POST") {
        // 导入是全局最贵的一次写：整批 INSERT 再整批 DELETE，中途失败还要回滚。
        // 先过写操作限速 —— 令牌泄露后被人反复丢大文件进来是最现实的打法。
        const limited = await enforceWriteGuard(api, writeBucket(request, api.getCurrentUserId(), trustXFF));
        if (limited) return limited;

        // 超大备份会拖垮 Worker：先用 Content-Length 拦一道（见 util.isBodyTooLarge）
        if (isBodyTooLarge(request)) {
            return Response.json(
                { success: false, message: "备份文件过大（上限 10MB），请精简后重试" },
                { status: 413 }
            );
        }
        const data = (await request.json()) as ExportData;

        // 验证导入数据（站点允许嵌套在分组中，兼容旧版备份格式）
        if (
            !data.groups ||
            !Array.isArray(data.groups) ||
            (data.configs !== undefined && typeof data.configs !== "object")
        ) {
            return Response.json(
                {
                    success: false,
                    message: "导入数据格式无效",
                },
                { status: 400 }
            );
        }

        // 体积之外再限一次条数：10MB 的 JSON 可以塞进几万条短记录，
        // 整批 INSERT 会把 D1 单次请求顶满、剩下的全失败（还得回滚）。
        // 正常备份远到不了这个量级，真超了说明文件不对劲。
        const groupCount = Array.isArray(data.groups) ? data.groups.length : 0;
        const siteCount = Array.isArray(data.sites) && data.sites.length > 0
            ? data.sites.length
            : data.groups.reduce((sum, group) => sum + (Array.isArray((group as Group & { sites?: unknown[] }).sites) ? (group as Group & { sites: unknown[] }).sites.length : 0), 0);
        if (groupCount > MAX_IMPORT_GROUPS || siteCount > MAX_IMPORT_SITES) {
            return Response.json(
                {
                    success: false,
                    message: `备份内容过多（分组上限 ${MAX_IMPORT_GROUPS}、站点上限 ${MAX_IMPORT_SITES}），请分批导入`,
                },
                { status: 413 }
            );
        }

        // 导入结果里带新旧 id 映射（前端的星标 / 标签要翻译到新 id 上）
        const result = await api.importData(data as ExportData);

        // 导出已经记了审计，导入同样要：它是唯一能「整体替换全站数据」的入口。
        // 数据已经换完了，审计写失败绝不能回滚导入 —— 所以整块包进 try。
        try {
            const uid = api.getCurrentUserId();
            const ip =
                request.headers.get("CF-Connecting-IP") ||
                request.headers.get("X-Forwarded-For") ||
                "";
            await api.writeAudit(
                "data-import",
                uid === null ? "anonymous" : String(uid),
                ip,
                JSON.stringify({ groups: groupCount, sites: siteCount })
            );
        } catch {
            // 同上：审计失败不影响导入结果
        }
        return Response.json(result);
    }

    // ============ WebDAV 备份相关路由（由 Worker 代理，避免浏览器跨域限制） ============
    else if (path === "webdav/test" && method === "POST") {
        // 只有这条允许「还没保存的临时配置」——填完想先试试正是它的用途
        const config = await resolveWebDavConfig(api, request, undefined, {
            allowBodyOverride: true,
        });
        const result = await webdavTest(config);
        return Response.json(result);
    } else if (path === "webdav/upload" && method === "POST") {
        // 备份数据整份进请求体，超大备份会拖垮 Worker（见 util.isBodyTooLarge）
        if (isBodyTooLarge(request)) {
            return Response.json(
                { success: false, message: "备份文件过大（上限 10MB），请精简后重试" },
                { status: 413 }
            );
        }
        const body = (await safeJson(request)) as {
            filename?: string;
            data?: ExportData;
        };
        const config = await resolveWebDavConfig(api, request, body);
        // 手动备份：不删任何已有备份（自动备份才滚动清理自己那一份）
        const stored = await readAllConfigs(api);
        // 备份口令来自配置（请求体优先，其次库里存的），与 AUTH_SECRET 无关
        const result = await runWebDavBackup(api, config, {
            mode: "manual",
            stored,
            data: body.data,
            password: config.backupPassword,
        });
        return Response.json(result);
    } else if (path === "webdav/list" && method === "POST") {
        const config = await resolveWebDavConfig(api, request);
        const result = await webdavList(config);
        return Response.json(result);
    } else if (path === "webdav/download" && method === "POST") {
        const body = (await safeJson(request)) as { filename?: string };
        const config = await resolveWebDavConfig(api, request, body);
        const result = await webdavDownload(config, body.filename || "", config.backupPassword);
        return Response.json(result);
    } else if (path === "webdav/delete" && method === "POST") {
        const body = (await safeJson(request)) as { filename?: string };
        const config = await resolveWebDavConfig(api, request, body);
        const result = await webdavDelete(config, body.filename || "");
        return Response.json(result);
    }

    return null;
}
