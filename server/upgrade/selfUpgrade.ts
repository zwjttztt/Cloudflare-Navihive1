// server/upgrade/selfUpgrade.ts
// 「把本容器升级到新镜像」的完整动作序列 + 升级状态机。
//
// 两条通道：
//   · spool 模式 —— 只写一个请求文件（见 ./spool.ts），重建由宿主上的 upgrader 容器做；
//   · sock 模式 —— 本进程直接调 Docker API，再起一次性 helper 容器执行
//     `docker compose up -d --force-recreate`（见 ./dockerApi.ts 与 ./compose.ts）。
//
// 2026-11 从 server/entry.ts 拆出（原文件 1500+ 行，其中七成是这一套）。
// **拆分只是搬运，行为完全等价** —— 下面每一条 ⚠️ 都对应一次线上事故，
// 改动前务必读完被它注释的那段代码。

import {
    UPGRADE_CONTAINER,
    UPGRADE_HELPER,
    dockerApi,
    dockerAvailable,
    dockerCliHost,
    dockerHostRaw,
    dockerImageId,
    dockerPull,
    dockerSockPath,
} from "./dockerApi";
import { readComposeInfo, upgraderCommand, type ComposeInfo } from "./compose";
import { spoolEnabled } from "./spool";

/** 与 server/entry.ts 的 env() 同义：空串也当没配（`||` 而非 `??`） */
const envOr = (key: string, fallback: string): string => process.env[key] || fallback;

/** 从建 helper 到它退出的最长等待。重建一个单容器服务只要几秒，2 分钟兜慢盘 */
const UPGRADE_HELPER_TIMEOUT_MS = 120_000;
/** 宿主机 docker CLI 与 compose 插件（`docker compose` 是插件，不是内建命令） */
const HOST_DOCKER_BIN = envOr("NAVIHIVE_HOST_DOCKER", "/usr/bin/docker");
const HOST_DOCKER_PLUGINS = envOr("NAVIHIVE_HOST_DOCKER_PLUGINS", "/usr/libexec/docker/cli-plugins");

/**
 * 升级过程的状态。**模块级**：POST 触发、GET 读取，两边必须看到同一份。
 * 进程被 compose 换掉后自然清零（成功后前端靠版本号判断，不靠它）。
 */
export const upgradeStatus: {
    // rolled_back / rollback_failed 是「健康门禁没过、走了回滚」的两个终态：
    // 与 spool 侧 state.json 同款相位，前端 upgradeWait 对它们有显式否决。
    phase: "idle" | "pulling" | "recreating" | "failed" | "rolled_back" | "rollback_failed";
    image: string;
    error: string;
    startedAt: number;
    finishedAt: number;
} = { phase: "idle", image: "", error: "", startedAt: 0, finishedAt: 0 };

/** 等 helper 退出。返回退出码；超时（多半是本进程已被换掉）返回 null */
function waitForHelperExit(id: string): Promise<number | null> {
    return new Promise(resolve => {
        let settled = false;
        const done = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(code);
        };
        const timer = setTimeout(() => done(null), UPGRADE_HELPER_TIMEOUT_MS);
        timer.unref?.();
        dockerApi("POST", `/containers/${id}/wait?condition=not-running`).then(
            res => {
                if (res.status >= 300) return done(-1);
                const code = (JSON.parse(res.body) as { StatusCode?: number }).StatusCode;
                done(typeof code === "number" ? code : -1);
            },
            () => done(-1),
        );
    });
}

/** 读 helper 的日志尾巴（失败时把真实原因带给用户，而不是一句「升级失败」） */
async function readHelperLogs(id: string): Promise<string> {
    try {
        const res = await dockerApi("GET", `/containers/${id}/logs?stdout=1&stderr=1&tail=200`);
        if (res.status >= 300) return "";
        // helper 带 Tty 创建：日志是纯文本（非 TTY 才是 8 字节头复用的多路流）
        // 兜掉可能混进来的 NUL（eslint 的 no-control-regex 也不让写正则）
        // ⚠️ 别在这里狠命截断：compose 的报错是排查的唯一线索，截太短等于没留。
        // 上限 4000 字符（前端 Alert 撑得住），且**保留开头**——头几行往往就是原因。
        return res.body.split("\u0000").join("").trim().slice(0, 4000);
    } catch {
        return "";
    }
}

/**
 * 起一个一次性 helper 容器，让它在**容器外面**执行 `docker compose up -d --force-recreate`。
 *
 * 为什么必须是容器外：执行升级的进程就在被升级的这个容器里，任何「自己停/删自己」
 * 的动作都会把它当场杀死（见 dockerUpgradeSelf 的注释）。daemon 侧的 helper 不受影响。
 * 借用的只是新镜像的 `/bin/sh` + 宿主机挂进来的 docker CLI，
 * 所以镜像是 node:slim 也没关系（以前正是「容器里没有 docker 二进制」才走了纯 API）。
 */
