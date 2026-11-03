// src/components/app/applyBootstrapExtras.ts
// bootstrap 里「分组」之外的那一半落地：把服务端那份配置 / 链接健康 / 星标 / 标签 /
// 访问统计 / 折叠态合并回本机。
//
// 原来是 App.tsx 里一个 64 行的内联函数声明（applyRemoteExtras）。它和「分组」那条
// 落地路径（hooks/useSites）合起来才是完整的一次 bootstrap，但两半一直分居两个文件，
// 这一半还夹在 App 的一堆 hook 调用中间 —— 所以合并规则整块搬到这里（2026-11 D6）。
//
// 边界怎么划的：「身份 / 恢复密钥」那两步留在 App —— 它们要写 useAccountSession 的
// state 与两个 ref，而那两个 ref 的用途正是「别让 useAccountSession 再问一次」，
// 属于账号域的私有约定。本文件只负责**数据合并**，不认识账号是什么。
//
// 为什么留成「数据 + 依赖对象」而不是 hook：App 里它是**函数声明**（会被提升），
// useSites 在它定义之前就把它当回调传进去了；它内部的依赖又在更后面才定义 ——
// 靠「调用时才取值」躲开 TDZ。搬家时保留这个形状：依赖在**调用那一刻**从宿主取。
//
// ⚠️ 合并顺序是有讲究的，别重排：
//   1. demoteLegacyDeadMarks 必须放在云端合并**之后** —— 合并进来的旧记录同样要降级，
//      否则开了同步的机器怎么都清不掉那几个天天在用却挂着「失效」的站。
//   2. 三段 JSON.parse 各自 try/catch：云端那份坏了就当没有，不影响本机。

import type { BootstrapData } from "../../API/types";
import type { useConfigController } from "../../hooks/useConfigController";
import type { UIPrefsValue } from "../../context/uiPrefsStore";
import {
    demoteLegacyDeadMarks,
    mergeLinkHealth,
    readDeadLinks,
} from "../../utils/linkHealth";
import { writeCollapsedGroupIds } from "../../utils/collapse";
import {
    LINK_HEALTH_CONFIG,
    LINK_HEALTH_SYNC_CONFIG,
    PREF_SYNC_CONFIG,
    PREF_STARRED_CONFIG,
    PREF_TAGS_CONFIG,
    PREF_VISITS_CONFIG,
    PREF_COLLAPSED_CONFIG,
} from "../../appDefaults";

/**
 * 落一次 bootstrap 需要的依赖。用 Pick / ReturnType 从各自的 hook 里取类型，
 * 而不是在这里手抄一份 —— 那两边的签名一改，这里跟着报错，不会悄悄漂走。
 */
export interface BootstrapExtrasDeps
    extends Pick<ReturnType<typeof useConfigController>, "applyConfigs">,
        Pick<UIPrefsValue, "setDeadLinks" | "mergeRemotePrefs" | "mergeRemoteVisits"> {}

/**
 * 把一次 bootstrap 拉回来的「分组之外」的数据合并进本地状态。
 *
 * @param data useSites 拿到的整份 bootstrap 结果（这里只读 configs）
 * @param deps App 层的那几个落地函数（配置 / 死链 / 星标标签 / 访问统计 / 折叠态）
 */
export function applyBootstrapExtras(data: BootstrapData, deps: BootstrapExtrasDeps): void {
    deps.applyConfigs(data.configs);

    // ---- 可选的多端同步：把服务端那份合并回本机 ----
    // 都是「取并集 / 取较新」，所以重复合并不会丢数据，也不怕和上传打架
    const incoming = data.configs || {};

    if (incoming[LINK_HEALTH_SYNC_CONFIG] === "true" && incoming[LINK_HEALTH_CONFIG]) {
        try {
            mergeLinkHealth(JSON.parse(incoming[LINK_HEALTH_CONFIG]));
        } catch {
            // 云端那份坏了就当没有，不影响本机
        }
    }

    // 旧判据（一次失败就标失效）留下的标记一律降级成「疑似」，否则用户升级完看到的
    // 还是那几个天天在用却挂着「失效」的站。必须放在云端合并**之后**：合并进来的
    // 旧记录同样要降级，不然开了同步的机器怎么都清不掉。
    demoteLegacyDeadMarks();
    deps.setDeadLinks(readDeadLinks());

    if (incoming[PREF_SYNC_CONFIG] === "true") {
        try {
            const remoteStarred = JSON.parse(incoming[PREF_STARRED_CONFIG] || "[]");
            const remoteTags = JSON.parse(incoming[PREF_TAGS_CONFIG] || "{}");
            deps.mergeRemotePrefs(remoteStarred, remoteTags);
        } catch {
            // 同上
        }

        // 访问统计：换台设备登录，点过的热度不该从零开始重攒
        try {
            deps.mergeRemoteVisits(JSON.parse(incoming[PREF_VISITS_CONFIG] || "{}"));
        } catch {
            // 同上
        }

        // 分组折叠是「当前状态」而非累计量，所以直接以服务端那份为准
        // （本机刚改过的话，下面的上传会立刻把新状态推回去，不会来回打架）
        try {
            const remote = JSON.parse(incoming[PREF_COLLAPSED_CONFIG] || "null");
            if (Array.isArray(remote)) {
                writeCollapsedGroupIds(remote.filter((id: unknown) => typeof id === "string"));
            }
        } catch {
            // 同上
        }
    }
}
