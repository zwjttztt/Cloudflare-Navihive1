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