async function runUpgraderContainer(image: string, info: ComposeInfo): Promise<void> {
    const name = UPGRADE_HELPER;
    // 上一轮失败留下的 helper：先清掉，否则 create 会 409
    await dockerApi("DELETE", `/containers/${name}?force=true`).catch(() => undefined);
    const created = await dockerApi("POST", `/containers/create?name=${name}`, {
        Image: image,
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: [upgraderCommand(info)],
        WorkingDir: info.workingDir,
        // 和主容器同样的身份：sock 属 root:docker，非 root 连不上
        User: "0:0",
        Tty: true,
        Labels: { "com.navihive.upgrader": "1" },
        // 代理模式：helper 里的 docker CLI 也要走同一个代理，否则它回头去找
        // /var/run/docker.sock（代理模式下根本没挂进去）而连不上 daemon。
        ...(dockerHostRaw ? { Env: [`DOCKER_HOST=${dockerCliHost()}`] } : {}),
        // 同理，只有代理模式才需要显式加入 proxy 所在的网络（默认 bridge 里没有它）
        ...(dockerHostRaw && info.network
            ? { NetworkingConfig: { EndpointsConfig: { [info.network]: {} } } }
            : {}),
        HostConfig: {
            AutoRemove: false,
            Binds: [
                // 代理模式下**不挂 sock**：代理的意义就是别把 daemon 的完整控制权交出去
                ...(dockerHostRaw ? [] : [`${dockerSockPath}:${dockerSockPath}`]),
                // ⚠️ 源和目标写成**同一个宿主路径**：见 compose.upgraderCommand 上方的长注释。
                // 挂在 /compose 会让 compose 把 /compose 写进新容器的 working_dir 标签，
                // 下一轮升级就再也找不到真正的 compose 目录（线上实测：第二次必失败）。
                `${info.workingDir}:${info.workingDir}`,
                `${HOST_DOCKER_BIN}:/usr/bin/docker:ro`,
                `${HOST_DOCKER_PLUGINS}:/usr/libexec/docker/cli-plugins:ro`,
            ],
        },
    });
    if (created.status >= 300) {
        throw new Error(`创建升级容器失败 HTTP ${created.status} ${created.body.slice(0, 200)}`);
    }
    const id = (JSON.parse(created.body) as { Id?: string }).Id || name;
    const started = await dockerApi("POST", `/containers/${id}/start`);
    if (started.status >= 300 && started.status !== 304) {
        throw new Error(`启动升级容器失败 HTTP ${started.status} ${started.body.slice(0, 200)}`);
    }

    const code = await waitForHelperExit(id);
    if (code === null) {
        // 收不到结果：本进程已经在 compose 重建时被换掉了 —— 这正是成功的样子
        return;
    }
    const logs = await readHelperLogs(id);
    await dockerApi("DELETE", `/containers/${id}?force=true`).catch(() => undefined);
    if (code !== 0) {
        // 40/41 是「健康门禁没过、已走回滚」的终态退出码。把退出码挂在 error 上，
        // POST 的失败分支才能如实报 rolled_back / rollback_failed（见 upgradeHealth.ts），
        // 而不是把「已回滚」混成一句普通失败、更不是误报「完成」。
        const error = new Error(`重建容器失败（退出码 ${code}）：${logs || "helper 没有输出"}`) as Error & {
            helperExitCode?: number;
        };
        error.helperExitCode = code;
        throw error;
    }
}

/**
 * 把**这个容器**升级到新镜像：拉镜像 → 交给 compose 用新镜像重建本容器。
 *
 * ⚠️⚠️ 两段都踩过线上坑，别再退回任何一段：
 *
 * ① 「容器内自己 stop → rm → create → start」：执行升级的 Node 进程就在被升级的
 *    容器里。`POST /containers/{name}/stop` 一发出去容器收到 SIGTERM、本进程立刻死，
 *    后面的 DELETE / CREATE / START **一行都不会执行**。线上症状：
 *    点「更新」后长时间无反应、刷新变 502，容器停在 `Exited (0)`。
 *
 * ② 「restart」（2026-10-19 为了绕开①改用）：restart 是 stop + start，由 daemon
 *    完成、不依赖容器内进程活着，看起来完美 —— 但它**按容器创建时记录的 ImageID
 *    启动**，不重新解析 `:latest` 标签。于是 `docker pull` 明明拉到了新镜像、
 *    容器也确实重启了，跑的还是旧代码。线上症状（2026-10-20 用户报）：
 *    「点击更新长时间无反应，刷新后还是原来版本」。
 *
 * 结论：换镜像必须由**容器外面的进程**做 → helper 容器执行 `docker compose up -d
 * --force-recreate`（顺便把 compose 里新增的配置项也带上，restart 做不到这点）。
 *
 * 顺序上先把所有可能失败的都做完（读规格、拉镜像），最后才动容器：
 * 拉取失败、读不到 compose 坐标，都绝不去碰容器，旧容器继续服务。
 */
