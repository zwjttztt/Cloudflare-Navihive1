// tests/siteActions.dom.test.tsx
// useSiteActions 的用例：卡片的「改 / 删 / 批量删」+ 改链接前的重复网址守卫。
//
// 这几条路径是 App 里唯一会**删数据**的地方，而删掉之后还能救回来的前提是：
//   - 删除前把本机标签 / 星标留了快照（卡片没了，这两样就没有宿主了）
//   - 撤销优先「从回收站精确还原」（保留原 id，标签按 id 自动归位）
//   - 拿不到回收站条目时才退回「按快照重建」（新 id，所以要手动把标签挂回去）
// 这两条路径任缺一条，表现都是「卡片回来了、标签却没了」，而手工点很难发现。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSiteActions, type SiteActionsDeps } from "../src/hooks/useSiteActions";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";
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

// ⚠️ 兜底清理：断言失败时用例末尾的 cleanup() 不会执行，残留的 host 会让后面
// 几条读到上一个测试的 DOM（在别的测试文件里栽过一次，查了很久）
afterEach(() => {
    cleanup();
});

const site = (id: number, groupId: number, name: string, url?: string): Site =>
    ({
        id,
        name,
        url: url ?? `https://${name}.com`,
        description: `${name} 的描述`,
        group_id: groupId,
        order_num: id,
    }) as unknown as Site;

const twoGroups = (): GroupWithSites[] => [
    {
        id: 1,
        name: "开发工具",
        order_num: 0,
        sites: [site(10, 1, "GitHub"), site(11, 1, "StackOverflow")],
    },
    {
        id: 2,
        name: "设计",
        order_num: 1,
        sites: [site(20, 2, "Figma")],
    },
];

interface Log {
    updates: { id: number; site: Partial<Site> }[];
    creates: Partial<Site>[];
    deletes: number[];
    bulkDeletes: number[][];
    restored: number[][];
    purged: number[];
    upsertLocal: number[];
    upsertManyLocal: number[][];
    removeLocal: number[];
    removeManyLocal: number[][];
    forget: number[][];
    tagWrites: { id: number; tags: string[] }[];
    starWrites: { ids: number[]; starred: boolean }[];
    errors: string[];
    notifies: string[];
    history: HistoryCommand[];
    dupPrompts: { url: string }[];
    fetchCalls: number;
    undoRuns: number;
}

const emptyLog = (): Log => ({
    updates: [],
    creates: [],
    deletes: [],
    bulkDeletes: [],
    restored: [],
    purged: [],
    upsertLocal: [],
    upsertManyLocal: [],
    removeLocal: [],
    removeManyLocal: [],
    forget: [],
    tagWrites: [],
    starWrites: [],
    errors: [],
    notifies: [],
    history: [],
    dupPrompts: [],
    fetchCalls: 0,
    undoRuns: 0,
});

interface ApiOpts {
    /** deleteSite 是否回一个回收站 id（没有 → 撤销只能按快照重建） */
    recycleId?: number;
    /** 批量删除的回执：每条给不给回收站 id */
    bulkRecycle?: Record<number, number | undefined>;
    failUpdate?: boolean;
    newId?: number;
    restoredSites?: Site[];
}

function makeApi(log: Log, opts: ApiOpts = {}) {
    return {
        updateSite: async (id: number, partial: Partial<Site>) => {
            log.updates.push({ id, site: partial });
            if (opts.failUpdate) throw new Error("网络断了");
            return { id, ...partial } as Site;
        },
        createSite: async (input: Site) => {
            log.creates.push(input);
            return { ...input, id: opts.newId ?? 777 } as Site;
        },
        deleteSite: async (id: number) => {
            log.deletes.push(id);
            return { success: true, recycleId: opts.recycleId };
        },
        deleteSites: async (ids: number[]) => {
            log.bulkDeletes.push(ids);
            const map = opts.bulkRecycle ?? {};
            const items = ids.map(id => ({ id, recycleId: map[id] }));
            const failed = items.filter(i => i.recycleId === undefined).map(i => i.id);
            return { items, failed };
        },
        restoreRecycleItems: async (ids: number[]) => {
            log.restored.push(ids);
            const restored = opts.restoredSites ?? [];
            return { restored, failed: [] };
        },
        purgeRecycleItem: async (id: number) => {
            log.purged.push(id);
            return true;
        },
        purgeRecycleItems: async (ids: number[]) => {
            log.purged.push(...ids);
            return { purged: ids };
        },
    };
}

