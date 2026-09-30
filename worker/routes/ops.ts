// 运维类路由：审计日志与回收站。
//
// 从 worker/index.ts 拆出来。两个都是「事后补救」性质的只读 / 撤销入口，
// 审计只有 owner 能看，回收站按账号隔离。
import {} from "../httpUtils";
import type { RouteCtx } from "./types";

export async function handleOpsRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        url,
        path,
        method,
        api,
        ip,
        
    } = ctx;

    // 审计日志只读视图（仅 owner）。谁在何时从哪 IP 做了什么，事后能溯源。
    if (path === "audit" && method === "GET") {
        const uid = api.getCurrentUserId();
        const me = uid !== null ? await api.getUserById(uid) : null;
        if (!me || me.role !== "owner") {
            return Response.json(
                { success: false, message: "仅站点所有者可以查看审计日志" },
                { status: 403 }
            );
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

    // 回收站：列出当前账号软删除的站点 / 分组
    if (path === "recycle" && method === "GET") {
        const items = await api.listRecycleBin();
        return Response.json({ success: true, items });
    }
    // 回收站：还原一条
    if (path === "recycle/restore" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { id?: number };
        const id = typeof body.id === "number" ? body.id : NaN;
        if (isNaN(id)) {
            return Response.json({ success: false, message: "缺少有效的 id" }, { status: 400 });
        }
        const ok = await api.restoreRecycleItem(id);
        await api.writeAudit("recycle.restore", "", ip, `回收站条目 ${id}`);
        return Response.json({ success: ok });
    }
    // 回收站：永久删除一条
    if (path === "recycle/purge" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { id?: number };
        const id = typeof body.id === "number" ? body.id : NaN;
        if (isNaN(id)) {
            return Response.json({ success: false, message: "缺少有效的 id" }, { status: 400 });
        }
        const ok = await api.purgeRecycleItem(id);
        await api.writeAudit("recycle.purge", "", ip, `回收站条目 ${id}`);
        return Response.json({ success: ok });
    }
    // 回收站：批量还原（撤销多选删除时一次请求搞定，并带回还原出来的卡片，
    // 前端直接插回界面，不必再 bootstrap 全量重拉）
    if (path === "recycle/restore-batch" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
        const ids = Array.isArray(body.ids)
            ? body.ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
            : [];
        if (ids.length === 0) {
            return Response.json({ success: false, message: "缺少有效的 id" }, { status: 400 });
        }
        const result = await api.restoreRecycleItems(ids);
        await api.writeAudit("recycle.batchRestore", "", ip, `回收站条目 ${ids.length} 条`);
        return Response.json(result);
    }
    // 回收站：批量永久删除（撤销后又删一次）
    if (path === "recycle/purge-batch" && method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
        const ids = Array.isArray(body.ids)
            ? body.ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
            : [];
        if (ids.length === 0) {
            return Response.json({ success: false, message: "缺少有效的 id" }, { status: 400 });
        }
        await api.purgeRecycleItems(ids);
        await api.writeAudit("recycle.batchPurge", "", ip, `回收站条目 ${ids.length} 条`);
        return Response.json({ success: true });
    }
    // 回收站：清空
    if (path === "recycle" && method === "DELETE") {
        const ok = await api.emptyRecycleBin();
        await api.writeAudit("recycle.empty", "", ip);
        return Response.json({ success: ok });
    }

    return null;
}
