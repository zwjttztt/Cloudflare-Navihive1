// src/utils/uuid.ts
// 生成 RFC 4122 v4 形态的 uuid。
//
// 为什么不用 `crypto.randomUUID()`：它在运行时是有的，但本项目的 workers-types v5
// 里没有它的类型声明，写了会红。项目里已有的做法是裸 `crypto.getRandomValues`
// （见 API/crypto.ts），这个文件沿用同一套。
//
// 为什么不用「时间戳 + Math.random」凑合：合并导入靠 uuid 识别「同一条笔记」，
// 弱随机在批量创建时有撞号可能，撞了就会把两条笔记判成一条 —— 而这种错不会报错，
// 只会让用户莫名少一条笔记。

/** 生成一个 v4 uuid（8-4-4-4-12 的连字符形式） */
export function newUuid(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // 第 6 字节的高 4 位固定成 0100（版本 4），第 8 字节的高 2 位固定成 10（variant）
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join("-");
}
