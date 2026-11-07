// server/upgrade/compose.ts
// 「怎么让宿主机上的 compose 用新镜像重建本容器」—— 坐标解析 + helper 命令拼装。
//
// 这一层是**纯逻辑**：不碰 socket、不读文件，输入是容器标签、输出是字符串。
// 这正是 2026-11 把它从 server/entry.ts 拆出来的原因：以前它和几百行 docker
// 调用缠在一个 1500 行的入口文件里，逻辑明明可测，却因为「同文件里有连不上的
// socket 调用」而覆盖率为 0。现在 tests/upgradeCompose.test.ts 可以逐格钉住
// 「标签被旧版污染」「配置文件不在工作目录里」这类只在线上炸过一次的判据。
//
// ⚠️ 这里产出的字符串会被塞进 `docker compose` 的命令行，**任何一个字符错都等于
// 升级失败**，而失败发生在容器正在被替换的那一刻 —— 没有第二次机会。改之前先读
// 下面两段长注释（它们各对应一次线上事故）。

import { tagPreviousBeforeRecreate, healthGuardAfterRecreate } from "../upgradeHealth";
import { UPGRADE_CONTAINER } from "./dockerApi";

/** compose 部署坐标：工程名 / 工作目录 / 配置文件（全部来自容器标签，无需额外配置） */
export interface ComposeInfo {
    project: string;
    workingDir: string;
    files: string[];
    /**
     * 本容器所在的网络名。只有代理模式才用得上：helper 必须和 docker-socket-proxy
     * 在同一个网络里才能按名字解析到它（默认 bridge 网里没有 proxy 这个别名）。
     */
    network: string;
}

/**
 * 从容器标签里读出 compose 部署坐标。
 *
 * 为什么不要求用户配 `NAVIHIVE_COMPOSE_DIR`：compose 自己会在容器上打
 * `com.docker.compose.project{,.working_dir,.config_files}` 三个标签，直接读它
 * 比自己猜可靠得多。读不到（纯 `docker run` 起的）→ 返回 null，
 * 由调用方明确报错，不假装成功。
 *
 * ⚠️ `/compose` 是旧版（v4.3.0/v4.3.1）helper 的挂载点：那两版把目录挂在容器内的
 * `/compose`，compose 于是把 `/compose` 写进新容器的 working_dir 标签，宿主机上
 * 并没有这个目录。见到它就说明标签被污染了 —— 照它 bind 只会得到一个空目录，
 * 升级必然失败。此时宁可不升级，把话说明，让用户去宿主机 `docker compose up -d`
 * 把标签改回来（或在 compose 里设 `NAVIHIVE_COMPOSE_DIR`）。
 *
 * @param labels 容器标签（`docker inspect` 的 `Config.Labels`）
 * @param overrideDir 环境变量 `NAVIHIVE_COMPOSE_DIR` 的值。默认从 process.env 取，
 *        显式传参只为让用例能覆盖（否则测这条函数要先改进程环境）。
 */
export function readComposeInfo(
    labels: Record<string, string>,
    overrideDir: string = process.env.NAVIHIVE_COMPOSE_DIR || "",
): ComposeInfo | null {
    const fromEnv = overrideDir;
    const workingDir = (fromEnv || labels["com.docker.compose.project.working_dir"] || "").replace(/\/+$/, "");
    // 必须是绝对路径：空串（没标签）/ 相对路径都没法当 bind 源
    if (!workingDir.startsWith("/")) return null;
    if (!fromEnv && workingDir === "/compose") return null;
    return {
        project: labels["com.docker.compose.project"] || UPGRADE_CONTAINER,
        workingDir,
        files: (labels["com.docker.compose.project.config_files"] || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean),
        network: "",
    };
}

