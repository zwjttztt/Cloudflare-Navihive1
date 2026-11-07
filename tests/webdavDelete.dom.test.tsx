// tests/webdavDelete.dom.test.tsx
// 「数据安全 → 从 WebDAV 恢复」列表的删除按钮：用户实测「有时要点好几次才删掉」。
//
// 这条链路是 BackupPanel（状态与写操作）→ RestoreTab（纯渲染）。
// 修之前叠了四条根因，任何一条都能让文件「删了又自己冒出来」：
//   ① 失败时 setRemoteFiles(snapshot) 整表回滚，紧接着 finally 的校准又覆盖一次；
//      连续删两条时各自闭包里的旧快照还会把对方已删的带回来；
//   ② DELETE 成功但 PROPFIND 有缓存 / 最终一致性，仍返回旧目录，整表覆盖让文件复活；
//   ③ IconButton 嵌在 ListItemButton 里，stopPropagation 只挡 click，不挡 mousedown /
//      pointerdown，外层 ButtonBase 抢焦点 / 起涟漪 / 重渲染，第一次点击可能被吞；
//   ④ 防连点用 state Set（异步批处理），同一帧里的双击两个都放行。
//   ⑤（QA 追补的 P1）DELETE 在途时用户点「查看远端备份」，非 silent 的
//      pendingDeletedRef.clear() 把屏蔽清空，陈旧 PROPFIND 于是把刚删成功的
//      文件写回并一直留着 —— 见 ⑥ / ⑥b。
//
// 这份用例直接跑 BackupPanel 本体（不是弹窗壳）：零 lazy、零 Dialog，
// client 只桩 webdavList / webdavDelete，毫秒级且能精确控制 PROPFIND 的返回值。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BackupPanel } from "../src/components/BackupDialog";
import type { NavigationClient } from "../src/API/client";
import type { ExportData, WebDavConfig, WebDavFile, WebDavResult } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(cleanup);

const CONFIG: WebDavConfig = {
    url: "https://dav.example.com/remote.php/dav/files/u/",
    username: "u",
    password: "p",
    path: "/navihive",
};

const FILE_A: WebDavFile = { name: "a.json", size: 1024, lastModified: "2026-01-01T00:00:00.000Z" };
const FILE_B: WebDavFile = { name: "b.json", size: 2048, lastModified: "2026-01-02T00:00:00.000Z" };
const FILE_C: WebDavFile = { name: "c.json", size: 4096, lastModified: "2026-01-03T00:00:00.000Z" };

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

interface Notification {
    message: string;
    severity?: "success" | "error" | "info";
}

interface Harness {
    deleteCalls: string[];
    notifications: Notification[];
    readonly listCalls: number;
}

interface MountOptions {
    files: WebDavFile[];
    /** 不传就永远返回挂载时那份原始列表（= 模拟陈旧 PROPFIND） */
    listResult?: (call: number) => Promise<WebDavResult<WebDavFile[]>>;
    deleteResult?: (name: string) => Promise<WebDavResult>;
}

function mount(opts: MountOptions): Harness {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    const deleteCalls: string[] = [];
    const notifications: Notification[] = [];
    let listCalls = 0;
    const original = opts.files;

    const client = {
        webdavList: async (_cfg: Partial<WebDavConfig>): Promise<WebDavResult<WebDavFile[]>> => {
            listCalls += 1;
            if (opts.listResult) return await opts.listResult(listCalls);
            return { success: true, data: original };
        },
        webdavDelete: async (name: string, _cfg: Partial<WebDavConfig>): Promise<WebDavResult> => {
            deleteCalls.push(name);
            if (opts.deleteResult) return await opts.deleteResult(name);
            return { success: true, message: "已删除备份" };
        },
    } as unknown as NavigationClient;

    act(() => {
        root!.render(
            <BackupPanel
                initialTab={1}
                client={client}
                webdavConfig={CONFIG}
                onSaveWebdavConfig={async () => {}}
                onBuildExportData={() => ({}) as ExportData}
                onDownloadLocal={() => {}}
                onImportData={async () => ({})}
                onNotify={(message, severity) => notifications.push({ message, severity })}
                includeCredentials
                onIncludeCredentialsChange={() => {}}
            />
        );
    });

    return {
        deleteCalls,
        notifications,
        get listCalls() {
            return listCalls;
        },
    };
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

/** 列表里还挂着删除按钮的文件名（= 用户眼里的列表内容） */
const listedNames = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('button[aria-label^="删除 "]')].map(el =>
        (el.getAttribute("aria-label") ?? "").replace(/^删除 /, "")
    );

