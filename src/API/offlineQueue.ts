// src/API/offlineQueue.ts
// 离线写入队列：Worker 不可达 / 浏览器离线时，增删改先落本地（localStorage），
// 恢复连接后自动重放。这样断网期间用户做的编辑不会丢。
//
// 设计要点：
// - 只在「确实是离线 / 网络错」时才入队；服务端 5xx、参数错这类「能连上但被拒」的不入队
//   （重放也没用，反而把脏数据打进队列）。
// - 队列里只存「方法名 + 参数」，重放时调同一份 api 方法即可，不用为每个操作写特例。
// - 重放失败的（还连不上）放回队列末尾，等下次 online 再试，不丢。
import { scopedKey } from "../utils/accountScope";

// 离线队列只关心「能按名字调出一个返回 Promise 的方法」，不需要整套客户端接口
/**
 * 重放时要用的接口面。
 *
 * 除了「按名字取出各个 mutation 方法」之外，还有 setIdempotencyKey：
 * 重放一条之前把那条操作自己的 ID 挂上去，让服务端能认出重复补发。
 * 它标成可选 —— 没实现也没关系，那只是退化成「不幂等」的老行为，不至于跑不起来。
 */
export type MutationApi = Record<string, (...args: unknown[]) => Promise<unknown>> & {
    setIdempotencyKey?: (key: string | null) => void;
};


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
    /** 入队时的账号；重放前必须还是同一个账号，否则会把别人的编辑写到别人库里 */
    uid?: number | null;
    /** 幂等键：同一次操作重放多次服务端只认一次（服务端支持时生效） */
    opId?: string;
    /** 已经重试过几次；超过上限就放弃，不让角标永远挂着 */
    attempts?: number;
}

/** 一条操作最多重放几次就放弃（服务端一直不收，再排下去也没用） */
const MAX_REPLAY_ATTEMPTS = 3;

const STORAGE_KEY = "navihive:offlineQueue";

/** 当前生效账号；null 表示还没登录（匿名一档）。由 setAccountUid 设置。 */
let accountUid: number | null = null;
/** 存储键按账号分片：换人登录时各自读各自的，不会互相看见 */
let storageKey: string = scopedKey(STORAGE_KEY, null);

function loadQueue(): PendingMutation[] {
    try {
        const raw = (globalThis.localStorage as Storage | undefined)?.getItem(storageKey);
        return raw ? (JSON.parse(raw) as PendingMutation[]) : [];
    } catch {
        return [];
    }
}

function saveQueue(queue: PendingMutation[]): void {
    try {
        (globalThis.localStorage as Storage).setItem(storageKey, JSON.stringify(queue));
    } catch {
        // 隐私模式 / 配额满：队列是尽力而为，存不下就本会话内生效
    }
}

let queue: PendingMutation[] = loadQueue();

/**
 * 绑定当前账号。换账号会立刻换一份存储并重读队列 ——
 * 于是「A 排队 → 登出 → B 登录 → 自动重放」这条串号路径被物理切断。
 */
export function setAccountUid(uid: number | null): void {
    if (uid === accountUid) return;
    accountUid = uid;
    storageKey = scopedKey(STORAGE_KEY, uid);
    queue = loadQueue();
    notifyChange();
}

/** 当前绑定的账号（测试与界面提示用） */
export function currentAccountUid(): number | null {
    return accountUid;
}

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

/**
 * 离线时把一次失败的操作存进队列。
 *
 * 带上入队时的账号：重放前会比对，账号对不上就不重放 ——
 * 「A 的操作在 B 的会话里补发」会直接写到 B 的库里，那是数据串号。
 * 顺带生成幂等键：断网期间重复提交 / 重放成功但回包丢了，服务端据此只认一次。
 */
export function enqueueMutation(kind: string, args: unknown[]): void {
    queue.push({
        kind,
        args,
        ts: Date.now(),
        uid: accountUid,
        opId: newOperationId(),
    });
    saveQueue(queue);
    notifyChange();
}

