// tests/groupActions.dom.test.tsx
// useGroupActions 的用例：分组的「改 / 删」。
//
// 删分组是全站代价最大的一次操作——它连组内所有卡片一起删。撤销时要把
// 「分组 + 卡片」整组重建回来，而且卡片的本机标签 / 星标要按快照重新挂上
// （重建出来的卡片是**新 id**）。这里钉住几条最容易悄悄坏掉的：
//   - 撤销优先从回收站精确还原；**还原失败时必须退回按快照重建**（这条分支
//     以前根本走不到，原因见下面那条用例）
//   - 卡片按原 order_num 重建，分组本身也要插回原来的位置
//   - redo 是「彻底清掉回收站那条」，不是再软删一次
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useGroupActions, type GroupActionsDeps } from "../src/hooks/useGroupActions";
import type { GroupWithSites } from "../src/types";
import type { Group, Site } from "../src/API/http";
import type { TagMap } from "../src/utils/tagOps";
import type { HistoryCommand } from "../src/utils/historyStack";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

afterEach(() => {
    cleanup();
});

const site = (id: number, groupId: number, name: string, order: number): Site =>
    ({ id, name, url: `https://${name}.com`, group_id: groupId, order_num: order }) as Site;

/** 分组 1（order 0）里有 10、11；分组 2（order 1）里有 20 */
const groups = (): GroupWithSites[] => [
    {
        id: 1,
        name: "开发工具",
        order_num: 0,
        sites: [site(10, 1, "GitHub", 0), site(11, 1, "StackOverflow", 1)],
    },
    {
        id: 2,
        name: "设计",
        order_num: 1,
        sites: [site(20, 2, "Figma", 0)],
    },
];

interface Log {
    groupUpdates: { id: number; group: Group }[];
    groupsCreated: Partial<Group>[];
    sitesCreated: Partial<Site>[];
    groupsDeleted: number[];
    restored: number[];
    purged: number[];
    forget: number[][];
    tagWrites: { id: number; tags: string[] }[];
    starWrites: { ids: number[]; starred: boolean }[];
    setGroupsCalls: number;
    errors: string[];
    notifies: string[];
    history: HistoryCommand[];
    fetchCalls: number;
    pending: (number | null)[];
}

const emptyLog = (): Log => ({
    groupUpdates: [],
    groupsCreated: [],
    sitesCreated: [],
    groupsDeleted: [],
    restored: [],
    purged: [],
    forget: [],
    tagWrites: [],
    starWrites: [],
    setGroupsCalls: 0,
    errors: [],
    notifies: [],
    history: [],
    fetchCalls: 0,
    pending: [],
});

interface ApiOpts {
    /** deleteGroup 是否回一个回收站 id */
    recycleId?: number;
    /** 回收站还原的结果：true / false / 对象形状（浏览器端给的是后者） */
    restoreResult?: boolean | { success: boolean };
    newGroupId?: number;
    failUpdate?: boolean;
}

function makeApi(log: Log, opts: ApiOpts = {}) {
    let siteSeq = 900;
    return {
        updateGroup: async (id: number, group: Group) => {
            log.groupUpdates.push({ id, group });
            if (opts.failUpdate) throw new Error("网络断了");
            return { ...group, id } as Group;
        },
        createGroup: async (input: Group) => {
            log.groupsCreated.push(input);
            return { ...input, id: opts.newGroupId ?? 55 } as Group;
        },
        createSite: async (input: Site) => {
            log.sitesCreated.push(input);
            return { ...input, id: siteSeq++ } as Site;
        },
        deleteGroup: async (id: number) => {
            log.groupsDeleted.push(id);
            return { success: true, recycleId: opts.recycleId };
        },
        restoreRecycleItem: async (id: number) => {
            log.restored.push(id);
            return opts.restoreResult ?? { success: true };
        },
        purgeRecycleItem: async (id: number) => {
            log.purged.push(id);
            return true;
        },
    };
}

function makeDeps(
    log: Log,
    opts: ApiOpts & { tags?: TagMap; starred?: number[] } = {}
): GroupActionsDeps {
    const groupsRef = { current: groups() };
    return {
        api: makeApi(log, opts) as unknown as GroupActionsDeps["api"],
        groupsRef,
        setGroups: () => {
            log.setGroupsCalls += 1;
        },
        handleError: m => log.errors.push(m),
        notify: (m: string) => log.notifies.push(m),
        tags: opts.tags ?? ({} as TagMap),
        starred: opts.starred ?? [],
        forgetSites: ids => log.forget.push(ids),
        setSiteTags: (id, tags) => log.tagWrites.push({ id, tags }),
        setStarredMany: (ids, starred) => log.starWrites.push({ ids, starred }),
        pushHistory: (cmd: HistoryCommand) => log.history.push(cmd),
        runUndo: async () => {},
        fetchData: async () => {
            log.fetchCalls += 1;
            return true;
        },
    };
}

function Harness({ deps }: { deps: GroupActionsDeps }) {
    const actions = useGroupActions(deps);
    Object.assign(window as unknown as Record<string, unknown>, { __g: actions });
    return null;
}

