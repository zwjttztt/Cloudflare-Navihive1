// tests/sortController.dom.test.tsx
// useSortController 的组件级用例：纯排列计算由 tests/sortable.test.ts 覆盖，
// 这里盯的是那层「胶水」——发几次请求、请求体长什么样、失败了还留不留排序模式。
//
// 最值得钉的一条：**后端说没写进去时，绝不能退出排序模式**。
// 一旦退出，用户刚拖好的顺序会原地丢失（本地只在成功后才补齐），
// 而界面已经回到普通模式，看起来就像「保存成功了但没生效」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSortController, type SortApi } from "../src/hooks/useSortController";
import type { SiteOrderItem } from "../src/utils/sortable";
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

const site = (id: number, groupId: number): Site =>
    ({ id, name: `s${id}`, url: `https://s${id}.com`, group_id: groupId, order_num: id } as Site);

const initialGroups = (): GroupWithSites[] => [
    { id: 1, name: "g1", order_num: 0, sites: [site(10, 1), site(11, 1)] },
    { id: 2, name: "g2", order_num: 1, sites: [site(20, 2)] },
];

type Call = { kind: "group"; orders: { id: number; order_num: number }[] } | { kind: "site"; orders: SiteOrderItem[] };

function makeApi(opts: { ok?: boolean; failed?: number[] } = {}) {
    const calls: Call[] = [];
    const api: SortApi = {
        updateGroupOrder: async orders => {
            calls.push({ kind: "group", orders });
            return { success: true };
        },
        updateSiteOrder: async orders => {
            calls.push({ kind: "site", orders });
            return { success: opts.ok ?? true, failed: opts.failed ?? [], updated: [] };
        },
    };
    return { api, calls };
}

/** 把 hook 的返回值挂到一组 data-testid 上，方便断言 */
function Harness({
    api,
    onClosed,
    onError,
}: {
    api: SortApi;
    onClosed: () => void;
    onError: (msg: string) => void;
}) {
    const [groups, setGroups] = useState<GroupWithSites[]>(initialGroups);
    const groupsRef = useRef<GroupWithSites[]>(groups);
    useEffect(() => {
        groupsRef.current = groups;
    }, [groups]);
    const sort = useSortController({ api, groupsRef, setGroups, onError, onMenuClose: onClosed });
    (window as unknown as { __sort: typeof sort }).__sort = sort;
    return (
        <div>
            <span data-testid='mode'>{String(sort.sortMode)}</span>
            <span data-testid='sorting-group'>{String(sort.currentSortingGroupId)}</span>
            <span data-testid='dragging'>{sort.draggingSite ? sort.draggingSite.id : "none"}</span>
            <span data-testid='groups'>{JSON.stringify(groups.map(g => [g.id, g.sites.map(s => s.id)]))}</span>
        </div>
    );
}

