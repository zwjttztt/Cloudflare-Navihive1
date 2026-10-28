// tests/systemUpgradeAudit.test.ts
// POST /api/system/upgrade 的审计：判定表 + 落库行为 + 接线（entry.ts 里真的调了）。
//
// 为什么分两层测：
//   端点本身跑在 server/entry.ts 里，而那个文件「一 import 就拉起 HTTP 服务」
//   （顶层 await + createServer），并且升级要真 Docker daemon —— 在这里造集成测试
//   只能造出一堆假容器，考验的是桩子而不是产品。所以：
//     ① 判定与文案抽成 server/upgradeAudit.ts 的纯函数，逐格钉死（本文件前半）；
//     ② entry.ts 的接线用源码守卫钉（后半）—— 保证纯函数不是「写了但没人调」。
//   同一套路见 tests/systemUpgradeGuard.test.ts（它钉的是「别自己 stop 容器」那些不变量）。
//
// 事故背景（2026-10-28 真实发生）：v17.0.0 发布后 navihive-upgrader 在 13:58:36
// 重建了容器，镜像对、重建成功、healthy —— 但 audit_log 里没有任何记录，
// 「谁、什么时候、从哪个 IP 换掉的生产容器」事后查不到。这组用例就是钉住这件事不再发生。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
    decideUpgradeAudit,
    recordUpgradeAudit,
    UPGRADE_ACTION,
    UPGRADE_DENIED_ACTION,
    UPGRADE_FAILED_ACTION,
    type UpgradeOutcome,
} from "../server/upgradeAudit";
import { actionLabel } from "../src/utils/auditActionLabels";

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
    throw new Error("找不到项目根目录（6 层内没有 package.json）");
}

/** 剥注释：守卫断言不能被自己写的说明文字骗过去 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const readSrc = (rel: string) => stripComments(readFileSync(resolve(projectDir(), rel), "utf8"));

/** 收集写入记录的假 writer —— 用例靠它断言「写了什么」与「有没有写」 */
function collector() {
    const writes: Array<{ action: string; actor: string; ip: string; detail: string }> = [];
    return {
        writes,
        write: async (action: string, actor: string, ip: string, detail: string): Promise<void> => {
            writes.push({ action, actor, ip, detail });
        },
    };
}

const IMAGE = "ghcr.io/example/navihive:latest";
const IP = "203.0.113.9";

// ============ 一、该记的：受理 ============

test("受理（spool）：落一条 system-upgrade，actor 是 owner，detail 带镜像与触发方式", async () => {
    const { writes, write } = collector();
    const wrote = await recordUpgradeAudit({ kind: "accepted", trigger: "spool", image: IMAGE }, IP, write);

    assert.equal(wrote, true, "受理时必须真的写了一条");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].action, "system-upgrade");
    assert.equal(writes[0].actor, "owner", "actor 用角色：能过闸的只有 owner，写角色改名也不用回改历史");
    assert.equal(writes[0].ip, IP, "来源 IP 必须落库 —— 事故复盘第一个要的就是它");
    assert.match(writes[0].detail, /ghcr\.io\/example\/navihive:latest/, "detail 要带镜像名");
    assert.match(writes[0].detail, /spool/, "detail 要能看出是交给升级器执行的");
});

test("受理（docker-api）：同一条动作名，detail 里能区分触发方式", async () => {
    const { writes, write } = collector();
    await recordUpgradeAudit({ kind: "accepted", trigger: "docker-api", image: IMAGE }, IP, write);

    assert.equal(writes.length, 1);
    // 动作名必须一致：两种触发方式在「审计流水」里是同一件事，
    // 分成两个动作会让标签表和统计各裂一份
    assert.equal(writes[0].action, UPGRADE_ACTION);
    assert.match(writes[0].detail, /docker-api/);
    assert.doesNotMatch(writes[0].detail, /spool/, "两种触发方式不能混在一句话里");
});

test("受理时 ip 为空也不炸（直连取不到对端时 audit 的 ip 列可以是空串）", async () => {
    const { writes, write } = collector();
    const wrote = await recordUpgradeAudit({ kind: "accepted", trigger: "spool", image: IMAGE }, "", write);

    assert.equal(wrote, true);
    assert.equal(writes[0].ip, "");
});

// ============ 二、该记的：提交失败 / 越权 ============

