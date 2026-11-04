// server/egressDispatch.ts
//
// 自托管专属：把「出站连接用的解析」**绑定到校验过的那一份 IP** 上。
//
// 要解决的问题（2026-10-24 全站复查行动项 R06）：
//   worker/safeFetch.ts 的 setEgressResolver 只做了「出站前把 hostname 解析一遍、
//   逐 IP 过黑名单」，而真正发请求的 `fetch()` **会自己再解析一次**。两次解析之间
//   就是 DNS rebinding 的窗口：校验时是公网 IP，连接时换回 127.0.0.1 / 内网。
//   safeFetch.ts 自己的注释也写着「这是缓解不是根治」。
//
// 根治办法：让**连接**也走我们这次解析的结果 ——
//   `new undici.Agent({ connect: { lookup } })` 里的 lookup 是 net.connect 唯一会用的
//   解析入口，连接目标 IP 由它给出，而 SNI / Host 头仍然是原域名
//   （已实测：把 example.invalid 钉到 127.0.0.1，本地服务端收到 `Host: example.invalid:9988`）。
//   于是「校验用的 IP」与「连接用的 IP」变成同一份，中间没有第二次解析。
//
// 边界：
//   · 只影响 safeFetch 这条出站路（通过 setFetchImpl 注入）。**不改全局 dispatcher** ——
//     那会把 WebDAV 一起管住，而 WebDAV 的 `allowPrivateNetwork` 是管理员显式放行的
//     内网 NAS 场景（见 worker/webdav/transport.ts 与 SECURITY.md 的例外说明）。
//   · undici 是运行期唯一的非打包依赖；缺失时 installEgressDispatcher 返回
//     { installed: false }，服务照常起，退化成「出站前复核」的缓解模式并告警。
//   · 这里**没有缓存**：每次连接解析一次（内核/上游 DNS 自己有缓存）。缓存会让
//     「校验的 IP」与「连接用的 IP」之间重新出现时间差，而这正是本文件要消灭的东西。

import { lookup as dnsLookup } from "node:dns/promises";
import { isBlockedHost } from "../worker/util";
import type { FetchLike } from "../worker/safeFetch";

/** 一条解析结果（与 dns.lookup / net 的地址对象同形） */
export interface LookupEntry {
    address: string;
    /** 4 或 6（Node 的 dns.lookup 用 number；undici 的 connect.lookup 也照收） */
    family: number;
}

/**
 * 注入用的解析器：形状对齐 `dns.promises.lookup(host, { all: true, verbatim: true })`。
 * 抽成参数是为了单测能塞假实现（不查真 DNS、不依赖网络）。
 */
export type RawLookup = (
    hostname: string,
    options: { all: true; verbatim: true }
) => Promise<readonly LookupEntry[]>;

/**
 * `net.connect` 约定的 lookup 回调。
 *
 * ⚠️ 两种模式**签名不同**，必须都实现（实测：只实现单模式时，undici 用 all 模式回调，
 *    拿到 string 而不是数组，连接直接失败）：
 *   · all 模式（`options.all === true`）：`cb(null, [{ address, family }, …])`
 *   · 单模式：`cb(null, address, family)`
 */
export type LookupCallback = (
    error: Error | null,
    address?: string | readonly LookupEntry[],
    family?: number
) => void;

/** 符合 `net.connect` 约定的 lookup 函数（交给 undici Agent 的 connect.lookup） */
export type ConnectLookup = (
    hostname: string,
    options: { all?: boolean; family?: number; hints?: number; verbatim?: boolean },
    callback: LookupCallback
) => void;

export interface ValidatingLookupDeps {
    /** 真解析器（自托管传 dns.promises.lookup，单测传假实现） */
    lookup: RawLookup;
    /** IP 判据（自托管传 isBlockedHost 的包装，单测传假实现） */
    isBlocked: (address: string) => boolean;
}

