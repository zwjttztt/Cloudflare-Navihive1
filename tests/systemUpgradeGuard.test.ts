// tests/systemUpgradeGuard.test.ts
// 「网页直接升级」端点的静态守卫。
//
// 演进史（每一步都踩过线上）：
//   ① 2026-10-18：用户要「加个升级按键直接升级」→ 第一版在容器内自己
//      stop / rm / create，`stop` 一发出去本进程就死了，容器停在 Exited(0)。
//   ② 2026-10-19：改成 `POST /containers/{name}/restart`（daemon 完成 stop+start，
//      不依赖容器内进程）→ 但 restart **按创建时记录的 ImageID 启动**，不重新解析
//      `:latest`。「点了更新、容器也重启了、版本号还是旧的」。
//   ③ 2026-10-20（当前）：换镜像交给**容器外**的一次性 helper 容器
//      （`docker compose up -d --force-recreate`），本进程不再自己动自己。
//
// 这里钉住的核心不变量：
//   - 不得自己 stop / restart / delete 本容器（① ② 的根因）
//   - 换镜像只能发生在 helper 容器里（compose --force-recreate）
//   - 拉镜像必须先于动容器（拉失败时旧代码继续服务）
//   - 先响应再执行；失败要有兜底且原因可查（GET 同一路径）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function projectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const readSrc = (rel: string) =>
    stripComments(readFileSync(resolve(projectDir(), rel), "utf8"));

test("server：upgrade 路由两道闸（owner / docker.sock），并给出 GET 进度", () => {
    const src = readSrc("server/entry.ts");
    assert.match(src, /pathname === "\/api\/system\/upgrade" && method === "POST"/, "要拦 POST /api/system/upgrade");
    // owner：内部问 worker 的 auth/me 复用鉴权
    assert.match(src, /internal\/api\/auth\/me/, "owner 判定复用 worker 的 auth/me");
    assert.match(src, /me\.role !== "owner"/, "非 owner 一律 403");
    // 环境检测：只剩 sock 一道（compose 目录那道是更早一版的 501 根因）
    assert.match(src, /existsSync\(DOCKER_SOCK\)/, "要检测 docker.sock");
    assert.doesNotMatch(src, /NAVIHIVE_UPGRADE_DIR/, "不得再要求 compose 目录（那是上一版 501 的根因）");
    // 进度查询：前端点完「更新」要有地方问「成了没有 / 卡在哪」
    assert.match(
        src,
        /pathname === "\/api\/system\/upgrade" && method === "GET"/,
        "要有 GET 进度查询（否则前端只能干等）"
    );
    assert.match(src, /phase: upgradeStatus\.phase/, "GET 要把 phase 交出去");
    assert.match(src, /error: upgradeStatus\.error/, "GET 要把失败原因交出去");
    // ⚠️ 状态必须模块级。写在 createServer 回调里的话每个请求都是一份新对象，
    // GET 永远读到初始值（POST 记的失败原因白记）—— 静态检查一次，别再犯。
    const statusAt = src.indexOf("const upgradeStatus");
    const serverAt = src.indexOf("const server = createServer(");
    assert.ok(statusAt > 0, "upgradeStatus 要存在");
    assert.ok(
        serverAt > 0 && statusAt < serverAt,
        "upgradeStatus（连同整套 docker helper）必须在 createServer 之外：写在请求回调里就是每请求一份新对象",
    );
    assert.ok(
        src.indexOf("async function dockerUpgradeSelf") < serverAt,
        "dockerUpgradeSelf 也要在模块级（同一类坑）",
    );
});

