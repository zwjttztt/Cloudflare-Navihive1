// src/utils/passwordHealth.ts
// 密码健康分析（方案 A「收纳增强」，2026-10-25）。
//
// 纯函数：输入「**已解密**」的站点凭据列表，输出 重复 / 弱 / 久未改 三组报告。
// 不碰网络、不碰存储 —— 解密由调用方（前端，手里已有解密后的站点）负责，
// 这里只做「看得见全量明文之后」的统计。零 schema / 零迁移，独立可交付。
//
// 与服务端无关，所以它能离线跑、也能进将来的方案 B（保险库）复用同一套判据。

import { passwordStrength } from "./passwordGenerator";

export interface CredentialEntry {
    id: number;
    /** 站点名（展示用） */
    name: string;
    username?: string;
    /** 解密后的明文密码；空 = 该站点没存密码 */
    password?: string;
    /** SQLite "YYYY-MM-DD HH:MM:SS"（UTC 无时区）或 ISO 串 */
    updated_at?: string;
}

export interface DuplicateGroup {
    password: string;
    count: number;
    sites: { id: number; name: string }[];
}

export interface WeakEntry {
    id: number;
    name: string;
    score: number;
    reasons: string[];
}

export interface StaleEntry {
    id: number;
    name: string;
    updatedAt: string | null;
    /** 距今天数（可能很大） */
    daysSince: number;
}

export interface HealthReport {
    /** 存了密码的站点数（分析口径） */
    total: number;
    /** 填了用户名却没填密码的站点数（善意提醒，不算问题） */
    usernameOnly: number;
    /** 同一密码用在 ≥2 个站点 */
    duplicates: DuplicateGroup[];
    /** 强度评分 ≤ weakMaxScore 的 */
    weak: WeakEntry[];
    /** 超过 staleDays 天未改的 */
    stale: StaleEntry[];
    staleDays: number;
}

export interface AnalyzeOptions {
    /** 「现在」的毫秒时间戳，测试可注入；默认 Date.now() */
    now?: number;
    /** 超过多少天未改算陈旧，默认 365 */
    staleDays?: number;
    /** 强度评分 ≤ 此值算「弱」，默认 1（很弱 / 弱） */
    weakMaxScore?: number;
}

/**
 * 解析站点的 updated_at。
 * 项目里 SQLite 时间是 **UTC 无时区串**（见 utils/sqlTime 的说明），直接 new Date()
 * 在东八区会差 8 小时 —— 所以补一个 "Z" 再解析。ISO 串（自带时区）原样交给他。
 */
function parseUpdatedAt(raw: string | undefined): number | null {
    if (!raw) return null;
    const s = raw.trim();
    if (!s) return null;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? `${s.replace(" ", "T")}Z` : s;
    const t = Date.parse(normalized);
    return Number.isNaN(t) ? null : t;
}

const DAY_MS = 86_400_000;

/** 分析一批站点凭据，产出健康报告。纯函数，同样输入必然同样输出。 */
export function analyzeCredentials(
    entries: CredentialEntry[],
    opts: AnalyzeOptions = {}
): HealthReport {
    const now = opts.now ?? Date.now();
    const staleDays = opts.staleDays ?? 365;
    const weakMaxScore = opts.weakMaxScore ?? 1;
    const list = Array.isArray(entries) ? entries : [];

    let usernameOnly = 0;
    const withPassword = list.filter(e => typeof e.password === "string" && e.password.length > 0);
    for (const e of list) {
        if ((!e.password || e.password.length === 0) && e.username && e.username.length > 0) {
            usernameOnly += 1;
        }
    }

    // 重复：按明文密码分组，≥2 个站点即报
    const byPassword = new Map<string, { id: number; name: string }[]>();
    for (const e of withPassword) {
        const key = e.password as string;
        const arr = byPassword.get(key) ?? [];
        arr.push({ id: e.id, name: e.name });
        byPassword.set(key, arr);
    }
    const duplicates: DuplicateGroup[] = [];
    for (const [password, sites] of byPassword) {
        if (sites.length >= 2) duplicates.push({ password, count: sites.length, sites });
    }
    // 重复最多的排前面（用户最该先改的就是它）
    duplicates.sort((a, b) => b.count - a.count);

    // 弱口令
    const weak: WeakEntry[] = [];
    for (const e of withPassword) {
        const s = passwordStrength(e.password as string);
        if (s.score <= weakMaxScore) {
            weak.push({ id: e.id, name: e.name, score: s.score, reasons: s.warnings });
        }
    }

    // 久未改
    const stale: StaleEntry[] = [];
    const threshold = staleDays * DAY_MS;
    for (const e of withPassword) {
        const t = parseUpdatedAt(e.updated_at);
        // 没有可解析的时间戳就不武断判陈旧（宁可漏报也不要误报）
        if (t === null) continue;
        const daysSince = Math.floor((now - t) / DAY_MS);
        if (now - t > threshold) {
            stale.push({ id: e.id, name: e.name, updatedAt: e.updated_at ?? null, daysSince });
        }
    }
    stale.sort((a, b) => b.daysSince - a.daysSince);

    return {
        total: withPassword.length,
        usernameOnly,
        duplicates,
        weak,
        stale,
        staleDays,
    };
}
