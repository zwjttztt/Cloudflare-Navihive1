// server/net.ts
// 自托管入口要用到的两个**纯**网络小工具。
//
// 为什么单开一个文件：server/entry.ts 一被 import 就会监听端口、开数据库、跑迁移，
// 单测根本没法引它（server/static.ts 也是同一个理由拆出来的）。这两个函数是
// entry.ts 里仅有的纯逻辑，抽出来就能钉住，不必为一个字符串判断拉起整个服务。

/**
 * IPv4-mapped IPv6 → 点分十进制。
 *
 * 双栈监听（host 省略或写 ::）时，IPv4 客户端的 `socket.remoteAddress` 是
 * `::ffff:203.0.113.7` 这种形态。直接写进 X-Forwarded-For 也不是不能用
 * （限速分桶只看字符串相等），但审计日志里躺着一列 ::ffff: 前缀，
 * 看的人和后面做 IP 归属查询的脚本都会再踩一次。
 */
export function normalizeRemoteAddress(addr: string): string {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    return mapped ? mapped[1] : addr;
}

/**
 * 「这个监听地址是不是对外可见」。
 *
 * 只在启动自检里用，用来决定要不要提醒 XFF 信任的风险：绑回环时外部连不进来，
 * 客户端伪造 X-Forwarded-For 换限速桶这条攻击路径不成立，没必要吓唬人。
 * 0.0.0.0 / :: / 空串都算对外 —— Node 的 listen 在 host 省略时监听所有网卡。
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
export function isPublicHost(host: string): boolean {
    const h = host.trim().toLowerCase();
    if (h.length === 0) return true; // Node 的语义：不传 host = 监听所有网卡
    if (LOOPBACK_HOSTS.has(h)) return false;
    return !/^127\./.test(h); // 整个 127/8 都是回环
}