test("server：换镜像交给容器外的 helper，绝不自己 stop / restart 本容器", () => {
    const src = readSrc("server/entry.ts");
    assert.match(src, /socketPath: DOCKER_SOCK/, "要经 unix socket 打 Docker API");
    assert.match(src, /DOCKER_API_VERSION = "v1\.47"/, "API 版本写死，行为才可预期");
    // 不能再回到 spawn docker：容器里本来就没有 docker 二进制，
    // 换镜像靠「挂宿主 CLI 的 helper 容器」，不是靠子进程
    assert.doesNotMatch(src, /child_process/, "不得引入子进程");
    // ⚠️ 两条历史根因，永久封死：
    assert.doesNotMatch(src, /\/containers\/\$\{name\}\/stop/, "不得自己 stop 容器（会杀掉执行升级的本进程）");
    assert.doesNotMatch(
        src,
        /\/containers\/\$\{name\}\/restart/,
        "不得用 restart 升级：它按创建时的 ImageID 启动，不重新解析 :latest（版本不变的根因）"
    );
    assert.doesNotMatch(src, /\/containers\/\$\{name\}\/\?force=true/, "不得自己 delete 容器");
    // 换镜像 = helper 里跑 compose --force-recreate
    assert.match(src, /docker compose \$CFG -p \$\{project\} up -d --force-recreate/, "helper 要真的重建容器");
    // ⚠️ 不能走管道接 $?：退出码会被 tee 之类的命令顶掉，失败就被当成成功了
    assert.match(src, /OUT=\$\(docker compose/, "compose 输出要先落到变量，$? 才是它自己的");
    assert.match(src, /CODE=\$\?/, "要留住 compose 的退出码");
    assert.match(src, /containers\/create\?name=\$\{name\}/, "要建一次性 helper 容器");
    assert.match(src, /Entrypoint: \["\/bin\/sh", "-c"\]/, "helper 借新镜像的 sh 跑脚本");
    // ⚠️⚠️ v4.3.0/v4.3.1 线上「第一次升级成功、第二次必失败」的根因：
    // compose 把自己运行时的工作目录写进新容器的
    // com.docker.compose.project.working_dir 标签，而那是下一轮读坐标的唯一来源。
    // 挂在容器内的 /compose → 标签被写成 /compose → 下一轮 bind 的源变成
    // 宿主机上不存在的 /compose（docker 还顺手建个空目录）→ compose 找不到文件。
    // 所以必须挂在**宿主原路径**，让容器内外看到同一个目录。
    assert.match(
        src,
        /`\$\{info\.workingDir\}:\$\{info\.workingDir\}`/,
        "helper 必须把 compose 目录挂在宿主原路径（同一路径），否则会污染下一轮的标签",
    );
    assert.match(src, /WorkingDir: info\.workingDir/, "helper 的工作目录也必须是宿主原路径");
    assert.match(src, /workingDir === "\/compose"/, "要能认出被旧版污染的 /compose 标签并明确报错");
    // compose 的报错是排查的唯一线索，别在 Node 侧狠命截断
    assert.match(src, /slice\(0, 4000\)/, "helper 日志要保留足够长（截太短等于没留线索）");
    // compose 坐标从容器标签读，不要求用户额外配环境变量
    assert.match(src, /com\.docker\.compose\.project\.working_dir/, "工作目录来自 compose 标签");
    assert.match(src, /com\.docker\.compose\.project\.config_files/, "配置文件来自 compose 标签");
    assert.match(src, /com\.docker\.compose\.project"\]/, "工程名来自 compose 标签");
    // 拉镜像必须在动容器之前：拉不动就别碰容器
    const pullAt = src.indexOf("await dockerPull(image);");
    const recreateAt = src.indexOf("await runUpgraderContainer(image, compose);");
    assert.ok(pullAt > 0 && recreateAt > pullAt, "必须先拉镜像再重建（拉失败时旧代码继续服务）");
    assert.ok(
        src.indexOf("await dockerPull(image);") > 0 &&
            src.indexOf("await dockerPull(image);") < src.indexOf('upgradeStatus.phase = "recreating"'),
        "状态要先走 pulling 再走 recreating",
    );
    // 拉镜像是流，必须读到结束
    assert.match(src, /res\.on\("end", \(\) => \{[\s\S]{0,200}resolve\(\)/, "拉镜像要等进度流结束");
    // 兜底：万一容器没起来也要拉起来
    assert.match(src, /dockerEnsureRunning\(\)/, "失败路径要确保容器在跑（站点停摆比升级失败严重）");
    // helper 成功后本进程没了，清理只能在下一次启动做；且只清「带标签 + 没在跑」的
    assert.match(src, /cleanupUpgraderContainer\(\)/, "启动时要清理上一轮升级留下的 helper");
    assert.match(src, /label: \["com\.navihive\.upgrader=1"\]/, "只清自己家的 helper（按标签过滤）");
    assert.match(src, /item\.State === "running"\) continue/, "正在跑的 helper 不能删（会弄丢升级现场）");
});

test("server：先响应再执行 + 失败原因可查", () => {
    const src = readSrc("server/entry.ts");
    const i = src.indexOf("/api/system/upgrade");
    const block = src.slice(i, i + 6000);
    const respAt = block.indexOf("res.writeHead(200");
    const runAt = block.indexOf("dockerUpgradeSelf(");
    assert.ok(respAt > 0 && runAt > respAt, "必须先把 200 写回去，再在 setTimeout 里执行升级");
    assert.match(block, /setTimeout\(/, "升级执行要延迟（等响应 flush）");
    assert.match(block, /upgradeStatus\.phase = "failed"/, "失败要把 phase 记下来给 GET 读");
    assert.match(block, /catch \(restoreError\)/, "兜底也要兜住，不能把异常吞掉就算了");
});

test("compose：要挂 docker.sock、给权限，并告知容器自己的名字", () => {
    const src = readSrc("docker-compose.yml");
    assert.match(src, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/, "要挂 docker.sock 才能网页升级");
    // ⚠️ sock 属 root:docker(987)，镜像默认以 node(1000) 跑 —— 不显式给权限就是
    // connect EACCES（文件看得见、连不上）。这条是 VPS 上重建后跑只读调用才暴露的。
    assert.match(src, /NAVIHIVE_RUN_AS|group_add/, "必须显式给访问 sock 的身份/组");
    assert.match(src, /NAVIHIVE_CONTAINER_NAME/, "要告诉服务自己要重建的容器名");
    assert.match(src, /NAVIHIVE_IMAGE/, "要可配置升级目标镜像");
});

test("前端：更新按钮优先调端点，404/501 回落复制命令，升级后要跟进结果", () => {
    const src = readSrc("src/components/VersionUpgradeSection.tsx");
    assert.match(src, /fetch\("\/api\/system\/upgrade"/, "要调升级端点");
    assert.match(src, /res\.status === 404 \|\| res\.status === 501/, "404（Workers）/501（没挂 sock）回落");
    assert.match(src, /setCopyState\("upgrading"\)/, "升级已触发要有 upgrading 态");
    assert.match(src, /data-update-running/, "upgrading 态有专属提示抓手");
    // 2026-10-20 用户报「长时间无反应」→ 点完必须跟进到底
    assert.match(src, /void watchUpgrade\(\)/, "触发成功后要开始跟进（不能只挂一句「升级中」）");
    assert.match(src, /waitForUpgrade\(/, "跟进靠 waitForUpgrade 轮询版本");
    assert.match(src, /reloadWithFreshCache/, "成了要清缓存刷到新版（否则 SW 喂回旧外壳）");
    assert.match(src, /data-update-failed/, "失败了要把原因摆出来");
    assert.match(src, /data-update-done/, "成了也要说一句");
    const util = readSrc("src/utils/upgradeWait.ts");
    assert.match(util, /\/api\/system\/upgrade/, "跟进要读服务端 phase（失败原因是它给的）");
    assert.match(util, /precache-manifest|PRECACHE_MANIFEST_URL/, "跟进要靠构建号判断换没换版本");
});
