// 运维类路由：审计日志与回收站。
//
// 从 worker/index.ts 拆出来。两个都是「事后补救」性质的只读 / 撤销入口，
// 审计只有 owner 能看，回收站按账号隔离。
import {} from "../httpUtils";
import type { RouteCtx } from "./types";
import { ApiError, errorResponse } from "../lib/apiError";
import { readJsonBody } from "./jsonBody";
import { enforceWriteGuard, writeBucket } from "../loginGuard";

export async function handleOpsRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        url,
        path,
        method,
        api,
        ip,
        // ⚠️ 必须解构出来传给 writeBucket：第三参默认 false，
        // 不传的话自托管（反代后面）所有用户共用一个桶 → 限速变成随机误伤。
        trustXFF,
        
    } = ctx;

    /**
     * 写操作限速闸门：回收站那五条写路由（还原 / 永久删除 / 两个批量版 / 清空）。
     *
     * 这些是全站最危险的写操作 —— 永久删除不可逆、清空一次能抹掉几千行，
     * 而「批量」版一条请求就能发几百个 id。裸奔时一次令牌泄露就能把整站清干净。
     * 与 data.ts 同构：放行返回 null，撞上限速返回填好 Retry-After 的 429。
     * 读路由（audit / stats / client-errors / recycle 列表）不过闸。
     */
    const writeGate = (): Promise<Response | null> =>
        enforceWriteGuard(api, writeBucket(request, api.getCurrentUserId(), trustXFF));

    // 审计日志只读视图（仅 owner）。谁在何时从哪 IP 做了什么，事后能溯源。
    if (path === "audit" && method === "GET") {
        const uid = api.getCurrentUserId();
        const me = uid !== null ? await api.getUserById(uid) : null;
        if (!me || me.role !== "owner") {
            return errorResponse(ApiError.forbidden("仅站点所有者可以查看审计日志"));
        }
        const limit = Math.min(
            Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1),
            200
        );
        const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
        const actor = url.searchParams.get("actor") || undefined;
        const log = await api.getAuditLog({ limit, offset, actor });
        return Response.json({ success: true, log, hasMore: log.length === limit });
    }

    // 运维统计看板聚合（仅 owner）：内容计数 / 近 30 天审计活跃 / 分享浏览 Top / 链接健康。
    if (path === "stats" && method === "GET") {
        const uid = api.getCurrentUserId();
        const me = uid !== null ? await api.getUserById(uid) : null;
        if (!me || me.role !== "owner") {
            return errorResponse(ApiError.forbidden("仅站点所有者可以查看统计看板"));
        }
        const stats = await api.getOpsStats();
        return Response.json({ success: true, stats });
    }

    // 前端错误上报的聚合视图（仅 owner）。
    // 上报本身是公开接口（崩在登录页的错误也要能报上来），所以「看」必须收口：
    // 聚合结果里带着页面路径与错误信息，不该让随便哪个账号都能翻。
    if (path === "client-errors" && method === "GET") {
        const uid = api.getCurrentUserId();
        const me = uid !== null ? await api.getUserById(uid) : null;
        if (!me || me.role !== "owner") {
            return errorResponse(ApiError.forbidden("仅站点所有者可以查看错误上报"));
        }
        const limit = Math.min(
            Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1),
            500
        );
        const groups = await api.getClientErrors(limit);
        return Response.json({ success: true, groups });
    }

    // 回收站：列出当前账号软删除的站点 / 分组（?kind=nav|note 分家：
    // 导航站的回收站只看站点/分组，记事本的回收站只看笔记 —— 互不可见互不误伤）
    if (path === "recycle" && method === "GET") {
        const kind = url.searchParams.get("kind");
        const scope = kind === "nav" || kind === "note" ? kind : undefined;
        const items = await api.listRecycleBin(scope);
        return Response.json({ success: true, items });
    }
    // 回收站：还原一条
    if (path === "recycle/restore" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const body = (await readJsonBody(request)) as { id?: number };
        const id = typeof body.id === "number" ? body.id : NaN;
        if (isNaN(id)) {
            return errorResponse(ApiError.badRequest("缺少有效的 id"));
        }
        const ok = await api.restoreRecycleItem(id);
        await api.writeAudit("recycle.restore", "", ip, `回收站条目 ${id}`);
        return Response.json({ success: ok });
    }
    // 回收站：永久删除一条
    if (path === "recycle/purge" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const body = (await readJsonBody(request)) as { id?: number };
        const id = typeof body.id === "number" ? body.id : NaN;
        if (isNaN(id)) {
            return errorResponse(ApiError.badRequest("缺少有效的 id"));
        }
        const ok = await api.purgeRecycleItem(id);
        await api.writeAudit("recycle.purge", "", ip, `回收站条目 ${id}`);
        return Response.json({ success: ok });
    }
    // 回收站：批量还原（撤销多选删除时一次请求搞定，并带回还原出来的卡片，
    // 前端直接插回界面，不必再 bootstrap 全量重拉）
    if (path === "recycle/restore-batch" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const body = (await readJsonBody(request)) as { ids?: unknown };
        const ids = Array.isArray(body.ids)
            ? body.ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
            : [];
        if (ids.length === 0) {
            return errorResponse(ApiError.badRequest("缺少有效的 id"));
        }
        const result = await api.restoreRecycleItems(ids);
        await api.writeAudit("recycle.batchRestore", "", ip, `回收站条目 ${ids.length} 条`);
        return Response.json(result);
    }
    // 回收站：批量永久删除（撤销后又删一次）
    if (path === "recycle/purge-batch" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const body = (await readJsonBody(request)) as { ids?: unknown };
        const ids = Array.isArray(body.ids)
            ? body.ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
            : [];
        if (ids.length === 0) {
            return errorResponse(ApiError.badRequest("缺少有效的 id"));
        }
        await api.purgeRecycleItems(ids);
        await api.writeAudit("recycle.batchPurge", "", ip, `回收站条目 ${ids.length} 条`);
        return Response.json({ success: true });
    }
    // 回收站：清空（?kind=nav|note 同上：清空也分家，导航站清空不动笔记）
    if (path === "recycle" && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;
        const kind = url.searchParams.get("kind");
        const scope = kind === "nav" || kind === "note" ? kind : undefined;
        const ok = await api.emptyRecycleBin(scope);
        await api.writeAudit("recycle.empty", "", ip);
        return Response.json({ success: ok });
    }

    return null;
}
