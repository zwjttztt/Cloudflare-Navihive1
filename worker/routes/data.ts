// 数据主干路由：首屏 bootstrap、分组 CRUD、站点 CRUD、批量删除、批量排序。
//
// 从 worker/index.ts 拆出来。这是站点日常读写量最大的一组，
// 读到的数据已经按 ctx.api 上绑定的账号过滤过（见 NavigationAPI.setCurrentUser）。
import type { Group, Site } from "../../src/API/http";
import { enforceWriteGuard, writeBucket } from "../loginGuard";
import { fetchSiteMeta } from "../meta";
import { weakEtag } from "../util";
import type { GroupInput, SiteInput } from "../types";
import { validateGroup, validateSite } from "../validate";
import { readIdempotencyKey, withIdempotency } from "../idempotency";
import type { RouteCtx } from "./types";

/** 幂等闸门只对写方法开：GET / HEAD 没有副作用，认重没有意义，只会白占一行记录 */
const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 对外入口：写请求（带 Idempotency-Key 的）先过一遍幂等闸门，再进真正的分发。
 *
 * 为什么不逐个分支包：这些分支是一条 `if / else if` 链，每个分支的收尾 `}` 同时
 * 是下一个分支的开头 `else if`，包一层箭头函数就得在链中间动刀，极易改坏。
 * 放在这里统一包一层，一个字都不用动链本身。
 *
 * endpoint 取「方法 + 路径首段」（sites/123 归成 sites）：幂等记录的作用域只需要
 * 区分开不同端点，具体 id 不进作用域 —— 那条记录是靠 op_id 认的，不是靠路径。
 */
export async function handleDataRoutes(ctx: RouteCtx): Promise<Response | null> {
    if (!IDEMPOTENT_METHODS.has(ctx.method)) return await dispatchDataRoutes(ctx);
    const key = readIdempotencyKey(ctx.request);
    if (!key) return await dispatchDataRoutes(ctx);

    const endpoint = `${ctx.method} ${ctx.path.split("/")[0]}`;
    return await withIdempotency(ctx.api, endpoint, key, () => dispatchDataRoutes(ctx));
}

