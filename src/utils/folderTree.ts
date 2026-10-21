// src/utils/folderTree.ts
// 文件夹树的两条公共规则（2026-10-22，3.3 mock 同源化的第一刀）。
//
// 为什么要抽这里：
//   src/API/methods/notes.ts 的 validateFolderParent 与 src/API/mock.ts 的
//   validateMockParent 是**同一条规则的两份实现** ——「文件夹不能移入自身或子文件夹」。
//   两份不只是重复：报错文案不一样（真实侧「文件夹 ID 无效」单独一条、mock 侧并进
//   循环里抛）、不存在的父文件夹也是两种说法。后果是**本地 mock 跑得通、
//   真机上换个说法**，或者反过来 —— 而这类差异只会在真机上才暴露。
//
// 同源化不是「把 1531 行 mock 全删了」（那是另一件事，风险另算），
// 而是**凡是「规则」级别的东西，只准有一份实现**，两侧都调它。
//
// ⚠️ lookup 可以是同步也可以是异步：mock 侧是内存数组（同步），真实侧要查库（异步）。
//    这里统一 await —— await 一个非 Promise 的值是合法的，且不会多切一个微任务队列之外
//    的东西（同步返回值会被包成已决议的 Promise，语义一致）。

/** 父级链里出现回环（把文件夹移进自己或自己的子文件夹） */
export const FOLDER_CYCLE_ERROR = "文件夹不能移入自身或子文件夹";
/** parent 传了非正整数 */
export const FOLDER_ID_INVALID = "文件夹 ID 无效";
/** 父级链上某一级查不到（真实侧还要带上「不属于当前账号」的可能性） */
export const FOLDER_NOT_FOUND = "目标文件夹不存在或不属于当前账号";

/** 查某一级的父 id；返回 undefined 表示这一级不存在 */
export type FolderParentLookup = (id: number) => number | null | undefined | Promise<number | null | undefined>;

/**
 * 校验「把 moving 移到 parent 下」是否合法。
 * 不合法就抛（沿用调用方原有的错误通道：真实侧靠 rejection、mock 侧当场抛）。
 *
 * ⚠️ seen 初始就要放进 moving：把 A 移到 A 自己下面，第一次循环就会命中，
 *    不需要等绕一圈 —— 「移入自身」和「移入子文件夹」是同一个环，只是长度不同。
 */
export async function validateFolderMove(opts: {
    parent: number | null;
    moving?: number;
    lookup: FolderParentLookup;
    /** 找不到的说法（mock 侧没有账号概念，可以传一句不带「不属于当前账号」的） */
    notFoundMessage?: string;
}): Promise<void> {
    const { parent, moving, lookup, notFoundMessage = FOLDER_NOT_FOUND } = opts;
    if (parent === null) return;
    if (!Number.isInteger(parent) || parent <= 0) throw new Error(FOLDER_ID_INVALID);
    const seen = new Set<number>(moving === undefined ? [] : [moving]);
    let cursor: number | null = parent;
    while (cursor !== null) {
        if (seen.has(cursor)) throw new Error(FOLDER_CYCLE_ERROR);
        seen.add(cursor);
        const parentId = await lookup(cursor);
        if (parentId === undefined) throw new Error(notFoundMessage);
        cursor = parentId ?? null;
    }
}
