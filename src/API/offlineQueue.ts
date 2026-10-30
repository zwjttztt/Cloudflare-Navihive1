// src/API/offlineQueue.ts
// 离线写入队列：Worker 不可达 / 浏览器离线时，增删改先落本地（localStorage），
// 恢复连接后自动重放。这样断网期间用户做的编辑不会丢。
//
// 设计要点：
// - 只在「确实是离线 / 网络错」时才入队；服务端 5xx、参数错这类「能连上但被拒」的不入队
//   （重放也没用，反而把脏数据打进队列）。
// - 队列里只存「方法名 + 参数」，重放时调同一份 api 方法即可，不用为每个操作写特例。
// - 每条操作有自己的状态：pending → sending →（确认后）删除。成功一条才从盘上划掉一条，
//   中途关页面 / 崩溃时剩下的还在盘上，不会凭空消失。
// - 暂时性失败按指数退避往后推；服务端明确拒绝（4xx）或重试到上限的，移进**失败列表**
//   让用户看得见、能重试或放弃 —— 不能让一条注定失败的操作永远占着角标。
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

/** 一条操作在队列里的状态。acked 不落盘 —— 确认收到就直接从队列删除。 */
export type MutationState = "pending" | "sending";

export interface PendingMutation {
    kind: string;
    args: unknown[];
    ts: number;
    /** 入队时的账号；重放前必须还是同一个账号，否则会把别人的编辑写到别人库里 */
    uid?: number | null;
    /** 幂等键：同一次操作重放多次服务端只认一次（服务端支持时生效） */
    opId?: string;
    /** 已经重试过几次；超过上限就移进失败列表，不让角标永远挂着 */
    attempts?: number;
    state?: MutationState;
    /** 进入 sending 的时刻：超过租期还没落地，说明发它的那个页面已经没了，要收回重排 */
    sentAt?: number;
    /** 退避到期时间：暂时性失败后不到点不重试，别把刚挂掉的服务端再锤一遍 */
    nextAttemptAt?: number;
    lastError?: string;
    /**
     * 离线新建的分组在本地先拿一个负数占位（真实 id 都是正数，绝不冲突）。
     * 之后在同一分组下新建的站点会带着这个负数入队，重放时按这里翻译回真实 id。
     */
    tempId?: number;
}

/** 已经放弃的操作：留给用户查看 / 重试 / 放弃，不再占着待同步角标 */
export interface FailedMutation {
    kind: string;
    args: unknown[];
    ts: number;
    uid?: number | null;
    opId?: string;
    attempts: number;
    reason: string;
    failedAt: number;
}

/** 一条操作最多重放几次就放弃（服务端一直不收，再排下去也没用） */
export const MAX_REPLAY_ATTEMPTS = 5;

/** sending 状态的租期：超时视为「发它的页面已经关了」，收回重新排队 */
export const SENDING_LEASE_MS = 60_000;

/** 指数退避：1s → 2s → 4s … 上限 60s，并加抖动避免同一批操作同时重试 */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/** 失败列表最多留多少条：再多就是噪声了，丢最旧的 */
export const MAX_FAILED_KEPT = 50;

