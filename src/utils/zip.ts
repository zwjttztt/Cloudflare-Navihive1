// src/utils/zip.ts
// 最小可用的 zip 读写（照 inkstone 的 shared/zip.ts 搬的，**零第三方依赖**）。
//
// 为什么要它：导出 JSON 不含图片附件，等于「备份能存、图片会丢」。inkstone 的
// zip 就是自己手写的 crc32 + zip32 结构，没有 jszip 之类的依赖 —— 之前把它
// 归为「需要新依赖」是误判，看完源码就可以直接搬。
//
// 两条刻意的选择，和 inkstone 一致：
//   1. **打包用 method 0（不压缩）**：图片本来就是压缩过的（png/jpeg/webp），
//      再 deflate 一遍几乎不省空间，却要付出几百毫秒 CPU。文本笔记体积可以忽略。
//      → 写侧完全不需要压缩器，浏览器和 Workers 都能跑。
//   2. **读侧同时认 0 和 8**：别人/别的工具打出来的 zip 多半是 deflate（8），
//      读的时候用 DecompressionStream('deflate-raw') 解开（Workers 与主流浏览器都有）。
//
// ⚠️ 安全：解包必须挡住「zip slip」（../../etc/passwd）—— normalizeZipPath 里
// 遇到 `..`、绝对路径、盘符一律报错；条目数与展开后体积都有上限，防止 zip 炸弹。

export interface ZipEntry {
    path: string;
    data: Uint8Array;
    /** 文件修改时间（不传就用打包那一刻） */
    mtime?: number;
}

export interface UnzippedEntry {
    path: string;
    data: Uint8Array;
}

export interface ReadZipOptions {
    maxEntries?: number;
    maxEntryBytes?: number;
    maxTotalBytes?: number;
    /** 只要这些路径（比如只挑 attachments/ 下的） */
    include?: (path: string) => boolean;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** 通用位标记里的第 11 位：文件名是 UTF-8（中文文件名必须靠它） */
const FLAG_UTF8 = 0x0800;

// ---------------- crc32 ----------------

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crcTable[i] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = ((crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff]) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms: number): { date: number; time: number } {
    const d = new Date(ms);
    const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
    return {
        date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    };
}

// ---------------- 打包 ----------------

