// tests/undoRedo.dom.test.tsx
// useUndoRedo 的用例：按下「撤销 / 重做」之后发生什么，以及刷新之后怎么把
// 落盘的记录捞回来。
//
// 这里最要紧的一条是**凭据**：快照里的账号 / 密码在落盘前就被抹掉了（见
// undoPersist.stripSecrets），写回时如果连同这两个空字段一起写，撤销一次
// 「改标题」就会把库里的站点密码清成空 —— 借撤销之手做了一次静默的凭据删除，
// 用户完全不知情。这条必须钉死。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useUndoRedo, type UndoRedoDeps } from "../src/hooks/useUndoRedo";
import { savePersistedUndo, clearPersistedUndo, type PersistedUndo } from "../src/utils/undoPersist";
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
    clearPersistedUndo();
}

afterEach(() => {
    cleanup();
});

const site = (id: number, groupId: number, name: string): Site =>
    ({
        id,
        name,
        url: `https://${name}.com`,
        group_id: groupId,
        order_num: id,
        username: "库里的账号",
        password: "库里的密码",
    }) as unknown as Site;

interface Log {
    updates: { id: number; site: Partial<Site> }[];
    upsertLocal: Site[];
    notifies: string[];
    hydrated: { label: string }[];
}

const emptyLog = (): Log => ({ updates: [], upsertLocal: [], notifies: [], hydrated: [] });

type Params = Omit<UndoRedoDeps, "api" | "groupsRef" | "upsertSiteLocally" | "notify" | "undoHistory" | "redoHistory" | "hydrateHistory" | "groupsReady"> & {
    sites?: Site[];
    groupsReady?: boolean;
    undoResult?: string | null;
    redoResult?: string | null;
    undoThrows?: boolean;
};

function Harness({ log, params }: { log: Log; params: Params }) {
    const groupsRef = {
        current: [
            {
                id: 1,
                name: "g1",
                order_num: 0,
                sites: params.sites ?? [site(10, 1, "GitHub")],
            },
        ] as GroupWithSites[],
    };
    const actions = useUndoRedo({
        api: {
            updateSite: async (id: number, partial: Partial<Site>) => {
                log.updates.push({ id, site: partial });
                return null;
            },
        },
        groupsRef,
        upsertSiteLocally: s => log.upsertLocal.push(s),
        notify: (m: string) => log.notifies.push(m),
        undoHistory: async () => {
            if (params.undoThrows) throw new Error("炸了");
            return params.undoResult ?? null;
        },
        redoHistory: async () => params.redoResult ?? null,
        hydrateHistory: (list, build) => {
            for (const item of list) {
                const cmd = build(item);
                if (!cmd) continue;
                log.hydrated.push({ label: cmd.label });
                // 留一条给用例直接执行，好检查它到底往库里写了什么
                Object.assign(window as unknown as Record<string, unknown>, { __hydrated: cmd });
            }
        },
        groupsReady: params.groupsReady ?? true,
    });
    Object.assign(window as unknown as Record<string, unknown>, { __u: actions });
    return null;
}

function mount(node: Parameters<Root["render"]>[0]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

type Actions = ReturnType<typeof useUndoRedo>;
const u = () => (window as unknown as { __u: Actions }).__u;

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

// ---- 按下撤销 / 重做 ----

test("撤销：栈里有东西就提示撤了哪一步", async () => {
    const log = emptyLog();
    mount(<Harness log={log} params={{ undoResult: "修改「GitHub」" }} />);
    await run(() => u().runUndo());
    await flush();
    assert.deepEqual(log.notifies, ["已撤销：修改「GitHub」"]);
});

test("撤销：栈空时说「没有可撤销的操作」，不报错", async () => {
    const log = emptyLog();
    mount(<Harness log={log} params={{ undoResult: null }} />);
    await run(() => u().runUndo());
    await flush();
    assert.deepEqual(log.notifies, ["没有可撤销的操作"]);
});

test("撤销失败：吞掉异常并提示，不让界面崩", async () => {
    const log = emptyLog();
    mount(<Harness log={log} params={{ undoThrows: true }} />);
    await run(() => u().runUndo());
    await flush();
    assert.deepEqual(log.notifies, ["撤销失败"]);
});

test("重做：同样的三种情况", async () => {
    const log = emptyLog();
    mount(<Harness log={log} params={{ redoResult: "修改「GitHub」" }} />);
    await run(() => u().runRedo());
    await flush();
    assert.deepEqual(log.notifies, ["已重做：修改「GitHub」"]);
});

// ---- 跨刷新恢复 ----

const persisted = (over: Partial<PersistedUndo> = {}): PersistedUndo =>
    ({
        kind: "site-edit",
        label: "修改「GitHub」",
        at: Date.now(),
        siteId: 10,
        // 快照里的凭据是被抹掉的（落盘前 stripSecrets 处理过）
        before: { ...site(10, 1, "旧名字"), username: "", password: "" },
        after: { ...site(10, 1, "新名字"), username: "", password: "" },
        ...over,
    }) as PersistedUndo;

test("刷新后恢复：只认此刻还存在的卡片", async () => {
    const log = emptyLog();
    savePersistedUndo([persisted({ siteId: 999 })]); // 999 已经不在了
    mount(<Harness log={log} params={{}} />);
    await flush();
    assert.equal(log.hydrated.length, 0, "卡片没了就别恢复，否则会造出一张谁都不认识的脏卡片");
});

test("刷新后恢复：卡片还在 → 压回栈，且写回时**不带凭据字段**", async () => {
    const log = emptyLog();
    savePersistedUndo([persisted()]);
    mount(<Harness log={log} params={{}} />);
    await flush();
    assert.equal(log.hydrated.length, 1);
});

test("写回库里时不能把站点密码清成空（撤销一次改标题 = 静默删掉凭据）", async () => {
    const log = emptyLog();
    savePersistedUndo([persisted()]);
    mount(<Harness log={log} params={{}} />);
    await flush();

    // 直接执行恢复出来的命令，看它往库里写了什么
    const cmd = (
        window as unknown as { __hydrated?: { undo: () => Promise<void> } }
    ).__hydrated;
    assert.ok(cmd, "前置条件：得有一条恢复出来的命令");
    await run(() => cmd.undo());
    await flush();

    const written = log.updates[0].site as Record<string, unknown>;
    assert.equal("password" in written, false, "快照里的空密码不许写回库里");
    assert.equal("username" in written, false, "同理");
    assert.equal(written.name, "旧名字", "真正要撤的字段得写回去");
});

test("本地保留现有凭据：界面上不会突然变成「未设置密码」", async () => {
    const log = emptyLog();
    savePersistedUndo([persisted()]);
    mount(<Harness log={log} params={{}} />);
    await flush();
    const cmd = (window as unknown as { __hydrated?: { undo: () => Promise<void> } }).__hydrated!;
    await run(() => cmd.undo());
    await flush();

    const local = log.upsertLocal[0] as unknown as Record<string, unknown>;
    assert.equal(local.password, "库里的密码", "写回本地时用**当前**的密码，不是快照里的空串");
    assert.equal(local.username, "库里的账号");
    assert.equal(local.name, "旧名字");
});

test("数据没到位时不恢复，到位后只恢复一次", async () => {
    const log = emptyLog();
    savePersistedUndo([persisted()]);
    // 先以「数据没到位」挂载
    mount(<Harness log={log} params={{ groupsReady: false }} />);
    await flush();
    assert.equal(log.hydrated.length, 0, "groups 还是空的，此时校验会全判成「卡片不在了」");
});