/**
 * 单条操作的载荷上限（序列化后的字节数）。
 *
 * 为什么要有这道闸门（E-3 降级版）：队列存在 localStorage，浏览器给每个源 ~5 MB。
 * 这个仓库里真正会撑爆它的只有两条路 —— `importData`（整份备份文件，可达数 MB）
 * 和「批量建站并带上 data: URL 图标」。其余 10 个 mutation 的载荷都是几百字节。
 * 队列里塞进一条 4 MB 的备份后，后面所有操作都会因为写不进配额而**静默丢失**
 * （writeJson 是尽力而为），比当面拒绝一条更糟。所以宁可在入队这一刻明确拒绝。
 *
 * 256 KB 的取值：既大到普通操作绝不会碰到（12 个 mutation 里最大的批量建站也只有
 * 几十 KB），又小到即使排满 10 条离 5 MB 配额还有一半余量。
 *
 * ⚠️ 不把 localStorage 换成 IndexedDB：那要改 3 处「启动即同步可读」的语义
 * （顶栏角标、账号分片、失败清单），还会让 30+ 条既有用例从同步内存改成异步注入，
 * 收益仅在队列 >5 MB 时兑现 —— 换个上限就是同样的效果，改动面却只有几十行。
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * 待同步队列的**总**字节上限（1 MB）。
 *
 * 为什么单条上限还不够：E-3 只管住「一条操作有多大」，管不住「一共排了多少条」。
 * 10 条 250 KB 的批量建站刚好各条都合规，加起来 2.5 MB —— localStorage 每源只有
 * ~5 MB，再算上失败清单与临时 id 映射，写进去就超了。而 writeJson 是尽力而为的
 * （catch 掉配额异常），于是**整批队列在用户眼里凭空消失**：角标归零、编辑全丢，
 * 控制台一声不响。这正是本文件开头说的「静默丢」最难看的一面。
 *
 * 所以入队前先算「现有总量 + 本条」，超了就当面抛 OfflineQueueFullError 且不入队 ——
 * 明确拒绝一次，远比静默丢掉全部已排队操作好。
 *
 * ⚠️ 为什么是 O(n) 逐条重算而不是维护一个累计字节数：队列条数本来就很少（1 MB / 单条
 * 几百字节 ≈ 上千条是理论值，实际正常使用个位数），内存里的数组求和比「增量计数与
 * 各种出队路径（drop / takeAll / requeue / retryFailed）保持同步」可靠得多 ——
 * 增量计数漏更新一处就会算错，而算错的方向可能是「明明满了却继续塞」。
 *
 * ⚠️ 口径必须说清：这是**args 序列化字节的上限，不是盘上字节的硬上限**。
 * 闸门只累加 `estimatePayloadBytes(op.args)`，而落盘的是整条记录 ——
 * 每条还带 kind / ts / uid / opId / state 这些信封字段，实测约 **123 B/条**。
 * QA 用 102 条小操作实测：闸门口径 1046206 B（占 1 MB 的 99.8%），
 * 盘上实际 1058753 B（**101.0%**），溢出约 **1.2%**。
 * 也就是说「闸门放行」并不等于「盘上一定装得下」—— 剩下的余量靠的是
 * localStorage 的 ~5 MB 配额远大于 1 MB（差了 4 MB，1.2% 的溢出吃不出问题）。
 * 真要改成盘上硬上限，就得把信封开销也计进来（还得预知 opId 长度），
 * 换来的只是数字更整齐 —— 不值得。**别照着这个常量去断言盘上字节数。**
 */
export const MAX_QUEUE_BYTES = 1024 * 1024;

/**
 * 失败清单的总字节上限（1 MB）。
 *
 * 单靠 MAX_FAILED_KEPT=50 是不够的：50 × 256 KB = 12.5 MB，是 localStorage 配额的
 * 2.5 倍。真要撞上（比如离线反复重试同一批批量建站），失败清单会把配额吃光，
 * 之后连待同步队列都写不进去 —— 那批操作才是用户真正的编辑，它们不该被
 * 「已经失败的记录」挤掉。所以两条闸门并存：条数管噪声，字节管配额。
 */
export const MAX_FAILED_BYTES = 1024 * 1024;

/**
 * 一条操作超出入队载荷上限。
 *
 * 刻意**不**继承 OfflineQueuedError：那条错误的意思是「已经帮你存下来、联网会自动
 * 同步」，而这条的意思是「根本没存，请联网重试」。混成一条会让界面骗用户
 * 「已暂存」，然后在重放时发现队列里什么都没有。
 */
export class QueuePayloadTooLargeError extends Error {
    constructor(
        public readonly kind: string,
        public readonly size: number,
        public readonly limit: number = MAX_PAYLOAD_BYTES
    ) {
        super(
            `该操作过大无法离线保存，请联网后重试（约 ${Math.ceil(size / 1024)} KB，` +
                `上限 ${Math.floor(limit / 1024)} KB）`
        );
        this.name = "QueuePayloadTooLargeError";
    }
}

/**
 * 待同步队列已经排满（总字节超过 MAX_QUEUE_BYTES），本条**没有**入队。
 *
 * 与 QueuePayloadTooLargeError 同一立场：不继承 OfflineQueuedError。那条的意思是
 * 「帮你存下来了，联网自动同步」，这条的意思是「存不下了，请联网先把现有的发出去」。
 * 混成一条的话界面会说「已暂存」，而用户的这次编辑其实当场就没了。
 *
 * message 直接给用户看（上层只负责把它塞进提示里），所以要写清「存不下」和「怎么办」。
 * 展示 MB 而不是字节 —— 「1048576 字节」没人算得出来。
 *
 * ⚠️ 刻意**不**写「已占用 X / 上限 Y」这组对比：超限 1 个字节时两个数按 MB 取整
 * 都会显示成 1，用户读到「已占用 1 MB / 上限 1 MB」却说满了，是自相矛盾。
 * 这不是精度问题（1.0000009 修到几位都还是 1.0 / 1.0），是那组对比本身不该出现。
 * 只报上限 + 一句「怎么办」就够了。
 */
