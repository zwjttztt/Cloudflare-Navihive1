// tests/visitTime.test.ts
// 「最近访问」统计窗口的纯计算。这里唯一容易错的是**窗口边界**：
// 「最近 7 天」是含今天的 7 个自然日，多算一天少算一天都不会报错，
// 只会让「最近访问」里莫名其妙多出/少掉几个站，很难被发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { recentVisitCount, RECENT_WINDOW_DAYS } from "../src/utils/time";

const DAY = 86400000;

/** 今天 00:00 的时间戳（用本地时区，和被测函数一致） */
function todayStart(): number {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 相对今天偏移 n 天的日期键（yyyy-m-d，与库里存的格式一致） */
function dayKey(offset: number): string {
    const d = new Date(todayStart() + offset * DAY);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

test("没有统计记录：算 0，不炸", () => {
    assert.equal(recentVisitCount(undefined), 0);
    assert.equal(recentVisitCount({}), 0);
});

test("窗口内的按天明细会被累加", () => {
    const stat = {
        count: 10,
        last: Date.now(),
        days: { [dayKey(0)]: 3, [dayKey(-1)]: 2, [dayKey(-3)]: 5 },
    };
    assert.equal(recentVisitCount(stat), 10, "0/-1/-3 三天都在 7 天窗口内");
});

test("窗口外的按天明细不算（这就是「最近 7 天」的含义）", () => {
    const stat = {
        count: 99,
        last: Date.now(),
        // -6 在窗口内（含今天共 7 天），-7 及更早超出
        days: { [dayKey(-6)]: 4, [dayKey(-7)]: 100, [dayKey(-30)]: 100 },
    };
    assert.equal(recentVisitCount(stat), 4, "第 8 天起的访问不该进「最近访问」");
});

test("窗口边界：第 7 天算、第 8 天不算（含今天的 7 个自然日）", () => {
    assert.equal(recentVisitCount({ days: { [dayKey(-(RECENT_WINDOW_DAYS - 1))]: 7 } }), 7);
    assert.equal(recentVisitCount({ days: { [dayKey(-RECENT_WINDOW_DAYS)]: 7 } }), 0);
});

test("未来日期（时钟被改过 / 脏数据）也算进窗口", () => {
    // 用 >= 而不是两端夹逼：未来的键不该被静默丢掉，否则用户改回时间后统计会乱
    assert.equal(recentVisitCount({ days: { [dayKey(2)]: 5 } }), 5);
});

test("老记录没有按天明细：按 last 兜底，避免升级后统计直接归零", () => {
    assert.equal(
        recentVisitCount({ count: 8, last: Date.now() }),
        8,
        "最近访问过 → 保留总次数"
    );
    assert.equal(
        recentVisitCount({ count: 8, last: todayStart() - 30 * DAY }),
        0,
        "最后一次访问是一个月前 → 归 0"
    );
});

test("有按天明细时不再用 count 兜底（两者不一致以明细为准）", () => {
    // 这是最容易写反的一处：明细和 count 对不上时，如果还拿 count 兜底，
    // 卡片会被算进「最近访问」，但它其实一整周都没点过
    const stat = { count: 100, last: Date.now(), days: { [dayKey(-30)]: 1 } };
    assert.equal(recentVisitCount(stat), 0);
});

test("按天明细里有脏键：跳过而不是把窗口算成 NaN", () => {
    const stat = {
        count: 3,
        last: Date.now(),
        days: { "": 5, "abc": 5, "2026": 5, [dayKey(0)]: 3 },
    };
    assert.equal(recentVisitCount(stat), 3, "只有合法的日期键被累加");
    assert.ok(Number.isFinite(recentVisitCount(stat)));
});

test("按天明细里日期为 0 的键：跳过，不许被 Date 折算成上个月末", () => {
    // `new Date(y, m, 0)` 会被 JS 折成「上个月的最后一天」——看起来是个合法日期，
    // 于是「2026-10-0」这种脏数据会被当成有效访问算进窗口。守卫必须拦掉。
    // 窗口放宽到 100 天，保证折算出来的日期一定落在窗口里，这样才测得出来。
    const d = new Date(todayStart());
    const zeroDayKey = `${d.getFullYear()}-${d.getMonth() + 1}-0`;
    const stat = { count: 9, last: Date.now(), days: { [zeroDayKey]: 5, [dayKey(0)]: 1 } };
    assert.equal(recentVisitCount(stat, 100), 1, "日期为 0 的键必须被跳过");
});

test("自定义窗口天数生效", () => {
    const stat = { days: { [dayKey(-2)]: 1, [dayKey(-5)]: 1 } };
    assert.equal(recentVisitCount(stat, 3), 1, "3 天窗口只留 -2");
    assert.equal(recentVisitCount(stat, 7), 2);
});
