// src/API/methods/sessions.ts
// NavigationAPI 的「sessions」域方法体：登录设备（会话）的登记、刷新与吊销。
//
// 为什么需要它：JWT 是无状态的，「改密 / 注销」只能靠 bump token_version 把某个账号的
// 令牌**整体**作废。这样有个盲区 —— 电脑丢了、或怀疑某台设备被人用过，主人没法只踢那一台：
// 要么改密把自己其它设备一起踢掉，要么干瞪眼等着。
//
// 办法是给每张令牌发一张「身份证」：签发时按 jti 登记一行（UA / IP / 时间），
// 之后就能按 jti 单独吊销。吊销 = 拉黑（真正让令牌失效）+ 删行（列表里消失），
// 别的设备完全不受影响。
//
// ⚠️ 拉黑这一步不能省：只删行的话，那张令牌在过期前依然能通过验签（JWT 自包含），
// 界面上看不到它、它却照样能改数据 —— 比不吊销更糟，因为主人会以为已经踢掉了。
import type { NavigationAPI } from "../http";
import { peekJwtClaim } from "../crypto";
import type { SessionInfo } from "../types";

/** last_seen 的刷新限频：同一个会话 1 小时内只写一次，避免每个请求都往 D1 落一行 */
const SESSION_TOUCH_INTERVAL_SEC = 60 * 60;

/** UA 存库前截断：恶意客户端可以塞超长 UA，别让它把行撑爆 */
const MAX_UA_LEN = 300;

/**
 * 设备标识的归一化：**浏览器家族 + 系统家族**，版本号一概不计。
 *
 * 为什么不能拿整条 UA 当设备标识：Chrome 每次大版本升级，UA 里的版本号就变
 * （Chrome/141.0.x → Chrome/142.0.x）；Android 大版本升级 likewise。
 * 同一台设备的两次登录于是被判成两台设备，「登录设备」列表里出现两行
 * 看着一模一样的条目 —— 2026-10-17 用户报的「重复设备」就是这么来的。
 * 为什么不能再用 UA + IP（v2.0.0 的做法，已证明不够）：出口 IP 会漂 ——
 * 家庭宽带 IPv4/IPv6 双栈各记一个地址、重拨换地址、经过不同代理链记下的
 * 段位也不同。同一台设备照样裂成两行。
 *
 * 归一化成「浏览器 · 系统」后，版本升级与 IP 漂移都不再制造重复行。
 * 这也是界面上实际显示的身份（AccountDialog 的 describeUserAgent 就认这两样），
 * 一行一台「看得出来的设备」。
 *
 * 代价（已知且接受）：同一台电脑上的 Chrome 稳定版与 Canary 共用一把键，
 * 后登录的会把先登录的顶下线；两台同型号手机也只留一行。对这个个人站点
 * 「一台设备一个活跃会话」的定位，这正是期望行为。
 */
export function deviceKeyOf(ua: string): string {
    if (!ua) return "unknown";
    // 判定顺序要紧：Edge 的 UA 里也含 "Chrome"、Chrome 的里面也含 "Safari"。
    const browser = /Edg\//.test(ua)
        ? "Edge"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Firefox\//.test(ua)
            ? "Firefox"
            : /Chrome\//.test(ua)
              ? "Chrome"
              : /Safari\//.test(ua)
                ? "Safari"
                : "";
    const os = /Windows NT/.test(ua)
        ? "Windows"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Android/.test(ua)
            ? "Android"
            : /Macintosh/.test(ua)
              ? "macOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
    if (browser || os) return `${browser}|${os}`;
    // 认不出的 UA（脚本客户端 / 小众内置浏览器）：抹掉版本号再比，
    // 至少同一客户端的升级不会裂成两行
    return ua.replace(/\d+(\.\d+)*/g, "#").slice(0, 80);
}

