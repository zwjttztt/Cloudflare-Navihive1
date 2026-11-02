// WebDAV 备份（worker/webdav/ 这一组文件）
//
// WebDAV 服务大多不返回 CORS 头，浏览器直连会被拦截，因此所有 WebDAV 请求都由 Worker 代发。
// 备份加密优先用用户自己设的「备份密码」（backupPassword）；没设时用 AUTH_SECRET 派生的
// 自动口令兜底（见 ./autoKey.ts）—— 上传永远是密文。显式口令与 AUTH_SECRET 解耦，
// 换密钥也不会让「设过口令」的旧备份失效；只有自动加密的那批会受影响。
//
// 按职责分成几份：types（数据结构）/ config（配置从哪来）/ naming（文件名与保留策略）/
// transport（出网那层：URL 校验 + 请求 + 错误翻译），index 里是五个对外操作。

export const DEFAULT_WEBDAV_PATH = "navihive-backup";

export interface WebDavConfig {
    url: string;
    username: string;
    password: string;
    path: string;
    /**
     * 备份文件的加密口令（可选）。
     *
     * 与 AUTH_SECRET 解耦：设了就用它，换 AUTH_SECRET 也照样解；没设则由
     * AUTH_SECRET 派生的自动口令兜底（见 ./autoKey.ts），**不再有「不加密」这个选项**
     * —— 导出的备份里含解密后的站点密码，明文上传等于把凭据交出去。
     * 代价：换 AUTH_SECRET / DATA_ENCRYPTION_KEY 会让旧的自动加密备份解不开，
     * 想跨实例可移植就显式设一个口令。两把根密钥都拿不到时备份直接失败。
     */
    backupPassword?: string;
    /**
     * 允许指向内网 / 本机地址（家里 NAS 的 192.168.x.x、xxx.local 之类）。
     * 默认关闭：WebDAV 地址由管理员配置，但账号一旦被攻破就可能被改成内网地址，
     * 让 Worker 把 Basic 凭据打到内网服务上。确实要备份到内网 NAS 时才打开。
     */
    allowPrivateNetwork?: boolean;
}

export interface WebDavFile {
    name: string;
    size: number;
    lastModified: string;
}

export interface WebDavResult<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
    /** 见 src/API/http.ts 的同名字段：encrypted / badPassword 时前端会弹口令输入框 */
    code?: "encrypted" | "badPassword";
}

/**
 * 备份来源：手动点「备份到 WebDAV」是 manual，每周定时任务是 auto。
 * 两者保留策略不同（见 runWebDavBackup），所以文件名也要能区分得出来源。
 */
export type WebDavBackupMode = "auto" | "manual";