export class OfflineQueueFullError extends Error {
    constructor(
        /** 本条要入队的载荷估算字节数 */
        public readonly size: number,
        /** 含本条在内的队列总字节数（超了上限的那个值）—— 不进文案，留给日志与断言用 */
        public readonly total: number,
        public readonly limit: number = MAX_QUEUE_BYTES
    ) {
        super(`离线待办已达上限（${formatMb(limit)}），请联网后再试`);
        this.name = "OfflineQueueFullError";
    }
}

/**
 * 这次操作的内容**无法序列化成 JSON**（循环引用 / BigInt 之类），因此没法离线暂存。
 *
 * 为什么必须有这条错误，而不是像以前那样「估成 0 字节放过去」：
 * 队列最终要 JSON.stringify 落进 localStorage。估成 0 的话两道闸门都当它免费放行，
 * 随后 writeJson 里的 stringify 抛错又被 catch 吞掉 —— 结果是**内存里有、盘上没有**。
 * 更糟的是这条坏记录会让整个会话的落盘一起失效（序列化整份数组时在同一条上抛），
 * 于此后每一笔正常编辑都「排队成功、刷新后全丢」，而界面一切正常。
 * 这正是本轮要消灭的「静默丢」最坏的一种，所以宁可在入队这一刻明确拒绝。
 *
 * 同样**不**继承 OfflineQueuedError：它是「没存」，不是「已暂存」。
 */
export class OfflineQueueUnserializableError extends Error {
    constructor(public readonly kind: string = "unknown") {
        super("该操作无法离线暂存（内容含无法序列化的数据），请联网后重试");
        this.name = "OfflineQueueUnserializableError";
    }
}

/** 把字节数换成给用户看的 MB 文案（1 MB 上限要显示成「1 MB」而不是「0.95 MB」） */
function formatMb(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    const rounded = mb >= 1 ? Math.round(mb * 10) / 10 : Math.ceil(mb * 10) / 10;
    return `${rounded} MB`;
}

/**
 * 估算一次操作序列化后的字节数（UTF-8）。
 *
 * 用 TextEncoder 而不是 `json.length`：中文标题约占 3 字节/字，
 * 按字符数算会把 90 KB 的批量建站当成 30 KB，闸门就形同虚设。
 *
 * 序列化失败（循环引用 / BigInt）返回 **Infinity**，不是 0 —— 这个值必须让闸门**拒绝**。
 * 返回 0 的话两道闸门都当它免费放行，接着 writeJson 里那次 stringify 同样抛错、
 * 同样被 catch 吞掉，于是那条记录「内存里有、盘上没有」，还会让**整份数组**之后
 * 都序列化失败（同一个坏条目）—— 之后每一笔正常编辑都排队成功、刷新后全丢。
 * 用 MAX_PAYLOAD_BYTES + 1 做哨兵也不行：那样错误会走「过大」那条文案，
 * 对用户说「操作太大」，而真实原因是内容压根没法序列化。Infinity 能同时满足
 * 「必被拒绝」「不冒充体积」两点，并由调用方先做有限性检查给出正确的错误。
 */
export function estimatePayloadBytes(args: unknown[]): number {
    let json: string;
    try {
        json = JSON.stringify(args) ?? "";
    } catch {
        return Number.POSITIVE_INFINITY;
    }
    return new TextEncoder().encode(json).byteLength;
}

/** 第 n 次重试要等多久（带抖动，指数上限 60s） */
export function backoffDelayMs(attempts: number): number {
    const n = Math.max(0, attempts - 1);
    const capped = Math.min(BACKOFF_BASE_MS * 2 ** n, BACKOFF_MAX_MS);
    // 抖动 50%~100%：同一批发出去的操作别在同一毫秒一起回来
    return Math.round(capped * (0.5 + Math.random() * 0.5));
}