export function createZip(entries: ZipEntry[]): Uint8Array {
    if (entries.length > 0xffff) throw new Error("文件太多，超出 zip 上限");

    const encoder = new TextEncoder();
    const now = Date.now();
    const paths = new Set<string>();

    const prepared = entries.map(entry => {
        const path = normalizeZipPath(entry.path);
        if (!path || path.endsWith("/")) throw new Error(`zip 里的文件名不合法：${entry.path}`);
        const nameBytes = encoder.encode(path);
        if (!nameBytes.length || nameBytes.length > 0xffff) {
            throw new Error(`zip 里的文件名不合法或过长：${entry.path}`);
        }
        if (entry.data.byteLength > 0xffffffff) throw new Error(`文件太大：${entry.path}`);
        const key = path.toLowerCase();
        if (paths.has(key)) throw new Error(`zip 里有重复的文件名：${entry.path}`);
        paths.add(key);
        return {
            nameBytes,
            data: entry.data,
            crc: crc32(entry.data),
            ...dosDateTime(entry.mtime ?? now),
        };
    });

    const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
    const centralSize = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
    const totalSize = localSize + centralSize + 22;
    if (!Number.isSafeInteger(totalSize) || totalSize > 0xffffffff) {
        throw new Error("内容超出 zip32 上限");
    }

    const out = new Uint8Array(totalSize);
    const dv = new DataView(out.buffer);
    let offset = 0;
    const offsets: number[] = [];

    for (const e of prepared) {
        offsets.push(offset);
        dv.setUint32(offset, LOCAL_SIG, true);
        dv.setUint16(offset + 4, 20, true); // 解压所需版本
        dv.setUint16(offset + 6, FLAG_UTF8, true);
        dv.setUint16(offset + 8, 0, true); // method 0：不压缩
        dv.setUint16(offset + 10, e.time, true);
        dv.setUint16(offset + 12, e.date, true);
        dv.setUint32(offset + 14, e.crc, true);
        dv.setUint32(offset + 18, e.data.length, true); // 压缩后
        dv.setUint32(offset + 22, e.data.length, true); // 原始
        dv.setUint16(offset + 26, e.nameBytes.length, true);
        dv.setUint16(offset + 28, 0, true); // extra 长度
        offset += 30;
        out.set(e.nameBytes, offset);
        offset += e.nameBytes.length;
        out.set(e.data, offset);
        offset += e.data.length;
    }

    const centralStart = offset;
    for (let i = 0; i < prepared.length; i++) {
        const e = prepared[i];
        dv.setUint32(offset, CENTRAL_SIG, true);
        dv.setUint16(offset + 4, 20, true);
        dv.setUint16(offset + 6, 20, true);
        dv.setUint16(offset + 8, FLAG_UTF8, true);
        dv.setUint16(offset + 10, 0, true); // method
        dv.setUint16(offset + 12, e.time, true);
        dv.setUint16(offset + 14, e.date, true);
        dv.setUint32(offset + 16, e.crc, true);
        dv.setUint32(offset + 20, e.data.length, true);
        dv.setUint32(offset + 24, e.data.length, true);
        dv.setUint16(offset + 28, e.nameBytes.length, true);
        dv.setUint16(offset + 30, 0, true); // extra
        dv.setUint16(offset + 32, 0, true); // comment
        dv.setUint16(offset + 34, 0, true); // 起始磁盘号
        dv.setUint16(offset + 36, 0, true); // 内部属性
        dv.setUint32(offset + 38, 0, true); // 外部属性
        dv.setUint32(offset + 42, offsets[i], true);
        offset += 46;
        out.set(e.nameBytes, offset);
        offset += e.nameBytes.length;
    }

    dv.setUint32(offset, EOCD_SIG, true);
    dv.setUint16(offset + 4, 0, true);
    dv.setUint16(offset + 6, 0, true);
    dv.setUint16(offset + 8, prepared.length, true);
    dv.setUint16(offset + 10, prepared.length, true);
    dv.setUint32(offset + 12, offset - centralStart, true);
    dv.setUint32(offset + 16, centralStart, true);
    dv.setUint16(offset + 20, 0, true); // 注释长度

    return out;
}

// ---------------- 解包 ----------------

interface CentralEntry {
    path: string;
    method: number;
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
}

