// src/utils/passwordGenerator.ts
// 密码生成器 + 强度评估（方案 A「收纳增强」，2026-10-25）。
//
// 设计约束（对齐 docs/password-manager-scope.md 的方案 A）：
//   - **纯客户端、纯函数、可单测**：只用 crypto.getRandomValues（WebCrypto，
//     浏览器与 Node 22 全局都有），零外部依赖，不碰网络/存储。生成发生在内存，
//     填进输入框后怎么保存由既有链路（站点新建/编辑）决定，本模块不感知。
//   - 这是四项里**唯一能独立交付**的一块：不碰 schema、不碰迁移、不碰密钥管理。
//   - 做进将来的方案 B（保险库）也能直接复用这两个函数。
//
// ⚠️ 随机性来源只有 crypto.getRandomValues，**不用 Math.random**（可预测，密码场景不可接受）。

/** 默认排除的易混淆字符（0/O、1/l/I、|）—— 用户抄写时看错是真实痛点 */
const AMBIGUOUS = /[0O1lI|]/g;

const POOL = {
    lower: "abcdefghijklmnopqrstuvwxyz",
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    digits: "0123456789",
    // 标点取一组跨键盘常见、且在 JSON/HTML/命令行里不需要额外转义太多的
    symbols: "!@#$%^&*()-_=+[]{};:,.<>?/~",
};

export interface GenerateOptions {
    /** 目标长度，默认 20；夹在 [4, 128] */
    length?: number;
    /** 含大写，默认 true */
    upper?: boolean;
    /** 含数字，默认 true */
    digits?: boolean;
    /** 含符号，默认 true */
    symbols?: boolean;
    /** 排除易混淆字符，默认 true */
    avoidAmbiguous?: boolean;
}

/** 从 WebCrypto 取一个 uint32 */
function randomUint32(): number {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0];
}

/**
 * [0, max) 上的**均匀**随机整数。
 * 用拒绝采样消除 `% max` 的取模偏置 —— max 不整除 2^32 时，直接取模会让小数
 * 端字符出现概率略高。密码场景宁可多抽一次也不要这点偏置。
 */
function randomIndex(max: number): number {
    if (max <= 1) return 0;
    const limit = Math.floor(0x1_0000_0000 / max) * max;
    let x = randomUint32();
    while (x >= limit) x = randomUint32();
    return x % max;
}

function clamp(n: number, lo: number, hi: number): number {
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * 生成一个随机密码。
 *
 * 每个被启用的字符类**至少出现一次**（长度够的话），再补齐到目标长度，最后
 * Fisher–Yates 洗牌 —— 否则「保证类别的字符」总固定在开头，等于把结构泄露了。
 */
export function generatePassword(opts: GenerateOptions = {}): string {
    const length = clamp(opts.length ?? 20, 4, 128);
    const avoid = opts.avoidAmbiguous !== false;
    const strip = (s: string) => (avoid ? s.replace(AMBIGUOUS, "") : s);

    // 小写恒定启用；其余三类可关。过滤后为空的类丢弃（避免 selected 但池空）。
    const pools = [
        POOL.lower,
        opts.upper !== false ? POOL.upper : "",
        opts.digits !== false ? POOL.digits : "",
        opts.symbols !== false ? POOL.symbols : "",
    ]
        .map(strip)
        .filter(s => s.length > 0);

    const alphabet = pools.join("");
    const out: string[] = [];
    // 先保证每个池来一个（不超过目标长度）
    const guaranteed = Math.min(pools.length, length);
    for (let i = 0; i < guaranteed; i++) {
        out.push(pools[i][randomIndex(pools[i].length)]);
    }
    while (out.length < length) {
        out.push(alphabet[randomIndex(alphabet.length)]);
    }
    for (let i = out.length - 1; i > 0; i--) {
        const j = randomIndex(i + 1);
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
    }
    return out.join("");
}

// ---------------- 强度评估 ----------------

export type StrengthLabel = "很弱" | "弱" | "中" | "强" | "很强";

export interface StrengthResult {
    /** 0 很弱 … 4 很强 */
    score: 0 | 1 | 2 | 3 | 4;
    label: StrengthLabel;
    /** 粗略熵估计（bit）：length × log2(字符池大小)，未计模式惩罚 */
    entropyBits: number;
    /** 命中就展示的具体问题（重复字符、常见弱口令、纯数字……） */
    warnings: string[];
}

/** 一小撮常见弱口令 —— 命中直接压到最低档，别让 "Password1!" 之类蒙混过关 */
const COMMON = new Set([
    "password", "password1", "password123", "123456", "12345678", "123456789",
    "qwerty", "qwerty123", "abc123", "admin", "administrator", "letmein",
    "welcome", "iloveyou", "monkey", "dragon", "sunshine", "princess",
    "football", "baseball", "master", "shadow", "superman", "trustno1",
    "passw0rd", "p@ssw0rd", "zaq12wsx", "asdfgh", "111111", "000000",
]);

function charsetSize(pw: string): number {
    let n = 0;
    if (/[a-z]/.test(pw)) n += 26;
    if (/[A-Z]/.test(pw)) n += 26;
    if (/[0-9]/.test(pw)) n += 10;
    // 非字母数字的都算符号，粗估 20
    if (/[^a-zA-Z0-9]/.test(pw)) n += 20;
    return n || 1;
}

/** 评估一个密码的强度（启发式，给 UI 展示用，不是加密学保证）。 */
export function passwordStrength(pw: string): StrengthResult {
    const value = pw ?? "";
    const warnings: string[] = [];
    if (value.length === 0) {
        return { score: 0, label: "很弱", entropyBits: 0, warnings: ["空密码"] };
    }

    const size = charsetSize(value);
    const entropyBits = value.length * Math.log2(size);

    // 常见弱口令（大小写不敏感）
    if (COMMON.has(value.toLowerCase())) {
        warnings.push("常见弱口令，几乎会被第一时间猜到");
    }
    // 只有一类字符
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(re => re.test(value)).length;
    if (classes <= 1) warnings.push(value.length && /^[0-9]+$/.test(value) ? "纯数字" : "只有一类字符");
    if (value.length < 12) warnings.push(`偏短（${value.length} 位，建议 ≥ 12）`);
    // 连续重复（aaa / 111）
    if (/(.)\1{2,}/.test(value)) warnings.push("有连续重复字符");
    // 递增/递减序列（1234 / abcd / 4321）
    if (hasSequence(value)) warnings.push("含连续升降序序列");

    let score: StrengthResult["score"];
    if (entropyBits < 28) score = 0;
    else if (entropyBits < 40) score = 1;
    else if (entropyBits < 60) score = 2;
    else if (entropyBits < 80) score = 3;
    else score = 4;

    // 命中常见弱口令 / 太短 → 强行压顶
    if (COMMON.has(value.toLowerCase()) || value.length < 8) score = Math.min(score, 1) as StrengthResult["score"];
    if (value.length < 6) score = 0;

    const labels: StrengthLabel[] = ["很弱", "弱", "中", "强", "很强"];
    return { score, label: labels[score], entropyBits: Math.round(entropyBits), warnings };
}

/** 是否存在长度 ≥ 4 的连续升/降序字符序列（按 charCode 相邻判断） */
function hasSequence(pw: string): boolean {
    let run = 1;
    for (let i = 1; i < pw.length; i++) {
        const d = pw.charCodeAt(i) - pw.charCodeAt(i - 1);
        if (d === 1 || d === -1) {
            run += 1;
            if (run >= 4) return true;
        } else {
            run = 1;
        }
    }
    return false;
}
