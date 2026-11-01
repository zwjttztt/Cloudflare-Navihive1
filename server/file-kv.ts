// server/file-kv.ts
// 把本地目录包成 KVNamespaceLike 形状，顶掉 Cloudflare KV 装笔记图片附件。
// 签名对齐 worker/types.ts 的 KVNamespaceLike，worker/attachments.ts 一行不用改。
//
// 使用面极窄：全仓库只有 attachments.ts 的四个调用 —— get(key) / get(key,"arrayBuffer") /
// put(key,value) / delete(key)，二进制只在 KV 里，不落 D1。
// key 形如 attachments/<userId>/<uuid>（worker/attachments.ts:67 attachmentObjectKey），
// 所以必须支持子目录。

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileKv {
    get(key: string): Promise<string | null>;
    get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
    put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void>;
    delete(key: string): Promise<void>;
}

/** 读的时候这些错误都等价于「key 不存在」；别的错误（权限 / 磁盘）必须照原样抛 */
const NOT_FOUND_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/** ArrayBufferView / ArrayBuffer → Buffer。DataView 要单独转，Buffer.from 不认它 */
function toBuffer(value: ArrayBuffer | ArrayBufferView): Buffer {
    if (value instanceof ArrayBuffer) {
        // 拷贝一份：Buffer.from(arrayBuffer) 是**共享内存**的视图，调用方复用底层缓冲会串数据
        return Buffer.from(new Uint8Array(value));
    }
    if (value instanceof DataView) {
        return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.from(value as Uint8Array);
}

export function makeFileKv(root: string): FileKv {
    const base = path.resolve(root);

    /**
     * 路径穿越防护。key 由代码生成（attachments/<数字>/<uuid>），但 KV 的调用面将来可能变宽，
     * 这里守一道：解析后的真实路径必须落在 base 里面。
     * ⚠️ 不能用 `p.startsWith(base + "/")` —— Windows 上 resolve 回的是反斜杠，
     * 那样写等于防护失效。用 relative 的结果判断，跨平台。
     */
    const safe = (key: string): string => {
        if (typeof key !== "string" || key.length === 0) throw new Error("非法的 KV key：空");
        // KV 的 key 是逻辑路径，统一按 / 拆（反斜杠版本由调用方负责，这里不认）
        // 以 / 开头的一律拒：它是「文件系统路径」的写法，不是逻辑 key
        // （真实 key 形如 attach/12/9f3c…，由 attachmentObjectKey 生成，永远不带 leading slash）
        if (key.startsWith("/")) throw new Error(`非法的 KV key：不能以 / 开头（${key}）`);
        const target = path.resolve(base, ...key.split("/"));
        const rel = path.relative(base, target);
        if (rel.length === 0) throw new Error("非法的 KV key：指向根目录");
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
            throw new Error(`非法的 KV key：越出根目录（${key}）`);
        }
        return target;
    };

    // 两个重载分开写：实现签名返回的是联合类型，直接塞进对象字面量对不上 FileKv 的重载
    function get(key: string): Promise<string | null>;
    function get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
    async function get(key: string, type?: "arrayBuffer"): Promise<string | ArrayBuffer | null> {
        try {
            const buf = await readFile(safe(key));
            if (type === "arrayBuffer") {
                // ⚠️ 必须切字节区间：Buffer 的底层 ArrayBuffer 可能比它自己大（缓冲池），
                // 直接回 buf.buffer 会把池里别人的字节一起带出去。
                return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            }
            return buf.toString("utf8");
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code && NOT_FOUND_CODES.has(code)) return null;
            throw error;
        }
    }

    return {
        get,
        async put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void> {
            const target = safe(key);
            await mkdir(path.dirname(target), { recursive: true });
            // 2026-11-01 写入原子化：直接 writeFile(target) 时进程在中途被杀 /
            // 磁盘写满会把目标文件留成**半截**，读回来的是损坏的图片且无从察觉。
            // 改为先写同目录临时文件、再 rename —— 同目录 rename 在同一文件系统上
            // 是原子操作，读者看到的要么是旧文件、要么是完整的新文件。
            // 临时文件必须与目标同目录（跨目录 rename 可能跨文件系统，退化为拷贝就
            // 不原子了）；后缀带随机值，避免并发写同一个 key 时互相踩对方的临时文件。
            const tmp = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            try {
                await writeFile(tmp, typeof value === "string" ? value : toBuffer(value));
                await rename(tmp, target);
            } catch (error) {
                // 写一半失败的临时文件必须清掉：留着既占磁盘，还会让目录里堆满
                // 谁都不敢动的垃圾。清理失败不掩盖原始错误（真正的失败原因在上面）。
                await rm(tmp, { force: true }).catch(() => {});
                throw error;
            }
        },
        async delete(key: string): Promise<void> {
            await rm(safe(key), { force: true });
        },
    };
}