function makeDeps(log: Log, opts: ApiOpts & { tags?: TagMap; starred?: number[] } = {}): SiteActionsDeps {
    const groupsRef = { current: twoGroups() };
    return {
        api: makeApi(log, opts) as unknown as SiteActionsDeps["api"],
        groupsRef,
        setDupPrompt: p => {
            if (p) log.dupPrompts.push({ url: p.url });
        },
        upsertSiteLocally: s => log.upsertLocal.push(s.id as number),
        upsertSitesLocally: list => log.upsertManyLocal.push(list.map(s => s.id as number)),
        removeSiteLocally: id => log.removeLocal.push(id),
        removeSitesLocally: ids => log.removeManyLocal.push(ids),
        handleError: m => log.errors.push(m),
        notify: (m: string) => log.notifies.push(m),
        tags: opts.tags ?? ({} as TagMap),
        starred: opts.starred ?? [],
        forgetSites: ids => log.forget.push(ids),
        setSiteTags: (id, tags) => log.tagWrites.push({ id, tags }),
        setStarredMany: (ids, starred) => log.starWrites.push({ ids, starred }),
        pushHistory: (cmd: HistoryCommand) => log.history.push(cmd),
        runUndo: async () => {
            log.undoRuns += 1;
        },
        fetchData: async () => {
            log.fetchCalls += 1;
            return true;
        },
    };
}

function Harness({ deps }: { deps: SiteActionsDeps }) {
    const actions = useSiteActions(deps);
    Object.assign(window as unknown as Record<string, unknown>, { __a: actions });
    return null;
}

function mount(node: Parameters<Root["render"]>[0]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

type Actions = ReturnType<typeof useSiteActions>;
const a = () => (window as unknown as { __a: Actions }).__a;

async function run(fn: () => void | Promise<void>) {
    await act(async () => {
        await fn();
    });
}

/** 推进一个宏任务：hook 里的 await 链要跑完才看得到结果 */
async function flush() {
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, 0));
    });
}

// ---- 改链接前的重复网址守卫 ----

test("改链接撞车：先弹确认，一个字节都不写库", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log)} />);
    // 10 改成和 11 一样的地址
    const input = { ...site(10, 1, "GitHub"), url: "https://StackOverflow.com" };
    await run(() => a().handleSiteUpdate(input));
    await flush();

    assert.equal(log.updates.length, 0, "撞车时不许直接写库");
    assert.equal(log.dupPrompts.length, 1, "要弹出重复网址确认");
    assert.equal(log.upsertLocal.length, 0, "连乐观更新都不许先做");
});

test("改链接没撞车：正常走写库（守卫不能误伤）", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log)} />);
    const input = { ...site(10, 1, "GitHub"), url: "https://new-site.com" };
    await run(() => a().handleSiteUpdate(input));
    await flush();

    assert.equal(log.dupPrompts.length, 0);
    assert.equal(log.updates.length, 1, "没撞车就应当直接写库");
});

test("伪协议链接：挡掉并报错，不写库", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log)} />);
    await run(() => a().handleSiteUpdate({ ...site(10, 1, "GitHub"), url: "javascript:alert(1)" }));
    await flush();

    assert.equal(log.updates.length, 0);
    assert.equal(log.upsertLocal.length, 0);
    assert.equal(log.errors.length, 1, "要告诉用户为什么没保存");
});

// ---- 更新：乐观更新与失败回滚 ----

test("更新：先乐观改本地，成功后再并上服务端回显", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log)} />);
    await run(() => a().handleSiteUpdate({ ...site(10, 1, "改名了"), url: "https://new-site.com" }));
    await flush();

    assert.deepEqual(log.upsertLocal, [10, 10], "乐观更新一次 + 回显一次");
    assert.ok(log.notifies.includes("卡片已更新"));
    assert.equal(log.history.length, 1, "改卡片也要能撤销");
});

test("更新失败：回滚到改动前的快照，不留半改状态", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log, { failUpdate: true })} />);
    await run(() => a().handleSiteUpdate({ ...site(10, 1, "改名了"), url: "https://new-site.com" }));
    await flush();

    // 第一次是乐观更新，第二次必须是**快照**（原样写回）
    assert.deepEqual(log.upsertLocal, [10, 10]);
    assert.match(log.errors[0], /更新站点失败/);
    assert.equal(log.history.length, 0, "失败的操作不进撤销栈");
});

// ---- 单张删除与撤销 ----

test("删除：进回收站、连本机标签/星标一起清掉，并给一条可撤销的记录", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log, { recycleId: 99, tags: { "10": ["AI"] }, starred: [10] })} />);
    await run(() => a().handleSiteDelete(10));
    await flush();

    assert.deepEqual(log.deletes, [10]);
    assert.deepEqual(log.removeLocal, [10], "界面上要立刻摘掉");
    assert.deepEqual(log.forget, [[10]], "卡片没了，它的标签/星标也没了宿主");
    assert.equal(log.history.length, 1);
    assert.match(log.history[0].label, /删除/);
    assert.ok(log.notifies.some(n => n.includes("已删除")), `实际提示：${log.notifies}`);
});

