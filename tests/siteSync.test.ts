// tests/siteSync.test.ts
// 卡片侧同步的本地状态（utils/siteSync.ts）：游标持久化 + 本设备删除记录。
//
// 修的背景（2026-10-18 用户报「每次刷新都弹『其它设备删除了 N 张卡片，已同步』」）：
//   - 游标原来只在内存 ref 里，刷新后首轮 since 为空 → 后端把 site_tombstone
//     全量倒回来 → 历史删除被当成刚发生的，每次刷新弹一遍；
//   - 本设备自己删的也会在下一轮轮询里命中窗口，弹一条误导的「其它设备删除了」。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    loadLocalSiteDeletes,
    loadSiteSyncCursor,
    markLocalSiteDeletes,
    saveSiteSyncCursor,
} from "../src/utils/siteSync";
import { setActiveAccount, clearActiveAccount } from "../src/utils/accountScope";

beforeEach(() => {
    globalThis.localStorage?.clear();
    clearActiveAccount();
});

test("游标存取：写入后读回，未写过是空串", () => {
    assert.equal(loadSiteSyncCursor(), "", "初始为空");
    saveSiteSyncCursor("2026-01-01 00:00:01");
    assert.equal(loadSiteSyncCursor(), "2026-01-01 00:00:01");
});

test("游标按账号隔离：换账号读不到对方的游标", () => {
    setActiveAccount(1);
    saveSiteSyncCursor("2026-01-01 00:00:01");
    setActiveAccount(2);
    assert.equal(loadSiteSyncCursor(), "", "账号 2 不应读到账号 1 的游标");
    saveSiteSyncCursor("2026-02-02 00:00:02");
    setActiveAccount(1);
    assert.equal(loadSiteSyncCursor(), "2026-01-01 00:00:01", "切回账号 1 游标还在");
});

test("本设备删除记录：标记后可读出，未标记的 id 不在里面", () => {
    markLocalSiteDeletes([7, 8]);
    const ids = loadLocalSiteDeletes();
    assert.ok(ids.includes(7) && ids.includes(8));
    assert.ok(!ids.includes(9), "没标记的 id 不应出现");
});

test("本设备删除记录带 24h 保质期：过期条目被清掉", () => {
    // 直写过期时间戳（loadLocalSiteDeletes 会顺手清理过期条目）
    const key = `navihive:siteLocalDeletes:anon`;
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    globalThis.localStorage?.setItem(key, JSON.stringify({ "3": stale, "4": Date.now() }));
    const ids = loadLocalSiteDeletes();
    assert.ok(!ids.includes(3), "过期条目不应再返回");
    assert.ok(ids.includes(4), "未过期的仍在");
    // 清理要落盘：再读一次，过期条目不复活
    assert.deepEqual(loadLocalSiteDeletes(), [4]);
});

test("删除记录同样按账号隔离", () => {
    setActiveAccount(1);
    markLocalSiteDeletes([7]);
    setActiveAccount(2);
    assert.deepEqual(loadLocalSiteDeletes(), [], "账号 2 不应读到账号 1 的删除记录");
});
