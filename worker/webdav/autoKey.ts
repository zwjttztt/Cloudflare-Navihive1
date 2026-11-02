// worker/webdav/autoKey.ts
//
// 「没设备份口令」时的兜底加密密钥。
//
// 背景（2026-11 的 P0）：导出的备份内容里**含解密后的站点密码**
// （src/API/methods/transfer.ts 的 decryptSitePasswords），上传那一步却是
// 「有口令才加密、没口令就明文 gzip」。于是没配 webdav.backupPassword 的部署，
// 每周定时任务都会把全站明文凭据传到自己的网盘上 —— 这是既成事实，不是理论风险。
//
// 所以把默认改成「一定加密」：口令留空时，从这里派生一把**确定性的**密钥顶上。
//
// 为什么从根密钥派生而不是随机生成一把存库：
//  - 不新增配置键、不改 UI、不写数据库（随机密钥要落库，就多一份要备份的密文）；
//  - 同一实例（同一 AUTH_SECRET）随时能解回自己的备份，用户不需要另抄恢复码；
//  - 派生输入里带账号 id，不同账号拿到不同密钥，多个账号共用同一个网盘目录也不会串。
//
// 代价（必须写进文档，deploy/selfhost.md 第七节）：换了 AUTH_SECRET /
// DATA_ENCRYPTION_KEY 之后，旧的**自动加密**备份就解不开了 —— 想跨实例可移植、
// 想长期存档，就应该设一个独立的 webdav.backupPassword。
const enc = new TextEncoder();

/**
 * 派生输入的版本化前缀。**改这个字符串 = 让所有历史自动加密备份变成解不开的废文件**，
 * 除非同时提供迁移手段，否则不要动。
 */
const AUTO_KEY_CONTEXT = "navihive:backup-auto-key:v1";

/**
 * 根密钥缺失时给用户看的固定文案：上传/下载两条链路共用，避免两处措辞漂移。
 */
export const NO_BACKUP_KEY_MESSAGE =
    "未配置备份口令，且实例缺少 AUTH_SECRET，无法加密备份 —— 请先设置 AUTH_SECRET 或备份口令";

/**
 * 只读 env 里我们关心的两把根密钥。
 *
 * 不直接依赖 Env：`deriveAutoBackupKey` / `resolveBackupPasswords` 也被单测直接喂普通
 * 对象，用结构化类型只描述「这里真正用到的字段」最省事，env 原样传进来即可。
 * （Env 现在包含这两个键，所以传真实 env 不需要任何断言。）
 */
export interface BackupKeyEnv {
    AUTH_SECRET?: string;
    DATA_ENCRYPTION_KEY?: string;
}

/** base64url 编码（与 src/API/crypto.ts 同口径：无填充、-_ 代替 +/） */
function toBase64Url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 「没设备份口令」时的兜底加密密钥。
 *
 * 派生方式：HMAC-SHA256(根密钥, "navihive:backup-auto-key:v1:<userId ?? 0>")，
 * 输出 32 字节，编码成 **base64url**（43 个字符，无填充）。
 *
 * 根密钥优先级：AUTH_SECRET → DATA_ENCRYPTION_KEY → 空串。
 * 两者都没有时返回 `""`，表示**无法派生** —— 调用方必须据此拒绝明文上传，
 * 绝不能把空串当成「口令为空所以不加密」继续往下走。
 */
export async function deriveAutoBackupKey(
    env: BackupKeyEnv | undefined,
    userId: number | null
): Promise<string> {
    const authSecret = env?.AUTH_SECRET ?? "";
    const dataKey = env?.DATA_ENCRYPTION_KEY ?? "";
    // 只把「空白」当缺失，保留原值（密钥里可能有有意的前后空白，trim 掉就解不开了）
    const source = authSecret.trim() ? authSecret : dataKey.trim() ? dataKey : "";
    if (!source) return "";

    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(source),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        enc.encode(`${AUTO_KEY_CONTEXT}:${userId ?? 0}`)
    );
    return toBase64Url(new Uint8Array(signature));
}

/** 这次上传/下载该用哪些口令候选，以及首选口令是从哪来的 */
export interface ResolvedBackupPasswords {
    /** 去重、去空后的口令候选；空数组 = 一把都没有（既没显式口令，也派生不出密钥） */
    candidates: string[];
    /** password = 用户显式设的；auto = 由根密钥派生；none = 都没有 */
    source: "password" | "auto" | "none";
}

/**
 * 解析「这次上传/下载该用哪些口令候选」。
 *
 * 顺序：用户显式口令 → 自动派生口令，去重、去空。
 *
 * 上传只取 `candidates[0]`；下载要拿**整个列表**逐个试：
 * 用户先没设口令（这份备份是自动口令加密的）、后来设了口令，旧的备份依然是
 * 自动口令加密的 —— 只试一个口令会把「自己的备份」误报成 badPassword。
 */
export async function resolveBackupPasswords(
    env: BackupKeyEnv | undefined,
    userId: number | null,
    explicit: string
): Promise<ResolvedBackupPasswords> {
    const auto = await deriveAutoBackupKey(env, userId);
    if (explicit) {
        const candidates = [explicit];
        // 兜底候选放最后：显式口令永远先试，自动密钥只在「用户改过配置」时救场
        if (auto && auto !== explicit) candidates.push(auto);
        return { candidates, source: "password" };
    }
    return auto
        ? { candidates: [auto], source: "auto" }
        : { candidates: [], source: "none" };
}

/**
 * 把 `string | readonly string[]` 归一成口令候选数组（去空）。
 *
 * 下载侧允许传单个口令（老接口形状）或候选列表（新接口形状）：
 * 空数组 = 老行为「遇到加密文件就回 code:"encrypted" 让用户输口令」。
 */
export function normalizePasswordCandidates(password: string | readonly string[]): string[] {
    const list = typeof password === "string" ? [password] : password;
    return list.filter(value => Boolean(value));
}