test("提交失败：落 system-upgrade.failed，带上 spool 的报错原因", async () => {
    const { writes, write } = collector();
    const wrote = await recordUpgradeAudit(
        { kind: "submit-failed", image: IMAGE, message: "EACCES: permission denied, open '/spool/upgrade.request'" },
        IP,
        write
    );

    assert.equal(wrote, true);
    assert.equal(writes[0].action, "system-upgrade.failed");
    assert.match(writes[0].detail, /EACCES/, "失败原因要进 detail，否则「点了升级没反应」还是查不到");
    assert.match(writes[0].detail, /ghcr\.io/, "镜像名也要留着");
});

test("已登录的非 owner：落 system-upgrade.denied，actor 是那个账号名", async () => {
    const { writes, write } = collector();
    const wrote = await recordUpgradeAudit({ kind: "denied", username: "alice", role: "user" }, IP, write);

    assert.equal(wrote, true);
    assert.equal(writes[0].action, "system-upgrade.denied");
    assert.equal(writes[0].actor, "alice", "越权尝试要记到人头上，不能只记个 owner");
    assert.match(writes[0].detail, /user/, "detail 里要留角色，便于判断是哪种账号在试");
});

test("非 owner 但账号名取不到：actor 兜底成 unknown，不写空字符串", async () => {
    const entry = decideUpgradeAudit({ kind: "denied", username: "", role: "user" });
    assert.ok(entry, "越权尝试即使拿不到账号名也要留痕");
    assert.equal(entry.actor, "unknown", "空 actor 会让审计流水那一列看起来像「系统」做的");
});

// ============ 三、不记的（这是判断，不是遗漏，理由写在 decideUpgradeAudit 里） ============

test("匿名请求（盲扫 / 令牌过期）：不写审计 —— 零变更的噪声会把真变更挤没", async () => {
    const { writes, write } = collector();
    const wrote = await recordUpgradeAudit({ kind: "anonymous" }, IP, write);

    assert.equal(wrote, false);
    assert.equal(writes.length, 0, "一次盲扫就能刷一屏 403，不该进审计表");
});

test("这个部署不支持网页升级（501）：不写审计 —— 它是部署形态的静态事实，不是变更", async () => {
    const { writes, write } = collector();
    const wrote = await recordUpgradeAudit({ kind: "unsupported", image: IMAGE }, IP, write);

    assert.equal(wrote, false);
    assert.equal(writes.length, 0, "没挂 docker.sock 这件事明天再点还是同一条，记它只会让流水显示「升级天天失败」");
});

test("判定函数本身对两种「不记」返回 null（不依赖 recordUpgradeAudit 的实现）", () => {
    assert.equal(decideUpgradeAudit({ kind: "anonymous" }), null);
    assert.equal(decideUpgradeAudit({ kind: "unsupported", image: IMAGE }), null);
    // 反向确认：该记的三种都不是 null（否则上面那些断言会因为「全都返回 null」而假绿）
    const outcomes: UpgradeOutcome[] = [
        { kind: "accepted", trigger: "spool", image: IMAGE },
        { kind: "submit-failed", image: IMAGE, message: "boom" },
        { kind: "denied", username: "alice", role: "user" },
    ];
    for (const outcome of outcomes) {
        assert.notEqual(decideUpgradeAudit(outcome), null, `${outcome.kind} 应该落审计`);
    }
});

// ============ 四、审计写失败不能反过来搞挂升级 ============

test("writer 抛异常：recordUpgradeAudit 不往上抛，返回 false", async () => {
    const originalWarn = console.warn;
    let warned = 0;
    console.warn = () => {
        warned++;
    };
    try {
        const threw = await recordUpgradeAudit({ kind: "accepted", trigger: "spool", image: IMAGE }, IP, async () => {
            throw new Error("D1_ERROR: database is locked");
        });
        assert.equal(threw, false, "写失败返回 false，供调用方区分");
        assert.equal(warned, 1, "失败要留一行 warn（不能彻底静默）");
    } finally {
        console.warn = originalWarn;
    }
});

test("writer 返回 rejected promise（不是同步 throw）同样被吞掉", async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        await assert.doesNotReject(async () => {
            await recordUpgradeAudit({ kind: "denied", username: "alice", role: "user" }, IP, () =>
                Promise.reject(new Error("no such table: audit_log"))
            );
        });
    } finally {
        console.warn = originalWarn;
    }
});

