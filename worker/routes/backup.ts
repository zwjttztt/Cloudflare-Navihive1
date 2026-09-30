// 备份与恢复路由：导出、导入、WebDAV 网盘。
//
// 从 worker/index.ts 拆出来。导出是「拿到会话后收益最大」的接口（整站数据 + 解密后的
// 站点密码），导入是「一觉醒来整站被换掉」的入口，所以两者的限速 / 体积上限都在这儿。
import type { ExportData } from "../../src/API/http";
import {
    computeLockAfterFailure,
    EXPORT_BASE_LOCK_MS,
    EXPORT_FREE_ATTEMPTS,
    EXPORT_MAX_LOCK_MS,
    exportBucket,
    nextExportCount,
    readExportGuard,
    writeExportGuard,
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
        // 但隔开一小时以上就从第 1 次重新数 —— 天天手动备份的人不该被越锁越久
        const exportCount = nextExportCount(exportGuard, nowMs);
        const lockMs = computeLockAfterFailure(
            exportCount,
            EXPORT_FREE_ATTEMPTS,
            EXPORT_BASE_LOCK_MS,
            EXPORT_MAX_LOCK_MS
        );
        if (lockMs > 0) {
            // 这一趟超了额度：只记锁定时刻，不再往上加计数 ——
            // 否则「被拦了还一直点」会把等待时间越点越长
            await writeExportGuard(
                api,
                { count: exportGuard.count, until: nowMs + lockMs },
                eBucket
            );
            return rejectExport(lockMs);
        }

        await writeExportGuard(api, { count: exportCount, until: 0 }, eBucket);

        const data = await api.exportData();
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

        // 导入结果里带新旧 id 映射（前端的星标 / 标签要翻译到新 id 上）
        const result = await api.importData(data as ExportData);
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