/**
 * 「这两行是不是同一台设备」（2026-10-22，修互踢下线）。
 *
 * ⚠️ 为什么不能只用归一化 UA：`Chrome|Windows` 这一把键会被**所有**
 *    「Windows + Chrome」客户端共用 —— 另一台电脑、另一个 Chrome 配置文件、
 *    虚拟机里的系统，全都是同一把键。后登录的据此把先登录的令牌拉黑，
 *    两台机器就互相顶下线（线上实证：每次开机第一次必 401，
 *    还出现过「登录→57 秒后 401→再登录→26 秒后 401」的循环）。
 *
 * 判定：**只有两边都有 device_id 且相等**，才算同一台设备。
 *   - device_id 是客户端持久化的随机 UUID（utils/deviceId.ts），同一台电脑的
 *     同一个浏览器配置才相同；换电脑 / 换 profile / 清缓存都会变。
 *   - 缺一边（老会话行、隐私模式客户端）→ 判**不同**。代价是列表里可能多一行，
 *     收益是绝不误踢 —— 被踢下线意味着「每次开机都要重新登录」，
 *     而多一行只是界面上多个条目，老行还会在 30 天内自然过期。
 *     ⚠️ 这里刻意**不**回退到 UA：回退就等于把「一台旧版 + 一台新版」
 *        这种最常见的过渡组合继续留在互踢里，修了等于没修。
 *
 * ⚠️ device_id 由客户端提供、可伪造，所以它**不是凭证**：唯一用途是
 *    「别把别人的设备误判成自己」。伪造最多让自己的会话在列表里合并显示。
 */
function sameDevice(
    rowDeviceId: string | null | undefined,
    _rowUserAgent: string | null | undefined,
    currentDeviceId: string | null | undefined,
    _currentUserAgent: string
): boolean {
    if (!rowDeviceId || !currentDeviceId) return false;
    return rowDeviceId === currentDeviceId;
}

export interface SessionsApi {
    /** 登录成功后登记这张令牌（jti / 过期时间 / 账号都从 token 里解，调用方不必知道） */
    /**
     * 登录成功后登记这张令牌。
     *
     * @param deviceId 客户端持久设备 ID（见 utils/deviceId.ts）。**判「是不是同一台
     *   设备」只认它**；为 null（老客户端 / 隐私模式）时才回退到归一化 UA。
     */
    recordSession(
        token: string,
        userAgent: string,
        ip: string,
        deviceId?: string | null
    ): Promise<void>;
    /** 验签通过后刷新「最后活跃」（限频） */
    touchSession(jti: string): Promise<void>;
    /** 列出某账号仍然有效的会话；currentJti 用来标出「当前这一台」 */
    listSessions(uid: number, currentJti: string): Promise<SessionInfo[]>;
    /** 吊销单个会话（只能吊销自己的） */
    revokeSession(uid: number, jti: string): Promise<{ success: boolean; message?: string }>;
    /** 吊销除 currentJti 之外的所有会话（「退出其它设备」） */
    revokeOtherSessions(
        uid: number,
        currentJti: string
    ): Promise<{ success: boolean; revoked: number; message?: string }>;
}

