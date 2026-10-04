// tests/offlineBanner.dom.test.tsx
// 断网提示 + 「没能同步」清单。
//
// 为什么补它：这一块守的是**不能骗人**。离线队列会重试五次、被服务端拒绝后把操作挪进
// 失败清单，清单里躺着的是「用户以为存好了、其实没存上」的改动。它们不再计入待同步角标，
// 于是唯一能让人看见的就是这个横幅 —— 一旦它不显示，等于系统悄悄把用户的改动吞了。
// 而这类「什么都不显示」的 bug 不会报错，冒烟里也看不出来（得先断网再跑一遍）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import OfflineBanner from "../src/components/OfflineBanner";
import {
    clearFailedMutations,
    enqueueMutation,
    failedMutations,
    flushOfflineQueue,
    pendingCount,
    RejectedByServerError,
    takeAll,
    type MutationApi,
} from "../src/API/offlineQueue";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<OfflineBanner />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
    takeAll();
    clearFailedMutations();
}

const bodyText = () => document.body.textContent || "";

function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );
}

async function click(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

async function fireWindowEvent(type: "online" | "offline") {
    await act(async () => {
        window.dispatchEvent(new Event(type));
        await Promise.resolve();
    });
}

/** 造一条「重试到头 / 被服务端拒绝」的改动 —— 只能靠真跑一次重放失败来产生 */
async function seedFailed(kind = "createSite", args: unknown[] = [{ name: "示例站点" }]) {
    enqueueMutation(kind, args);
    const api = {
        [kind]: () => Promise.reject(new RejectedByServerError("服务端拒绝：链接重复")),
    } as unknown as MutationApi;
    await act(async () => {
        await flushOfflineQueue(api);
    });
}

test("联网且没有失败项：什么都不显示（别为「一切正常」占一块屏幕）", t => {
    t.after(cleanup);
    mount();
    assert.equal(bodyText().trim(), "", `应完全不渲染，实际 ${JSON.stringify(bodyText())}`);
});

test("断网：提示改动已暂存本地、联网后自动同步", async t => {
    t.after(cleanup);
    mount();
    await fireWindowEvent("offline");
    const text = bodyText();
    assert.ok(text.includes("网络已断开"), `应说明断网，实际 ${JSON.stringify(text)}`);
    assert.ok(text.includes("已暂存本地"), "必须说清改动没丢，只是暂存");
    assert.ok(text.includes("自动同步"), "不能再写「等恢复再操作一次」——那是老文案，与离线队列的行为不符");
});

test("断网且有待同步项：把待同步条数显示出来", async t => {
    t.after(cleanup);
    enqueueMutation("updateSite", [{ id: 1 }]);
    mount();
    await fireWindowEvent("offline");
    assert.ok(
        bodyText().includes(`${pendingCount()} 项待同步`),
        `应写出待同步条数，实际 ${JSON.stringify(bodyText())}`
    );
});

test("恢复网络：切成「网络已恢复」的成功提示", async t => {
    t.after(cleanup);
    mount();
    await fireWindowEvent("offline");
    await fireWindowEvent("online");
    const text = bodyText();
    assert.ok(text.includes("网络已恢复"), `实际 ${JSON.stringify(text)}`);
    assert.ok(!text.includes("网络已断开"));
});

test("有失败项：无论联网与否都要显示，并写清条数", async t => {
    t.after(cleanup);
    await seedFailed();
    assert.equal(failedMutations().length, 1, "前置：确实产生了一条失败项");
    mount();
    const text = bodyText();
    assert.ok(text.includes("1 项改动没能同步"), `实际 ${JSON.stringify(text)}`);
    assert.ok(text.includes("已停止重试"), "要说清系统不会再自动重试，得用户自己决定");
});

test("失败项不随「网络已恢复」那 2.6 秒一起消失", async t => {
    t.after(cleanup);
    await seedFailed();
    mount();
    await fireWindowEvent("offline");
    await fireWindowEvent("online");
    assert.ok(
        bodyText().includes("1 项改动没能同步"),
        "网络恢复了不代表这些改动补上了，清单必须留着"
    );
});

test("展开清单：写清是哪一项、以及为什么没同步", async t => {
    t.after(cleanup);
    await seedFailed();
    mount();
    const view = buttonByText("查看");
    assert.ok(view, "应有「查看」按钮");
    await click(view!);

    const text = bodyText();
    assert.ok(text.includes("新建卡片"), `应把操作名翻成人话，实际 ${JSON.stringify(text)}`);
    assert.ok(text.includes("示例站点"), "应带上改动对象，否则用户不知道是哪一条");
    assert.ok(text.includes("服务端拒绝：链接重复"), "应显示失败原因");
    assert.ok(buttonByText("收起"), "展开后按钮应变成「收起」");
});

test("单条「放弃」：从清单里移除；「全部重试」：放回待同步队列", async t => {
    t.after(cleanup);
    await seedFailed();
    mount();
    const view = buttonByText("查看");
    await click(view!);

    const discard = buttonByText("放弃");
    assert.ok(discard, "每条都应有「放弃」");
    await click(discard!);
    assert.equal(failedMutations().length, 0, "放弃后应从清单里消失");

    // 再来一条，这次走「全部重试」
    await seedFailed("updateSite", [{ id: 7, name: "要改的卡片" }]);
    assert.equal(failedMutations().length, 1);
    const retryAll = buttonByText("全部重试");
    assert.ok(retryAll, "应有「全部重试」");
    await click(retryAll!);
    assert.equal(failedMutations().length, 0, "重试的应离开失败清单");
    assert.equal(pendingCount(), 1, "并回到待同步队列，等联网后重放");
});

test("「清空清单」：一次性清掉全部失败项", async t => {
    t.after(cleanup);
    await seedFailed("createSite", [{ name: "A" }]);
    await seedFailed("updateSite", [{ id: 2, name: "B" }]);
    assert.equal(failedMutations().length, 2);
    mount();
    await click(buttonByText("查看")!);
    const clear = buttonByText("清空清单");
    assert.ok(clear, "展开后应有「清空清单」");
    await click(clear!);
    assert.equal(failedMutations().length, 0);
});

test("认不出的操作类型：原样显示，不显示空白", async t => {
    t.after(cleanup);
    await seedFailed("someFutureOp", []);
    mount();
    await click(buttonByText("查看")!);
    const text = bodyText();
    assert.ok(text.includes("someFutureOp"), `未登记的类型应原样显示，实际 ${JSON.stringify(text)}`);
});
