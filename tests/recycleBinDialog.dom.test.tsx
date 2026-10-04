// tests/recycleBinDialog.dom.test.tsx
// 回收站弹窗。
//
// 这里要钉的不是「还原能不能成功」，而是两条**防误操作**的设计：
// 1. 单项「彻底删除」不能直接生效 —— 它旁边就是「还原」，两个图标挨着，手指一偏就是
//    不可逆的删除。所以点图标只弹确认，确认了才真删。
// 2. 读失败要显示「没读到」而不是空列表。空列表和「没读到」在界面上长得一样的话，
//    用户会以为回收站真的是空的，直接关掉走人 —— 而他的数据其实还在，只是没读出来。
//
// 顺带把「保留天数不写死 7 天」钉住（它应该跟网站设置里配的一致）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import RecycleBinDialog from "../src/components/RecycleBinDialog";
import type { NavigationClient } from "../src/API/client";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Item {
    id: number;
    kind: "site" | "group";
    name: string;
    deletedAt: number;
}

interface FakeOpts {
    items?: Item[];
    listError?: Error;
    restoreOk?: boolean;
    purgeOk?: boolean;
    clearOk?: boolean;
}

function makeClient(opts: FakeOpts = {}) {
    const calls = {
        list: 0,
        restore: [] as number[],
        purge: [] as number[],
        clear: 0,
    };
    const client = {
        getRecycleBin: async () => {
            calls.list += 1;
            if (opts.listError) throw opts.listError;
            return { items: opts.items ?? [] };
        },
        restoreRecycleItem: async (id: number) => {
            calls.restore.push(id);
            return { success: opts.restoreOk ?? true };
        },
        purgeRecycleItem: async (id: number) => {
            calls.purge.push(id);
            return { success: opts.purgeOk ?? true };
        },
        emptyRecycleBin: async () => {
            calls.clear += 1;
            return { success: opts.clearOk ?? true };
        },
    } as unknown as NavigationClient;
    return { client, calls };
}

const ITEM_A: Item = { id: 11, kind: "site", name: "被删的站点", deletedAt: 1759000000 };
const ITEM_B: Item = { id: 12, kind: "group", name: "被删的分组", deletedAt: 1759000100 };

function mount(
    client: NavigationClient,
    retentionDays?: number,
    onNotify?: (msg: string) => void
) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <ThemeProvider theme={createTheme()}>
                <RecycleBinDialog
                    open
                    client={client}
                    onClose={() => {}}
                    retentionDays={retentionDays}
                    onNotify={onNotify}
                />
            </ThemeProvider>
        );
    });
}

function cleanup() {
    if (root) {
        act(() => {
            root!.unmount();
        });
    }
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

// 兜底：断言失败会跳过用例末尾那句 cleanup，残留的弹窗会污染下一条
// （MUI 的 Portal 挂在 body 上，光靠 host.remove() 收不干净）
afterEach(cleanup);

/** 等 effect 里的异步拉取落地 */
async function settle() {
    await act(async () => {
        await new Promise(r => setTimeout(r, 0));
        await Promise.resolve();
    });
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > deadline) assert.fail(`等了 ${timeoutMs}ms 也没等到：${label}`);
        await settle();
    }
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

