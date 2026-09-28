// src/API/offlineQueue.ts
// 离线写入队列：Worker 不可达 / 浏览器离线时，增删改先落本地（localStorage），
// 恢复连接后自动重放。这样断网期间用户做的编辑不会丢。
//
// 设计要点：
// - 只在「确实是离线 / 网络错」时才入队；服务端 5xx、参数错这类「能连上但被拒」的不入队
//   （重放也没用，反而把脏数据打进队列）。
// - 队列里只存「方法名 + 参数」，重放时调同一份 api 方法即可，不用为每个操作写特例。
// - 重放失败的（还连不上）放回队列末尾，等下次 online 再试，不丢。
// 离线队列只关心「能按名字调出一个返回 Promise 的方法」，不需要整套客户端接口
export type MutationApi = Record<string, (...args: unknown[]) => Promise<unknown>>;

/** 所有会被拦截的 mutation 方法。returnsSuccess=true 表示「返回 false 即失败」。 */
export const MUTATION_METHODS: { name: string; returnsSuccess?: boolean }[] = [
    { name: "createGroup" },
    { name: "updateGroup" },
    { name: "deleteGroup", returnsSuccess: true },
    { name: "createSite" },
    { name: "updateSite" },
    { name: "deleteSite", returnsSuccess: true },
    { name: "setConfig", returnsSuccess: true },
    { name: "setConfigs", returnsSuccess: true },
    { name: "deleteConfig", returnsSuccess: true },
    { name: "updateGroupOrder", returnsSuccess: true },
    { name: "updateSiteOrder", returnsSuccess: true },
    { name: "importData", returnsSuccess: true },
];

export interface PendingMutation {
    kind: string;
    args: unknown[];
    ts: number;
}

const STORAGE_KEY = "navihive:offlineQueue";

function loadQueue(): PendingMutation[] {
    try {
        const raw = (globalThis.localStorage as Storage | undefined)?.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as PendingMutation[]) : [];
    } catch {
        return [];
    }
}

function saveQueue(queue: PendingMutation[]): void {
    try {
        (globalThis.localStorage as Storage).setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch {
        // 隐私模式 / 配额满：队列是尽力而为，存不下就本会话内生效
    }
}

let queue: PendingMutation[] = loadQueue();

/** 网络是否判定为「离线」（单测可改 globalThis.navigator 验证） */
export function isOffline(): boolean {
    return typeof navigator === "undefined" ? false : navigator.onLine === false;
}

/** 一个错误是否该触发离线入队：明确离线，或典型网络错（fetch 抛 TypeError / 含 offline 字样） */
export function isOfflineError(err: unknown): boolean {
    if (isOffline()) return true;
    if (!err || typeof err !== "object") return false;
    const e = err as { name?: string; message?: string };
    const msg = e.message || "";
    return e.name === "TypeError" || /fetch|network|offline|failed to fetch/i.test(msg);
}

const listeners = new Set<() => void>();
function notifyChange() {
    for (const l of listeners) l();
}

/** 订阅队列变化，返回取消订阅函数 */
export function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
        listeners.delete(cb);
    };
}

/** 离线时把一次失败的操作存进队列 */
export function enqueueMutation(kind: string, args: unknown[]): void {
    queue.push({ kind, args, ts: Date.now() });
    saveQueue(queue);
    notifyChange();
}

/** 待同步数量（顶栏角标用） */
export function pendingCount(): number {
    return queue.length;
}

/** 取出并清空队列（重放前调用） */
export function takeAll(): PendingMutation[] {
    const all = queue;
    queue = [];
    saveQueue(queue);
    notifyChange();
    return all;
}

/** 把一次操作重新放回队列（重放仍失败时用） */
export function requeue(op: PendingMutation): void {
    queue.push(op);
    saveQueue(queue);
    notifyChange();
}

/**
 * 判定一次重放是否失败。
 * 有些方法返回 boolean（false 即失败），有些返回 { success } 对象（对象恒为真，
 * 得看字段）—— 两种都在这里统一处理。
 */
function isFailedResult(res: unknown): boolean {
    if (res === false || res === null || res === undefined) return true;
    if (typeof res === "object" && "success" in (res as Record<string, unknown>)) {
        return !(res as { success?: boolean }).success;
    }
    return false;
}

/**
 * 重放队列：逐个调 api[kind](...args)。返回成功数。
 * 仍失败的操作放回队列，连不上时不会丢。
 */
export async function flushOfflineQueue(api: MutationApi): Promise<number> {
    if (isOffline()) return 0;
    const ops = takeAll();
    if (ops.length === 0) return 0;
    let done = 0;
    for (const op of ops) {
        try {
            const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op.kind];
            if (typeof fn !== "function") {
                requeue(op);
                continue;
            }
            const res = await fn.apply(api, op.args);
            // returnsSuccess 类方法：返回假也视为没成功，放回队列。
            // 有的方法（importData）返回的是带 success 字段的对象，对象本身恒为真，
            // 得看里面的 success 才算数。
            const def = MUTATION_METHODS.find(m => m.name === op.kind);
            if (def?.returnsSuccess && isFailedResult(res)) {
                requeue(op);
                continue;
            }
            done++;
        } catch {
            requeue(op);
        }
    }
    return done;
}

/** 可识别的「已离线、已入队」错误，让上层显示温和提示而不是硬失败 */
export class OfflineQueuedError extends Error {
    constructor(public readonly kind: string, cause?: unknown) {
        super(`操作已离线保存，将在恢复连接后自动同步：${kind}`);
        this.name = "OfflineQueuedError";
        if (cause) (this as { cause?: unknown }).cause = cause;
    }
}

let listenerInstalled = false;

/** 注册一次「恢复连接就重放」的监听（幂等） */
export function installOnlineListener(api: MutationApi, onFlushed?: (done: number) => void): void {
    if (listenerInstalled || typeof window === "undefined") return;
    listenerInstalled = true;
    window.addEventListener("online", async () => {
        const done = await flushOfflineQueue(api);
        if (done > 0) onFlushed?.(done);
    });
}

let wrapped = false;

/**
 * 给 api 的 mutation 方法包一层离线保护：离线 / 网络错时把操作存进队列并抛
 * OfflineQueuedError（让上层显示温和提示），服务端自身的错误（5xx / 参数错）则原样抛出、
 * 不入队。幂等，多次调用只在第一次生效。
 */
export function wrapMutations(api: MutationApi): void {
    if (wrapped) return;
    wrapped = true;
    for (const m of MUTATION_METHODS) {
        const original = api[m.name];
        if (typeof original !== "function") continue;
        (api as Record<string, unknown>)[m.name] = async (...args: unknown[]) => {
            try {
                const res = await original.apply(api, args);
                // 返回假 = 这次没写进去；只在确实离线时才入队（在线时返回假是服务端拒绝，不入队）
                if (m.returnsSuccess && !res && isOffline()) {
                    enqueueMutation(m.name, args);
                    throw new OfflineQueuedError(m.name);
                }
                return res;
            } catch (err) {
                if (isOfflineError(err)) {
                    enqueueMutation(m.name, args);
                    throw new OfflineQueuedError(m.name, err);
                }
                throw err;
            }
        };
    }
}
