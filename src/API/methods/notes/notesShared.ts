// src/API/methods/notes/notesShared.ts
// notes 域的共享常量与辅助，被多个子模块复用（不放回 notes.ts，避免再长回去）。
//
// 这里只放「被超过一个子模块用到」的东西：
//   - NOTE_FIELDS：listNotes / getNote / createNote / updateNote / searchNotes 都要它。
//   - validateFolderParent：笔记与文件夹的创建/移动都靠它做防环 + 账号隔离校验。
//   - notesSnapshotFingerprint：轮询要判断「快照变了没有」，真实现与 mock 必须用**同一把尺子**
//     （否则演示模式的指纹与真机对不上，前端会在两种模式下走不同的分支）。
// 单模块专用的辅助（relabelAttachmentLink / inlineTagStatements / releaseSiteBindingStatement /
// ftsScopeSql / pushRevision 那个函数）各自待在自己的子模块里。
import type { NavigationAPI } from "../../http";
import { validateFolderMove } from "../../../utils/folderTree";
import type { NoteFolder, NoteTag } from "../../types";

/** notes 表全字段（写操作的 RETURNING、读操作的 SELECT 都用它） */
export const NOTE_FIELDS =
    "id, uuid, title, content, pinned, starred, rev, order_num, site_id, archived, folder_id, link_count, created_at, updated_at";

/**
 * 校验「把笔记/文件夹移到 parent 下」是否合法（防环 + 越权按「查不到」处理，不泄露存在性）。
 *
 * 环路判定本身搬到 utils/folderTree（mock 也用同一份，同源化）；这里只剩「怎么查父 id」
 * —— 要带账号 scope，越权访问按「查不到」处理，不泄露存在性。
 */
export async function validateFolderParent(
    api: NavigationAPI,
    parent: number | null,
    moving?: number
): Promise<void> {
    await validateFolderMove({
        parent,
        moving,
        lookup: async id => {
            const row: { parent_id: number | null } | null = await api.db
                .prepare(`SELECT parent_id FROM note_folder WHERE id = ?${api.scopeSql(true)}`)
                .bind(...api.scopeParams([id])).first<{ parent_id: number | null }>();
            // ⚠️ 查不到时返回 undefined（= 这一级不存在），null 是「存在但它是根」
            return row ? (row.parent_id ?? null) : undefined;
        },
    });
}

/**
 * 轮询快照的指纹（2026-10-28，`notes/changes` 省流量）。
 *
 * 跨设备轮询每 30 秒一轮，原来每一轮都把「文件夹 + 标签 + 标签关联」整份倒给客户端，
 * 客户端再 `JSON.stringify` 比对一次形状。标签关联是按笔记展开的（一篇一条），
 * 上千条笔记时这一份能到几十 KB —— 也就是说 **绝大多数轮询在传一份和上一轮
 * 一模一样的数据**，只为让客户端自己发现「没变」。
 *
 * 现在服务端先算指纹：与客户端手里那份相同就只回 `{ unchanged: true, fingerprint }`，
 * 快照三个字段一律回空数组。客户端据此跳过形状比对与 reload。
 *
 * ⚠️ 指纹**必须**由「本来就要发出去的那份数据」算出来，不能另取一个便宜的近似量
 * （比如 `MAX(note_tag.updated_at)`）：
 *   · `updateFolder` 改 order_num / icon / color 时**不写 updated_at**；
 *   · `note_note_tag` 根本没有时间戳列，换标签只表现为行集合变化。
 * 用近似量会漏判 —— 漏判的表现是「别处改了标签，本机一直不刷新」，比多传几十 KB 严重得多。
 * 所以这里选「算准」而不是「算快」：读那三份清单本来就是 3 条索引查询（几十行），
 * 省下来的是**网络上那几十 KB 与客户端的 JSON.parse**，那才是这个端点的成本大头。
 *
 * 碰撞概率：FNV-1a 32 位。理论上可碰撞，但需要**刻意构造**的数据；而且失败模式是
 * 「这一次轮询没刷新」，客户端存的指纹仍是旧值，下一次任何真实变更都会让它对不上 →
 * 补一次全量。不会永久静默。
 */
export function notesSnapshotFingerprint(
    folders: NoteFolder[],
    tags: NoteTag[],
    noteTags: Record<number, number[]>
): string {
    // 规范化：字段按固定顺序拼，标签 id 排序（后端返回顺序变了不算变更），
    // 笔记键按数字升序（对象键序在 JS 里是「整数键升序」，但别依赖引擎细节）。
    const folderPart = folders
        .map(f => [f.id ?? 0, f.parent_id ?? "", f.name ?? "", f.order_num ?? 0, f.icon ?? "", f.color ?? ""].join("\u0001"))
        .join("\u0002");
    const tagPart = tags
        .map(t => [t.id ?? 0, t.name ?? "", t.color ?? ""].join("\u0001"))
        .join("\u0002");
    const linkPart = Object.keys(noteTags)
        .map(Number)
        .filter(k => Number.isFinite(k))
        .sort((a, b) => a - b)
        .map(k => `${k}:${[...(noteTags[k] ?? [])].sort((a, b) => a - b).join(",")}`)
        .join("\u0002");
    return fnv1a(`${folderPart}\u0003${tagPart}\u0003${linkPart}`);
}

/**
 * FNV-1a 32 位。选它而不是 parseInt(JSON)/djb2 的理由：分布均匀、实现只有四行、
 * 不依赖 BigInt（Worker 里 BigInt 没问题，但没必要）。输出补成定长 8 位十六进制，
 * 方便直接当字符串比较与打日志。
 */
function fnv1a(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        // >>> 0 稳住 uint32；乘法用移位加法避免 2**24 以上丢精度
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