/**
 * 造一个「先校验、再交给 net 去连」的 lookup。
 *
 * 语义（每一条都是安全边界，改动前先想清楚）：
 *   · 用 `all: true, verbatim: true` 拿**全部** A/AAAA —— 只拿第一条的话，
 *     多 A 记录里排在后面的内网地址就没人看。
 *   · **任何一个**地址被判为 blocked 就 `cb(new Error(...))` **拒绝整次连接**。
 *     绝不「过滤掉内网地址、连剩下那个公网的」：多 A 记录里藏一个 127.0.0.1
 *     正是攻击者的意图，悄悄过滤等于按攻击者的备用路径继续跑（而且用户看到的是
 *     「偶发成功」，比直接失败更难排查）。
 *   · DNS 失败 → 错误**原样透传**（fail-closed：让这次连接失败，不退回「你随便连」）。
 *     与 server/entry.ts 里 setEgressResolver 的 fail-closed 判定同口径。
 *   · 错误文案只带 hostname 与被命中的那**一条** IP：整份解析结果不进日志/报错
 *     （那等于把内网拓扑写在用户能看到的报错里）。
 *   · 单模式下若调用方约定了 family（4/6），挑该 family 的第一条；一条都没有则报错
 *     （不做「拿别的 family 顶上」：那会让 socket 层拿到一个连不通的地址，
 *      错误信息反而离原因更远）。
 */
export function createValidatingLookup({ lookup, isBlocked }: ValidatingLookupDeps): ConnectLookup {
    return (hostname, options, callback) => {
        // lookup 是回调式接口，内部用异步实现；这里显式 void 掉，避免未处理的 rejection。
        void (async () => {
            let rows: readonly LookupEntry[];
            try {
                rows = await lookup(hostname, { all: true, verbatim: true });
            } catch (error) {
                // fail-closed：解析失败不连接，错误原样往上抛（调用方看到的是 ENOTFOUND 之类）
                callback(error instanceof Error ? error : new Error(String(error)));
                return;
            }

            if (!Array.isArray(rows) || rows.length === 0) {
                // 解析「成功」但一条地址都没有：同样不能放行
                callback(new Error(`出站解析没有返回任何地址（${hostname}）：拒绝连接`));
                return;
            }

            for (const row of rows) {
                if (isBlocked(row.address)) {
                    // ⚠️ 只报命中的这一条，不 dump 整份结果
                    callback(
                        new Error(
                            `出站 hostname ${hostname} 解析到被禁止的地址 ${row.address}：拒绝连接`
                        )
                    );
                    return;
                }
            }

            if (options.all) {
                callback(
                    null,
                    rows.map(row => ({ address: row.address, family: row.family }))
                );
                return;
            }

            const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
            const picked = wanted ? rows.find(row => row.family === wanted) : rows[0];
            if (!picked) {
                callback(
                    new Error(`出站 hostname ${hostname} 没有 IPv${wanted} 地址：拒绝连接`)
                );
                return;
            }
            callback(null, picked.address, picked.family);
        })();
    };
}

/** 结构化的 undici 视图：不 import 它的类型（避免把 undici 的 .d.ts 拖进编译面） */
interface UndiciDispatcherLike {
    close?: () => Promise<void>;
}

/** undici.fetch 的 init：比标准的 RequestInit 多一个 dispatcher */
type UndiciFetchInit = RequestInit & { dispatcher?: UndiciDispatcherLike };

interface UndiciModuleLike {
    Agent: new (options?: { connect?: { lookup?: ConnectLookup } }) => UndiciDispatcherLike;
    fetch: (input: string, init?: UndiciFetchInit) => Promise<unknown>;
}

export interface EgressLogger {
    info?: (message: string) => void;
    warn: (message: string) => void;
}