test("撤销删除：从回收站精确还原，并把标签/星标按**原 id** 写回去", async () => {
    const log = emptyLog();
    mount(
        <Harness
            deps={makeDeps(log, {
                recycleId: 99,
                tags: { "10": ["AI"] },
                starred: [10],
                restoredSites: [site(10, 1, "GitHub")],
            })}
        />
    );
    await run(() => a().handleSiteDelete(10));
    await flush();

    log.tagWrites.length = 0;
    log.starWrites.length = 0;
    await run(() => log.history[0].undo());
    await flush();

    assert.deepEqual(log.restored, [[99]], "走的是回收站还原，不是重建");
    assert.deepEqual(log.upsertManyLocal, [[10]], "还原出来的卡片直接插回界面，不再全量重拉");
    assert.deepEqual(log.tagWrites, [{ id: 10, tags: ["AI"] }], "标签要按**原 id** 挂回去");
    assert.deepEqual(log.starWrites, [{ ids: [10], starred: true }], "星标同理");
    assert.equal(log.creates.length, 0, "拿到回收站条目就不该再走重建");
});

test("撤销删除（没有回收站条目）：按快照重建，标签/星标挂到**新 id** 上", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log, { tags: { "10": ["AI"] }, starred: [10], newId: 555 })} />);
    await run(() => a().handleSiteDelete(10));
    await flush();
    assert.equal(log.history.length, 1);

    await run(() => log.history[0].undo());
    await flush();

    assert.equal(log.creates.length, 1, "没有回收站 id → 退回按快照重建");
    assert.deepEqual(log.tagWrites, [{ id: 555, tags: ["AI"] }], "重建拿到的是新 id");
    assert.deepEqual(log.starWrites, [{ ids: [555], starred: true }]);
    assert.equal(log.restored.length, 0);
});

test("撤销后再删一次：把回收站里那条彻底清掉", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log, { recycleId: 99, restoredSites: [site(10, 1, "GitHub")] })} />);
    await run(() => a().handleSiteDelete(10));
    await flush();
    await run(() => log.history[0].undo());
    await flush();
    await run(() => log.history[0].redo());
    await flush();

    assert.deepEqual(log.purged, [99], "redo = 从回收站彻底删除，不是再走一次软删");
    assert.deepEqual(log.deletes, [10], "不该再发一次 deleteSite");
});

// ---- 批量删除 ----

test("批量删除：只摘掉真删成的，没删成的留在原地并说清楚", async () => {
    const log = emptyLog();
    // 10 删成（有回收站 id），11 没删成
    mount(<Harness deps={makeDeps(log, { bulkRecycle: { 10: 81, 11: undefined } })} />);
    await run(() => a().doSitesDelete([10, 11]));
    await flush();

    assert.deepEqual(log.removeManyLocal, [[10]], "11 还活着，不许从界面上摘掉");
    assert.deepEqual(log.forget, [[10]], "只清真删掉的那张的本机偏好");
    assert.ok(
        log.notifies.some(n => n.includes("1 个没删成")),
        `实际提示：${log.notifies}`
    );
});

test("批量删除：一个都没删成时报错，界面一个都不动", async () => {
    const log = emptyLog();
    mount(<Harness deps={makeDeps(log, { bulkRecycle: { 10: undefined, 11: undefined } })} />);
    await run(() => a().doSitesDelete([10, 11]));
    await flush();

    assert.equal(log.removeManyLocal.length, 0, "一个都没删成，界面必须原样");
    assert.equal(log.forget.length, 0);
    assert.match(log.errors[0], /一个都没删成功/);
    assert.equal(log.history.length, 0);
});

test("批量删除后撤销：一次请求还原，并把标签挂回原 id", async () => {
    const log = emptyLog();
    mount(
        <Harness
            deps={makeDeps(log, {
                bulkRecycle: { 10: 81, 11: 82 },
                tags: { "10": ["AI"], "11": [] },
                starred: [11],
                restoredSites: [site(10, 1, "GitHub"), site(11, 1, "StackOverflow")],
            })}
        />
    );
    await run(() => a().doSitesDelete([10, 11]));
    await flush();
    log.tagWrites.length = 0;
    log.starWrites.length = 0;

    await run(() => log.history[0].undo());
    await flush();

    assert.deepEqual(log.restored, [[81, 82]], "一次请求搬完");
    assert.deepEqual(log.upsertManyLocal, [[10, 11]]);
    // 11 没标签但加过星，所以只有它写星标；10 有标签所以写标签
    assert.deepEqual(log.tagWrites, [{ id: 10, tags: ["AI"] }]);
    assert.deepEqual(log.starWrites, [{ ids: [11], starred: true }]);
});
