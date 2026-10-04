// tests/auditDialog.dom.test.tsx
// 审计日志弹窗（仅站点所有者可见）。
//
// 为什么是它：这是「事后溯源」的唯一界面，而且它的失败模式特别安静 ——
//   拉不到日志时如果只显示一个空列表，用户会以为真的没有记录，
//   而实际原因可能是权限或网络。所以这里最该钉住的是**错误态要说得出来**，
//   以及「切到前端错误才拉那份数据」（平时别占一次查询）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AuditDialog from "../src/components/AuditDialog";
import type { NavigationClient } from "../src/API/client";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface AuditRow {
    id: number;
    action: string;
    actor: string;
    ip: string;
    detail: string;
    created_at: string;
}

interface ErrorGroup {
    key: string;
    source: string;
    message: string;
    count: number;
    lastAt: string;
    paths: string[];
}

interface FakeClientOpts {
    rows?: AuditRow[];
    hasMore?: boolean;
    auditError?: Error;
    groups?: ErrorGroup[];
    errorsError?: Error;
}

function makeClient(opts: FakeClientOpts = {}) {
    const calls = { audit: 0, clientErrors: 0, lastActor: undefined as string | undefined };
    const client = {
        getAuditLog: async (o: { actor?: string; offset?: number } = {}) => {
            calls.audit++;
            calls.lastActor = o.actor;
            if (opts.auditError) throw opts.auditError;
            return {
                success: true,
                log: opts.rows ?? [],
                hasMore: opts.hasMore ?? false,
            };
        },
        getClientErrors: async () => {
            calls.clientErrors++;
            if (opts.errorsError) throw opts.errorsError;
            return { success: true, groups: opts.groups ?? [] };
        },
    } as unknown as NavigationClient;
    return { client, calls };
}

const ROW: AuditRow = {
    id: 1,
    action: "login.success",
    actor: "admin",
    ip: "203.0.113.7",
    detail: "从浏览器登录",
    created_at: "2026-10-01 09:30:00",
};

function mount(client: NavigationClient, retentionDays?: number) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <AuditDialog open client={client} onClose={() => {}} retentionDays={retentionDays} />
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

/** 等 effect 里的异步拉取落地（不用固定 sleep：CI 上一睡就偶发红） */
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

async function clickAsync(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

test("拉到了日志：动作码翻译成中文，IP 也显示出来", async () => {
    const { client } = makeClient({ rows: [ROW] });
    mount(client);
    await waitFor("日志渲染出来", () => (document.body.textContent ?? "").includes("登录成功"));
    const text = document.body.textContent ?? "";
    assert.match(text, /登录成功/, "login.success 要显示中文名，不能把原始动作码甩给用户");
    assert.equal(text.includes("login.success"), false, "不该出现原始动作码");
    assert.match(text, /203\.0\.113\.7/, "IP 要显示出来");
    assert.match(text, /admin/);
    cleanup();
});

test("拉不到日志：说清楚是「没读到」而不是「没有记录」", async () => {
    const { client } = makeClient({ auditError: new Error("仅站点所有者可查看") });
    mount(client);
    await waitFor("错误态渲染出来", () => (document.body.textContent ?? "").includes("没读到审计日志"));
    const text = document.body.textContent ?? "";
    assert.match(text, /没读到审计日志/, "空白列表和「没读到」长得一样，必须说出来");
    assert.match(text, /仅站点所有者可查看/);
    assert.equal(text.includes("暂无审计记录"), false, "错误时不能显示「暂无记录」");
    assert.ok(buttonByText("重试"), "要给一个重试入口");
    cleanup();
});

test("真的没有记录：显示「暂无审计记录」", async () => {
    const { client } = makeClient({ rows: [] });
    mount(client);
    await waitFor(
        "空态渲染出来",
        () => (document.body.textContent ?? "").includes("暂无审计记录")
    );
    cleanup();
});

test("保留天数用网站设置里的值，不写死 7 天", async () => {
    const { client } = makeClient({ rows: [] });
    mount(client, 30);
    await waitFor(
        "标题里的保留天数",
        () => (document.body.textContent ?? "").includes("仅保留 30 天")
    );
    cleanup();
});

test("默认只看操作日志，不去拉前端错误（平时不占这份查询）", async () => {
    const { client, calls } = makeClient({ rows: [ROW] });
    mount(client);
    await waitFor("日志渲染出来", () => (document.body.textContent ?? "").includes("登录成功"));
    assert.equal(calls.audit, 1);
    assert.equal(calls.clientErrors, 0, "没切到那个视图就不该拉");
    cleanup();
});

test("切到「前端错误」才拉，并按次数归并展示", async () => {
    const { client, calls } = makeClient({
        rows: [ROW],
        groups: [
            {
                key: "k1",
                source: "site-card",
                message: "Cannot read properties",
                count: 9,
                lastAt: "2026-10-01 09:30:00",
                paths: ["/", "/groups"],
            },
        ],
    });
    mount(client);
    await waitFor("日志渲染出来", () => (document.body.textContent ?? "").includes("登录成功"));

    const tab = document.querySelector<HTMLButtonElement>('[aria-label="前端错误"]');
    assert.ok(tab, "应有「前端错误」视图切换");
    await clickAsync(tab);

    await waitFor("错误聚合渲染出来", () => (document.body.textContent ?? "").includes("Cannot read"));
    assert.equal(calls.clientErrors, 1, "切过去才拉，且只拉一次");
    const text = document.body.textContent ?? "";
    assert.match(text, /共 9 次上报，归为 1 类/);
    assert.match(text, /9 次/);
    cleanup();
});

test("按操作者筛选：只有点「筛选」（或回车）才重新拉，不是每敲一个字都拉", async () => {
    const { client, calls } = makeClient({ rows: [ROW] });
    mount(client);
    await waitFor("首屏日志", () => (document.body.textContent ?? "").includes("登录成功"));
    assert.equal(calls.audit, 1);

    const input = [...document.querySelectorAll<HTMLInputElement>("input")].find(i =>
        (i.getAttribute("placeholder") || "").includes("账号名")
    );
    assert.ok(input, "应有按操作者筛选的输入框");
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
    )?.set;
    await act(async () => {
        setter?.call(input, "alice");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
    });
    assert.equal(calls.audit, 1, "光打字不该触发重新拉取");

    const filter = buttonByText("筛选");
    assert.ok(filter);
    await clickAsync(filter);
    await waitFor("带筛选条件重新拉", () => calls.audit >= 2);
    assert.equal(calls.lastActor, "alice", "筛选条件要真的传下去");
    cleanup();
});