export async function readZip(
    buffer: Uint8Array,
    options: ReadZipOptions = {}
): Promise<UnzippedEntry[]> {
    const maxEntries = positiveLimit(options.maxEntries, 2500);
    const maxEntryBytes = positiveLimit(options.maxEntryBytes, 96 * 1024 * 1024);
    const maxTotalBytes = positiveLimit(options.maxTotalBytes, 96 * 1024 * 1024);
    if (buffer.byteLength < 22) throw new Error("这不是一个有效的 zip 文件");

    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

    // 结尾记录（EOCD）在文件末尾，但后面可能有注释，所以要往回扫一段
    let eocd = -1;
    const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
    for (let i = buffer.length - 22; i >= searchStart; i--) {
        if (
            dv.getUint32(i, true) === EOCD_SIG &&
            i + 22 + dv.getUint16(i + 20, true) === buffer.length
        ) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("这不是一个有效的 zip 文件");

    requireRange(buffer, eocd, 22, "zip 结尾记录不完整");
    requireRange(buffer, eocd + 22, dv.getUint16(eocd + 20, true), "zip 注释不完整");
    if (dv.getUint16(eocd + 4, true) !== 0 || dv.getUint16(eocd + 6, true) !== 0) {
        throw new Error("不支持分卷 zip");
    }
    const diskCount = dv.getUint16(eocd + 8, true);
    const count = dv.getUint16(eocd + 10, true);
    const centralSize = dv.getUint32(eocd + 12, true);
    const centralOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        throw new Error("不支持 zip64");
    }
    if (diskCount !== count) throw new Error("zip 条目数对不上");
    if (count > maxEntries) throw new Error(`zip 条目超过上限 ${maxEntries}`);
    requireRange(buffer, centralOffset, centralSize, "zip 中央目录越界");
    if (centralOffset + centralSize > eocd) throw new Error("zip 中央目录位置不合法");

    let pointer = centralOffset;
    const entries: CentralEntry[] = [];
    const seenPaths = new Set<string>();
    for (let i = 0; i < count; i++) {
        requireRange(buffer, pointer, 46, "zip 中央目录不完整");
        if (dv.getUint32(pointer, true) !== CENTRAL_SIG) throw new Error("zip 中央目录损坏");
        if (dv.getUint16(pointer + 34, true) !== 0) throw new Error("不支持分卷 zip");
        const flags = dv.getUint16(pointer + 8, true);
        if (flags & 0x0001) throw new Error("不支持加密的 zip");
        const method = dv.getUint16(pointer + 10, true);
        const crc = dv.getUint32(pointer + 16, true);
        const compressedSize = dv.getUint32(pointer + 20, true);
        const uncompressedSize = dv.getUint32(pointer + 24, true);
        const nameLen = dv.getUint16(pointer + 28, true);
        const extraLen = dv.getUint16(pointer + 30, true);
        const commentLen = dv.getUint16(pointer + 32, true);
        const localOffset = dv.getUint32(pointer + 42, true);
        const recordSize = 46 + nameLen + extraLen + commentLen;
        requireRange(buffer, pointer, recordSize, "zip 中央目录条目越界");

        let decodedPath: string;
        try {
            decodedPath = decoder.decode(buffer.subarray(pointer + 46, pointer + 46 + nameLen));
        } catch {
            throw new Error("zip 里的文件名不是合法的 UTF-8");
        }
        // ⚠️ 变量不能叫 `path`：打包成 ESM 在 Node 里跑时，裸的 `path` 会被解析成
        // Node 内置的 path 模块（对象字面量简写 `{ path }` 拿到的就是那个模块 ——
        // 症状是解出来每个条目的 path 都是一坨模块对象）。改名叫 zipPath。
        const zipPath = normalizeZipPath(decodedPath);
        pointer += recordSize;

        if (!zipPath || zipPath.endsWith("/")) continue; // 目录项跳过
        const pathKey = zipPath.toLowerCase();
        if (seenPaths.has(pathKey)) throw new Error(`zip 里有重复的文件名：${zipPath}`);
        seenPaths.add(pathKey);
        entries.push({ path: zipPath, method, crc, compressedSize, uncompressedSize, localOffset });
    }
    if (pointer !== centralOffset + centralSize) throw new Error("zip 中央目录长度对不上");

    const include = options.include;
    const selected = include ? entries.filter(e => include(e.path)) : entries;
    const declaredTotal = selected.reduce((sum, e) => sum + e.uncompressedSize, 0);
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > maxTotalBytes) {
        throw new Error(`展开后的内容超过 ${formatBytes(maxTotalBytes)} 上限`);
    }

    const out: UnzippedEntry[] = [];
    let totalBytes = 0;
    for (const entry of selected) {
        if (entry.method !== 0 && entry.method !== 8) {
            throw new Error(`zip 条目用了不支持的压缩方式：${entry.path}`);
        }
        if (entry.uncompressedSize > maxEntryBytes) {
            throw new Error(`zip 条目太大：${entry.path}`);
        }

        requireRange(buffer, entry.localOffset, 30, `zip 局部记录损坏：${entry.path}`);
        if (dv.getUint32(entry.localOffset, true) !== LOCAL_SIG) {
            throw new Error(`zip 局部记录签名不对：${entry.path}`);
        }
        const localFlags = dv.getUint16(entry.localOffset + 6, true);
        const localMethod = dv.getUint16(entry.localOffset + 8, true);
        if (localFlags & 0x0001 || localMethod !== entry.method) {
            throw new Error(`zip 局部记录与中央目录对不上：${entry.path}`);
        }
        const localNameLen = dv.getUint16(entry.localOffset + 26, true);
        const localExtraLen = dv.getUint16(entry.localOffset + 28, true);
        requireRange(
            buffer,
            entry.localOffset + 30,
            localNameLen,
            `zip 局部文件名损坏：${entry.path}`
        );
        let localPath: string;
        try {
            localPath = normalizeZipPath(
                decoder.decode(
                    buffer.subarray(
                        entry.localOffset + 30,
                        entry.localOffset + 30 + localNameLen
                    )
                )
            );
        } catch {
            throw new Error(`zip 局部文件名不合法：${entry.path}`);
        }
        if (localPath !== entry.path) {
            throw new Error(`zip 局部文件名与中央目录对不上：${entry.path}`);
        }

        const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen;
        requireRange(buffer, dataStart, entry.compressedSize, `zip 数据越界：${entry.path}`);
        const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);

        let data: Uint8Array;
        if (entry.method === 0) {
            if (entry.compressedSize !== entry.uncompressedSize) {
                throw new Error(`zip 条目长度对不上：${entry.path}`);
            }
            data = raw;
        } else {
            data = await inflateRaw(raw, Math.min(maxEntryBytes, maxTotalBytes - totalBytes));
        }
        if (data.byteLength !== entry.uncompressedSize) {
            throw new Error(`zip 条目展开后长度对不上：${entry.path}`);
        }
        totalBytes += data.byteLength;
        if (totalBytes > maxTotalBytes) {
            throw new Error(`展开后的内容超过 ${formatBytes(maxTotalBytes)} 上限`);
        }
        // ⚠️ 校验和必须对得上：传输出错 / 文件被动过手脚都会在这里露出来
        if (crc32(data) !== entry.crc) throw new Error(`zip 条目校验失败：${entry.path}`);
        // ⚠️ 必须写 `path: entry.path`：这里没有局部的 `path`，简写 `{ path }` 在
        // Node 的 ESM 里会解析到内置的 path 模块（解出来每个条目名都是一坨模块对象）。
        out.push({ path: entry.path, data });
    }

    return out;
}

