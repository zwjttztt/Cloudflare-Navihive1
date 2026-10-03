// src/utils/configMerge.ts
// 服务端下发的一整包 configs 怎么拆成本地的「外观配置」与「WebDAV 配置」。
//
// 从 App.tsx 的 applyConfigs 里搬出来的。搬运而不是重写，是为了让它能被单测盯住：
// 这里的两个约定都是「写错了不报错、只是悄悄不对」的类型 ——
//   1) `webdav.` 前缀的键不进 configs（否则会被写进备份文件，等于把网盘口令上传上去）
//   2) 布尔按项目惯例存 "1"/"0"，不是 "true"/"false"（写成后者会让判断永远为真）
// 这两条单靠点页面是发现不了的，得有网。

import { DEFAULT_CONFIGS, DEFAULT_WEBDAV_CONFIG, WEBDAV_CONFIG_PREFIX } from "../appDefaults";
import type { WebDavConfig } from "../API/types";

/** WebDAV 配置里哪些字段是纯字符串，直接搬即可 */
const WEBDAV_TEXT_FIELDS = ["url", "username", "password", "backupPassword", "path"] as const;

export interface SplitConfigs {
    configs: Record<string, string>;
    webdav: WebDavConfig;
}

/**
 * 把服务端下发（或备份导入）的配置拆成两份。
 *
 * - 未知键一律进 configs：以后加了新配置项不用改这里，DEFAULT_CONFIGS 里没有的
 *   会被界面忽略，但至少不会丢（导入导出要能原样带回去）。
 * - `webdav.` 前缀的键只认白名单里的字段名，其余丢弃 —— 免得一个拼错的前缀键
 *   把 undefined 写进 WebDAV 配置。
 */
export function splitIncomingConfigs(
    data: Record<string, string> | null | undefined
): SplitConfigs {
    const configs: Record<string, string> = { ...DEFAULT_CONFIGS };
    const webdav: WebDavConfig = { ...DEFAULT_WEBDAV_CONFIG };

    for (const [key, value] of Object.entries(data || {})) {
        if (key.startsWith(WEBDAV_CONFIG_PREFIX)) {
            const field = key.slice(WEBDAV_CONFIG_PREFIX.length);
            if ((WEBDAV_TEXT_FIELDS as readonly string[]).includes(field)) {
                // 白名单已经收敛过类型，这里只需要告诉 TS 字段名是那五个之一
                webdav[field as (typeof WEBDAV_TEXT_FIELDS)[number]] = value;
            } else if (field === "allowPrivateNetwork") {
                webdav.allowPrivateNetwork = value === "1";
            }
            continue;
        }
        configs[key] = value;
    }

    return { configs, webdav };
}

/**
 * 打开设置弹窗时的草稿：以当前生效配置为基础。
 * 单独抽出来是因为「打开时以谁为准」之前变过两次（一度用 tempConfigs，
 * 导致取消之后界面还留着上次的改动）。
 */
export function draftConfigs(configs: Record<string, string>): Record<string, string> {
    return { ...configs };
}
