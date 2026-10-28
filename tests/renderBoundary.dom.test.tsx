// tests/renderBoundary.dom.test.tsx
// src/components/RenderBoundary.tsx 的行为契约。
//
// 为什么值得单独钉：这个组件存在的**全部理由**是「一块崩了别拖垮整页」。它一旦失效，
// 表现不是报错，而是用户最需要自救入口的时候整页被换成「页面出了点问题」——
// 站点列表里某条脏数据就能让「去记事本」「退出登录」一起消失。这类退化很难在
// 冒烟里被发现（冒烟用的是干净数据，压根不会抛错）。
//
// 钉的四件事：
//   1. 正常时它必须**不存在**（不多套一层 DOM、不误报 alert）；
//   2. 崩了要出 role="alert" 且带上 label —— 用户得知道是哪一块崩了；
//   3. 边界只管自己那棵子树，兄弟节点必须还在（这条就是整个组件的存在理由）；
//   4. 「重试」按下去要真的恢复，而不是按了没反应。
//
// ⚠️ 抛错的孩子会让 React 打一屏 console.error（React 19 会把捕获到的错误照旧往
// 控制台吐一份）。这是**预期行为**，不要为了控制台干净去 mock console ——
// 那会把「边界其实没接住、错误冒到根上」这类真问题一起盖掉。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import RenderBoundary from "../src/components/RenderBoundary";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** 在真实 DOM 里挂载（这个组件不 portal，查 host 就够） */
function mount(ui: ReactNode) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(ui);
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

beforeEach(() => {
    // componentDidCatch 会走 utils/errorReporter 的 reportError → sendBeacon。
    // jsdom 没有 sendBeacon，会降级到 fetch('/api/report-error')，在 Node 里是一条
    // 注定失败的真请求（虽然内部已经 catch 住）。用例不关心上报内容，
    // 这里把出口打成空函数，免得每次渲染崩溃都往网络栈里丢一条噪音。
    Object.defineProperty(navigator, "sendBeacon", {
        value: () => true,
        configurable: true,
        writable: true,
    });
});

afterEach(cleanup);

/** 只数兜底块：正常情况下页面上不该有任何 role="alert" */
const alerts = () => [...document.querySelectorAll('[role="alert"]')];

const text = () => (host?.textContent || "").trim();

/** 渲染期必炸的子树。React 会把它拦在边界里，不会冒到根上 */
function Boom(): never {
    throw new Error("boom");
}

// ---------- 正常路径 ----------

test("子树正常时原样渲染，且不出现 role=alert", () => {
    mount(
        <RenderBoundary label="站点列表">
            <div>正常内容</div>
        </RenderBoundary>
    );

    assert.ok(text().includes("正常内容"), `子内容没渲染出来，实际：${text()}`);
    assert.equal(
        alerts().length,
        0,
        "没出错却挂了兜底块 —— 用户会以为界面坏了，而且兜底块里的「重试」会把好好的页面重载"
    );
});

// ---------- 崩了：兜底块要能认出是哪一块 ----------

test("子树抛错时出 role=alert，文案带上传入的 label", () => {
    mount(
        <RenderBoundary label="站点列表">
            <Boom />
        </RenderBoundary>
    );

    assert.equal(alerts().length, 1, "抛错了却没出兜底块 —— 说明错误冒到根边界，整页会变错误页");
    assert.ok(
        text().includes("站点列表这块出了点问题"),
        `兜底文案没带 label，用户不知道是哪一块崩了。实际：${text()}`
    );
});

// ---------- 这整个组件的存在理由：只拦自己那棵子树 ----------

