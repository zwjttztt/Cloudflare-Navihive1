// src/utils/backupIntegrity.ts
// 备份文件的完整性校验。
//
// 备份是一整份明文 JSON（加密备份是整份再包一层 AES-GCM），中途只要坏了一个字节，
// 轻则某个字段变成乱码，重则整份恢复进去才发现「我的卡片怎么少了 / 全空了」。
// 导出时顺手算一个摘要写进文件，导入前重算一遍比对：对不上就明确报「文件损坏」，
// 而不是让用户恢复完才发现不对。
//
// 摘要只对「文件内容」负责，不防篡改（密钥不在文件里），它的价值是抓传输 /
// 网盘 / 编辑器保存带来的意外损坏 —— 这类事故远比「有人精心改我的备份」常见。

/** 摘要算法。写进文件里，以后换算法时老文件还能按标记走老路 */
export const BACKUP_INTEGRITY_ALGO = "SHA-256";

/** 写进备份文件 integrity 字段的形状 */
export interface BackupIntegrity {
    algo: string;
    /** 16 进制小写摘要 */
    value: string;
}

export interface BackupIntegrityCheck {
    /** true = 通过或「没法校验」（老备份没有 integrity 字段），可以继续导入 */
    ok: boolean;
    /** ok=false 时给用户的说明 */
    reason?: string;
}

/**
 * 稳定序列化：对象的键按字典序排、数组保序。
 *
 * 直接用 JSON.stringify 不行 —— 它照着键的插入顺序输出，只要有人手改过备份文件
 * （哪怕只是把 version 挪到第一行），同一份内容就会算出不同的摘要，白白误报。
 */
export function stableStringify(value: unknown): string {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
        .map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
        .join(",")}}`;
}

function toHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * 给导出数据算摘要。integrity 字段本身不参与（它是摘要的结果，不能又是输入）。
 * 任何环境拿不到 crypto.subtle 时返回 null —— 导出照常成功，只是这份备份不带校验值。
 */
export async function computeBackupIntegrity(
    payload: unknown
): Promise<BackupIntegrity | null> {
    try {
        const bytes = new TextEncoder().encode(stableStringify(payload));
        const digest = await crypto.subtle.digest(BACKUP_INTEGRITY_ALGO, bytes);
        return { algo: BACKUP_INTEGRITY_ALGO, value: toHex(digest) };
    } catch {
        return null;
    }
}

/**
 * 给一份已经定型、马上要写成文件的备份数据补上摘要（已有的会被覆盖重算）。
 *
 * 前端在服务端导出之后还会往里塞 localPrefs（星标 / 标签），服务端那份摘要就失效了，
 * 所以「写文件前的最后一刻」统一由这里收口 —— 摘要必须对着最终落盘的那串字节算。
 */
export async function withBackupIntegrity<T extends object>(
    data: T
): Promise<T & { integrity?: BackupIntegrity }> {
    const { integrity: _stale, ...rest } = data as Record<string, unknown>;
    void _stale;
    const integrity = await computeBackupIntegrity(rest);
    return (integrity ? { ...rest, integrity } : { ...rest }) as T & {
        integrity?: BackupIntegrity;
    };
}

/**
 * 校验一份备份数据。
 *
 * 老备份（没有 integrity 字段）一律放行 —— 不然就是一次断崖式的「老文件全不能用了」。
 * 算法标记对不上也放行：说明是别的版本导出的，按它自己的标记算不出来就别拦。
 */
export async function verifyBackupIntegrity(data: unknown): Promise<BackupIntegrityCheck> {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { ok: true };
    }

    const record = data as Record<string, unknown>;
    const integrity = record.integrity as Partial<BackupIntegrity> | undefined;
    if (!integrity || typeof integrity !== "object") return { ok: true };
    if (integrity.algo !== BACKUP_INTEGRITY_ALGO || typeof integrity.value !== "string") {
        return { ok: true };
    }

    // 摘掉 integrity 再算一遍：它是结果，不能当输入
    const { integrity: _ignored, ...rest } = record;
    void _ignored;

    const actual = await computeBackupIntegrity(rest);
    if (!actual) return { ok: true }; // 环境算不出来，别拦着用户恢复
    if (actual.value !== integrity.value) {
        return {
            ok: false,
            reason:
                "备份文件校验失败：内容与文件里记录的校验值不一致，文件可能已损坏、被截断或被改动过。" +
                "请换一份完好的备份再试（现有数据未改动）。",
        };
    }
    return { ok: true };
}
