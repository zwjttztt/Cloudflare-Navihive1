// tests/bulkActions.dom.test.tsx
// 批量动作（useBulkActions）与标签操作（useTagOpsActions）的胶水层用例。
//
// 纯计算（排序号、只搬成功的那批、删标签影响谁）在 tests/bulkOps.test.ts，
// 这里盯的是**只有把 hook 跑起来才看得到**的几件事：
//
// 1. **空勾选不该有任何动作** —— 什么都没选点「加星」，既不该弹提示也不该发请求，
//    否则用户以为操作成功了。
// 2. **批量移动失败要报错，且界面一个都不动** —— 库里没动、界面先动是最糟的谎言。
// 3. **改/删标签后筛选条件要跟着换** —— 否则瞬间筛出一片空白，看着像数据丢了。
// 4. **撤销要把整份标签表原样写回** —— 比逐条反算可靠得多。
//
// 这些都是破坏性且不可逆的操作，撤销栈有网，但触发撤销的那一步此前没网。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useBulkActions } from "../src/hooks/useBulkActions";
import { useTagOpsActions } from "../src/hooks/useTagOpsActions";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const site = (id: number, group_id: number, order_num: number): Site =>
    ({ id, group_id, order_num, name: `s${id}`, url: `https://${id}.example.com` }) as Site;

// ---------- 记录 ----------

interface Log {
    starred: Array<{ ids: number[]; starred: boolean }>;
    addedTags: Array<{ ids: number[]; tags: string[] }>;
    removedTags: string[];
    orderCalls: Array<{ id: number; order_num: number; group_id?: number }[]>;
    groupSnapshots: GroupWithSites[][];
    deleted: number[][];
    notices: string[];
    errors: string[];
    tagWrites: Array<Record<string, string[]>>;
    activeTags: string[][];
}

function emptyLog(): Log {
    return {
        starred: [],
        addedTags: [],
        removedTags: [],
        orderCalls: [],
        groupSnapshots: [],
        deleted: [],
        notices: [],
        errors: [],
        tagWrites: [],
        activeTags: [],
    };
}

interface Options {
    selected?: number[];
    /** updateSiteOrder 的返回；failed 用来模拟「一批里失败几条」 */
    moveResult?: { updated: number[]; failed: number[] };
    moveThrows?: boolean;
    initialTags?: Record<string, string[]>;
    initialActiveTags?: string[];
}

// ---------- 宿主 ----------

function Harness(props: { o: Options; log: Log }) {
    const { o, log } = props;
    const [groups, setGroups] = useState<GroupWithSites[]>([
        { id: 1, name: "A", order_num: 0, sites: [site(1, 1, 0), site(2, 1, 1)] } as GroupWithSites,
        { id: 2, name: "B", order_num: 1, sites: [site(3, 2, 0)] } as GroupWithSites,
    ]);
    const [tags] = useState<Record<string, string[]>>(o.initialTags ?? {});
    const [activeTags, setActiveTags] = useState<string[]>(o.initialActiveTags ?? []);
    const groupsRef = useRef(groups);
    groupsRef.current = groups;
    const cleared = useRef(0);

    const bulk = useBulkActions({
        selectedIds: o.selected ?? [],
        clearSelection: () => {
            cleared.current += 1;
        },
        groupsRef,
        tags,
        api: {
            updateSiteOrder: async orders => {
                log.orderCalls.push(orders);
                if (o.moveThrows) throw new Error("网络挂了");
                const r = o.moveResult ?? { updated: orders.map(x => x.id), failed: [] };
                return { success: r.failed.length === 0, ...r };
            },
        },
        setGroups: value => {
            setGroups(prev => {
                const next = typeof value === "function" ? value(prev) : value;
                log.groupSnapshots.push(next);
                return next;
            });
        },
        setActiveTags: value => {
            setActiveTags(prev => {
                const next = typeof value === "function" ? value(prev) : value;
                log.activeTags.push(next);
                return next;
            });
        },
        setStarredMany: (ids, starred) => {
            log.starred.push({ ids, starred });
        },
        addTagsToMany: (ids, next) => {
            log.addedTags.push({ ids, tags: next });
        },
        removeTagFromAll: tag => {
            log.removedTags.push(tag);
        },
        setBulkDeleteOpen: () => {},
        doSitesDelete: async ids => {
            log.deleted.push(ids);
        },
        notify: (message, _level, _ms, action) => {
            log.notices.push(message);
            if (action) undoAction = action.onClick;
        },
        handleError: message => {
            log.errors.push(message);
        },
    });

    const tagOps = useTagOpsActions({
        tags,
        applyTagOps: next => {
            log.tagWrites.push(next);
        },
        setActiveTags: value => {
            setActiveTags(prev => {
                const next = typeof value === "function" ? value(prev) : value;
                log.activeTags.push(next);
                return next;
            });
        },
        notify: (message, _level, _ms, action) => {
            log.notices.push(message);
            if (action) undoAction = action.onClick;
        },
    });

    bulkRef = bulk;
    tagOpsRef = tagOps;
    clearedRef = cleared;

    return (
        <div>
            <span data-testid='groups'>{JSON.stringify(groups.map(g => g.sites.map(s => s.id)))}</span>
            <span data-testid='activeTags'>{activeTags.join(",")}</span>
        </div>
    );
}