const STORAGE_KEY = "navihive:offlineQueue";
const FAILED_STORAGE_KEY = "navihive:failedMutations";
const TEMP_MAP_KEY = "navihive:offlineTempIds";

/** 当前生效账号；null 表示还没登录（匿名一档）。由 setAccountUid 设置。 */
let accountUid: number | null = null;
/** 存储键按账号分片：换人登录时各自读各自的，不会互相看见 */
let storageKey: string = scopedKey(STORAGE_KEY, null);
let failedStorageKey: string = scopedKey(FAILED_STORAGE_KEY, null);
let tempMapKey: string = scopedKey(TEMP_MAP_KEY, null);

function readJson<T>(key: string, fallback: T): T {
    try {
        const raw = (globalThis.localStorage as Storage | undefined)?.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        (globalThis.localStorage as Storage).setItem(key, JSON.stringify(value));
    } catch {
        // 隐私模式 / 配额满：队列是尽力而为，存不下就本会话内生效
    }
}

function loadQueue(): PendingMutation[] {
    const raw = readJson<PendingMutation[]>(storageKey, []);
    return Array.isArray(raw) ? raw : [];
}

function saveQueue(queue: PendingMutation[]): void {
    writeJson(storageKey, queue);
}

let queue: PendingMutation[] = loadQueue();
let failed: FailedMutation[] = readJson<FailedMutation[]>(failedStorageKey, []);
if (!Array.isArray(failed)) failed = [];
/** 临时 id（负数）→ 重放后拿到的真实 id。按账号分片存，换号不串。 */
let tempIdMap: Record<string, number> = readJson<Record<string, number>>(tempMapKey, {});
if (!tempIdMap || typeof tempIdMap !== "object") tempIdMap = {};

/**
 * 绑定当前账号。换账号会立刻换一份存储并重读队列 ——
 * 于是「A 排队 → 登出 → B 登录 → 自动重放」这条串号路径被物理切断。
 */