function mount(node: Parameters<Root["render"]>[0]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

type Actions = ReturnType<typeof useGroupActions>;
const g = () => (window as unknown as { __g: Actions }).__g;

async function run(fn: () => void | Promise<void>) {
    await act(async () => {
        await fn();
    });
}

async function flush() {
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, 0));
    });
}

// ---- 更新分组 ----

test("更新分组：写库后并上服务端回显，卡片不受影响", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log)} />);
    await run(() => g().handleGroupUpdate({ id: 1, name: "改名了" } as Group));
    await flush();
    assert.equal(log.groupUpdates.length, 1);
    assert.equal(log.setGroupsCalls, 1, "本地要跟着改一次");
    assert.equal(log.errors.length, 0);
});

test("更新分组失败：报错，不静默", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log, { failUpdate: true })} />);
    await run(() => g().handleGroupUpdate({ id: 1, name: "改名了" } as Group));
    await flush();
    assert.match(log.errors[0], /更新分组失败/);
});

// ---- 删除分组：入口只是「登记待确认」----

test("点删除分组：只登记待确认，真正删除要等确认之后", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log)} />);
    await run(() => g().handleGroupDelete(1));
    await flush();
    assert.equal(g().pendingGroupDelete, 1);
    assert.equal(log.groupsDeleted.length, 0, "没确认就不许删");
});

// ---- 真正删除 ----

test("删除分组：软删 → 连组内卡片的本机标签/星标一起清掉", async () => {
    const log = emptyLog();
    mount(
        <Harness deps={makeDeps(log, { recycleId: 77, tags: { "10": ["AI"] }, starred: [11] })} />
    );
    await run(() => g().doGroupDelete(1));
    await flush();

    assert.deepEqual(log.groupsDeleted, [1]);
    assert.deepEqual(log.forget, [[10, 11]], "卡片跟着没了，它们的标签/星标也要清掉");
    assert.equal(log.history.length, 1);
    assert.match(log.history[0].label, /删除分组/);
});

test("撤销删除分组：回收站还原成功 → 拉一次远端即可，不再重建", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log, { recycleId: 77, restoreResult: { success: true } })} />);
    await run(() => g().doGroupDelete(1));
    await flush();
    await run(() => log.history[0].undo());
    await flush();

    assert.deepEqual(log.restored, [77]);
    assert.equal(log.fetchCalls, 1, "还原成功后拉一次远端把界面和库对齐");
    assert.equal(log.groupsCreated.length, 0, "还原成功就不该再重建");
});

test("撤销删除分组：还原失败 → 必须退回「按快照重建」（以前这条分支走不到）", async () => {
    const log = emptyLog();
    // 浏览器端 NavigationClient 返回的是 { success: false } —— 直接 `if (res)`
    // 会把对象当成真值，于是永远不会走进重建分支，撤销后分组就回不来了
    mount(
        <Harness
            deps={makeDeps(log, {
                recycleId: 77,
                restoreResult: { success: false },
                tags: { "10": ["AI"] },
                starred: [11],
                newGroupId: 55,
            })}
        />
    );
    await run(() => g().doGroupDelete(1));
    await flush();
    await run(() => log.history[0].undo());
    await flush();

    assert.deepEqual(log.restored, [77], "确实试过从回收站还原");
    assert.deepEqual(log.groupsCreated, [{ name: "开发工具", order_num: 0 }], "失败后要重建分组");
    // 卡片按原 order_num 顺序重建
    assert.deepEqual(
        log.sitesCreated.map(s => s.name),
        ["GitHub", "StackOverflow"],
        "卡片要按原顺序重建"
    );
    assert.equal(log.fetchCalls, 0, "重建路径不需要全量重拉");
});

test("按快照重建时：卡片的本机标签/星标要挂到**新 id** 上", async () => {
    const log = emptyLog();
    mount(
        <Harness
            deps={makeDeps(log, {
                // 没有回收站 id → 直接走重建
                tags: { "10": ["AI"], "11": [] },
                starred: [11],
                newGroupId: 55,
            })}
        />
    );
    await run(() => g().doGroupDelete(1));
    await flush();
    await run(() => log.history[0].undo());
    await flush();

    assert.equal(log.groupsCreated.length, 1);
    // 重建出的新 id 从 900 开始（假 api 的发号器）
    assert.deepEqual(log.tagWrites, [{ id: 900, tags: ["AI"] }], "10 有标签 → 挂到新 id 上");
    assert.deepEqual(log.starWrites, [{ ids: [901], starred: true }], "11 加过星 → 挂到新 id 上");
});

test("撤销后再删一次：彻底清掉回收站那条，不是再软删一次", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log, { recycleId: 77, restoreResult: { success: true } })} />);
    await run(() => g().doGroupDelete(1));
    await flush();
    await run(() => log.history[0].undo());
    await flush();
    await run(() => log.history[0].redo());
    await flush();

    assert.deepEqual(log.purged, [77]);
    assert.deepEqual(log.groupsDeleted, [1], "不该再发一次 deleteGroup");
});