function deleteButton(name: string): HTMLButtonElement {
    const btn = document.querySelector<HTMLButtonElement>(`button[aria-label="删除 ${name}"]`);
    assert.ok(btn, `应能找到「删除 ${name}」按钮`);
    return btn;
}

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

async function settle(ms = 20) {
    await act(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, ms));
    });
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > deadline) assert.fail(`等了 ${timeoutMs}ms 也没等到：${label}`);
        await settle(10);
    }
}

function refreshButton(): HTMLButtonElement {
    const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === "查看远端备份"
    );
    assert.ok(btn, "恢复页要有「查看远端备份」按钮");
    return btn;
}

/** 主动点一次「查看远端备份」（非 silent 刷新）。不替用例等结果，便于卡竞态窗口 */
async function clickRefresh() {
    // 连续点两次刷新时，前一次的 listLoading 会短暂把按钮置灰；按状态等，不睡固定时长
    await waitFor("「查看远端备份」恢复可点", () => !refreshButton().disabled);
    const btn = refreshButton();
    assert.equal(
        btn.disabled,
        false,
        "删除期间「查看远端备份」应当可点：listLoading 只在主动刷新时为 true"
    );
    await act(async () => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/** 让用户主动点一次「查看远端备份」，把列表灌进 state */
async function loadList() {
    await clickRefresh();
    await waitFor("远端列表渲染出来", () => listedNames().length > 0);
}

// ── ① 一次点击必定少一条，DELETE 只调一次 ─────────────────────────────────
test("① 点击一次删除：列表立即少一条，webdavDelete 只被调用一次", async () => {
    const gate = deferred<WebDavResult>();
    const h = mount({
        files: [FILE_A, FILE_B, FILE_C],
        // DELETE 先挂住：断言的是「点下去那一刻」的乐观更新，不是跑完之后的校准
        deleteResult: () => gate.promise,
    });
    await loadList();
    assert.deepEqual(listedNames(), ["a.json", "b.json", "c.json"]);

    click(deleteButton("a.json"));

    assert.deepEqual(listedNames(), ["b.json", "c.json"], "点下去要立刻从列表摘掉");
    assert.deepEqual(h.deleteCalls, ["a.json"], "webdavDelete 只能被调一次");

    gate.resolve({ success: true, message: "已删除备份" });
    await settle();
});

test("①b 同一帧双击同一颗删除按钮：webdavDelete 仍然只调一次（ref 同步防连点）", async () => {
    const gate = deferred<WebDavResult>();
    const h = mount({ files: [FILE_A, FILE_B], deleteResult: () => gate.promise });
    await loadList();

    const btn = deleteButton("a.json");
    act(() => {
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(h.deleteCalls, ["a.json"], "state Set 会漏掉同一帧的第二次点击，ref 不会");
    assert.deepEqual(listedNames(), ["b.json"]);

    gate.resolve({ success: true });
    await settle();
});

// ── ② 直接回归「要点好几次」：DELETE 成功但校准仍返回旧文件 ───────────────
test("② DELETE 成功但随后的 PROPFIND 仍返回旧文件 → 该文件不会重新出现", async () => {
    const h = mount({
        files: [FILE_A, FILE_B, FILE_C],
        // 每一次列目录（含删除后的静默校准）都返回原始三份：
        // 模拟 WebDAV 服务缓存 / 最终一致性，DELETE 还没在 PROPFIND 上生效
        listResult: async () => ({ success: true, data: [FILE_A, FILE_B, FILE_C] }),
        deleteResult: async () => ({ success: true, message: "已删除备份" }),
    });
    await loadList();
    assert.equal(h.listCalls, 1, "初始列目录 1 次");

    click(deleteButton("a.json"));
    await waitFor("删除后的静默校准跑完", () => h.listCalls >= 2);
    // 再多等几帧，确保没有迟到的整表覆盖把文件加回来
    await settle(40);

    assert.ok(
        !listedNames().includes("a.json"),
        "陈旧 PROPFIND 把刚删的文件又加回来了 —— 这正是用户要点好几次的原因"
    );
    assert.deepEqual(listedNames(), ["b.json", "c.json"]);
    assert.deepEqual(h.deleteCalls, ["a.json"], "用户只需要点一次");
});

// ── ③ DELETE 明确失败：放回 + 说清原因 ────────────────────────────────────
test("③ DELETE 返回 success=false：该文件放回，并给出带原因的错误提示", async () => {
    const h = mount({
        files: [FILE_A, FILE_B],
        listResult: async () => ({ success: true, data: [FILE_A, FILE_B] }),
        deleteResult: async () => ({ success: false, message: "服务端拒绝删除" }),
    });
    await loadList();

    click(deleteButton("a.json"));
    await waitFor("失败提示出现", () => h.notifications.some(n => n.severity === "error"));
    await settle(30);

    assert.ok(listedNames().includes("a.json"), "DELETE 失败要把这一条放回列表");
    assert.deepEqual(listedNames().sort(), ["a.json", "b.json"]);
    const error = h.notifications.find(n => n.severity === "error");
    assert.ok(error, "必须给出明确的失败提示，不能点了没反应");
    assert.match(error.message, /删除「a\.json」失败/);
    assert.match(error.message, /服务端拒绝删除/, "提示要说明失败原因");
    assert.match(error.message, /文件已保留在列表中/, "提示要交代文件还在");
});

test("③b DELETE 抛异常（网络断）：同样放回 + 说明原因", async () => {
    const h = mount({
        files: [FILE_A, FILE_B],
        listResult: async () => ({ success: true, data: [FILE_A, FILE_B] }),
        deleteResult: async () => {
            throw new Error("网络中断");
        },
    });
    await loadList();

    click(deleteButton("a.json"));
    await waitFor("异常提示出现", () => h.notifications.some(n => n.severity === "error"));
    await settle(30);

    assert.ok(listedNames().includes("a.json"), "异常也要把这一条放回");
    const error = h.notifications.find(n => n.severity === "error");
    assert.match(error!.message, /网络中断/);
});

// ── ④ 连续快速删两个文件：互不覆盖 ────────────────────────────────────────
test("④ 连续快速删两个文件：两条都消失、互不影响，校准也不能带回来", async () => {
    const gateA = deferred<WebDavResult>();
    const gateB = deferred<WebDavResult>();
    const h = mount({
        files: [FILE_A, FILE_B, FILE_C],
        listResult: async () => ({ success: true, data: [FILE_A, FILE_B, FILE_C] }),
        deleteResult: async name => (name === "a.json" ? gateA.promise : gateB.promise),
    });
    await loadList();

    // 先把两颗按钮都抓在手里：点第一颗后另一颗就被乐观移出 DOM 了
    const btnA = deleteButton("a.json");
    const btnB = deleteButton("b.json");
    act(() => {
        btnA.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        btnB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(listedNames(), ["c.json"], "两条都要立刻消失");
    assert.deepEqual(h.deleteCalls, ["a.json", "b.json"], "两条各删一次");

    gateA.resolve({ success: true, message: "已删除备份" });
    gateB.resolve({ success: true, message: "已删除备份" });
    await waitFor("两次静默校准都跑完", () => h.listCalls >= 3);
    await settle(40);

    assert.deepEqual(listedNames(), ["c.json"], "旧快照 / 陈旧 PROPFIND 都不许把两条带回来");
});

test("④b 连续删两条、其中一条失败：失败那条放回，成功那条不复活", async () => {
    const h = mount({
        files: [FILE_A, FILE_B, FILE_C],
        listResult: async () => ({ success: true, data: [FILE_A, FILE_B, FILE_C] }),
        deleteResult: async name =>
            name === "a.json"
                ? { success: false, message: "权限不足" }
                : { success: true, message: "已删除备份" },
    });
    await loadList();

    const btnA = deleteButton("a.json");
    const btnB = deleteButton("b.json");
    act(() => {
        btnA.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        btnB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor("两条 DELETE 都跑完", () => h.deleteCalls.length === 2);
    await waitFor("两次静默校准都跑完", () => h.listCalls >= 3);
    await settle(40);

    const names = listedNames();
    assert.ok(names.includes("a.json"), "失败那条要放回");
    assert.ok(!names.includes("b.json"), "成功那条不能被另一条的整表快照带回来");
    assert.ok(names.includes("c.json"), "无关的第三条不受影响");
});

// ── ⑤ 删除按钮不触发选中 ─────────────────────────────────────────────────
test("⑤ 点删除图标时 setSelectedRemote 不被误触发（按钮在可点行之外）", async () => {
    const h = mount({
        files: [FILE_A, FILE_B],
        listResult: async () => ({ success: true, data: [FILE_A, FILE_B] }),
        // 故意失败，让 a.json 那一行留在列表里，才能观察它有没有被误选中
        deleteResult: async () => ({ success: false, message: "服务端拒绝" }),
    });
    await loadList();

    assert.equal(
        deleteButton("a.json").closest(".MuiListItemButton-root"),
        null,
        "删除按钮必须是 ListItemButton 的兄弟节点，不能嵌在可点行里"
    );

    // 先选中 b.json
    const rowB = [...document.querySelectorAll<HTMLElement>(".MuiListItemButton-root")].find(
        el => (el.textContent || "").includes("b.json")
    );
    assert.ok(rowB, "应能找到 b.json 那一行");
    click(rowB);
    await waitFor("b.json 变成已选中", () =>
        [...document.querySelectorAll<HTMLElement>(".MuiListItemButton-root")].some(
            el => (el.textContent || "").includes("b.json") && (el.textContent || "").includes("已选中")
        )
    );

    click(deleteButton("a.json"));
    await waitFor("删除失败提示出现", () => h.notifications.some(n => n.severity === "error"));
    await settle(30);

    const rows = [...document.querySelectorAll<HTMLElement>(".MuiListItemButton-root")];
    const rowA = rows.find(el => (el.textContent || "").includes("a.json"));
    assert.ok(rowA, "失败后 a.json 应该还在列表里");
    assert.ok(
        !(rowA.textContent || "").includes("已选中"),
        "点删除不该顺手把 a.json 选中（外层 ListItemButton 的 onClick 被触发了）"
    );
    const rowBAfter = rows.find(el => (el.textContent || "").includes("b.json"));
    assert.ok(
        (rowBAfter?.textContent || "").includes("已选中"),
        "删除点击不该把原来选中的 b.json 改掉"
    );
});

// ── ⑥ QA 追补的 P1：删除在途 + 主动刷新 ──────────────────────────────────
// 复现序列（webdavList 恒返回旧列表 = PROPFIND 缓存长期不生效）：
//   点删除 → DELETE 挂起 → 在 DELETE 回来之前点「查看远端备份」→ resolve DELETE
//   success → 等静默校准完成 → 文件绝不能留在列表里，也不该需要再点第二次。
test("⑥ DELETE 在途时主动刷新：陈旧 PROPFIND 不能把刚删成功的文件写回", async () => {
    const gate = deferred<WebDavResult>();
    const h = mount({
        files: [FILE_A, FILE_B, FILE_C],
        // 每一次列目录（初始 / 主动刷新 / 静默校准）都返回原始三份
        listResult: async () => ({ success: true, data: [FILE_A, FILE_B, FILE_C] }),
        deleteResult: () => gate.promise,
    });
    await loadList();
    assert.deepEqual(listedNames(), ["a.json", "b.json", "c.json"]);

    click(deleteButton("a.json")); // DELETE 挂起，a.json 被乐观摘掉
    assert.deepEqual(listedNames(), ["b.json", "c.json"]);
    assert.deepEqual(h.deleteCalls, ["a.json"]);

    // 关键窗口：DELETE 还没 settle 就主动刷新。修复前这里的 clear() 会撤掉屏蔽，
    // 主动刷新把 a.json 写回，随后 success 的静默校准也没法再过滤它。
    await clickRefresh();
    await waitFor("主动刷新完成", () => h.listCalls >= 2);
    await settle(20);

    gate.resolve({ success: true, message: "已删除备份" });
    await waitFor("删除后的静默校准完成", () => h.listCalls >= 3);
    await settle(40);

    assert.ok(
        !listedNames().includes("a.json"),
        "删除在途期间主动刷新，随后 DELETE 成功 → 文件不该复活（用户不用再点第二次）"
    );
    assert.deepEqual(listedNames(), ["b.json", "c.json"]);
    assert.deepEqual(h.deleteCalls, ["a.json"], "webdavDelete 只该被调用一次");
});

// ⑥b 同时把「服务端长期陈旧」时的**两步语义**钉死，不让它只靠实现细节隐含表达。
//
// 语义选择：**两步后以服务端真相为准**，不是「删除成功后永久屏蔽直到服务端不再列出」。
//   · 若第一次主动刷新就放行陈旧 PROPFIND，用户刚点完删除、随手点一下刷新就看到
//     文件回来 —— 又变成「删了又冒出来」，回到本 bug 的原始症状；
//   · 若一直屏蔽到服务端不再列出，服务端长期陈旧 / 缓存永不失效时，同名的**新**
//     备份会被永久藏起来 —— 那会改坏 QA 已验的「不存在永久屏蔽」。
// 所以给最终一致性一次刷新的宽限：第一次仍隐藏、同时放开屏蔽；第二次起以服务端
// 列表为准。正常服务端在静默校准那一步就已确认删除，两次刷新都不会有 a.json ——
// 两步差异只在「服务端长期陈旧」这个前提下才出现，正是本用例专门构造的前提。
test("⑥b 对照：删除完成后主动刷新，第 1 次仍不复活、第 2 次才以服务端旧列表为准", async () => {
    const h = mount({
        files: [FILE_A, FILE_B, FILE_C],
        listResult: async () => ({ success: true, data: [FILE_A, FILE_B, FILE_C] }),
        deleteResult: async () => ({ success: true, message: "已删除备份" }),
    });
    await loadList();

    click(deleteButton("a.json"));
    await waitFor("删除后的静默校准完成", () => h.listCalls >= 2);
    await settle(20);
    assert.ok(!listedNames().includes("a.json"), "删除完成后界面里本来就不该有 a.json");

    // 第 1 次：shieldedNames 快照仍含 a.json，界面继续不显示；
    // 同时非 silent 的清除循环把它从 pendingDeletedRef 移走（放开的出口）。
    await clickRefresh();
    await waitFor("第 1 次主动刷新完成", () => h.listCalls >= 3);
    await settle(30);
    assert.deepEqual(
        listedNames(),
        ["b.json", "c.json"],
        "第 1 次主动刷新不能让陈旧 PROPFIND 把文件带回来"
    );

    // 第 2 次：屏蔽已空，服务端真相生效（陈旧列表里的 a.json 显示出来）。
    // 这条断言明确排除了「删除成功后永久屏蔽」—— 若谁把它改成永久屏蔽，这里会红。
    await clickRefresh();
    await waitFor("第 2 次主动刷新完成", () => h.listCalls >= 4);
    await settle(30);
    assert.deepEqual(
        listedNames(),
        ["a.json", "b.json", "c.json"],
        "两步后必须以服务端真相为准：不能把同名新备份永久屏蔽"
    );
    assert.deepEqual(h.deleteCalls, ["a.json"], "整个过程只删了一次，不需要再点第二次");
});

// ── ⑥c listEpochRef：失败放回 → 过期列目录响应晚回来 ─────────────────────
// 确认「只在失败路径 ++、成功路径靠 finally 的新一次静默校准兜底」这个设计：
// DELETE 失败会把那一条放回并 ++ 代次；此前发出、却**更晚**回来的主动刷新响应
// 必须被丢弃，否则它的 shieldedNames 快照（还含 a.json）会把刚放回的文件又藏掉。
test("⑥c DELETE 失败放回后，更早发出的列目录响应晚回来也不能把文件藏掉", async () => {
    const refreshGate = deferred<WebDavResult<WebDavFile[]>>();
    const deleteGate = deferred<WebDavResult>();
    const h = mount({
        files: [FILE_A, FILE_B, FILE_C],
        listResult: async call => {
            // call 1 = 初始加载；call 2 = 故意挂起的主动刷新；call 3 = 静默校准
            if (call === 2) return await refreshGate.promise;
            return { success: true, data: [FILE_A, FILE_B, FILE_C] };
        },
        deleteResult: () => deleteGate.promise,
    });
    await loadList();

    click(deleteButton("a.json")); // DELETE 挂起，a.json 乐观移除，仍属「在途」
    assert.deepEqual(listedNames(), ["b.json", "c.json"]);

    await clickRefresh(); // call 2 发出并挂起（此时快照里还有 a.json）
    await waitFor("主动刷新已发出", () => h.listCalls >= 2);

    deleteGate.resolve({ success: false, message: "服务端拒绝删除" });
    await waitFor("失败提示出现", () => h.notifications.some(n => n.severity === "error"));
    await waitFor("失败后的静默校准完成", () => h.listCalls >= 3);
    await settle(30);
    assert.ok(
        listedNames().includes("a.json"),
        "DELETE 失败要把这一条放回列表"
    );

    // 过期响应最后才回来：代次不匹配 → 整份结果作废，不许覆盖刚放回的那一条
    refreshGate.resolve({ success: true, data: [FILE_A, FILE_B, FILE_C] });
    await settle(40);
    assert.deepEqual(
        listedNames(),
        ["a.json", "b.json", "c.json"],
        "过期的主动刷新响应回来也不许把失败放回的文件藏掉（listEpochRef 兜底）"
    );
    assert.deepEqual(h.deleteCalls, ["a.json"]);
});