// notify 的第 4 个参数挂着「撤销」回调；这里把它捞出来给用例直接调
let undoAction: (() => void) | null = null;

let bulkRef: ReturnType<typeof useBulkActions> | null = null;
let tagOpsRef: ReturnType<typeof useTagOpsActions> | null = null;
let clearedRef: { current: number } = { current: 0 };

async function setup(o: Options = {}): Promise<Log> {
    const log = emptyLog();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<Harness o={o} log={log} />);
    });
    return log;
}

const text = (id: string): string => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    assert.ok(el, `应有 [data-testid="${id}"]`);
    return (el!.textContent || "").trim();
};

// ==================== 空勾选 ====================

test("没勾任何卡片：加星什么都不做（不该弹「已给 0 个网站加星」）", async () => {
    const log = await setup({ selected: [] });
    act(() => bulkRef!.bulkStar(true));
    assert.deepEqual(log.starred, []);
    assert.deepEqual(log.notices, []);
    cleanup();
});

test("没勾任何卡片：打标签什么都不做", async () => {
    const log = await setup({ selected: [] });
    act(() => bulkRef!.bulkTag(["常用"]));
    assert.deepEqual(log.addedTags, []);
    cleanup();
});

test("没勾任何卡片：移动连请求都不发", async () => {
    const log = await setup({ selected: [] });
    await act(async () => {
        await bulkRef!.bulkMove(2);
    });
    assert.deepEqual(log.orderCalls, []);
    cleanup();
});

// ==================== 加星 / 打标签 ====================

test("批量加星：一次改所有勾中的卡片", async () => {
    const log = await setup({ selected: [1, 2] });
    act(() => bulkRef!.bulkStar(true));
    assert.deepEqual(log.starred, [{ ids: [1, 2], starred: true }]);
    assert.ok(log.notices[0].includes("2 个"), `提示要说清改了几个：${log.notices[0]}`);
    cleanup();
});

test("批量打标签：追加式，一次改所有勾中的卡片", async () => {
    const log = await setup({ selected: [1, 2] });
    act(() => bulkRef!.bulkTag(["常用", "工具"]));
    assert.deepEqual(log.addedTags, [{ ids: [1, 2], tags: ["常用", "工具"] }]);
    cleanup();
});

// ==================== 批量移动 ====================

test("批量移动：请求里带上新分组与追加到末尾的排序号", async () => {
    const log = await setup({ selected: [1, 2] });
    await act(async () => {
        await bulkRef!.bulkMove(2);
    });
    assert.equal(log.orderCalls.length, 1);
    assert.deepEqual(log.orderCalls[0], [
        { id: 1, order_num: 1, group_id: 2 },
        { id: 2, order_num: 2, group_id: 2 },
    ]);
    cleanup();
});

test("批量移动：搬完界面跟着动（原分组少一张、目标分组多两张）", async () => {
    await setup({ selected: [1, 2] });
    await act(async () => {
        await bulkRef!.bulkMove(2);
    });
    assert.equal(text("groups"), "[[],[3,1,2]]");
    cleanup();
});

test("批量移动：一批里失败几条时只搬成功的，且提示说清楚", async () => {
    const log = await setup({ selected: [1, 2], moveResult: { updated: [1], failed: [2] } });
    await act(async () => {
        await bulkRef!.bulkMove(2);
    });
    assert.equal(
        text("groups"),
        "[[2],[3,1]]",
        "没成功的那张必须留在原组 —— 界面不能比库里多动"
    );
    assert.ok(
        log.notices.some(m => m.includes("1 个没成功")),
        `要说明有几个没成功：${log.notices.join(" | ")}`
    );
    cleanup();
});

test("批量移动：一个都没成功就报错，界面一个都不动", async () => {
    const log = await setup({ selected: [1, 2], moveResult: { updated: [], failed: [1, 2] } });
    await act(async () => {
        await bulkRef!.bulkMove(2);
    });
    assert.equal(text("groups"), "[[1,2],[3]]", "一个都没搬成就该原地不动");
    assert.deepEqual(log.groupSnapshots, [], "连快照都不该更新");
    assert.ok(log.errors.some(m => m.includes("批量移动站点失败")), "要报错");
    cleanup();
});

test("批量移动：请求抛异常也要有错误提示", async () => {
    const log = await setup({ selected: [1], moveThrows: true });
    await act(async () => {
        await bulkRef!.bulkMove(2);
    });
    assert.ok(log.errors.length > 0, "要给出错误提示");
    assert.equal(text("groups"), "[[1,2],[3]]");
    cleanup();
});