export async function dockerUpgradeSelf(image: string): Promise<void> {
    const name = UPGRADE_CONTAINER;
    const { status, body } = await dockerApi("GET", `/containers/${name}/json`);
    if (status >= 300) throw new Error(`读不到容器 ${name}（HTTP ${status}）`);
    const info = JSON.parse(body) as {
        Config?: { Labels?: Record<string, string> };
        NetworkSettings?: { Networks?: Record<string, unknown> };
        /** 容器当前在跑的镜像 ID（sha256:…）—— 升级成功与否的**唯一硬判据** */
        Image?: string;
    };
    const runningImageId = info.Image || "";
    const labels = info.Config?.Labels ?? {};
    const compose = readComposeInfo(labels);
    if (!compose) {
        // 两种读不到坐标的情况给不同的处方：被旧版污染 vs 根本不是 compose 起的
        const polluted = labels["com.docker.compose.project.working_dir"] === "/compose";
        throw new Error(
            polluted
                ? "compose 目录标签被旧版写成 /compose（v4.3.0/v4.3.1 的已知问题）：" +
                      "请到宿主机进入 compose 目录执行 docker compose up -d --force-recreate 修正标签，" +
                      "或在 compose 的 environment 里加 NAVIHIVE_COMPOSE_DIR 指向真实目录。"
                : "读不到 compose 部署信息（容器标签里没有 com.docker.compose.*）：本容器不是 docker compose 启动的。" +
                      "网页一键升级只支持 compose 部署，请到宿主机执行 docker compose up -d --force-recreate。"
        );
    }
    // 网络名从本容器身上读：helper 要跟它在同一个网里才解析得到代理。
    // 有多个网时取第一个 —— 代理模式的标准形态是单网。
    compose.network = Object.keys(info.NetworkSettings?.Networks ?? {})[0] ?? "";
    if (dockerHostRaw && !compose.network) {
        throw new Error(
            "配了 NAVIHIVE_DOCKER_HOST 但读不到本容器的网络名：helper 会进默认 bridge，" +
                "解析不到代理地址。请确认本容器在 compose 网络里（docker inspect 看 NetworkSettings.Networks）。"
        );
    }
    upgradeStatus.phase = "pulling";
    await dockerPull(image);

    // ⚠️⚠️ 拉完先比一次镜像 ID（2026-10-21 用户报「点更新又长时间没反应」，线上排查
    // 发现：点了之后容器确实重建过，但**跑的还是旧镜像**，页面等满两分钟才报「没检测到
    // 新版本」）。根因是「有新版本」这个判断来自仓库里的 package.json，而镜像要在
    // GHCR 上构建好几分钟 —— 于是存在一个窗口：
    //   仓库里已经是 5.1.0（前端说「发现新版本」）→ registry 上 :latest 还是上一版 →
    //   pull 拉到的还是旧的 → compose 重建了个一模一样的容器。
    // 白等两分钟还是小事，站点白白抖一次才是。
    // 这种情况**绝不能动容器**：直接如实说「镜像还没更新，容器没动，过几分钟再点」。
    const pulledImageId = await dockerImageId(image);
    if (pulledImageId && runningImageId && pulledImageId === runningImageId) {
        upgradeStatus.phase = "idle";
        throw new Error(
            `镜像没有更新：registry 上的 ${image} 仍是当前运行的这一版。` +
                "「发现新版本」比的是仓库里的 package.json，而镜像要在 GitHub 上构建（本仓库是 " +
                "multi-arch，要模拟 arm64，**通常 10 分钟以上**）—— 版本号先到、镜像后到，这个空档里" +
                "点「更新」只会拉回旧镜像。容器没有重建、站点没受影响；等镜像构建完成（GitHub → " +
                "Actions → docker-publish 变绿）后再点一次。"
        );
    }

    upgradeStatus.phase = "recreating";
    await runUpgraderContainer(image, compose);

    // ⚠️ helper「退出码 0」不等于升级成功：compose 可能认为无须重建直接退 0，
    // `wait` 也可能拿不到结果被当成成功（见 runUpgraderContainer 的 null 分支）。
    // 真正的判据只有一个 —— **容器现在跑的镜像变了没有**。没变就如实报失败，
    // 别让前端去等一个永远不会变的版本号。
    if (runningImageId) {
        const after = await dockerApi("GET", `/containers/${name}/json`).catch(() => null);
        if (after && after.status < 300) {
            const afterImageId = (JSON.parse(after.body) as { Image?: string }).Image || "";
            if (afterImageId && afterImageId === runningImageId) {
                throw new Error(
                    "容器重建后仍在跑旧镜像（compose 没有换成新镜像）。站点仍在服务，" +
                        "请到宿主机 compose 目录执行 docker compose pull && docker compose up -d --force-recreate。"
                );
            }
        }
    }
}