export interface InstallEgressDispatcherOptions {
    /** worker/safeFetch 的 setFetchImpl（safeFetch 内部发请求时改走注入实现） */
    setFetchImpl: (fn: FetchLike | null) => void;
    logger: EgressLogger;
    /**
     * 测试注入点：替换 `import("undici")`。
     * 默认实现必须是**字面量**动态 import —— 见下方 defaultLoadUndici 的注释
     * （esbuild 要靠这个字面量把 undici 标成 external）。
     */
    loadUndici?: () => Promise<unknown>;
    /** 测试注入点：替换解析器（默认 dns.promises.lookup） */
    lookup?: RawLookup;
    /** 测试注入点：替换 IP 判据（默认 isBlockedHost 包一层） */
    isBlocked?: (address: string) => boolean;
}

export interface EgressDispatcherResult {
    installed: boolean;
    /** 未安装的原因（只用于日志；调用方按 installed 分支处理，不要据此抛错） */
    reason?: string;
}

/** 把任意抛出物转成一行人类可读文案 */
function describeError(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}

/**
 * 默认的 undici 加载器。
 *
 * ⚠️ 这里必须写**字面量** `import("undici")`：script/build-server.mjs 用
 * `external: ["undici"]` 把这条 import 原样留在产物里（undici 不能被 esbuild 打进
 * ESM 单文件 —— 会报 `Dynamic require of "node:assert" is not supported`）。
 * 写成变量或计算出来的模块名，esbuild 既不 external、也解析不了。
 */
function defaultLoadUndici(): Promise<unknown> {
    return import("undici");
}

/**
 * 装上「校验后的 IP 直接用于连接」的出站通道。
 *
 * 成功：注册一个用 undici.fetch + 上面那个 Agent 的 fetch 实现，返回 { installed: true }。
 * 失败（undici 缺失 / 模块形状不对 / Agent 建不起来）：返回 { installed: false, reason }，
 * **不抛** —— 出站能力的降级不该把整个服务拖住（自托管镜像里 undici 是唯一的外部
 * 运行期依赖，Dockerfile 有拷贝，但 npm 直跑 / 裁剪过的镜像可能没有）。
 */
export async function installEgressDispatcher(
    options: InstallEgressDispatcherOptions
): Promise<EgressDispatcherResult> {
    const loadUndici = options.loadUndici ?? defaultLoadUndici;

    let loaded: unknown;
    try {
        loaded = await loadUndici();
    } catch (error) {
        const reason = `undici 加载失败（${describeError(error)}）`;
        options.logger.warn(`[egress] ${reason}`);
        return { installed: false, reason };
    }

    const mod = loaded as UndiciModuleLike | null;
    if (!mod || typeof mod.Agent !== "function" || typeof mod.fetch !== "function") {
        const reason = "undici 模块缺少 Agent/fetch（版本不匹配？）";
        options.logger.warn(`[egress] ${reason}`);
        return { installed: false, reason };
    }

    const validatingLookup = createValidatingLookup({
        lookup: options.lookup ?? dnsLookup,
        // isBlockedHost 同时接受 hostname 与 IP 字面量，且看不懂的一律按私网处理（fail-closed）
        isBlocked: options.isBlocked ?? ((address: string) => isBlockedHost(address)),
    });

    let dispatcher: UndiciDispatcherLike;
    try {
        dispatcher = new mod.Agent({ connect: { lookup: validatingLookup } });
    } catch (error) {
        const reason = `undici Agent 创建失败（${describeError(error)}）`;
        options.logger.warn(`[egress] ${reason}`);
        return { installed: false, reason };
    }

    const undiciFetch = mod.fetch;
    options.setFetchImpl(async (input: string, init?: RequestInit): Promise<Response> => {
        // Response 走一次类型重解释：undici 自己的 Response 与 Node 全局 fetch 的
        // Response 是同一个实现（Node 的全局 fetch 就是 undici），运行时没有区别。
        const response = await undiciFetch(input, { ...(init ?? {}), dispatcher });
        return response as Response;
    });

    options.logger.info?.("[egress] 出站 fetch 已切到校验后的 IP（undici Agent + validating lookup）");
    return { installed: true };
}
