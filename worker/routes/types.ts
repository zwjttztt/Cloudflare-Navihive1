// 路由处理函数的入参。
//
// 原来 handleRequest 是一个 1323 行的函数，所有分支共享它作用域里的十来个局部变量
// （api / path / method / trustXFF / secureCookie / currentJti …）。拆成多个路由模块之后，
// 这些变量得有个地方装着传进去 —— 就是这个 ctx。
//
// 约定：每个路由模块导出 `handle(ctx): Promise<Response | null>`，
// 认领了就返回 Response，没认领返回 null，由 index.ts 继续问下一个模块。

import type { NavigationAPI } from "../../src/API/http";
import type { Env } from "../types";

export interface RouteCtx {
    request: Request;
    env: Env;
    url: URL;
    /** `/api/` 之后的路径，如 `sites/12` */
    path: string;
    method: string;
    api: NavigationAPI;
    /** 客户端 IP（审计日志用），已在入口算好 */
    ip: string;
    /** 是否信任 X-Forwarded-For 作为限速分桶依据（见 NAVIHIVE_TRUST_XFF） */
    trustXFF: boolean;
    /** cookie 是否带 Secure（按浏览器真实 scheme 判断，见 requestIsSecure） */
    secureCookie: boolean;
    /** 当前令牌的 jti —— 退出登录 / 注销账号时按它拉黑 */
    currentJti: string;
    /** 当前令牌的过期时间（秒），拉黑时一起写进黑名单 */
    currentTokenExp: number;
}
