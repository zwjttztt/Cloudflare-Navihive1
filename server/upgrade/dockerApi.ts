// server/upgrade/dockerApi.ts
// Docker Engine API 的最小客户端 —— 自托管「网页一键升级」的底座。
//
// 为什么不用 `docker` CLI：运行镜像是 node:24-slim，里面**没有** docker 二进制；
// 而把宿主机的 /usr/bin/docker 挂进容器要连带挂 cli-plugins（`docker compose`
// 是插件不是内建命令），还要挂 compose 目录，链路长且动态库容易不兼容。
// Docker Engine 的 HTTP API 走 /var/run/docker.sock，Node 原生就能发请求
// （http.request 的 socketPath 选项），零额外依赖、也不需要 compose。
//
// ⚠️ 这段代码在容器里跑，升级的正是**它自己所在的容器**：整条序列必须
// 「先把 200 响应发出去，再动手」，否则 compose 换容器时进程被杀，
// 用户等不到任何反馈。调用方（server/entry.ts 的路由）已保证这个顺序。
//
// 2026-11 从 server/entry.ts 拆出（原文件 1500+ 行，Docker 自升级占七成）。
// **拆分只是搬运，行为完全等价**；理由见 server/upgrade/compose.ts 文件头的说明。

import { request as httpRequest, type RequestOptions } from "node:http";
import { existsSync } from "node:fs";
import { spoolEnabled } from "./spool";

/**
 * Docker daemon 的访问方式。两种，按 `NAVIHIVE_DOCKER_HOST` 是否配置自动选：
 *
 *   1. 没配（默认）—— 走 unix socket `/var/run/docker.sock`
 *      （路径可用 `NAVIHIVE_DOCKER_SOCK` 改）。等价于把宿主机 Docker 的完整控制权
 *      交给这个容器。
 *   2. 配了 —— 走 TCP，接的是 `docker-socket-proxy` 一类的最小权限代理，
 *      只能碰升级必需的几个端点（拉镜像 / 建启删容器 / 读日志），
 *      容器失守也不等于拿到宿主机 root。
 *      compose 片段见 `deploy/docker-socket-proxy.yml`。
 *
 * ⚠️ 代理模式下 helper 容器**不再挂 sock**，改为给它注入 `DOCKER_HOST`，
 * 让里面的 `docker compose` 也走同一个代理（见 selfUpgrade.runUpgraderContainer）。
 */
const DOCKER_SOCK = process.env.NAVIHIVE_DOCKER_SOCK || "/var/run/docker.sock";
const DOCKER_HOST = (process.env.NAVIHIVE_DOCKER_HOST || "").trim();
/** API 版本写死：不跟着 daemon 版本漂，行为才可预期（v1.47 ≈ Docker 25/26） */
const DOCKER_API_VERSION = "v1.47";

/** 被升级的那个容器的名字（compose 的 service 名，可用 NAVIHIVE_CONTAINER_NAME 改） */
export const UPGRADE_CONTAINER = process.env.NAVIHIVE_CONTAINER_NAME || "navihive";
/** 升级目标镜像引用（pull 的对象） */
export const UPGRADE_IMAGE = process.env.NAVIHIVE_IMAGE || "ghcr.io/zwjttztt/navihive:latest";
/** 一次性 helper 容器的名字（daemon 里一眼能认出是升级用的，别和主容器混） */
export const UPGRADE_HELPER = `${UPGRADE_CONTAINER}-upgrader`;

/** 代理模式下要连的地址（原文，`http://…`）；空串 = 走 unix socket */
export const dockerHostRaw = DOCKER_HOST;
/** unix socket 路径（`runUpgraderContainer` 要把它 bind 进 helper） */
export const dockerSockPath = DOCKER_SOCK;

/** 拼 http.request 的连接参数：代理模式给 host/port，否则给 socketPath */
export function dockerEndpoint(): RequestOptions {
    if (!DOCKER_HOST) return { socketPath: DOCKER_SOCK };
    // 形如 http://docker-socket-proxy:2375；代理只开 http，端口缺省 2375
    const url = new URL(DOCKER_HOST);
    return { host: url.hostname, port: Number(url.port) || 2375 };
}