export const sessionsImpl: SessionsApi = {

    /**
     * 登记一张新令牌。
     *
     * 失败一律吞掉：登录本身已经成功了，不能因为「记设备」这件锦上添花的事
     * 反过来把人挡在门外（记不上最多是列表里少一行，踢设备的入口还在）。
     */
    recordSession: async function (
        this: NavigationAPI,
        token: string,
        userAgent: string,
        ip: string,
        deviceId?: string | null
    ): Promise<void> {
        if (!token) return;
        try {
            const jti = peekJwtClaim(token, "jti");
            const exp = peekJwtClaim(token, "exp");
            const uid = peekJwtClaim(token, "uid");
            if (typeof jti !== "string" || !jti) return;
            if (typeof exp !== "number") return;

            const now = Math.floor(Date.now() / 1000);
            // device_id 落库：老库里这一列可能是 NULL（迁移补的），所以写入时允许 null。
            const did = typeof deviceId === "string" && deviceId ? deviceId.slice(0, 64) : null;
            // ON CONFLICT：同一 jti 重复登记（重试 / 重放登录）时只更新时间，不插第二行
            await this.db
                .prepare(
                    `INSERT INTO user_sessions (jti, user_id, user_agent, ip, created_at, last_seen_at, expires_at, device_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(jti) DO UPDATE SET last_seen_at = ?, expires_at = ?, device_id = COALESCE(excluded.device_id, user_sessions.device_id)`
                )
                .bind(
                    jti,
                    typeof uid === "number" ? uid : null,
                    (userAgent || "").slice(0, MAX_UA_LEN),
                    ip || "",
                    now,
                    now,
                    exp,
                    did,
                    now,
                    exp
                )
                .run();

            // 同设备重登去重（用户 2026-10-17 报告「登录设备重复显示」）：
            // 同一账号 + 同一台设备（归一化 UA，见 deviceKeyOf）的旧会话是
            // 同一台设备的历史登录，把它们拉黑并删行 —— 列表里一台设备只留最新一条。
            // ⚠️ 必须先拉黑再删：旧令牌在过期前仍能通过验签，只删行的话
            // 界面看不见它、它却照样能用，比不清理更糟。
            if (typeof uid === "number") {
                const old = await this.db
                    .prepare(
                        `SELECT jti, expires_at, user_agent, device_id FROM user_sessions
                         WHERE user_id = ? AND jti != ?`
                    )
                    .bind(uid, jti)
                    .all<{
                        jti: string;
                        expires_at: number;
                        user_agent: string | null;
                        device_id: string | null;
                    }>();
                const stale = (old.results || []).filter(row =>
                    sameDevice(row.device_id, row.user_agent, did, userAgent)
                );
                for (const row of stale) {
                    await this.blacklistToken(row.jti, row.expires_at);
                }
                if (stale.length > 0) {
                    await this.db
                        .prepare(
                            `DELETE FROM user_sessions
                             WHERE user_id = ? AND jti IN (${stale.map(() => "?").join(",")})`
                        )
                        .bind(uid, ...stale.map(row => row.jti))
                        .run();
                }
            }
        } catch (error) {
            console.error("登记登录会话失败:", error);
        }
    },

    /**
     * 刷新「最后活跃」。限频写在 SQL 里（last_seen_at 超过 1 小时才更新），
     * 这样每个请求都不必先 SELECT 一次再决定要不要写 —— 省掉一半查询。
     */
    touchSession: async function (this: NavigationAPI, jti: string): Promise<void> {
        if (!jti) return;
        try {
            const now = Math.floor(Date.now() / 1000);
            await this.db
                .prepare(
                    `UPDATE user_sessions SET last_seen_at = ? WHERE jti = ? AND last_seen_at < ?`
                )
                .bind(now, jti, now - SESSION_TOUCH_INTERVAL_SEC)
                .run();
        } catch {
            // 表还没建好、或这行已被清理掉，都不该影响主流程
        }
    },

    /**
     * 列出某账号仍然有效的会话。
     *
     * 过期的直接不返回：令牌过期后这张会话已经不能再用了，列出来只会让人以为
     * 「还有一台设备登着」，实际点吊销也是空操作。
     *
     * 同设备去重（2026-10-17，v2.0.0 起）：recordSession 会在重登时顶掉同设备
     * 旧会话，但历史遗留的重复行还在库里（旧版按 UA+IP 判重，版本升级 / IP 漂移
     * 漏掉的）—— 列表时按**归一化设备键**折叠（deviceKeyOf：浏览器 + 系统，
     * 不计版本号与 IP），只留最近活跃的一条；被折叠的旧行顺手拉黑 + 删行自愈
     * （当前会话那一行永不折叠）。
     *
     * 两档折叠（2026-10-24 补第二档）：
     *   ① device_id 相同 → 真·同一设备，折叠 + 拉黑 + 删行（上面那段）；
     *   ② 只是「看起来一样」（UA 家族 + 系统相同，且有一边没有 device_id，
     *      或 IP 也相同）→ 只折叠显示，**不吊销**。见下面列的判定注释。
     */
    listSessions: async function (
        this: NavigationAPI,
        uid: number,
        currentJti: string
    ): Promise<SessionInfo[]> {
        const now = Math.floor(Date.now() / 1000);
        try {
            const result = await this.db
                .prepare(
                    // ⚠️ device_id 必须一起选出来：折叠键优先用它（见下面的 deviceKey）。
                    //    漏了它就会静默回退到归一化 UA —— 而那正是互踢下线的根因。
                    `SELECT jti, user_agent, device_id, ip, created_at, last_seen_at, expires_at
                     FROM user_sessions
                     WHERE user_id = ? AND expires_at > ?
                     ORDER BY last_seen_at DESC`
                )
                .bind(uid, now)
                .all<{
                    jti: string;
                    user_agent: string | null;
                    device_id: string | null;
                    ip: string | null;
                    created_at: number;
                    last_seen_at: number;
                    expires_at: number;
                }>();
            const rows = result.results || [];

            // 折叠同设备重复：键 = deviceKeyOf(UA)（浏览器 + 系统，不计版本与 IP）。
            // 两轮走：第一轮让**当前会话**先占掉它的设备键（它永远不被折叠），
            // 第二轮其余行按 last_seen 倒序（SQL 已排好）各认各的键。
            // 为什么不能一轮顺着排：万一某条陈行的 last_seen 比当前行还新
            // （手工改库 / 极端竞态），一轮会把陈行先放进去、当前行再进来，
            // 同一设备就漏折叠成两行。
            // 折叠键（2026-10-22）：优先 device_id，老行回退归一化 UA。
            // 用 device_id 做键才不会被「另一台 Windows+Chrome」误折叠 ——
            // 那正是互踢下线的根因（见 sameDevice 注释）。
            const seenDevices = new Set<string>();
            const deviceKey = (row: { user_agent: string | null; device_id: string | null }): string =>
                row.device_id ? `did:${row.device_id}` : `ua:${deviceKeyOf(row.user_agent || "")}`;
            const uaKeyOf = (row: { user_agent: string | null }): string =>
                deviceKeyOf(row.user_agent || "");
            const out: SessionInfo[] = [];
            const stale: Array<{ jti: string; expires_at: number }> = [];
            /** 已经列出来的行（用来判断「后面这条是不是它的重复」） */
            const listed: Array<{
                user_agent: string | null;
                device_id: string | null;
                ip: string | null;
            }> = [];
            const toInfo = (row: {
                jti: string;
                user_agent: string | null;
                ip: string | null;
                created_at: number;
                last_seen_at: number;
                expires_at: number;
            }, current: boolean): SessionInfo => ({
                jti: row.jti,
                userAgent: row.user_agent || "",
                ip: row.ip || "",
                createdAt: row.created_at,
                lastSeenAt: row.last_seen_at,
                expiresAt: row.expires_at,
                current,
            });
            for (const row of rows) {
                if (row.jti !== currentJti) continue;
                seenDevices.add(deviceKey(row));
                listed.push(row);
                out.push(toInfo(row, true));
            }
            for (const row of rows) {
                if (row.jti === currentJti) continue;
                const key = deviceKey(row);
                if (seenDevices.has(key)) {
                    stale.push({ jti: row.jti, expires_at: row.expires_at });
                    continue;
                }
                // 「看起来是同一台」的重复行（2026-10-24，用户第二次报「登录设备有重复」）：
                // 界面上能区分的只有「浏览器 · 系统」和 IP，所以两天前那个没有 device_id
                // 的老会话（老客户端 / 脚本登录留下的）会和当前设备**长得一模一样**，
                // 明明是同一条机器却在列表里占两行。
                // 折叠条件（满足其一即可，且必须 UA 家族 + 系统相同）：
                //   · 任意一边没有 device_id —— 识别不了的行，只能按外观认；
                //   · IP 也相同 —— 同一处出口 + 同一个浏览器，看着就是同一台。
                // ⚠️ 这里**只折叠显示，不拉黑也不删行**：认不出来的行不能替用户踢掉
                //    （误踢 = 那台机器下次打开就要重新登录）。真想清干净还有
                //    「退出其它设备」，那一个动作是全清的。
                if (
                    listed.some(
                        other =>
                            uaKeyOf(other) === uaKeyOf(row) &&
                            (!other.device_id ||
                                !row.device_id ||
                                (other.ip || "") === (row.ip || ""))
                    )
                ) {
                    continue;
                }
                listed.push(row);
                seenDevices.add(key);
                out.push(toInfo(row, false));
            }

            // 自愈：被折叠的旧会话拉黑 + 删行。拉黑失败不阻塞列表（那行已从视图消失，
            // 最坏情况是旧令牌活到过期 —— 与修复前的行为一致，不倒退）。
            for (const s of stale) {
                try {
                    await this.blacklistToken(s.jti, s.expires_at);
                } catch {
                    // 拉黑失败：下次列表还会再试
                }
            }
            if (stale.length > 0) {
                await this.db
                    .prepare(
                        `DELETE FROM user_sessions WHERE user_id = ? AND jti IN (${stale
                            .map(() => "?")
                            .join(",")})`
                    )
                    .bind(uid, ...stale.map(s => s.jti))
                    .run();
            }

            return out;
        } catch {
            // 表还没建好：返回空列表，界面上那段直接不显示
            return [];
        }
    },

    /**
     * 吊销单个会话。
     *
     * 用 `WHERE jti = ? AND user_id = ?` 而不是只按 jti：少了账号条件，
     * 任何人猜到一个 jti 就能把别人的设备踢下线（虽然踢人只是骚扰，但不能开这个口子）。
     */
    revokeSession: async function (
        this: NavigationAPI,
        uid: number,
        jti: string
    ): Promise<{ success: boolean; message?: string }> {
        if (!jti) return { success: false, message: "缺少会话标识" };
        try {
            const row = await this.db
                .prepare("SELECT jti, expires_at FROM user_sessions WHERE jti = ? AND user_id = ?")
                .bind(jti, uid)
                .first<{ jti: string; expires_at: number }>();
            if (!row) return { success: false, message: "会话不存在或不属于当前账号" };

            // 先拉黑再删行：顺序反了的话，万一删完崩了，那张令牌还能用到过期
            await this.blacklistToken(row.jti, row.expires_at);
            await this.db.prepare("DELETE FROM user_sessions WHERE jti = ?").bind(jti).run();
            return { success: true };
        } catch (error) {
            return {
                success: false,
                message: "吊销失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    },

    /**
     * 退出其它设备：除当前这一台之外全部吊销。
     *
     * currentJti 为空（用 Authorization 头的脚本客户端，没有 cookie 会话概念）时
     * 会把自己的也一起踢掉 —— 那种场景本来就没有「当前设备」可言，全踢才符合预期。
     */
    revokeOtherSessions: async function (
        this: NavigationAPI,
        uid: number,
        currentJti: string
    ): Promise<{ success: boolean; revoked: number; message?: string }> {
        try {
            const result = await this.db
                .prepare("SELECT jti, expires_at FROM user_sessions WHERE user_id = ? AND jti != ?")
                .bind(uid, currentJti)
                .all<{ jti: string; expires_at: number }>();
            const rows = result.results || [];

            for (const row of rows) {
                await this.blacklistToken(row.jti, row.expires_at);
            }
            await this.db
                .prepare("DELETE FROM user_sessions WHERE user_id = ? AND jti != ?")
                .bind(uid, currentJti)
                .run();

            return { success: true, revoked: rows.length };
        } catch (error) {
            return {
                success: false,
                revoked: 0,
                message: "吊销失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    },
};
