/**
 * AVIF（ISO-BMFF 容器）：尺寸不在固定偏移，要沿盒子树走
 * meta（FullBox，内容前多 4 字节 version/flags）→ iprp → ipco → ispe。
 * ispe 内容：4 字节 version/flags + uint32 width + uint32 height（大端）。
 * 多个 ispe 时取第一个（典型 AVIF 只有主图一个）；任何越界都当解析失败。
 */
function readAvifSize(view: DataView, len: number): { width: number; height: number } | null {
    const boxType = (off: number) =>
        String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
    /** 在 [start, end) 里找第一个指定类型的盒子，返回内容区 [contentStart, contentEnd]，找不到返回 null */
    const findBox = (start: number, end: number, want: string): [number, number] | null => {
        let off = start;
        while (off + 8 <= end) {
            let size = view.getUint32(off);
            let head = 8;
            if (size === 1) {
                // largesize：8 字节 64 位大小跟在类型后面；图片不可能超 4GB，取低 32 位
                if (off + 16 > end) return null;
                size = view.getUint32(off + 12);
                head = 16;
            } else if (size === 0) {
                size = end - off;
            }
            if (size < head || off + size > end) return null;
            if (boxType(off + 4) === want) return [off + head, off + size];
            off += size;
        }
        return null;
    };
    const meta = findBox(0, len, "meta");
    if (!meta) return null;
    const iprp = findBox(meta[0] + 4, meta[1], "iprp"); // meta 是 FullBox，内容前 4 字节 version/flags
    if (!iprp) return null;
    const ipco = findBox(iprp[0], iprp[1], "ipco");
    if (!ipco) return null;
    let off = ipco[0];
    while (off + 8 <= ipco[1]) {
        let size = view.getUint32(off);
        let head = 8;
        if (size === 1) {
            if (off + 16 > ipco[1]) return null;
            size = view.getUint32(off + 12);
            head = 16;
        } else if (size === 0) {
            size = ipco[1] - off;
        }
        if (size < head || off + size > ipco[1]) return null;
        if (boxType(off + 4) === "ispe") {
            if (off + head + 12 > ipco[1]) return null;
            return { width: view.getUint32(off + head + 4), height: view.getUint32(off + head + 8) };
        }
        off += size;
    }
    return null;
}

export function readImageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
    try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let width = 0, height = 0;
        if (mime === "image/png" && bytes.length >= 24) {
            width = view.getUint32(16); height = view.getUint32(20);
        } else if (mime === "image/gif" && bytes.length >= 10) {
            width = view.getUint16(6, true); height = view.getUint16(8, true);
        } else if (mime === "image/jpeg") {
            let offset = 2;
            while (offset + 9 <= bytes.length) {
                if (bytes[offset] !== 255) { offset++; continue; }
                const marker = bytes[offset + 1];
                if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
                    height = view.getUint16(offset + 5); width = view.getUint16(offset + 7); break;
                }
                const size = view.getUint16(offset + 2);
                if (size < 2) break;
                offset += size + 2;
            }
        } else if (mime === "image/avif" && bytes.length >= 20) {
            const parsed = readAvifSize(view, bytes.length);
            if (parsed) { width = parsed.width; height = parsed.height; }
        } else if (mime === "image/webp" && bytes.length >= 30) {
            const format = String.fromCharCode(...bytes.slice(12, 16));
            if (format === "VP8X") {
                width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
                height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
            } else if (format === "VP8 ") {
                width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383;
            } else if (format === "VP8L" && bytes[20] === 47) {
                const bits = view.getUint32(21, true);
                width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
            }
        }
        return width > 0 && height > 0 && width <= 100000 && height <= 100000 ? { width, height } : null;
    } catch { return null; }
}