/**
 * 升级后的兜底：确认容器真的在跑，不在就拉起来。
 *
 * 正常路径用不上（helper 失败时 compose 一般还没动到旧容器，我们还活着）；
 * 但「旧容器被停掉、新容器没起来」的那种半途状态只能靠它救 —— 而且只有在
 * 本进程侥幸没被杀（比如 compose 在 stop 之前就报错退出）时才轮得到它。
 * 站点停摆比升级失败严重得多，多这一跳不亏。
 */
export async function dockerEnsureRunning(): Promise<void> {
    const name = UPGRADE_CONTAINER;
    const { status, body } = await dockerApi("GET", `/containers/${name}/json`);
    if (status >= 300) throw new Error(`读不到容器 ${name}（HTTP ${status}）`);
    const state = (JSON.parse(body) as { State?: { Running?: boolean } }).State ?? {};
    if (state.Running) return;
    const started = await dockerApi("POST", `/containers/${name}/start`);
    if (started.status >= 300 && started.status !== 304) {
        throw new Error(`启动容器失败 HTTP ${started.status} ${started.body.slice(0, 200)}`);
    }
}

/**
 * 启动时清掉上一轮升级留下的 helper 容器。
 *
 * 成功升级会把本进程连同容器一起换掉，helper 没机会自己收尾 —— 它会留下一个
 * 已退出的 `navihive-upgrader`。下次启动顺手删掉，daemon 里不留垃圾
 * （升级失败时另一条路径已经在 runUpgraderContainer 里删过了）。
 * 只管带 `com.navihive.upgrader=1` 标签、且**不在运行**的容器：
 * 删正在跑的那个会把升级现场弄丢，而删别人的容器是绝对不行的。
 *
 * ⚠️ 只在 docker-api 模式下有意义：spool 模式的收尾归宿主上的 upgrader 服务，
 * 本进程在那儿根本不会创建 helper 容器（见函数体内第一段注释）。
 */
export async function cleanupUpgraderContainer(): Promise<void> {
    // spool 模式直接收工（2026-10-31 修）：本进程在 spool 模式下**从不创建** helper 容器 ——
    // 带 `com.navihive.upgrader=1` 标签的只可能来自下面那条 Docker API 路径
    // （runUpgraderContainer 创建时贴的 Labels）。spool 的收尾归宿主上的 upgrader 服务
    // （docker-compose.yml 的 `upgrader`，长驻轮询 /spool/request，自己 rm 请求文件），
    // 而它连标签都没有，就算连得上 daemon 也筛不出来。
    //
    // 为什么不能靠 `dockerAvailable()` 兜：它在 spool 模式下**恒为 true** —— 那是
    // 「这个部署形态支不支持网页升级」的判据，不是「本进程连不连得上 daemon」的判据。
    // 沿用它就会去连 compose 故意没挂进来的 /var/run/docker.sock，健康启动也刷一条
    // `connect ENOENT /var/run/docker.sock` 的 warn —— 看起来像故障，实际只是走错了通道。
    //
    // 也不顺手清 /spool 里的文件：`request` 是「待执行命令」（升级器读走立刻 rm，
    // 我们删掉等于静默取消一次升级）、`state.json` 是升级器写的进度（删了会让
    // GET /api/system/upgrade 在升级中途退回 idle）、`request.tmp` 还可能与并发的
    // 写入抢 rename。这三样都不归本进程管。
    if (spoolEnabled()) return;
    if (!dockerAvailable()) return;
    try {
        const filters = encodeURIComponent(JSON.stringify({ label: ["com.navihive.upgrader=1"] }));
        const { status, body } = await dockerApi("GET", `/containers/json?all=1&filters=${filters}`);
        if (status >= 300) return;
        const list = JSON.parse(body) as { Id: string; State?: string }[];
        for (const item of list) {
            if (item.State === "running") continue;
            await dockerApi("DELETE", `/containers/${item.Id}?force=true`).catch(() => undefined);
            console.log(`[upgrade] 已清理上一轮升级的 helper 容器 ${item.Id.slice(0, 12)}`);
        }
    } catch (error) {
        // 清理是顺手的家务，失败绝不阻断启动
        console.warn("[upgrade] 清理 helper 容器失败（不影响运行）:", error);
    }
}
