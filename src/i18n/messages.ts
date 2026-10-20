// src/i18n/messages.ts
// 文案表。第一条规则：**zh 这一列必须与界面上现在的文案逐字一致** ——
// 接入 i18n 的过程不允许顺手改字，否则「行为不变」就没法验证了。
//
// 目前只收了「语言设置」这一处用到的几条（骨架阶段刻意收窄）：
// 表一大了容易整片过期，小而准的表才能一直对齐界面。以后每接一处，就把那一处的
// 文案搬进来，并让它走 t()。en 列缺了会回落 zh，不会显示空白。
//
// key 的命名：`模块.位置.内容`，方便按界面位置反查。
import type { Message } from "./locale";

export const messages: Record<string, Message> = {
    "settings.language.title": {
        zh: "界面语言",
        en: "Language",
    },
    "settings.language.hint": {
        zh: "只存在这台设备上；文案正在逐步接入，没接到的地方仍显示中文。",
        en: "Stored on this device only. Strings are being migrated; unmigrated ones stay Chinese.",
    },
    "settings.language.label": {
        zh: "界面语言",
        en: "Interface language",
    },
    "settings.language.zh": {
        zh: "中文",
        en: "Chinese",
    },
    "settings.language.en": {
        zh: "English",
        en: "English",
    },
    "settings.language.note": {
        zh: "切换后立即生效，不需要刷新。",
        en: "Takes effect immediately — no reload needed.",
    },
};