/**
 * helper 里跑 compose 用的路径。**必须和宿主机上的原路径一字不差**。
 *
 * ⚠️⚠️ 这是 v4.3.0/v4.3.1 线上「第一次升级成功、第二次必失败」的根因：
 * compose 会把自己运行时的工作目录写进新容器的
 * `com.docker.compose.project.working_dir` 标签，而那个标签是下一轮升级
 * 读坐标的**唯一**来源。早先把目录挂在 `/compose`（容器内路径），
 * 于是重建后标签变成 `/compose`；下一轮照着它 bind，源就变成宿主机上
 * 并不存在的 `/compose`，docker 还会顺手创建一个**空目录**挂进去 ——
 * compose 找不到配置文件，退出码 1，升级静默失败。
 * 挂在宿主原路径上，compose 记录的才是宿主的真实路径，下一轮才接得上。
 *
 * @param info 部署坐标
 * @param container 被重建的容器名。默认取 `NAVIHIVE_CONTAINER_NAME`，
 *        显式传参只为让用例能断言具体命令（不影响生产行为）。
 */
export function upgraderCommand(info: ComposeInfo, container: string = UPGRADE_CONTAINER): string {
    const dir = info.workingDir;
    const base = `${dir}/`;
    // 只认落在工作目录里的配置文件
    const inside = info.files.filter(f => f.startsWith(base)).map(f => `${dir}/${f.slice(base.length)}`);
    const project = info.project;
    // 健康门禁回滚用的第一个 compose 文件（bare 路径；无 -f 前缀）
    const firstFile = inside[0] || `${dir}/docker-compose.yml`;
    return [
        `CFG="${inside.map(f => `-f ${f}`).join(" ")}"`,
        'if [ -z "$CFG" ]; then',
        `  for f in ${dir}/docker-compose.yml ${dir}/docker-compose.yaml ${dir}/compose.yml ${dir}/compose.yaml; do`,
        `    if [ -f "$f" ]; then CFG="-f $f"; break; fi`,
        "  done",
        "fi",
        `if [ -z "$CFG" ]; then echo "[upgrader] 在 ${dir} 里找不到 compose 配置文件（挂载目录不对？）"; exit 21; fi`,
        'if [ ! -x /usr/bin/docker ]; then echo "[upgrader] 宿主机 docker CLI 不可用：/usr/bin/docker 没挂进来"; exit 22; fi',
        `cd "${dir}"`,
        // 升级前先把当前（旧）镜像记成回滚锚点：recreate 之后 latest 就是新镜像，
        // 旧镜像只剩正在跑的这一份 ImageID，必须现在 inspect 下来 tag 住。
        tagPreviousBeforeRecreate(container),
        // 往宿主机的 compose 目录记一笔：重建会把容器自身的日志一起换掉，
        // 出问题时这份文件是最后一份现场
        `LOG="${dir}/.navihive-upgrade.log"`,
        `echo "[upgrader] $(date -u +%FT%TZ) 开始 $CFG -p ${project}" >> "$LOG"`,
        `echo "[upgrader] docker compose $CFG -p ${project} up -d --force-recreate"`,
        // 不用管道：$? 必须来自 docker compose 本身
        `OUT=$(docker compose $CFG -p ${project} up -d --force-recreate 2>&1) ; CODE=$?`,
        'printf "%s\\n" "$OUT"',
        'printf "%s\\n" "$OUT" >> "$LOG"',
        'if [ "$CODE" -ne 0 ]; then',
        `  echo "[upgrader] $(date -u +%FT%TZ) 失败（退出码 $CODE）" >> "$LOG"`,
        '  echo "[upgrader] 重建失败：docker compose 返回非 0 退出码"',
        "  exit 1",
        "fi",
        // 重建成功 ≠ 新容器能服务：探活，不健康就回滚 previous（#9 健康门禁）
        // ⚠️ R05：门禁没过时下面这段会直接 exit 40/41（rolled_back / rollback_failed），
        // 末尾两句「成功」只在 GUARD_OK 非空（门禁通过）时才跑得到 —— 回滚绝不能再报升级完成。
        healthGuardAfterRecreate(container, project, firstFile),
        `echo "[upgrader] $(date -u +%FT%TZ) 成功" >> "$LOG"`,
        'echo "[upgrader] 完成：容器已按新镜像重建（健康门禁已通过）"',
    ].join("\n");
}
