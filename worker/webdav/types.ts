// WebDAV 备份（worker/webdav/ 这一组文件）
//
// WebDAV 服务大多不返回 CORS 头，浏览器直连会被拦截，因此所有 WebDAV 请求都由 Worker 代发。
// 备份加密用的是用户自己设的「备份密码」（backupPassword），与 AUTH_SECRET 无关：
// AUTH_SECRET 是服务端 JWT 签名密钥，轮换它会让所有旧备份瞬间解不开；
// 备份文件飞出服务端落到网盘上，本就不该由服务端密钥护着。
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
     * 刻意与 AUTH_SECRET 无关：AUTH_SECRET 是服务端 JWT 签名密钥，轮换一次就把此前
     * 所有备份变成废文件。备份一旦传到网盘就不在服务端的保护范围内了，该由用户
     * 自己的口令护着（和本地加密备份同一套 NAVIHIVE-ENC1 格式）。
     * 留空 = 不加密，仍然是 gzip 压缩后上传（能备份，只是文件里是明文）。
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
