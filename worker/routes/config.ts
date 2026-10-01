// 配置路由：configs 的读 / 批量写 / 单键改 / 删。
//
// 从 worker/index.ts 拆出来。这里最要紧的是那道「全站外观只有站点所有者能改」的门槛，
// 三个写分支各判了一次 —— 拆出来之后三处挨在一起，改一处不容易漏掉另两处。
import { isUserScopedConfigKey } from "../../src/API/http";
import { enforceConfigGuard, endpointBucket } from "../loginGuard";
import type { ConfigInput } from "../types";
import { validateConfig } from "../validate";
import type { RouteCtx } from "./types";

export async function handleConfigRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        path,
        method,
        api,
        trustXFF,
    } = ctx;

    // 写配置先过一道闸门。
    //
    // 之前这类端点一把锁都没有：全站外观、WebDAV 凭据、巡检开关都能被一个泄露的
    // 令牌在几秒内反复改写（改配置还是最省事的持久化手段）。阈值比站点 CRUD 严，
    // 因为它频率低 —— 正常人手点远到不了一分钟 30 次。
    const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    if (WRITE_METHODS.has(method)) {
        const limited = await enforceConfigGuard(
            api,
            endpointBucket(request, api.getCurrentUserId(), trustXFF)
        );
        if (limited) return limited;
    }

    // 配置相关API
    if (path === "configs" && method === "GET") {
        const configs = await api.getConfigs();
        return Response.json(configs);
    }
    // 批量写入配置：保存网站设置时一次请求搞定，省掉 N 个网络往返
    else if (path === "configs/batch" && method === "POST") {
        const data = (await request.json()) as { configs?: Record<string, string> };
        const entries = Object.entries(data.configs || {});

        // 全站设置（标题 / 主题 / 背景…）是所有人共用的，只有站点所有者能写。
        // 过去只靠前端把入口藏起来，服务端没管 —— 普通账号直接调这个路由就能改。
        // 这里提前判掉，好给前端一句能看懂的提示，而不是静默「保存失败」。
        const needsShared = entries.some(([key]) => !isUserScopedConfigKey(key));
        if (needsShared && !(await api.canManageSharedConfigs())) {
            return Response.json(
                {
                    success: false,
                    message: "全站外观设置只有站点所有者可以修改",
                },
                { status: 403 }
            );
        }

        if (entries.length === 0) {
            return Response.json({ success: true, saved: 0 });
        }

        // 管理员凭据同样不允许在这里改（要走校验当前密码的专用接口）
        const blocked = entries.find(([key]) => key.startsWith("auth."));
        if (blocked) {
            return Response.json(
                {
                    success: false,
                    message: "管理员凭据请通过「更多选项 → 账号管理」修改",
                },
                { status: 403 }
            );
        }

        const bad = entries.find(
            ([, value]) => typeof value !== "string" || value === undefined
        );
        if (bad) {
            return Response.json(
                { success: false, message: `配置项 ${bad[0]} 的值不合法` },
                { status: 400 }
            );
        }

        const result = await api.setConfigs(Object.fromEntries(entries));
        return Response.json({ success: result, saved: entries.length });
    } else if (path.startsWith("configs/") && method === "GET") {
        const key = path.substring("configs/".length);
        // 管理员凭据不允许读取
        if (key.startsWith("auth.")) {
            return Response.json(
                { error: "管理员凭据不可读取" },
                { status: 403 }
            );
        }
        const value = await api.getConfig(key);
        return Response.json({ key, value });
    } else if (path.startsWith("configs/") && method === "PUT") {
        const key = path.substring("configs/".length);
        // 管理员凭据只能通过 /api/auth/credentials 修改（需要校验当前密码）
        if (key.startsWith("auth.")) {
            return Response.json(
                {
                    success: false,
                    message: "管理员凭据请通过「更多选项 → 账号管理」修改",
                },
                { status: 403 }
            );
        }
        // 与 configs/batch 同一道门槛：全站设置只有站点所有者能改
        if (!isUserScopedConfigKey(key) && !(await api.canManageSharedConfigs())) {
            return Response.json(
                { success: false, message: "全站外观设置只有站点所有者可以修改" },
                { status: 403 }
            );
        }
        const data = (await request.json()) as ConfigInput;

        // 验证配置数据
        const validation = validateConfig(data);
        if (!validation.valid) {
            return Response.json(
                {
                    success: false,
                    message: `验证失败: ${validation.errors?.join(", ")}`,
                },
                { status: 400 }
            );
        }

        // 确保value存在
        if (data.value === undefined) {
            return Response.json(
                {
                    success: false,
                    message: "配置值不能为空",
                },
                { status: 400 }
            );
        }

        const result = await api.setConfig(key, data.value);
        return Response.json({ success: result });
    } else if (path.startsWith("configs/") && method === "DELETE") {
        const key = path.substring("configs/".length);
        // 不允许删除管理员凭据，避免悄悄退化回默认密码
        if (key.startsWith("auth.")) {
            return Response.json({ success: false }, { status: 403 });
        }
        // 删除也是写：全站设置同样只归站点所有者
        if (!isUserScopedConfigKey(key) && !(await api.canManageSharedConfigs())) {
            return Response.json(
                { success: false, message: "全站外观设置只有站点所有者可以修改" },
                { status: 403 }
            );
        }
        const result = await api.deleteConfig(key);
        return Response.json({ success: result });
    }

    return null;
}