/** 生成一次操作的幂等键（浏览器支持 crypto 就用随机的，否则退回时间戳 + 计数） */
let opSeq = 0;
function newOperationId(): string {
    const cryptoObj = globalThis.crypto as Crypto | undefined;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
        return cryptoObj.randomUUID();
    }
    opSeq += 1;
    return `${Date.now()}-${opSeq}`;
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

/** 把已处理完（成功或被判定为不必再试）的操作从队列里划掉 */
function drop(op: PendingMutation): void {
    const index = queue.indexOf(op);
    if (index === -1) return;
    queue.splice(index, 1);
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

/** 重放期间禁止重入：online 事件与启动各调一次就够了，两个一起跑会把同一条发两遍 */
let flushing = false;

/**
 * 服务端明确拒绝（4xx / success=false）的错误：重试没有意义，留在队列里只会
 * 一遍遍撞同一堵墙，还占着角标。与「还连不上」区分开，后者才继续等下次 online。
 */
export class RejectedByServerError extends Error {
    constructor(message = "服务端拒绝了该操作") {
        super(message);
        this.name = "RejectedByServerError";
    }
}

/** 从常见错误里认出「服务端明确拒绝」：HTTP 4xx（408/429 除外，那是「稍后再来」） */
export function isRejectedByServer(err: unknown): boolean {
    if (err instanceof RejectedByServerError) return true;
    const status = (err as { status?: number } | null)?.status;
    if (typeof status === "number") {
        return status >= 400 && status < 500 && status !== 408 && status !== 429;
    }
    const msg = (err as { message?: string } | null)?.message || "";
    return /HTTP 4\d\d/.test(msg) && !/HTTP (408|429)/.test(msg);
}

/**
 * 重放队列：逐个调 api[kind](...args)。返回成功数。
 *
 * 与早先「先整批取出、失败再塞回」不同，这里**成功一条才从存储里划掉一条**：
 * 中途关页面 / 崩溃时剩下的还在盘上，不会凭空消失。
 */
export async function flushOfflineQueue(api: MutationApi): Promise<number> {
    if (isOffline() || flushing || queue.length === 0) return 0;
    flushing = true;
    let done = 0;
    try {
        // 最多重放一轮：仍失败的会被留在 / 放回队列，等下一次 online，不会在这里死循环
        const pending = [...queue];
        for (const op of pending) {
            if (isOffline()) break;
            try {
                const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op.kind];
                if (typeof fn !== "function") {
                    drop(op);
                    continue;
                }
                // 账号变了就不许再补发：这条操作属于别人，写进当前账号就是串号，直接丢弃
                if (op.uid !== undefined && op.uid !== accountUid) {
                    drop(op);
                    continue;
                }
                // 带上这条操作自己的幂等 ID：服务端可能已经执行过（只是响应没回到本机），
                // 同一个 ID 过去它会回放上次结果，而不是再做一个重复站点。
                // 用完即清，别让后面手动的操作被误合并。
                if (typeof api.setIdempotencyKey === "function") {
                    api.setIdempotencyKey(op.opId ?? null);
                }
                const res = await fn.apply(api, op.args);
                // returnsSuccess 类方法：返回假也视为没成功。
                // 有的方法（importData）返回的是带 success 字段的对象，对象本身恒为真，
                // 得看里面的 success 才算数。
                const def = MUTATION_METHODS.find(m => m.name === op.kind);
                if (def?.returnsSuccess && isFailedResult(res)) {
                    // 返回假 = 服务端没收下。留着再试几次（可能是暂时性的），
                    // 但试够就放弃：一直挂在队列里，角标永远消不掉，重放也只会一遍遍撞墙。
                    op.attempts = (op.attempts ?? 0) + 1;
                    if (op.attempts >= MAX_REPLAY_ATTEMPTS) {
                        drop(op);
                    } else {
                        saveQueue(queue);
                    }
                    continue;
                }
                drop(op);
                done++;
            } catch (err) {
                // 连不上：留在队列里等下次 online。服务端明确拒绝：直接丢弃，
                // 否则角标永远消不掉，还一遍遍撞同一堵墙。
                if (isRejectedByServer(err)) drop(op);
            }
        }
    } finally {
        flushing = false;
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
