// tests/systemUpgradeGuard.test.ts
// 「网页直接升级」端点的静态守卫。
//
// 2026-10-18 用户要「加个升级按键直接升级」；2026-10-19 再报「改成点击后直接在
// 网页端升级，不要再复制代码去后台升级」—— 上一版虽已写成网页触发，但部署侧
// **没挂 docker.sock、又要求 NAVIHIVE_UPGRADE_DIR**，于是端点一律 501，用户看到
// 的仍是「复制命令去后台」。
//
// 本轮把实现从「容器内跑 docker CLI + compose」换成 **Docker Engine API
// （unix socket）**：镜像是 node:24-slim，没有 docker 二进制；挂宿主 CLI 还要
// 连带挂 cli-plugins 与 compose 目录，链路长且动态库容易不兼容。Node 原生
// http.request 的 socketPath 就能打 sock，零额外依赖。
// 这里钉住：两道闸 / 先响应后执行 / 不依赖 compose 目录 / 失败能自救。
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

test("server：upgrade 路由两道闸（owner / docker.sock）", () => {
    const src = readSrc("server/entry.ts");
    assert.match(src, /pathname === "\/api\/system\/upgrade" && method === "POST"/, "要拦 POST /api/system/upgrade");
    // owner：内部问 worker 的 auth/me 复用鉴权
    assert.match(src, /internal\/api\/auth\/me/, "owner 判定复用 worker 的 auth/me");
    assert.match(src, /me\.role !== "owner"/, "非 owner 一律 403");
    // 环境检测：只剩 sock 一道（compose 目录那道是上一版的，已去掉）
    assert.match(src, /existsSync\(DOCKER_SOCK\)/, "要检测 docker.sock");
    assert.doesNotMatch(src, /NAVIHIVE_UPGRADE_DIR/, "不得再要求 compose 目录（那是上一版 501 的根因）");
});

test("server：升级走 Docker Engine API，且用 restart 而非 recreate", () => {
    const src = readSrc("server/entry.ts");
    assert.match(src, /socketPath: DOCKER_SOCK/, "要经 unix socket 打 Docker API");
    assert.match(src, /DOCKER_API_VERSION = "v1\.47"/, "API 版本写死，行为才可预期");
    // 不能再回到 spawn docker / docker compose：容器里没有这些二进制
    assert.doesNotMatch(src, /child_process/, "不得再引入子进程（容器里没有 docker CLI 可调）");
    // ⚠️ 不断言「不出现 docker compose」字样：兜底日志里要**告诉用户**去宿主机执行
    // `docker compose up -d --force-recreate`（见下面那条 match）。执行层面由上面
    // 的 child_process 断言堵死 —— 没有子进程就调不到任何 CLI。
    // ⚠️ 核心不变量：绝不能自己去 stop / delete 这个容器 —— 执行升级的进程就在
    // 容器里，stop 一发出去本进程立刻死，后面的步骤一行都不会执行（线上实测过：
    // 点更新 → 502，容器停在 Exited(0)）。stop+start 必须交给 daemon 的 restart。
    assert.doesNotMatch(src, /\/containers\/\$\{name\}\/stop/, "不得自己 stop 容器（会杀掉执行升级的本进程）");
    assert.doesNotMatch(src, /\/containers\/\$\{name\}\/\?force=true/, "不得自己 delete 容器（同上）");
    assert.match(src, /\/containers\/\$\{name\}\/restart\?t=10/, "必须用 restart 让 daemon 完成停+起");
    assert.match(src, /dockerPull\(/, "要拉镜像");
    // 拉镜像必须在 restart 之前：拉不动就别碰容器
    const pullAt = src.indexOf("await dockerPull(image);");
    const restartAt = src.indexOf("/restart?t=10");
    assert.ok(pullAt > 0 && restartAt > pullAt, "必须先拉镜像再重启（拉失败时旧代码继续服务）");
    // 拉镜像是流，必须读到结束
    assert.match(src, /res\.on\("end", \(\) => \{[\s\S]{0,200}resolve\(\)/, "拉镜像要等进度流结束");
    // 兜底：重启没成也要保证容器活着
    assert.match(src, /dockerEnsureRunning\(\)/, "失败路径要确保容器在跑（站点停摆比升级失败严重）");
});

test("server：先响应再执行 + 失败能自救", () => {
    const src = readSrc("server/entry.ts");
    const i = src.indexOf("/api/system/upgrade");
    const block = src.slice(i, i + 4000);
    const respAt = block.indexOf("res.writeHead(200");
    const runAt = block.indexOf("dockerPull(");
    assert.ok(respAt > 0 && runAt > respAt, "必须先把 200 写回去，再在 setTimeout 里执行升级");
    assert.match(block, /setTimeout\(/, "升级执行要延迟（等响应 flush）");
    // 重启没成也要保证容器活着
    assert.match(block, /catch \(restoreError\)/, "兜底也要兜住，不能把异常吞掉就算了");
    assert.match(block, /docker compose up -d --force-recreate/, "兜底日志要给出宿主机上的恢复命令");
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

test("前端：更新按钮优先调端点，404/501 回落复制命令", () => {
    const src = readSrc("src/components/VersionUpgradeSection.tsx");
    assert.match(src, /fetch\("\/api\/system\/upgrade"/, "要调升级端点");
    assert.match(src, /res\.status === 404 \|\| res\.status === 501/, "404（Workers）/501（没挂 sock）回落");
    assert.match(src, /setCopyState\("upgrading"\)/, "升级已触发要有 upgrading 态");
    assert.match(src, /data-update-running/, "upgrading 态有专属提示抓手");
});
