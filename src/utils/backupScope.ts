// 备份「什么进文件 / 什么能写回」的判定。
//
// 从 useBackupController（560 行）里抽出来的纯计算。之所以单独放：备份文件是会
// 传到网盘、会发给别人的，判定错了两种后果都不轻 ——
//
// - **带多了**：WebDAV 凭据 / AI 密钥跟着文件走 = 把别人的网盘和付费额度一起交出去；
//   普通账号把整站外观带出去 = 恢复时把整站长什么样改掉。
// - **带少了**：恢复完发现主题、背景、自定义 CSS 全没了，等于白备份一次。
//
// 这两条规则分别用在导出（写文件）和导入（写回库）两个方向上，散在 hook 里
// 迟早有一处改了另一处没改。抽出来之后两边共用同一份判定，也才好用单测钉住。

import {
    isPerUserAppearanceKey,
    isSecretConfigKey,
    isUserScopedConfigKey,
    type LocalPrefsBackup,
} from "../API/http";

/** 当前登录者。`null` 表示未启用登录的单账号部署（那人对整站有全权） */
export type BackupActor = { role: "owner" | "user" } | null;

/**
 * 这份备份有没有权改全站外观。
 * 未启用登录时只有一个账号，它就是全站；普通账号只对自己那份外观有话事权。
 */
export function canWriteSharedConfigs(actor: BackupActor): boolean {
    return !actor || actor.role === "owner";
}

export interface ExportConfigs {
    /** 跟着账号走的那份（普通账号的外观） */
    own: Record<string, string>;
    /**
     * 全站共享的那份。只有 `canWriteSharedConfigs` 为真时才非空 ——
     * 老备份把这批混在 `configs` 里，导入端两边都要按归属规则过一遍。
     */
    shared: Record<string, string>;
}

/**
 * 挑出备份文件里要带的配置，并按「全站 / 本人」分成两堆。
 *
 * 敏感键（auth.* / webdav.* / ai.* 与几个服务端镜像）一律不带，与身份无关 ——
 * 它们是「别人的凭据」或「可重测的临时数据」，放进文件只有坏处。
 */
export function pickExportConfigs(
    configs: Record<string, string>,
    actor: BackupActor
): ExportConfigs {
    const mayExportShared = canWriteSharedConfigs(actor);
    const own: Record<string, string> = {};
    const shared: Record<string, string> = {};

    for (const [key, value] of Object.entries(configs)) {
        if (isSecretConfigKey(key)) continue;
        if (mayExportShared) {
            // 所有者那一份本来就写在全站 configs 里，不要再往 own 里抄一遍
            shared[key] = value;
        } else if (isPerUserAppearanceKey(key)) {
            own[key] = value;
        }
    }

    return { own, shared };
}

/**
 * 恢复时哪些配置允许写回库。
 *
 * 老备份的全站设置混在 `configs` 里，新备份放在 `sharedConfigs`，两边都要过滤：
 * - `DB_INITIALIZED` 是建库标记，写回去会让服务端以为库已经建好了；
 * - 敏感键一律不写（备份文件可能被别人改过，不能拿它去覆盖网盘凭据）；
 * - 非按账号隔离的键（也就是全站外观）只有所有者能写。
 */
export function pickImportConfigEntries(
    data: {
        configs?: Record<string, string>;
        sharedConfigs?: Record<string, string>;
    },
    actor: BackupActor
): Array<[string, string]> {
    const mayWriteShared = canWriteSharedConfigs(actor);
    const entries: Array<[string, string]> = [];

    for (const [key, value] of [
        ...Object.entries(data.configs || {}),
        ...Object.entries(data.sharedConfigs || {}),
    ]) {
        if (key === "DB_INITIALIZED") continue;
        if (isSecretConfigKey(key)) continue;
        if (!isUserScopedConfigKey(key) && !mayWriteShared) continue;
        entries.push([key, value]);
    }

    return entries;
}

/**
 * 把备份里的星标 / 标签按「旧 id → 新 id」翻译一遍。
 *
 * 覆盖恢复时服务端会重新发号，合并导入时前端自己建，两种模式都会拿到映射。
 * 映射为空（老备份、或备份里没有 id）时**照原样写回** —— 宁可星标错位，
 * 也不要因为翻译不出来就把用户的星标整份丢掉。
 */
export function remapLocalPrefs(
    prefs: LocalPrefsBackup | undefined,
    siteIdMap: Map<number, number>
): LocalPrefsBackup | undefined {
    if (!prefs) return undefined;
    if (siteIdMap.size === 0) return prefs;

    const tags: Record<string, string[]> = {};
    for (const [siteId, list] of Object.entries(prefs.tags ?? {})) {
        const mapped = siteIdMap.get(Number(siteId));
        if (typeof mapped === "number") tags[String(mapped)] = list;
    }

    return {
        starred: (prefs.starred ?? [])
            .map(id => siteIdMap.get(id))
            .filter((id): id is number => typeof id === "number"),
        tags,
    };
}

/** cron 留痕的形状（见 useBackupController 的 cronError） */
export interface CronError {
    task: string;
    message: string;
    at?: string;
}

/**
 * 取最近一次定时任务（每周自动备份 / 死链巡检）的失败留痕。
 *
 * 定时任务跑在 Worker 里，失败了页面上毫无动静 —— 只能靠启动时提示一句 +
 * 备份弹窗里常驻一条。留痕本身坏了（坏 JSON / 空 message）就当没留过：
 * 别因为一行坏数据把弹窗搞崩。
 */
export function pickCronError(
    configs: Record<string, string>,
    prefix: string,
    tasks: string[] = ["backup", "linkSweep"]
): CronError | null {
    for (const task of tasks) {
        const raw = configs[`${prefix}.${task}`];
        if (!raw) continue;
        try {
            const parsed = JSON.parse(raw) as {
                task?: string;
                message?: string;
                at?: string;
            };
            if (parsed && typeof parsed.message === "string" && parsed.message) {
                return { task: parsed.task || task, message: parsed.message, at: parsed.at };
            }
        } catch {
            // 坏 JSON 当作没有留痕
        }
    }
    return null;
}
