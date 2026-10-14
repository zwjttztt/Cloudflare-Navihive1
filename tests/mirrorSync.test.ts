// tests/mirrorSync.test.ts
//
// 单向镜像同步（方案 A / 文档里编号 ②）的行为钉子。
//
// 这一类东西坏了**没有任何东西会报错**：
//   - 镜像站没开维护模式就同步 → 那里的写入被整批覆盖，且不吭一声；
//   - 只同步导航、漏了笔记 → 切到镜像站才发现笔记全空（导航备份刻意不含笔记）；
//   - 写请求不带 Sec-Fetch-Site → 服务端的同源判据走兜底分支，判据一收紧就 403；
//   - 写请求带重试 → /api/import 是「先插入后删旧」，重来一批就是重复行。
// 这些只能钉在这里。本测试只做**源码静态检查**：脚本要真跑起来必须两边都有账号，
// 那属于联调，不进单测。
//
// ⚠️ 扫源码**必须剥注释**：注释里写着端点名与键名，不剥的话守卫全是假绿。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============  helpers ============

/** 单测会被打包到 script/tmp-tests/ 下再跑，逐级向上找真身（ESM 没有 __dirname） */
function projectDir(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录（6 层内没有 package.json）");
}

const ROOT = projectDir();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * 剥掉 JS/TS 注释。
 *
 * 行注释只剥「前面不是冒号」的 // —— 否则 `https://` 会被当成注释开头，
 * 把整行代码吃掉，后面的索引判断全错。
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SYNC = "script/sync-mirror.mjs";

test("单向同步脚本存在，且 package.json 里有对应的 npm 入口", () => {
    assert.ok(existsSync(path.join(ROOT, SYNC)), `仓库里没有 ${SYNC}`);
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.scripts?.["sync:mirror"], `node ${SYNC}`, "package.json 缺 sync:mirror（或路径与脚本不一致）");
});

test("脚本读的六个环境变量与文档口径一致（改名会静默拿不到配置）", () => {
    const src = stripComments(read(SYNC));
    for (const name of [
        "MIRROR_SRC_URL",
        "MIRROR_SRC_USER",
        "MIRROR_SRC_PASS",
        "MIRROR_DST_URL",
        "MIRROR_DST_USER",
        "MIRROR_DST_PASS",
    ]) {
        assert.match(src, new RegExp(`"${name}"`), `脚本里读不到环境变量 ${name}`);
    }
    // 凭据只能来自环境变量：命令行参数会出现在 ps / shell history 里
    assert.doesNotMatch(src, /process\.argv[\s\S]{0,80}(PASS|Pass|pass)/, "凭据不能从命令行参数取");
});

test("两条通道的端点与 worker 侧真实路由对得上", () => {
    const sync = stripComments(read(SYNC));
    const backup = stripComments(read("worker/routes/backup.ts"));
    const data = stripComments(read("worker/routes/data.ts"));

    // 通道 1：导航 —— 导出在 backup.ts，导入也在 backup.ts
    assert.match(sync, /"export"/, "脚本没有走 /api/export");
    assert.match(sync, /"import"/, "脚本没有走 /api/import");
    assert.match(backup, /path === "export"/, "worker 侧没有 GET /api/export 了");
    assert.match(backup, /path === "import"/, "worker 侧没有 POST /api/import 了");

    // 通道 2：笔记 —— 导航备份刻意不含笔记，漏了这条就是「切过去笔记全空」
    assert.match(sync, /"notes\/export"/, "脚本没有走 /api/notes/export");
    assert.match(sync, /"notes\/import"/, "脚本没有走 /api/notes/import");
    assert.match(data, /path === "notes\/export"/, "worker 侧没有 GET /api/notes/export 了");
    assert.match(data, /path === "notes\/import"/, "worker 侧没有 POST /api/notes/import 了");
});

test("notes/export 必须排在抢分支的 notes/ 通配路由之前", () => {
    const data = stripComments(read("worker/routes/data.ts"));
    const at = data.indexOf(`path === "notes/export"`);
    assert.ok(at > 0, "没找到 notes/export 分支");
    // 真正的杀手是 `path.startsWith("notes/") && method === "GET"`：单条笔记的读法，
    // 里面 parseInt(path.split("/")[1]) 对 "export" 得 NaN → 400「无效的ID」。
    // 被它抢走的表现是接口一直 400，而新库里根本不进这条链，本地怎么测都是绿的。
    const wildcard = data.indexOf(`path.startsWith("notes/")`);
    assert.ok(wildcard > 0, "没找到 notes/ 通配分支");
    assert.ok(at < wildcard, "notes/export 被 notes/ 通配路由抢走了（必须排在它前面）");
});