async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
    if (maxBytes < 0) throw new Error("展开后的内容超过上限");
    if (typeof DecompressionStream === "undefined") {
        throw new Error("当前环境不支持解压 zip（需要 DecompressionStream）");
    }
    const source = new Response(data as unknown as BodyInit).body;
    if (!source) throw new Error("当前环境不支持解压 zip");

    const reader = source.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maxBytes) {
                await reader.cancel();
                throw new Error(`zip 条目展开后超过 ${formatBytes(maxBytes)} 上限`);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function requireRange(
    buffer: Uint8Array,
    offset: number,
    length: number,
    message: string
): void {
    if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 0 ||
        offset > buffer.byteLength - length
    ) {
        throw new Error(message);
    }
}

/** zip slip 防护：`..`、绝对路径、盘符、NUL 一律拒绝 */
export function normalizeZipPath(input: string): string {
    if (!input || input.includes("\0")) throw new Error("zip 里的文件名不合法");
    const raw = input.replace(/\\/g, "/");
    if (raw.startsWith("/") || /^[a-z]:\//i.test(raw)) throw new Error("zip 里含绝对路径");

    const segments = raw.split("/");
    const normalized: string[] = [];
    for (const segment of segments) {
        if (!segment || segment === ".") continue;
        if (segment === "..") throw new Error("zip 里含向上跳转的路径");
        normalized.push(segment);
    }
    return normalized.join("/") + (raw.endsWith("/") ? "/" : "");
}

function positiveLimit(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function formatBytes(bytes: number): string {
    return bytes >= 1024 * 1024
        ? `${Math.ceil(bytes / (1024 * 1024))} MB`
        : `${Math.ceil(bytes / 1024)} KB`;
}
