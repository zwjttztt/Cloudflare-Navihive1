// tests/cronFailure.test.ts
// 定时任务失败的留痕：失败要写下来给页面看，成功要把上一次的提示撤掉。
//
// 这类 bug 的特点是不报错、不崩溃，只是「悄悄没干成」——等发现时已经连着失败几个月，
// 所以断言的重点是「留痕真的落到了库里」以及「留痕本身出错不能把任务搞挂」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWeeklyBackup, runLinkSweep, type SchedulerDB } from "../worker/cron";
import { CRON_LAST_ERROR_KEY } from "../src/API/http";

interface Recorder {
    api: SchedulerDB;
    /** 写进 configs 的（键 -> 值） */
    written: Map<string, string>;
    /** 被删掉的键 */
    deleted: string[];
    /** 写进审计日志的 action */
    audits: string[];
}

/** 只实现了定时任务真正用到的那几个方法的假库，不发网络请求、不碰 D1 */
function makeRecorder(overrides: {
    getConfig?: (key: string) => Promise<string | null>;
    getSites?: () => Promise<never[]>;
    /** 备份任务读的是整份配置（readAllConfigs），不是单个键 */
    getConfigs?: () => Promise<Record<string, string>>;
} = {}): Recorder {
    const written = new Map<string, string>();
    const deleted: string[] = [];
    const audits: string[] = [];

    const api = {
        async getConfig(key: string) {
            if (overrides.getConfig) return overrides.getConfig(key);
            return null;
        },
        async getSites() {
            if (overrides.getSites) return overrides.getSites();
            return [];
        },
        async setConfig(_key: string, _value: string) {
            return true;
        },
        async getConfigs() {
            // 默认「没配 WebDAV」→ 备份任务会跳过；要造失败就靠 overrides 覆盖
            return overrides.getConfigs ? overrides.getConfigs() : {};
        },
        async listUsers() {
            return [{ id: 1, username: "u", role: "owner", status: "active" }];
        },
        setCurrentUser(_uid: number | null) {
            /* 定时任务靠它切换账号视图，这里不需要真的切 */
        },
        async writeAudit(action: string) {
            audits.push(action);
        },
        async setSystemConfig(key: string, value: string) {
            written.set(key, value);
            return true;
        },
        async deleteSystemConfig(key: string) {
            deleted.push(key);
            return true;
        },
    };

    return { api: api as unknown as SchedulerDB, written, deleted, audits };
}

test("自动备份失败：写 cron.lastError.backup + 审计留痕", async () => {
    const rec = makeRecorder({
        // 配了一个连不上的网盘地址（本机端口 1，且本机地址本来就在出站黑名单里）：
        // 备份必然失败，同时不会真的往外网发请求
        getConfigs: async () => ({ "webdav.url": "http://127.0.0.1:1/webdav" }),
    });

    await runWeeklyBackup(rec.api);

    const raw = rec.written.get(`${CRON_LAST_ERROR_KEY}.backup`);
    assert.ok(raw, "失败后必须留下 cron.lastError.backup");
    const parsed = JSON.parse(raw as string);
    assert.equal(parsed.task, "backup");
    assert.ok(parsed.message, "失败原因要写进留痕");
    assert.ok(parsed.at);
    assert.ok(rec.audits.includes("cron.backup.failed"), "审计日志里要有这条失败");
});

test("自动备份没配置 / 跳过：撤掉上一次的失败提示", async () => {
    // 没配 WebDAV（getConfig 一律返回 null）→ 直接跳过，不算失败
    const rec = makeRecorder();
    await runWeeklyBackup(rec.api);

    assert.equal(rec.written.size, 0, "没失败就不该写失败留痕");
    assert.ok(
        rec.deleted.includes(`${CRON_LAST_ERROR_KEY}.backup`),
        "跑过一轮没失败就该把旧提示清掉"
    );
});

test("死链巡检异常：按任务分键留痕，不跟备份的混在一起", async () => {
    const rec = makeRecorder({
        getSites: async () => {
            throw new Error("探测超时");
        },
    });

    await runLinkSweep(rec.api);

    assert.ok(rec.written.has(`${CRON_LAST_ERROR_KEY}.linkSweep`));
    assert.ok(!rec.written.has(`${CRON_LAST_ERROR_KEY}.backup`), "巡检失败不该动备份那条");
    const parsed = JSON.parse(rec.written.get(`${CRON_LAST_ERROR_KEY}.linkSweep`) as string);
    assert.match(parsed.message, /探测超时/);
});

test("巡检正常：清掉巡检那条失败提示（不影响备份那条）", async () => {
    const rec = makeRecorder();
    await runLinkSweep(rec.api);

    assert.ok(rec.deleted.includes(`${CRON_LAST_ERROR_KEY}.linkSweep`));
    assert.ok(!rec.deleted.includes(`${CRON_LAST_ERROR_KEY}.backup`));
});

test("库里没有留痕所需的方法（验证脚本的假实现）：任务照跑，不抛错", async () => {
    const bare = {
        async getConfig() {
            return null;
        },
        async getSites() {
            return [];
        },
        async setConfig() {
            return true;
        },
        // 没有 listUsers / setCurrentUser / getConfigs：备份要退回「单账号」的旧行为，
        // 不能因为取不到账号列表就整个崩掉（外层只会记一行 console，任务等于没跑）
    } as unknown as SchedulerDB;

    // 两个任务都不该因为「写不进留痕」而失败
    await assert.doesNotReject(() => runWeeklyBackup(bare));
    await assert.doesNotReject(() => runLinkSweep(bare));
});