/**
 * 给 **docker CLI / compose** 用的 DOCKER_HOST。
 *
 * ⚠️⚠️ CLI 只接受 `unix://` 与 `tcp://` 两种形状，`http://` 会被直接判非法：
 *   `Failed to initialize: unable to resolve docker endpoint:
 *    invalid bind address format: http://docker-socket-proxy:2375`
 *   2026-10-22 网页一键升级就是这么挂的 —— 我把给自己 fetch 用的 http:// 地址
 *   原样塞进了 helper 的 DOCKER_HOST。自己读 api 要 http://，CLI 要 tcp://，
 *   **同一个地址两种写法**，所以这里必须分开派生，不能共用 DOCKER_HOST。
 *
 * ⚠️ https:// 也映射到 tcp://，不带 TLS：socket-proxy 只监听明文 TCP（2375）。
 *    真要上 TLS 得给 CLI 配 --tlsverify 与证书目录，不在当前形态里。
 */
export function dockerCliHost(): string {
    if (!DOCKER_HOST) return "";
    return DOCKER_HOST.replace(/^https?:\/\//i, "tcp://");
}

/** 一次 API 调用的结果（不解析 JSON，交给调用方 —— 不同端点形状差别太大） */
export interface DockerCall {
    status: number;
    body: string;
}

/** 打一次 Docker Engine API。socketPath 走 unix socket，不需要 TCP 端口。 */
export function dockerApi(method: string, apiPath: string, payload?: unknown): Promise<DockerCall> {
    return new Promise((resolve, reject) => {
        const body = payload === undefined ? undefined : JSON.stringify(payload);
        const req = httpRequest(
            {
                ...dockerEndpoint(),
                method,
                path: `/${DOCKER_API_VERSION}${apiPath}`,
                headers: {
                    ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
                    Host: "docker",
                },
            },
            res => {
                const chunks: Buffer[] = [];
                res.on("data", c => chunks.push(c as Buffer));
                res.on("end", () =>
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
                );
            },
        );
        req.on("error", reject);
        // 拉镜像可能几分钟：别让 socket 级别的超时把它掐了
        req.setTimeout(0);
        if (body) req.write(body);
        req.end();
    });
}

/** 拉镜像。POST /images/create 回的是 NDJSON 进度流，要读到流结束才算拉完。 */
export async function dockerPull(image: string): Promise<void> {
    const sep = image.lastIndexOf(":");
    const fromImage = sep > image.lastIndexOf("/") ? image.slice(0, sep) : image;
    const tag = sep > image.lastIndexOf("/") ? image.slice(sep + 1) : "latest";
    await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
            {
                ...dockerEndpoint(),
                method: "POST",
                path: `/${DOCKER_API_VERSION}/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
                headers: { Host: "docker" },
            },
            res => {
                if ((res.statusCode ?? 0) >= 300) {
                    res.resume();
                    res.on("end", () => reject(new Error(`拉取镜像失败 HTTP ${res.statusCode}`)));
                    return;
                }
                // 进度流：逐行读，只为把 socket 读完（内容只用于报错）
                let buf = "";
                res.on("data", c => {
                    buf += c.toString();
                    if (buf.length > 1 << 20) buf = buf.slice(-4096);
                });
                res.on("end", () => {
                    if (/"error"\s*:/.test(buf)) reject(new Error("拉取镜像时 daemon 报了错"));
                    else resolve();
                });
            },
        );
        req.on("error", reject);
        req.setTimeout(0);
        req.end();
    });
}

/**
 * 某个镜像引用（`repo:tag`）在当前 daemon 里的镜像 ID（`sha256:…`）。
 *
 * 用来回答一个很实际的问题：**这次拉取真的有新东西吗**。
 * 拉取失败 / 没有这个镜像时返回空串 —— 调用方按「不知道」处理，不拿它拦升级。
 * 路径里的 `/` 与 `:` 原样传：daemon 的 `/images/{name}/json` 认这种写法，
 * 编码成 %2F 反而会被当成镜像名的一部分。
 */
export async function dockerImageId(image: string): Promise<string> {
    const res = await dockerApi("GET", `/images/${image}/json`).catch(() => null);
    if (!res || res.status >= 300) return "";
    try {
        const id = (JSON.parse(res.body) as { Id?: string }).Id;
        return typeof id === "string" ? id : "";
    } catch {
        return "";
    }
}

/**
 * 「网页升级可用」的判据。
 *
 * ⚠️ spool 模式恒为 true：那说的是「这个部署形态支不支持网页升级」，
 * 不是「本进程连不连得上 daemon」。别拿它当后者的判据 ——
 * cleanupUpgraderContainer 的注释里有一次踩坑记录。
 */
export function dockerAvailable(): boolean {
    // spool 模式：重建由升级器容器做，本进程不需要 daemon
    if (spoolEnabled()) return true;
    return DOCKER_HOST ? true : existsSync(DOCKER_SOCK);
}