export function setAccountUid(uid: number | null): void {
    if (uid === accountUid) return;
    accountUid = uid;
    storageKey = scopedKey(STORAGE_KEY, uid);
    failedStorageKey = scopedKey(FAILED_STORAGE_KEY, uid);
    tempMapKey = scopedKey(TEMP_MAP_KEY, uid);
    queue = loadQueue();
    failed = readJson<FailedMutation[]>(failedStorageKey, []);
    if (!Array.isArray(failed)) failed = [];
    tempIdMap = readJson<Record<string, number>>(tempMapKey, {});
    if (!tempIdMap || typeof tempIdMap !== "object") tempIdMap = {};
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

// ---------------- 临时 id（离线新建分组 → 在同一分组下新建站点）----------------
/**
 * 是不是「本地占位 id」。
 * 真实 id 由 SQLite AUTOINCREMENT 分配，永远是正整数，所以负数不会撞。
 */
export function isTempId(value: unknown): boolean {
    return typeof value === "number" && value < 0 && Number.isFinite(value);
}

let tempSeq = 0;
/** 生成一个本地占位 id。刻意取很大的负数，避免与任何手写的测试数据撞上 */
export function newTempId(): number {
    tempSeq += 1;
    return -(1_000_000 + tempSeq);
}

/** 已解析出的 临时id → 真实id 映射（界面展示 / 测试用） */
export function resolvedTempIds(): Record<string, number> {
    return { ...tempIdMap };
}

/**
 * 把参数里的占位 id 换成重放后拿到的真实 id。
 *
 * 只认两种形状：第一个参数是带 group_id 的对象（createSite / updateSite），
 * 以及它的 sites 数组（importData）。其余原样返回 —— 宁可漏翻也不猜。
 */
export function translateTempIds(args: unknown[], map: Record<string, number> = tempIdMap): unknown[] {
    const translateId = (v: unknown): unknown =>
        isTempId(v) && map[String(v)] !== undefined ? map[String(v)] : v;

    const first = args[0];
    if (!first || typeof first !== "object") return args;
    const obj = first as Record<string, unknown>;
    const out = { ...obj };

    if (out.group_id !== undefined) out.group_id = translateId(out.group_id);
    // updateSite / deleteSite 这类「针对某条记录」的操作：记录本身也可能是离线建的，
    // 它头上还是占位 id，得一并翻译。真实 id 永远是正数，不会误伤。
    if (isTempId(out.id)) out.id = translateId(out.id);

    if (Array.isArray(obj.sites)) {
        out.sites = (obj.sites as Record<string, unknown>[]).map(
            (s) => (s && typeof s === "object" && s.group_id !== undefined
                ? { ...s, group_id: translateId(s.group_id) }
                : s)
        );
    }

    return [out, ...args.slice(1)];
}

// ---------------- 入队 / 出队 ----------------
/**
 * 一组操作参数的总字节数（O(n) 求和，见 MAX_QUEUE_BYTES 的注释为什么不做增量计数）。
 *
 * 求和遇到不可序列化项（Infinity）时结果是 Infinity，比较 `total > MAX_QUEUE_BYTES`
 * 仍然成立 —— 也就是「放不进去」，方向是对的，不需要额外处理。
 */
function totalPayloadBytes(items: ReadonlyArray<{ args: unknown[] }>): number {
    return items.reduce((sum, item) => sum + estimatePayloadBytes(item.args), 0);
}

/**
 * 离线时把一次失败的操作存进队列。
 *
 * 带上入队时的账号：重放前会比对，账号对不上就不重放 ——
 * 「A 的操作在 B 的会话里补发」会直接写到 B 的库里，那是数据串号。
 * 顺带生成幂等键：断网期间重复提交 / 重放成功但回包丢了，服务端据此只认一次。
 *
 * 返回入队的那条记录（含 tempId）：离线新建分组时，界面要拿这个占位 id 先把分组
 * 显示出来，用户才能在它下面继续加站点。
 */
export function enqueueMutation(kind: string, args: unknown[]): PendingMutation {
    // 超限就当面拒绝，不入队：一条 4 MB 的备份进队列后，后面的操作会因为写不进
    // localStorage 配额而静默消失（writeJson 是尽力而为）—— 那比明确报错糟得多。
    const size = estimatePayloadBytes(args);
    // ⚠️ 顺序不能反：不可序列化时 size 是 Infinity，先拿到下面那条会打印出
    // 「约 Infinity KB」，用户完全看不懂；而且真正的原因（内容没法序列化）也被盖住了。
    if (!Number.isFinite(size)) {
        throw new OfflineQueueUnserializableError(kind);
    }
    if (size > MAX_PAYLOAD_BYTES) {
        throw new QueuePayloadTooLargeError(kind, size);
    }
    // 第二道闸门看**总量**：每条都合规、加起来超配额同样会静默丢掉整个队列。
    // 判据用「现有 + 本条 > 上限」而不是「≥」：正好塞满 1 MB 是合法的，不该拒。
    const total = totalPayloadBytes(queue) + size;
    if (total > MAX_QUEUE_BYTES) {
        throw new OfflineQueueFullError(size, total);
    }
    // 新建类操作需要占位 id：离线时拿不到服务端发号，界面得先有个 id 才能继续操作
    // （在刚建的分组下加站点、编辑刚建的卡片）。更新 / 删除都用已有的真实 id。
    const needsTempId = kind === "createGroup" || kind === "createSite";
    const op: PendingMutation = {
        kind,
        args,
        ts: Date.now(),
        uid: accountUid,
        opId: newOperationId(),
        state: "pending",
        ...(needsTempId ? { tempId: newTempId() } : {}),
    };
    queue.push(op);
    saveQueue(queue);
    notifyChange();
    return op;
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

/** 取出并清空队列（测试与「整体丢弃」场景用；重放路径走 flushOfflineQueue） */
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

// ---------------- 失败列表（可查看） ----------------
/** 已经放弃的操作（不再计入待同步角标，但用户能看见、能重试） */
export function failedMutations(): FailedMutation[] {
    return failed.map(f => ({ ...f }));
}

function pushFailed(op: PendingMutation, reason: string): void {
    failed.push({
        kind: op.kind,
        args: op.args,
        ts: op.ts,
        uid: op.uid,
        opId: op.opId,
        attempts: op.attempts ?? 0,
        reason,
        failedAt: Date.now(),
    });
    // 只留最近这些条：再多的历史对排错没帮助，还会把 localStorage 撑爆
    if (failed.length > MAX_FAILED_KEPT) failed = failed.slice(-MAX_FAILED_KEPT);
    // 条数上限兜不住字节：50 × 256 KB = 12.5 MB，是配额的 2.5 倍。按**最旧的先丢**裁到
    // 字节上限内 —— 用户要救的是最近那次编辑，最旧的失败项排错价值也最低。
    // 保底留 1 条（进不来循环）：失败清单的全部意义就是「让用户看见」，清空等于把
    // 「你没同步成功」这件事一起藏起来。单条已受 MAX_PAYLOAD_BYTES（256 KB）限制，
    // 一条撑满 1 MB 需要 4 倍，物理上不会发生。
    let failedBytes = totalPayloadBytes(failed);
    while (failed.length > 1 && failedBytes > MAX_FAILED_BYTES) {
        const dropped = failed.shift();
        if (!dropped) break;
        const droppedBytes = estimatePayloadBytes(dropped.args);
        // 不可序列化的条目理论上进不来（enqueueMutation 的有限性闸门已经拦掉），
        // 这里只做兜底：Infinity 一旦参与减法会得到 -Infinity，循环随即退出、
        // 裁剪静默失效 —— 正是这个文件反复在修的那种「看着没事，其实防线没了」。
        if (Number.isFinite(droppedBytes)) failedBytes -= droppedBytes;
    }
    writeJson(failedStorageKey, failed);
    // ⚠️ 必须在这里通知：重放路径是「先 drop(op) 再 pushFailed(op)」，
    // drop 里那次通知发出去时这条还没进失败清单，订阅者（OfflineBanner、顶栏角标）
    // 看到的还是旧列表 —— 结果是**被服务端拒绝的改动界面上不显示**，
    // 而那正是失败清单唯一存在的理由（悄悄丢掉等于骗人「都同步好了」）。
    notifyChange();
}

function removeFailed(opId: string): FailedMutation | null {
    const index = failed.findIndex(f => f.opId === opId);
    if (index === -1) return null;
    const [removed] = failed.splice(index, 1);
    writeJson(failedStorageKey, failed);
    return removed ?? null;
}

/** 把失败列表里的一条放回队列再试一次（用户修好了问题之后用） */
export function retryFailedMutation(opId: string): boolean {
    const item = removeFailed(opId);
    if (!item) return false;
    queue.push({
        kind: item.kind,
        args: item.args,
        ts: item.ts,
        uid: item.uid,
        opId: item.opId ?? newOperationId(),
        state: "pending",
        attempts: 0,
    });
    saveQueue(queue);
    notifyChange();
    return true;
}

/** 放弃失败列表里的一条（用户确认「这条不要了」） */
export function discardFailedMutation(opId: string): boolean {
    const removed = removeFailed(opId);
    if (removed) notifyChange();
    return removed !== null;
}

/** 清空当前账号的失败列表 */
export function clearFailedMutations(): void {
    failed = [];
    writeJson(failedStorageKey, failed);
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
 * 正在重放：包装层据此**不再入队**。
 * 重放调的是被 wrapMutations 包装过的方法，失败时它会再 enqueue 一条 ——
 * 于是队列里同一件事变成两条，联网后被做两遍。重放期间必须关掉这条入口。
 */
let replaying = false;

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

/** 把「还连不上」的操作按指数退避往后推；重试到上限就进失败列表 */
function scheduleRetry(op: PendingMutation, reason: string): void {
    op.attempts = (op.attempts ?? 0) + 1;
    op.state = "pending";
    op.sentAt = undefined;
    op.lastError = reason;
    if (op.attempts >= MAX_REPLAY_ATTEMPTS) {
        drop(op);
        pushFailed(op, `${reason}（已重试 ${op.attempts} 次后放弃）`);
        return;
    }
    op.nextAttemptAt = Date.now() + backoffDelayMs(op.attempts);
    saveQueue(queue);
}

/** 收回到期还没落地的 sending 操作：发它的那个页面多半已经关了 */
function reclaimStuckSending(): void {
    const now = Date.now();
    let changed = false;
    for (const op of queue) {
        if (op.state === "sending" && (op.sentAt ?? 0) + SENDING_LEASE_MS <= now) {
            op.state = "pending";
            op.sentAt = undefined;
            op.attempts = (op.attempts ?? 0) + 1;
            changed = true;
        }
    }
    if (changed) saveQueue(queue);
}

/**
 * 重放队列：逐个调 api[kind](...args)。返回成功数。
 *
 * 状态机是 pending → sending →（服务端确认后）从存储删除：
 * 成功一条才划掉一条，中途关页面 / 崩溃时剩下的还在盘上，不会凭空消失。
 */
export async function flushOfflineQueue(api: MutationApi): Promise<number> {
    if (isOffline() || flushing || queue.length === 0) return 0;
    flushing = true;
    replaying = true;
    let done = 0;
    try {
        reclaimStuckSending();
        // 最多重放一轮：仍失败的会被推迟或进失败列表，等下一次 online，不会在这里死循环
        const pending = [...queue];
        for (const op of pending) {
            if (isOffline()) break;
            // 退避未到期的不碰：刚失败过就再锤一遍只会把服务端拖得更惨
            if (op.nextAttemptAt && op.nextAttemptAt > Date.now()) continue;
            if (op.state === "sending") continue;

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

                // 先标 sending 再落盘：页面此刻关掉的话，下次启动能靠租期把它收回来重发，
                // 而不是像「先取出再执行」那样凭空消失。
                op.state = "sending";
                op.sentAt = Date.now();
                saveQueue(queue);

                // 占位 id 这里翻译：离线新建的分组拿到的真实 id 要回填到后续操作里，
                // 否则站点会挂在一个本地才有的负数分组上。
                const res = await fn.apply(api, translateTempIds(op.args));

                // returnsSuccess 类方法：返回假也视为没成功。
                // 有的方法（importData）返回的是带 success 字段的对象，对象本身恒为真，
                // 得看里面的 success 才算数。
                const def = MUTATION_METHODS.find(m => m.name === op.kind);
                if (def?.returnsSuccess && isFailedResult(res)) {
                    scheduleRetry(op, "服务端未接受该操作");
                    continue;
                }

                // 新建类操作拿到了真实 id：记下 占位id → 真实id。
                // 后面「在这个分组下加的站点」「编辑这张卡片」重放时才有号可用。
                if (op.tempId !== undefined && res && typeof res === "object") {
                    const realId = (res as { id?: unknown }).id;
                    if (typeof realId === "number") {
                        tempIdMap[String(op.tempId)] = realId;
                        writeJson(tempMapKey, tempIdMap);
                    }
                }

                // 服务端确认了才从盘上划掉（acked）
                drop(op);
                done++;
            } catch (err) {
                if (isRejectedByServer(err)) {
                    // 服务端明确拒绝：重试没有意义，进失败列表让用户自己决定
                    drop(op);
                    pushFailed(
                        op,
                        err instanceof Error ? err.message : "服务端拒绝了该操作"
                    );
                    continue;
                }
                // 连不上 / 5xx 之类：退避后等下次 online
                scheduleRetry(op, err instanceof Error ? err.message : String(err));
            }
        }
    } finally {
        flushing = false;
        replaying = false;
    }
    return done;
}

/** 可识别的「已离线、已入队」错误，让上层显示温和提示而不是硬失败 */
export class OfflineQueuedError extends Error {
    /** 离线新建分组时带出的本地占位 id；界面靠它先把分组显示出来 */
    public readonly tempId?: number;

    constructor(public readonly kind: string, cause?: unknown, tempId?: number) {
        super(`操作已离线保存，将在恢复连接后自动同步：${kind}`);
        this.name = "OfflineQueuedError";
        if (tempId !== undefined) this.tempId = tempId;
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
 *
 * ⚠️ 还多两种出口：载荷超过 MAX_PAYLOAD_BYTES（QueuePayloadTooLargeError）、
 * 或队列总字节超过 MAX_QUEUE_BYTES（OfflineQueueFullError）时，enqueueMutation 抛的错会
 * **原样穿出这一层**（不包装成 OfflineQueuedError）—— 因为那条错误代表「已暂存」，
 * 而这两条都表示什么都**没存**，调用方要单独提示。
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
                if (m.returnsSuccess && !res && isOffline() && !replaying) {
                    enqueueMutation(m.name, args);
                    throw new OfflineQueuedError(m.name);
                }
                return res;
            } catch (err) {
                // 重放期间不再入队：flush 拿到的就是包装后的这个方法，
                // 这里再入一条会让同一件事在队列里出现两次，联网后被做两遍。
                if (isOfflineError(err) && !replaying) {
                    const op = enqueueMutation(m.name, args);
                    throw new OfflineQueuedError(m.name, err, op.tempId);
                }
                throw err;
            }
        };
    }
}
