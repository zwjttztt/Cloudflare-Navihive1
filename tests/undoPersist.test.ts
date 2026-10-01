// tests/undoPersist.test.ts
// 撤销栈的跨刷新保留。
// 重点是「别把不该留的留下来、别把脏数据写回去」：
// 过期的要作废、坏形状的要丢弃、卡片已经不在了就不能再重建那一步撤销。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    clearPersistedUndo,
    isPersistedUndo,
    loadPersistedUndo,
    savePersistedUndo,
    setUndoAccountUid,
    type PersistedUndo,
} from "../src/utils/undoPersist";
import { HistoryStack } from "../src/utils/historyStack";
import { scopedKey } from "../src/utils/accountScope";
import type { Site } from "../src/API/http";

// 撤销快照按账号分片存放：没绑定账号时落在 anon 这一档
const KEY = scopedKey("navihive:persistedUndo", null);

// node 环境没有 localStorage：给一个够用的内存替身
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
        return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value),
} as Storage;

const site = (over: Partial<Site> = {}): Site => ({
    id: 1,
    group_id: 1,
    name: "A",
    url: "https://a.example",
    icon: "",
    description: "",
    notes: "",
    username: "",
    password: "",
    order_num: 0,
    ...over,
});

const undoItem = (over: Partial<PersistedUndo> = {}): PersistedUndo => ({
    kind: "site-edit",
    label: "修改「A」",
    at: Date.now(),
    siteId: 1,
    before: site({ name: "改之前" }),
    after: site({ name: "改之后" }),
    ...over,
});

test("存进去再读出来：往返一致", () => {
    clearPersistedUndo();
    const item = undoItem();
    savePersistedUndo([item]);
    const loaded = loadPersistedUndo();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].siteId, 1);
    assert.equal(loaded[0].before.name, "改之前");
});

test("超过一天的记录作废", () => {
    clearPersistedUndo();
    savePersistedUndo([undoItem({ at: Date.now() - 25 * 60 * 60 * 1000 })]);
    assert.equal(loadPersistedUndo().length, 0);
});

test("形状不对的记录丢弃（坏数据不能变成一步撤销）", () => {
    clearPersistedUndo();
    store.set(
        KEY,
        JSON.stringify([{ kind: "site-edit" }, null, "x", { kind: "delete", siteId: 1 }])
    );
    assert.equal(loadPersistedUndo().length, 0);

    // 缺了 before/after 的也不算数
    assert.equal(isPersistedUndo({ kind: "site-edit", siteId: 1, at: Date.now() }), false);
});

test("只留最近 10 步，多出来的丢最旧的", () => {
    clearPersistedUndo();
    const list = Array.from({ length: 13 }, (_, i) => undoItem({ siteId: i + 1 }));
    savePersistedUndo(list);
    const loaded = loadPersistedUndo();
    assert.equal(loaded.length, 10);
    assert.equal(loaded[0].siteId, 4, "最旧的三步被丢掉");
    assert.equal(loaded[9].siteId, 13);
});

test("存的是空列表：清掉键，不留空数组", () => {
    savePersistedUndo([undoItem()]);
    assert.equal(store.has(KEY), true);
    savePersistedUndo([]);
    assert.equal(store.has(KEY), false);
});

test("换账号后读不到上一个人的撤销快照", () => {
    clearPersistedUndo();
    savePersistedUndo([undoItem({ siteId: 1 })]);
    setUndoAccountUid(7);
    try {
        assert.equal(loadPersistedUndo().length, 0, "别人的撤销不该被读出来");
        savePersistedUndo([undoItem({ siteId: 2 })]);
        assert.equal(loadPersistedUndo()[0].siteId, 2);
    } finally {
        setUndoAccountUid(null);
        clearPersistedUndo();
    }
});

test("落盘前抹掉站点凭据：密码不写进 localStorage", () => {
    clearPersistedUndo();
    savePersistedUndo([
        undoItem({
            before: site({ name: "改之前", username: "u1", password: "p1" }),
            after: site({ name: "改之后", username: "u2", password: "p2" }),
        }),
    ]);
    const raw = store.get(KEY) ?? "";
    assert.equal(raw.includes("p1"), false, "旧密码不得出现在存储里");
    assert.equal(raw.includes("p2"), false, "新密码不得出现在存储里");
    assert.equal(loadPersistedUndo()[0].before.username, "", "账号名一并抹掉");
});

test("栈里带 persist 的才算可保留，撤销/重做要跟着同步", async () => {
    const stack = new HistoryStack();
    const persisted = undoItem({ siteId: 7 });

    stack.push({ label: "删除（不保留）", undo: async () => {}, redo: async () => {} });
    stack.push({
        label: "修改（跨刷新保留）",
        undo: async () => {},
        redo: async () => {},
        persist: persisted,
    });

    assert.deepEqual(
        stack.persistable.map(item => item.siteId),
        [7],
        "只有给了 persist 的那一步会留下"
    );

    await stack.undo(); // 撤销掉「修改」
    // 注意别写 deepEqual(stack.persistable, []) —— node:assert 的签名是
    // `asserts actual is T`，会把 persistable 收窄成 never[]，下面的 item.siteId 就取不到了
    assert.equal(stack.persistable.length, 0, "撤销之后这一步不该还留在待办里");

    await stack.redo();
    assert.deepEqual(
        stack.persistable.map(item => item.siteId),
        [7],
        "重做之后要回到待办里"
    );
});

test("hydrate：能重放的压回栈，卡片已经不在的跳过", async () => {
    const stack = new HistoryStack();
    const count = stack.hydrate(
        [undoItem({ siteId: 1 }), undoItem({ siteId: 2 })],
        item => (item.siteId === 2 ? null : { label: item.label, undo: async () => {}, redo: async () => {} })
    );

    assert.equal(count, 1);
    assert.equal(stack.undoDepth, 1);
    assert.equal((await stack.undo()) !== null, true);
});

test("hydrate 出来的那一步仍然可继续持久化（刷新两次也不丢）", async () => {
    const stack = new HistoryStack();
    const item = undoItem({ siteId: 3 });
    stack.hydrate([item], persisted => ({
        label: persisted.label,
        undo: async () => {},
        redo: async () => {},
        persist: persisted,
    }));
    assert.deepEqual(
        stack.persistable.map(entry => entry.siteId),
        [3]
    );
});