test("子树崩了之后，边界外面的兄弟节点仍然在 DOM 里", () => {
    mount(
        <>
            <div>头部入口</div>
            <RenderBoundary label="站点列表">
                <Boom />
            </RenderBoundary>
            <div>底部入口</div>
        </>
    );

    // 这两个兄弟节点代表「去记事本」「退出登录」这类自救入口。
    // 它们要是跟着一起没了，用户就只剩一个刷新按钮 —— 那正是引入这个边界之前的样子。
    assert.ok(text().includes("头部入口"), "子树崩了却把前面的兄弟节点一起带走了");
    assert.ok(text().includes("底部入口"), "子树崩了却把后面的兄弟节点一起带走了");
    assert.equal(alerts().length, 1, "兜底块本身还得在，否则崩掉的那块变成一块空白");
});

// ---------- 重试 ----------

test("点「重试」调用 onReset 一次，兜底块消失、子树重新渲染", async () => {
    // 脏数据被换掉之后同一个子树应该能正常渲染 —— 用开关模拟 onReset 修好数据
    let shouldThrow = true;
    function Flaky() {
        if (shouldThrow) throw new Error("boom");
        return <div>恢复后的内容</div>;
    }

    let resets = 0;
    const onReset = () => {
        resets += 1;
        shouldThrow = false;
    };

    mount(
        <RenderBoundary label="站点列表" onReset={onReset}>
            <Flaky />
        </RenderBoundary>
    );
    assert.equal(alerts().length, 1, "前置条件：先得崩出来才有得点");

    const retry = [...document.querySelectorAll("button")].find(
        b => (b.textContent || "").trim() === "重试"
    );
    assert.ok(retry, "兜底块里没有「重试」按钮，用户只能自己刷新");

    // retry 内部是 Promise.resolve(onReset()).then(clear)，清 error 发生在微任务里，
    // 所以要用 async 的 act 把那条链路一起冲干净
    await act(async () => {
        retry!.click();
        await Promise.resolve();
    });

    assert.equal(resets, 1, `onReset 被调了 ${resets} 次，应当恰好一次`);
    assert.equal(alerts().length, 0, "点了重试兜底块还在 —— 按钮看着有反应其实没生效");
    assert.ok(
        text().includes("恢复后的内容"),
        `子树没有重新渲染出来，实际：${text()}`
    );
});

test("onReset 返回 Promise 时要等它落地才清 error", async () => {
    // 这条钉的是源码注释里那句「渲染崩溃时子树已卸载，数据没换掉就清 error
    // 会立刻用同一份脏数据再炸一次」。判据：onReset 的 promise 还没 resolve 之前，
    // 兜底块必须仍然在。
    let shouldThrow = true;
    function Flaky() {
        if (shouldThrow) throw new Error("boom");
        return <div>恢复后的内容</div>;
    }

    let release: () => void = () => {};
    const pending = new Promise<void>(resolve => {
        release = resolve;
    });
    const onReset = () => {
        void pending.then(() => {
            shouldThrow = false;
        });
        return pending;
    };

    mount(
        <RenderBoundary label="站点列表" onReset={onReset}>
            <Flaky />
        </RenderBoundary>
    );

    const retry = [...document.querySelectorAll("button")].find(
        b => (b.textContent || "").trim() === "重试"
    )!;
    await act(async () => {
        retry.click();
        await Promise.resolve();
    });
    assert.equal(
        alerts().length,
        1,
        "onReset 还没落地就把 error 清了 —— 会用同一份脏数据立刻重挂子树，用户得连点两次"
    );

    await act(async () => {
        release();
        await pending;
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.equal(alerts().length, 0, "onReset 落地后仍然没恢复");
    assert.ok(text().includes("恢复后的内容"), `子树没有重新渲染出来，实际：${text()}`);
});

// ---------- 刻意不测的一条 ----------
//
// 「不传 onReset 时点重试会 window.location.reload()」这条**不测**：
// jsdom 的 location.reload 是「未实现」桩，调用会往 stderr 打一行 "Not implemented"
// 且不改任何可观测状态，断言只能靠劫持 location 对象 —— 而 jsdom 里 location 的属性
// 大多不可重定义，打桩本身比被测行为还脆。真正的重载行为只能在浏览器里验收。