// ============ 五、detail 的形状：一句话，不撑爆审计流水 ============

test("detail 压成单行", async () => {
    const { writes, write } = collector();
    await recordUpgradeAudit(
        { kind: "submit-failed", image: IMAGE, message: "line1\n\tline2\r\nline3" },
        IP,
        write
    );

    assert.doesNotMatch(writes[0].detail, /[\r\n\t]/, "detail 是对话框里的一句话，不能带换行");
    assert.match(writes[0].detail, /line1 line2 line3/);
});

test("detail 超长要截断（spool 报错可能带一长串路径）", async () => {
    const { writes, write } = collector();
    await recordUpgradeAudit({ kind: "submit-failed", image: IMAGE, message: "x".repeat(5000) }, IP, write);

    assert.ok(writes[0].detail.length <= 201, `detail 应该被截到 200 字符上下，实际 ${writes[0].detail.length}`);
    assert.match(writes[0].detail, /…$/, "截断要有可见的省略号，让人知道去看日志");
});

// ============ 六、标签表（审计流水里显示成中文，而不是 system-upgrade） ============

test("三个动作名都有中文标签（否则 owner 在审计流水里看到的是原始键）", () => {
    assert.equal(actionLabel(UPGRADE_ACTION), "网页触发升级");
    assert.equal(actionLabel(UPGRADE_FAILED_ACTION), "升级提交失败");
    assert.equal(actionLabel(UPGRADE_DENIED_ACTION), "越权尝试升级");
    // 反向确认标签表没被写坏（未登记的动作名仍原样返回是既定行为）
    assert.equal(actionLabel("no-such-action"), "no-such-action");
});

// ============ 七、接线：entry.ts 真的调了它们（防止「纯函数写了没人用」） ============

test("entry.ts：五个结论各接一次，且落库只走 writeAudit（不自己拼 SQL）", () => {
    const src = readSrc("server/entry.ts");

    assert.match(src, /import \{ recordUpgradeAudit, type UpgradeOutcome \} from "\.\/upgradeAudit"/, "要引判定模块");
    assert.match(src, /new NavigationAPI\(serverEnv\)\.writeAudit\(/, "落库走 worker 的 writeAudit（唯一写入口）");
    assert.doesNotMatch(src, /INSERT INTO audit_log/, "entry.ts 不得自己拼 SQL 写审计表");

    const count = (needle: string) => src.split(needle).length - 1;
    assert.equal(count('kind: "accepted"'), 2, "两条受理路径（spool / docker-api）各要落一条");
    assert.equal(count('kind: "submit-failed"'), 1, "提交失败要落一条");
    assert.equal(count('kind: "denied"'), 1, "越权尝试要落一条");
    assert.equal(count('kind: "anonymous"'), 1, "匿名的判定也要显式走一遍（决定权在判定模块）");
    assert.equal(count('kind: "unsupported"'), 1, "501 的判定同样显式走一遍");
});

test("entry.ts：审计写在响应之前（容器随时会被换掉，不能留「升级成功但审计丢了」的窗口）", () => {
    const src = readSrc("server/entry.ts");
    const at = src.indexOf('pathname === "/api/system/upgrade" && method === "POST"');
    assert.ok(at > 0, "找不到升级端点");
    const block = src.slice(at, at + 7000);

    // ① 403 之前已经写过（越权那条）
    const deniedAt = block.indexOf('kind: "denied"');
    const forbiddenAt = block.indexOf("res.writeHead(403");
    assert.ok(deniedAt > 0 && forbiddenAt > deniedAt, "越权审计要在 403 响应之前落库");

    // ② spool 受理的审计要在第一个 200 之前
    const acceptedAt = block.indexOf('kind: "accepted"');
    const okAt = block.indexOf("res.writeHead(200");
    assert.ok(acceptedAt > 0 && okAt > acceptedAt, "受理审计要在 200 响应之前落库（且要 await 它）");

    // ③ 必须 await：写成 void / 不 await 的话进程被换掉时这条就丢了
    assert.match(block, /await writeUpgradeAudit\(/, "审计必须 await 完再响应");
    assert.doesNotMatch(block, /void writeUpgradeAudit\(/, "审计不能 fire-and-forget");
});