async function dispatchDataRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        url,
        path,
        method,
        api,
        ip,
        trustXFF,
    } = ctx;

    /**
     * 写操作限速闸门：分组 / 站点的增删改与批量操作都要先过这一道。
     * 放行返回 null，撞上限速返回已经填好 Retry-After 的 429，调用处直接 return 出去。
     * GET 一律不过闸 —— 读不消耗 D1 写入配额，也不该因为「翻了几页」就把人锁住。
     */
    const writeGate = (): Promise<Response | null> =>
        enforceWriteGuard(api, writeBucket(request, api.getCurrentUserId(), trustXFF));

    // 抓目标站点的标题 / 描述（新增卡片时一键补全）—— 要鉴权，因为会对外发请求，
    // 不能让陌生人拿我们的 Worker 当代理使
    if (path === "meta" && method === "GET") {
        return await fetchSiteMeta(request);
    }

    // 路由匹配
    if (path === "bootstrap" && method === "GET") {
        // 一次请求返回分组 + 站点 + 配置，供前端首屏与刷新使用。
        // 带上弱 ETag：浏览器下次会在 If-None-Match 里回传，
        // 数据没变就只回一个 304 空包，省掉整份 JSON 的下载与解析
        // （站点多的时候这一份能到几百 KB）。
        const data = await api.getBootstrap();
        const body = JSON.stringify(data);
        const etag = weakEtag(body);
        // no-cache（每次都要问一趟服务器）而不是 no-store（不许存），
        // 否则浏览器手头没有副本，ETag 也就无从比较
        const headers = {
            "Content-Type": "application/json; charset=utf-8",
            ETag: etag,
            "Cache-Control": "no-cache",
        };
        if (request.headers.get("if-none-match") === etag) {
            return new Response(null, { status: 304, headers });
        }
        return new Response(body, { headers });
    } else if (path === "groups" && method === "GET") {
        const groups = await api.getGroups();
        return Response.json(groups);
    } else if (path.startsWith("groups/") && method === "GET") {
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }
        const group = await api.getGroup(id);
        return Response.json(group);
    } else if (path === "groups" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = (await request.json()) as GroupInput;

        // 验证分组数据
        const validation = validateGroup(data);
        if (!validation.valid) {
            return Response.json(
                {
                    success: false,
                    message: `验证失败: ${validation.errors?.join(", ")}`,
                },
                { status: 400 }
            );
        }

        const result = await api.createGroup(validation.sanitizedData as Group);
        return Response.json(result);
    } else if (path.startsWith("groups/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const data = (await request.json()) as Partial<Group>;
        // 对修改的字段进行验证
        if (
            data.name !== undefined &&
            (typeof data.name !== "string" || data.name.trim() === "")
        ) {
            return Response.json(
                {
                    success: false,
                    message: "分组名称不能为空且必须是字符串",
                },
                { status: 400 }
            );
        }

        if (data.order_num !== undefined && typeof data.order_num !== "number") {
            return Response.json(
                {
                    success: false,
                    message: "排序号必须是数字",
                },
                { status: 400 }
            );
        }

        const result = await api.updateGroup(id, data);
        return Response.json(result);
    } else if (path.startsWith("groups/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const result = await api.deleteGroup(id);
        // 软删除：结果含 recycleId，前端撤销时据此精确还原
        return Response.json(result);
    }
    // 站点相关API
    if (path === "sites" && method === "GET") {
        const groupId = url.searchParams.get("groupId");
        const sites = await api.getSites(groupId ? parseInt(groupId) : undefined);
        return Response.json(sites);
    } else if (path.startsWith("sites/") && method === "GET") {
        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const site = await api.getSite(id);
        return Response.json(site);
    } else if (path === "sites" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = (await request.json()) as SiteInput;

        // 验证站点数据
        const validation = validateSite(data);
        if (!validation.valid) {
            return Response.json(
                {
                    success: false,
                    message: `验证失败: ${validation.errors?.join(", ")}`,
                },
                { status: 400 }
            );
        }

        const result = await api.createSite(validation.sanitizedData as Site);
        return Response.json(result);
    } else if (path.startsWith("sites/") && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const data = (await request.json()) as Partial<Site>;

        // 验证更新的站点数据
        if (data.url !== undefined) {
            try {
                new URL(data.url);
            } catch {
                return Response.json(
                    {
                        success: false,
                        message: "无效的URL格式",
                    },
                    { status: 400 }
                );
            }
        }

        if (data.icon !== undefined && data.icon !== "") {
            try {
                new URL(data.icon);
            } catch {
                return Response.json(
                    {
                        success: false,
                        message: "无效的图标URL格式",
                    },
                    { status: 400 }
                );
            }
        }

        if (data.username !== undefined && typeof data.username !== "string") {
            return Response.json(
                {
                    success: false,
                    message: "账号必须是字符串",
                },
                { status: 400 }
            );
        }

        if (data.password !== undefined && typeof data.password !== "string") {
            return Response.json(
                {
                    success: false,
                    message: "密码必须是字符串",
                },
                { status: 400 }
            );
        }

        const result = await api.updateSite(id, data);
        return Response.json(result);
    } else if (path.startsWith("sites/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;

        const id = parseInt(path.split("/")[1]);
        if (isNaN(id)) {
            return Response.json({ error: "无效的ID" }, { status: 400 });
        }

        const result = await api.deleteSite(id);
        await api.writeAudit("site.delete", "", ip, `站点 ${id}`);
        // 软删除：结果含 recycleId，前端撤销时据此精确还原
        return Response.json(result);
    }
    // 批量删除站点：多选删除一次请求搬完（逐个 DELETE 在 20 张卡时要等十几秒）
    else if (path === "sites/batch-delete" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;

        const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
        const ids = Array.isArray(body.ids)
            ? body.ids.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
            : [];
        if (ids.length === 0) {
            return Response.json({ success: false, message: "缺少要删除的 id" }, { status: 400 });
        }
        // 一次删太多会把 D1 单次请求顶满，也给误操作留个上限
        if (ids.length > 500) {
            return Response.json({ success: false, message: "一次最多删除 500 个" }, { status: 400 });
        }
        const result = await api.deleteSites(ids);
        await api.writeAudit("site.batchDelete", "", ip, `站点 ${ids.length} 个`);
        return Response.json(result);
    }
    // 批量更新排序
    else if (path === "group-orders" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        const data = (await request.json()) as Array<{ id: number; order_num: number }>;

        // 验证排序数据
        if (!Array.isArray(data)) {
            return Response.json(
                {
                    success: false,
                    message: "排序数据必须是数组",
                },
                { status: 400 }
            );
        }

        for (const item of data) {
            if (
                !item.id ||
                typeof item.id !== "number" ||
                item.order_num === undefined ||
                typeof item.order_num !== "number"
            ) {
                return Response.json(
                    {
                        success: false,
                        message: "排序数据格式无效，每个项目必须包含id和order_num",
                    },
                    { status: 400 }
                );
            }
        }

        const result = await api.updateGroupOrder(data);
        return Response.json({ success: result });
    } else if (path === "site-orders" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;

        // 支持一次提交「顺序 + 所属分组」，拖拽跨组移动不必再逐个请求
        const data = (await request.json()) as Array<{
            id: number;
            order_num: number;
            group_id?: number;
        }>;

        // 验证排序数据
        if (!Array.isArray(data)) {
            return Response.json(
                {
                    success: false,
                    message: "排序数据必须是数组",
                },
                { status: 400 }
            );
        }

        for (const item of data) {
            if (
                !item.id ||
                typeof item.id !== "number" ||
                item.order_num === undefined ||
                typeof item.order_num !== "number"
            ) {
                return Response.json(
                    {
                        success: false,
                        message: "排序数据格式无效，每个项目必须包含id和order_num",
                    },
                    { status: 400 }
                );
            }

            if (item.group_id !== undefined && typeof item.group_id !== "number") {
                return Response.json(
                    {
                        success: false,
                        message: "分组ID必须是数字",
                    },
                    { status: 400 }
                );
            }
        }

        // 结果里带着「成了哪几个、没成哪几个」：D1 没有跨语句事务，
        // 一批里挂掉几条是真实存在的，前端要按实际结果更新（见 App 的 bulkMove）
        const result = await api.updateSiteOrder(data);
        return Response.json(result);
    }

    return null;
}