test("镜像站只读闸门必须在任何写请求之前（否则别人的写入被静默覆盖）", () => {
    const src = stripComments(read(SYNC));
    const gate = src.indexOf("assertMirrorReadOnly(");
    assert.ok(gate > 0, "脚本里没有镜像站只读闸门");
    // 取**调用点**（不是函数定义）：定义在文件后面，位置说明不了顺序
    const gateCall = src.indexOf("await assertMirrorReadOnly(cfg.dst)");
    assert.ok(gateCall > 0, "main 里没有调用只读闸门");
    const firstWrite = src.indexOf("writeJson(cfg.dst");
    assert.ok(firstWrite > 0, "脚本没有往镜像站写过东西？");
    assert.ok(
        gateCall < firstWrite,
        "只读闸门排在写请求之后了 —— 闸门必须在搬第一个字节之前拦住"
    );
});

test("只读闸门判的是 maintenance 字段，键名与 shared/maintenance.ts 一致", () => {
    const src = stripComments(read(SYNC));
    const shared = stripComments(read("shared/maintenance.ts"));
    const keyMatch = /MAINTENANCE_ENABLED_KEY = "([^"]+)"/.exec(shared);
    assert.ok(keyMatch, "shared/maintenance.ts 里找不到 MAINTENANCE_ENABLED_KEY");
    const key = keyMatch[1];

    assert.match(src, /init\.maintenance|init\?\.maintenance/, "闸门没有读 /api/init 的 maintenance 字段");
    assert.match(src, new RegExp(key.replace(/\./g, "\\.")), `脚本里的维护模式键名与 shared/maintenance.ts 的 ${key} 不一致`);
    // 读不到 /api/init 也要按「不能确认只读」退出 2，而不是当成「同步失败」
    const gateBody = src.slice(src.indexOf("async function assertMirrorReadOnly"), src.indexOf("async function withBackupCredentials"));
    assert.match(gateBody, /process\.exit\(2\)/, "闸门拦下时必须以退出码 2 结束");
});

test("--dry-run 不得发起任何写请求", () => {
    const src = stripComments(read(SYNC));
    const body = src.slice(src.indexOf("async function writeJson"), src.indexOf("async function reconcile"));
    assert.ok(body.length > 0, "找不到 writeJson");
    assert.match(body, /dryRun/, "writeJson 没有 dryRun 判断 —— 试跑会把镜像站覆盖掉");
    assert.match(body, /throw new Error/, "dry-run 命中写请求时应当直接抛错而不是静默跳过");
});

test("非 GET 请求带 Sec-Fetch-Site: same-origin，且不自带 Origin", () => {
    const src = stripComments(read(SYNC));
    assert.match(src, /Sec-Fetch-Site/, "写请求没有声明 Sec-Fetch-Site（同源判据收紧后必 403）");
    assert.match(src, /"same-origin"/, "Sec-Fetch-Site 的值不是 same-origin");
    // ⚠️ 带了 Origin 就走 host 比对，脚本的 host 与站点不一致 → 必被 CSRF 闸门拦下
    assert.doesNotMatch(src, /headers\[?\.?\s*"?Origin"?\]?\s*=/, "不要给请求加 Origin 头");
});

test("写请求不重试（/api/import 先插入后删旧，重来一批就是重复行）", () => {
    const src = stripComments(read(SYNC));
    const writeBody = src.slice(src.indexOf("async function writeJson"), src.indexOf("async function reconcile"));
    assert.doesNotMatch(writeBody, /RETRIES/, "writeJson 里出现了重试逻辑");
    // 重试只属于读：读是幂等的，跨境链路抖一下重试是安全的
    const readBody = src.slice(src.indexOf("async function readJson"), src.indexOf("async function writeJson"));
    assert.match(readBody, /READ_RETRIES/, "读接口应当带重试");
});

test("失败与「前置条件不满足」用不同退出码，便于定时任务区分告警", () => {
    const src = stripComments(read(SYNC));
    assert.match(src, /process\.exit\(1\)/, "同步失败应当退出 1");
    assert.match(src, /process\.exit\(2\)/, "前置条件不满足应当退出 2");
    // 退出码是给定时任务看的，人得在同一份输出里看到原因 —— 只有码没有话等于没法排查
    assert.match(src, /console\.error/, "退出前应当打印人话原因");
});

test("状态文件写进 .gitignore（它含两端地址，且不该被当成源码改动）", () => {
    const gitignore = read(".gitignore");
    assert.match(gitignore, /mirror-sync-state\.json/, ".gitignore 没有忽略同步状态文件");
});