const purgeIcon = (name: string) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="彻底删除 ${name}"]`);

async function clickAsync(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

const bodyText = () => document.body.textContent || "";

// ---------- 读取 ----------

test("读出来就列出来，标清是站点还是分组、什么时候删的", async () => {
    const { client } = makeClient({ items: [ITEM_A, ITEM_B] });
    mount(client);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));

    assert.ok(bodyText().includes("站点"), "要能分清删的是站点还是分组");
    assert.ok(bodyText().includes("分组"));
    assert.ok(bodyText().includes("删除于"));
    cleanup();
});

test("空的回收站要说「是空的」", async () => {
    const { client } = makeClient({ items: [] });
    mount(client);
    await waitFor("空态出现", () => bodyText().includes("回收站是空的"));
    cleanup();
});

test("读不出来要说「没读到」，不能显示成空列表", async () => {
    // 界面上长得一样的话，用户会以为数据真没了，直接关掉走人
    const { client } = makeClient({ listError: new Error("网络断了") });
    mount(client);
    await waitFor("错误态出现", () => bodyText().includes("没读到回收站内容"));

    assert.ok(bodyText().includes("网络断了"), "要把原因说出来");
    assert.ok(!bodyText().includes("回收站是空的"), "不能同时显示成空的");
    assert.ok(buttonByText("重试"), "要给重试入口");
    cleanup();
});

test("点重试会再拉一次", async () => {
    const { client, calls } = makeClient({ listError: new Error("网络断了") });
    mount(client);
    await waitFor("错误态出现", () => bodyText().includes("没读到回收站内容"));
    const before = calls.list;

    await clickAsync(buttonByText("重试")!);
    await settle();

    assert.ok(calls.list > before, "重试要真的再拉一次");
    cleanup();
});

test("保留天数跟着网站设置走，不写死 7 天", async () => {
    const { client } = makeClient({ items: [ITEM_A] });
    mount(client, 30);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));

    assert.ok(bodyText().includes("30"), "配了 30 天就该显示 30 天");
    assert.ok(!bodyText().includes("仅保留 7 天"));
    cleanup();
});

test("没配保留天数时用默认值", async () => {
    const { client } = makeClient({ items: [ITEM_A] });
    mount(client);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));
    assert.ok(/仅保留 \d+ 天/.test(bodyText()));
    cleanup();
});

// ---------- 彻底删除必须过确认 ----------

test("点「彻底删除」图标不会立刻删，只弹确认", async () => {
    const { client, calls } = makeClient({ items: [ITEM_A] });
    mount(client);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));

    await clickAsync(purgeIcon("被删的站点")!);
    await waitFor("确认弹窗出现", () => Boolean(buttonByText("永久删除")));

    assert.deepEqual(calls.purge, [], "图标旁边就是「还原」，点错一次没有第二次机会");
    assert.ok(bodyText().includes("被删的站点"), "确认文案要点名删的是哪一条");
    assert.ok(bodyText().includes("无法恢复"));
    cleanup();
});

test("确认之后才真的删", async () => {
    const { client, calls } = makeClient({ items: [ITEM_A] });
    mount(client);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));
    await clickAsync(purgeIcon("被删的站点")!);
    await waitFor("确认弹窗出现", () => Boolean(buttonByText("永久删除")));

    await clickAsync(buttonByText("永久删除")!);
    await waitFor("删除请求发出", () => calls.purge.length > 0);

    assert.deepEqual(calls.purge, [11], "删的是点中的那一条");
    cleanup();
});

test("确认弹窗里点取消不会删", async () => {
    const { client, calls } = makeClient({ items: [ITEM_A] });
    mount(client);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));
    await clickAsync(purgeIcon("被删的站点")!);
    await waitFor("确认弹窗出现", () => Boolean(buttonByText("永久删除")));

    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === "取消"
    );
    assert.ok(cancel, "要有取消");
    await clickAsync(cancel);
    await settle();

    assert.deepEqual(calls.purge, []);
    cleanup();
});

test("删除失败时不静默：要提示，而且确认弹窗已经关掉了也不算成功", async () => {
    const { client } = makeClient({ items: [ITEM_A], purgeOk: false });
    let note = "";
    mount(client, undefined, m => {
        note = m;
    });
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));
    await clickAsync(purgeIcon("被删的站点")!);
    await waitFor("确认弹窗出现", () => Boolean(buttonByText("永久删除")));
    await clickAsync(buttonByText("永久删除")!);
    await waitFor("提示出现", () => note !== "");

    assert.match(note, /失败/, "purge 返回 success:false 时必须让用户知道没删掉");
    cleanup();
});

// ---------- 清空回收站 ----------

test("清空也要过确认，且说明有多少条", async () => {
    const { client, calls } = makeClient({ items: [ITEM_A, ITEM_B] });
    mount(client);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));

    await clickAsync(buttonByText("清空回收站")!);
    await waitFor("确认弹窗出现", () => Boolean(buttonByText("清空")));

    assert.equal(calls.clear, 0);
    assert.ok(bodyText().includes("全部条目"));
    cleanup();
});

test("回收站为空时「清空回收站」是禁用的", async () => {
    const { client } = makeClient({ items: [] });
    mount(client);
    await waitFor("空态出现", () => bodyText().includes("回收站是空的"));
    assert.equal(buttonByText("清空回收站")?.disabled, true);
    cleanup();
});

test("清空失败时抛出去 —— 确认弹窗不关闭，用户可以直接再点一次", async () => {
    const { client, calls } = makeClient({ items: [ITEM_A], clearOk: false });
    mount(client);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));
    await clickAsync(buttonByText("清空回收站")!);
    await waitFor("确认弹窗出现", () => Boolean(buttonByText("清空")));

    await clickAsync(buttonByText("清空")!);
    await waitFor("清空请求发出", () => calls.clear > 0);

    // 抛异常让 ConfirmDialog 认为「还没成功」从而不关闭：用户不用重新走一遍
    // 「打开回收站 → 清空」才能再试一次。
    // ⚠️ 这里必须**反复确认它一直在**：MUI Dialog 关闭有淡出过渡，按钮在过渡期间
    // 还留在 DOM 里，只查一次会被假绿骗过去。
    for (let i = 0; i < 12; i += 1) {
        await settle();
        await act(async () => {
            await new Promise(r => setTimeout(r, 40));
        });
        assert.ok(buttonByText("清空"), "清空失败后确认弹窗要留在原地，方便直接再点一次");
    }
    cleanup();
});

// ---------- 还原 ----------

test("还原直接用，不需要二次确认（它是可逆的）", async () => {
    const { client, calls } = makeClient({ items: [ITEM_A] });
    mount(client);
    await waitFor("列表出现", () => bodyText().includes("被删的站点"));

    await clickAsync(buttonByText("还原")!);
    await waitFor("还原请求发出", () => calls.restore.length > 0);

    assert.deepEqual(calls.restore, [11]);
    cleanup();
});