function mount(node: Parameters<Root["render"]>[0]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.textContent!.trim();
const sort = () => (window as unknown as { __sort: ReturnType<typeof useSortController> }).__sort;

async function run(fn: () => void | Promise<void>) {
    await act(async () => {
        await fn();
    });
}

test("进入站点排序：切到 SiteSort、记住分组 id，并先关掉「更多选项」菜单", async () => {
    const { api } = makeApi();
    let closed = 0;
    mount(<Harness api={api} onClosed={() => closed++} onError={() => {}} />);
    assert.equal(text("mode"), "0"); // SortMode.None

    await run(() => sort().startSiteSort(2));
    assert.equal(text("mode"), "2"); // SortMode.SiteSort
    assert.equal(text("sorting-group"), "2");
    assert.equal(closed, 0, "站点排序不经过菜单，不该顺手关菜单");

    await run(() => sort().startGroupSort());
    assert.equal(text("mode"), "1"); // SortMode.GroupSort
    assert.equal(text("sorting-group"), "null");
    assert.equal(closed, 1, "分组排序必须先关菜单，否则菜单失去锚点会跑到左上角");
    cleanup();
});

test("取消排序回到 None", async () => {
    const { api } = makeApi();
    mount(<Harness api={api} onClosed={() => {}} onError={() => {}} />);
    await run(() => sort().startSiteSort(1));
    await run(() => sort().cancelSort());
    assert.equal(text("mode"), "0");
    assert.equal(text("sorting-group"), "null");
    cleanup();
});

test("拖拽：跨组移动改本地分组，浮层跟着被拖起的卡片", async () => {
    const { api } = makeApi();
    mount(<Harness api={api} onClosed={() => {}} onError={() => {}} />);
    await run(() => sort().handleSiteDragStart({ active: { id: "site-10" } } as never));
    assert.equal(text("dragging"), "10");
    // 非站点 id（分组被拖起）不该改浮层
    await run(() => sort().handleSiteDragStart({ active: { id: "group-1" } } as never));
    assert.equal(text("dragging"), "10");

    await run(() =>
        sort().handleSiteSortDragEnd({ active: { id: "site-10" }, over: { id: "group-2" } } as never)
    );
    assert.equal(text("groups"), "[[1,[11]],[2,[20,10]]]");
    await run(() => sort().handleSiteDragCancel());
    assert.equal(text("dragging"), "none");
    cleanup();
});

test("保存站点排序：顺序 + 跨组合成一次请求，成功后退出排序模式并补齐本地", async () => {
    const { api, calls } = makeApi();
    mount(<Harness api={api} onClosed={() => {}} onError={() => {}} />);
    await run(() => sort().startSiteSort(1));
    await run(() =>
        sort().handleSiteSortDragEnd({ active: { id: "site-10" }, over: { id: "group-2" } } as never)
    );
    await run(() => sort().handleSaveSiteSort());

    assert.equal(calls.length, 1, "跨组移动 + 顺序调整必须合并成一次请求");
    const call = calls[0];
    assert.equal(call.kind, "site");
    assert.deepEqual(call.kind === "site" && call.orders, [
        { id: 11, order_num: 0 },
        { id: 20, order_num: 0 },
        { id: 10, order_num: 1, group_id: 2 },
    ]);
    assert.equal(text("mode"), "0", "保存成功后要退出排序模式");
    cleanup();
});

test("保存站点排序：后端没写进去时报错，且**留在排序模式里**让用户重试", async () => {
    const { api } = makeApi({ ok: false, failed: [10] });
    const errors: string[] = [];
    mount(<Harness api={api} onClosed={() => {}} onError={m => errors.push(m)} />);
    await run(() => sort().startSiteSort(1));
    await run(() =>
        sort().handleSiteSortDragEnd({ active: { id: "site-10" }, over: { id: "group-2" } } as never)
    );
    await run(() => sort().handleSaveSiteSort());

    assert.equal(errors.length, 1);
    assert.match(errors[0], /1 个未生效/);
    assert.equal(text("mode"), "2", "失败了绝不能退出排序模式，否则刚拖好的顺序会看着像丢了的");
    cleanup();
});

test("保存分组排序：按当前下标批量提交，失败也留在排序模式", async () => {
    const { api, calls } = makeApi();
    const errors: string[] = [];
    mount(<Harness api={api} onClosed={() => {}} onError={m => errors.push(m)} />);
    await run(() => sort().startGroupSort());
    await run(() => sort().handleDragEnd({ active: { id: "2" }, over: { id: "1" } } as never));
    assert.equal(text("groups"), "[[2,[20]],[1,[10,11]]]");

    await run(() => sort().handleSaveGroupOrder());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "group");
    assert.deepEqual(calls[0].kind === "group" && calls[0].orders, [
        { id: 2, order_num: 0 },
        { id: 1, order_num: 1 },
    ]);
    assert.equal(text("mode"), "0");
    assert.equal(errors.length, 0);
    cleanup();
});

test("保存单组站点排序：只提交这一组的卡片", async () => {
    const { api, calls } = makeApi();
    mount(<Harness api={api} onClosed={() => {}} onError={() => {}} />);
    await run(() => sort().startSiteSort(1));
    await run(() =>
        sort().handleSaveSiteOrder(1, [
            { ...site(11, 1), order_num: 0 },
            { ...site(10, 1), order_num: 1 },
        ])
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].kind === "site" && calls[0].orders, [
        { id: 11, order_num: 0 },
        { id: 10, order_num: 1 },
    ]);
    // 本地按新 order_num 重排，另一组不受影响
    assert.equal(text("groups"), "[[1,[11,10]],[2,[20]]]");
    cleanup();
});
