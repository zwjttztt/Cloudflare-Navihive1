// src/utils/configForm.ts
// 设置弹窗里那几个「输入长得什么样都可能」的表单值，统一在这里规整成可用值。
//
// 单独成文件是因为它们都要被单测直接打到：配置是从数据库、备份文件、
// 云端同步三条路进来的，脏值防不住，而校验写错的表现是「主题悄悄变难看」
// 或者「整页白屏」—— 不报错、也很难在冒烟里看出来。

/** 合法的主色：#rgb 或 #rrggbb（大小写都收） */
const ACCENT_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * 自定义主色：预览值优先，回落已保存值；只认合法写法，其余一律按「没设」处理。
 *
 * @param preview 设置弹窗里选色时的即时预览（不落库，关掉弹窗就回滚）
 * @param saved   库里已保存的值
 * @returns 合法则返回去空格后的原值，否则空串（调用方按「用默认主色」处理）
 *
 * 注意 preview 为**空串**时不回落到 saved：那是「用户把预览清空了」的意思，
 * 跟「没有预览」（null）不是一回事。用 ?? 而不是 || 就是为了保住这个区别。
 */
export function normalizeAccent(
    preview: string | null | undefined,
    saved: string | null | undefined
): string {
    const raw = (preview ?? saved ?? "").trim();
    return ACCENT_PATTERN.test(raw) ? raw : "";
}

/** 毛玻璃强度：空 / 非法都按默认 14，并夹在 0~24 之间 */
export function normalizeGlassBlur(raw: string | null | undefined): number {
    if (raw === null || raw === undefined || raw === "") return 14;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 14;
    return Math.min(24, Math.max(0, n));
}