test("批量移动：目标分组不存在就直接返回（不发明一个分组）", async () => {
    const log = await setup({ selected: [1] });
    await act(async () => {
        await bulkRef!.bulkMove(999);
    });
    assert.deepEqual(log.orderCalls, []);
    cleanup();
});

// ==================== 批量删除 ====================

test("批量删除：先关确认框、清勾选，再执行删除", async () => {
    const log = await setup({ selected: [1, 2] });
    await act(async () => {
        await bulkRef!.bulkDelete();
    });
    assert.deepEqual(log.deleted, [[1, 2]]);
    assert.equal(clearedRef.current, 1, "删完要清掉勾选");
    cleanup();
});

test("批量删除：传的是勾选的快照（删的过程中勾选变了也不影响）", async () => {
    const log = await setup({ selected: [1] });
    await act(async () => {
        await bulkRef!.bulkDelete();
    });
    assert.deepEqual(log.deleted, [[1]]);
    cleanup();
});

// ==================== 删标签 ====================

test("删标签：从所有卡片上摘掉，并给一次撤销", async () => {
    const log = await setup({
        initialTags: { "1": ["常用", "工具"], "2": ["工具"] },
    });
    act(() => bulkRef!.deleteTagWithUndo("工具"));
    assert.deepEqual(log.removedTags, ["工具"]);
    // 撤销：把标签加回受影响的那两张卡片
    const undo = lastUndoAction();
    undo();
    assert.deepEqual(log.addedTags, [{ ids: [1, 2], tags: ["工具"] }]);
    cleanup();
});

test("删标签：正在用它筛选时，筛选项要一起去掉（否则瞬间筛出一片空白）", async () => {
    const log = await setup({
        initialTags: { "1": ["常用"] },
        initialActiveTags: ["常用", "AI"],
    });
    act(() => bulkRef!.deleteTagWithUndo("常用"));
    assert.deepEqual(log.activeTags, [["AI"]]);
    cleanup();
});

test("删标签：没有卡片用这个标签就什么都不做（不给没意义的撤销）", async () => {
    const log = await setup({ initialTags: { "1": ["常用"] } });
    act(() => bulkRef!.deleteTagWithUndo("没人在用"));
    assert.deepEqual(log.removedTags, []);
    assert.deepEqual(log.notices, []);
    cleanup();
});

// ==================== 标签改名 / 合并 ====================

test("改名：写回新表，并把筛选条件跟着换成新名字", async () => {
    const log = await setup({
        initialTags: { "1": ["旧名"] },
        initialActiveTags: ["旧名"],
    });
    const ok = tagOpsRef!.renameTagWithUndo("旧名", "新名");
    assert.equal(ok, true);
    assert.deepEqual(log.tagWrites, [{ "1": ["新名"] }]);
    assert.deepEqual(log.activeTags, [["新名"]]);
    cleanup();
});

test("改名：没有可改动的卡片就返回 false 且不写回", async () => {
    const log = await setup({ initialTags: { "1": ["常用"] } });
    const ok = tagOpsRef!.renameTagWithUndo("没这个标签", "新名");
    assert.equal(ok, false);
    assert.deepEqual(log.tagWrites, []);
    assert.ok(log.notices[0].includes("没有可改动"), "要说明为什么没改");
    cleanup();
});

test("改名后撤销：整份标签表原样写回（比逐条反算可靠）", async () => {
    const log = await setup({ initialTags: { "1": ["旧名"] } });
    tagOpsRef!.renameTagWithUndo("旧名", "新名");
    lastUndoAction()();
    assert.deepEqual(log.tagWrites[1], { "1": ["旧名"] }, "撤销要还原成改动前的整份表");
    cleanup();
});

test("合并：多个源标签并到目标，且给一次撤销", async () => {
    const log = await setup({
        initialTags: { "1": ["A"], "2": ["B"], "3": ["A", "B"] },
        initialActiveTags: ["A"],
    });
    const ok = tagOpsRef!.mergeTagsWithUndo(["A", "B"], "AB");
    assert.equal(ok, true);
    assert.deepEqual(log.tagWrites, [{ "1": ["AB"], "2": ["AB"], "3": ["AB"] }]);
    assert.deepEqual(log.activeTags, [["AB"]], "筛选项要跟着指向新名字");
    cleanup();
});

test("合并：撤销要还原成合并前的整份表", async () => {
    const log = await setup({ initialTags: { "1": ["A"], "2": ["B"] } });
    tagOpsRef!.mergeTagsWithUndo(["A", "B"], "AB");
    lastUndoAction()();
    assert.deepEqual(log.tagWrites[1], { "1": ["A"], "2": ["B"] });
    cleanup();
});

// ---------- 撤销入口 ----------

function lastUndoAction(): () => void {
    const fn = undoAction;
    assert.ok(fn, "提示条上应该挂了「撤销」");
    undoAction = null;
    return fn!;
}
