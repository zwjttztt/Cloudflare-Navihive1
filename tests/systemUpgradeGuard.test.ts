// tests/systemUpgradeGuard.test.ts
// 「网页直接升级」端点的静态守卫（2026-10-18 用户要「加个升级按键直接升级」）。
//
// 实现形态：server/entry.ts 拦 POST /api/system/upgrade（**先于** proxyToWorker），
// 三道闸（owner / docker.sock / compose 目录），**先响应再执行**（compose up 会
// 把容器自己换掉，响应发不出去）。Workers 部署没有这个路由 → 404 → 前端回落
// 复制命令。这里把「三道闸 + 先响应后执行 + owner 复用 worker 鉴权」钉住。
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

test("server：upgrade 路由三道闸（owner / docker.sock / compose 目录）", () => {
    const src = readSrc("server/entry.ts");
    assert.match(src, /pathname === "\/api\/system\/upgrade" && method === "POST"/, "要拦 POST /api/system/upgrade");
    // owner：内部问 worker 的 auth/me 复用鉴权
    assert.match(src, /internal\/api\/auth\/me/, "owner 判定复用 worker 的 auth/me");
    assert.match(src, /me\.role !== "owner"/, "非 owner 一律 403");
    // 环境检测
    assert.match(src, /existsSync\("\/var\/run\/docker\.sock"\)/, "要检测 docker.sock");
    assert.match(src, /NAVIHIVE_UPGRADE_DIR/, "升级目录走 env（不写死 /home/docker/navihive）");
    assert.match(src, /docker-compose\.yml/, "目录里要有 compose 文件");
});

test("server：先响应再执行（容器会把自己换掉，响应必须发得出去）", () => {
    const src = readSrc("server/entry.ts");
    const i = src.indexOf("/api/system/upgrade");
    const block = src.slice(i, i + 3000);
    const respAt = block.indexOf("res.writeHead(200");
    const spawnAt = block.indexOf("spawn(");
    assert.ok(respAt > 0 && spawnAt > respAt, "必须先把 200 写回去，再 setTimeout 里 detached 执行升级");
    assert.match(block, /setTimeout\(/, "升级执行要延迟（等响应 flush）");
    assert.match(block, /detached: true/, "升级子进程要 detached（本进程被杀不影响它）");
    assert.match(block, /docker pull[\s\S]*docker compose up -d --force-recreate/, "脚本 = pull 成功才 up");
});

test("前端：更新按钮优先调端点，404/501 回落复制命令", () => {
    const src = readSrc("src/components/VersionUpgradeSection.tsx");
    assert.match(src, /fetch\("\/api\/system\/upgrade"/, "要调升级端点");
    assert.match(src, /res\.status === 404 \|\| res\.status === 501/, "404（Workers）/501（没挂 sock）回落");
    assert.match(src, /setCopyState\("upgrading"\)/, "升级已触发要有 upgrading 态");
    assert.match(src, /data-update-running/, "upgrading 态有专属提示抓手");
});
