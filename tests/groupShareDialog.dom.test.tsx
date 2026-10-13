// src/components/GroupShareDialog.tsx 的直测（243 行，此前零覆盖）。
//
// 为什么是它：分组分享（2026-10-11 阶段④）与笔记分享是**同一天、按同一套语义**加的，
// 但笔记分享的对话框有真渲染用例（见 notes.dom.test.tsx 的「分享设置弹窗」），
// 这个一个都没有 —— 覆盖率体检（docs/coverage-checkup-2026-10-13.md）把它列为
// 分享 UI 三件套零覆盖的第一名。
//
// 钉的都是「改坏了界面不报错、只是行为悄悄变掉」的那类约定，最重要的是两条口令语义：
//   - 创建时空串要归一成 **null**（不设口令），不能把空字符串写进库；
//   - 更新时**没动过口令要传 undefined**（保持原口令），传 null 会把口令清掉 ——
//     那是一条静默的安全回归：用户只想改有效期，口令没了。
//
// 关于有效期下拉：刻意不测「点开 Select 再点选项」。MUI 的 Select 弹层在 jsdom 里
// 要模拟 mousedown + portal 查找，容易做成偶发红（而偶发红的测试比没有测试更糟，
// 它会训练人忽略红色）。改用更稳的口径：断言「后端返回的 expires_at 被映射成哪个
// 有效期」以及「最终发给 api 的是哪个 days」—— 那正是这条逻辑的意义所在。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import GroupShareDialog, { type GroupShareDialogProps } from "../src/components/GroupShareDialog";
import type { GroupShareConfig } from "../src/API/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const TOKEN = "a".repeat(64);
const GROUP_ID = 7;

type ShareApi = GroupShareDialogProps["api"];

interface Recorder {
    get: number[];
    create: Array<[number, number | null, string | null | undefined]>;
    update: Array<[number, number | null, string | null | undefined]>;
    revoke: number[];
}

function makeApi(opts: {
    config?: GroupShareConfig | null;
    created?: GroupShareConfig | null;
    updated?: GroupShareConfig | null;
} = {}): { api: ShareApi; rec: Recorder; notes: Array<[string, string | undefined]> } {
    const rec: Recorder = { get: [], create: [], update: [], revoke: [] };
    const notes: Array<[string, string | undefined]> = [];
    return {
        rec,
        notes,
        api: {
            getGroupShareConfig: async (id: number) => {
                rec.get.push(id);
                return opts.config ?? null;
            },
            createGroupShare: async (id: number, days: number | null, password?: string | null) => {
                rec.create.push([id, days, password]);
                return opts.created ?? null;
            },
            updateGroupShare: async (id: number, days: number | null, password?: string | null) => {
                rec.update.push([id, days, password]);
                return opts.updated ?? null;
            },
            revokeGroupShare: async (id: number) => {
                rec.revoke.push(id);
                return { success: true };
            },
        },
    };
}

function mount(handlers: {
    api: ShareApi;
    onClose?: () => void;
    onNotify?: (m: string, s?: "success" | "error" | "info") => void;
    open?: boolean;
}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <GroupShareDialog
                open={handlers.open ?? true}
                groupId={GROUP_ID}
                groupName="常用工具"
                api={handlers.api}
                onClose={handlers.onClose ?? (() => {})}
                onNotify={handlers.onNotify}
            />
        );
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

afterEach(cleanup);

const pageText = () => document.body.textContent ?? "";
const byAttr = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

async function clickAsync(el: Element | null | undefined) {
    assert.ok(el, "要点的元素不在");
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

/** 等 promise 链跑完（组件的 refresh / create 都是 async） */
async function settle(ms = 20) {
    await act(async () => {
        await new Promise(r => setTimeout(r, ms));
    });
}

/** 等条件成立，而不是睡固定时长：CI 慢机上固定 sleep 会偶发不够用 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > deadline) assert.fail(`等了 ${timeoutMs}ms 也没等到：${label}`);
        await settle(10);
    }
}

/** 给受控输入赋值：必须走原生 value setter 再派发 input，直接改 el.value 会被 React 吞掉 */
function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

const cfg = (over: Partial<GroupShareConfig> = {}): GroupShareConfig => ({
    token: TOKEN,
    expires_at: Date.now() + 7 * 86_400_000,
    views: 5,
    hasPassword: false,
    ...over,
});

// ---------- 读取与两个态 ----------

test("打开后读配置；没有分享时给创建表单，不出现链接与撤销", async () => {
    const { api, rec } = makeApi({ config: null });
    mount({ api });
    // 读之前是「读取中…」，不该直接把创建表单拍出来
    assert.ok(pageText().includes("读取中"), "读取中要有占位");
    await waitFor("创建表单出现", () => !!byAttr("[data-group-share-create='1']"));

    assert.deepEqual(rec.get, [GROUP_ID], "要按传进来的 groupId 读配置");
    assert.equal(byAttr("[data-group-share-create='1']") !== null, true, "要有创建按钮");
    assert.equal(byAttr("[data-group-share-link='1']"), null, "没分享就不该有链接框");
    assert.equal(byAttr("[data-group-share-revoke='1']"), null, "没分享就不该有撤销按钮");
    // 说明文案要讲清「访问者能看到什么」—— 这是分享功能的知情权
    assert.ok(pageText().includes("不含站点密码"), "要说明公开页不含站点密码");
});

test("已有分享时显示 /sg/ 链接、浏览次数，且按 hasPassword 标注受口令保护", async () => {
    const { api } = makeApi({ config: cfg({ hasPassword: true, views: 12 }) });
    mount({ api });
    await waitFor("链接框出现", () => !!byAttr("[data-group-share-link='1']"));

    const link = byAttr<HTMLElement>("[data-group-share-link='1']")!.querySelector("input")!;
    // 路由必须是 /sg/<token>：写错了访客打开就是 404，而主人界面完全看不出异常
    assert.equal(link.value, `http://localhost/sg/${TOKEN}`, "链接要走 /sg/<token>");
    assert.ok(pageText().includes("浏览 12 次"), "要显示浏览次数");
    assert.ok(pageText().includes("受口令保护"), "hasPassword 为真要标注");
    assert.ok(byAttr("[data-group-share-update='1']"), "要有更新设置按钮");
    assert.equal(byAttr("[data-group-share-create='1']"), null, "已有分享就不该再给创建按钮");
});

test("hasPassword 为假时不标注受口令保护", async () => {
    const { api } = makeApi({ config: cfg({ hasPassword: false }) });
    mount({ api });
    await waitFor("链接框出现", () => !!byAttr("[data-group-share-link='1']"));
    assert.ok(!pageText().includes("受口令保护"), "没设口令不该标注");
});

test("后端返回的 expires_at 映射成对应有效期：永久 / 远期 30 天 / 近期 7 天", async () => {
    // 映射逻辑在 refresh() 里：expires_at === null → 永久；> 3 天 → 30；否则 7。
    // 映射错了的后果是「主人以为设的是 30 天，实际发给后端的是 7 天」。
    const forever = makeApi({ config: cfg({ expires_at: null }) });
    mount({ api: forever.api });
    await waitFor("永久生效", () => pageText().includes("永久"));
    cleanup();

    const far = makeApi({ config: cfg({ expires_at: Date.now() + 20 * 86_400_000 }) });
    mount({ api: far.api });
    await waitFor("30 天", () => pageText().includes("30 天"));
    cleanup();

    const near = makeApi({ config: cfg({ expires_at: Date.now() + 2 * 86_400_000 }) });
    mount({ api: near.api });
    await waitFor("7 天", () => pageText().includes("7 天"));
});

// ---------- 创建：空口令要归一成 null ----------

test("创建时空口令要归一成 null 发给后端（不能把空字符串写进库）", async () => {
    const { api, rec, notes } = makeApi({ created: cfg({ hasPassword: false }) });
    mount({ api, onNotify: (m, s) => notes.push([m, s]) });
    await waitFor("创建按钮出现", () => !!byAttr("[data-group-share-create='1']"));

    await clickAsync(byAttr("[data-group-share-create='1']"));
    await waitFor("api 收到创建", () => rec.create.length > 0);

    // days 默认 7；口令框是空的 → 必须传 null（后端语义：null = 不设口令）
    assert.deepEqual(rec.create[0], [GROUP_ID, 7, null], "空口令要归一成 null");
    assert.deepEqual(notes[0], ["分享已创建：链接立即生效，旧链接已轮换失效", "success"]);
});

test("创建时填了口令就原样带过去", async () => {
    const { api, rec } = makeApi({ created: cfg({ hasPassword: true }) });
    mount({ api });
    await waitFor("口令框出现", () => !!byAttr("[data-group-share-pw-input='1']") || !!byAttr("input[aria-label='访问口令']"));
    setInputValue(byAttr<HTMLInputElement>("input[aria-label='访问口令']")!, "s3cret");
    await clickAsync(byAttr("[data-group-share-create='1']"));
    await waitFor("api 收到创建", () => rec.create.length > 0);
    assert.deepEqual(rec.create[0], [GROUP_ID, 7, "s3cret"], "填了口令要原样传");
});

test("创建失败（后端回 null）要提示原因，且不切到已分享态", async () => {
    const { api, notes } = makeApi({ created: null });
    mount({ api, onNotify: (m, s) => notes.push([m, s]) });
    await waitFor("创建按钮出现", () => !!byAttr("[data-group-share-create='1']"));
    await clickAsync(byAttr("[data-group-share-create='1']"));
    await waitFor("提示创建失败", () => notes.some(n => n[0].includes("创建失败")));
    assert.deepEqual(notes[0], ["创建失败：分组不存在", "error"]);
    assert.equal(byAttr("[data-group-share-link='1']"), null, "失败不该假装已有分享");
});

// ---------- 更新：没动过口令必须传 undefined ----------

test("更新时没动过口令 → 第三参是 undefined（保持原口令），不是 null", async () => {
    // ⚠️ 这是本文件最重要的一条。组件里写的是
    //   updateGroupShare(groupId, days, password === "" ? undefined : password || null)
    // 谁把它「顺手简化」成 `password || null`，空串就会变成 null = 清除口令 ——
    // 用户只想改有效期，口令静默没了，而且界面上没有任何提示。
    const { api, rec } = makeApi({
        config: cfg({ hasPassword: true }),
        updated: cfg({ hasPassword: true }),
    });
    mount({ api });
    await waitFor("更新按钮出现", () => !!byAttr("[data-group-share-update='1']"));

    await clickAsync(byAttr("[data-group-share-update='1']"));
    await waitFor("api 收到更新", () => rec.update.length > 0);

    assert.equal(rec.update[0][0], GROUP_ID);
    // 默认配置的 expires_at 是 7 天后，而映射规则是「> 3 天 → 30」，
    // 所以这里发出去的是 30（映射本身由上面那条 expires_at 用例钉住）
    assert.equal(rec.update[0][1], 30, "没改有效期就按读到的映射发");
    assert.equal(rec.update[0][2], undefined, "没动过口令必须传 undefined（保持）");
});

test("更新时填了口令 → 第三参是那个字符串（重设）", async () => {
    const { api, rec } = makeApi({ config: cfg(), updated: cfg({ hasPassword: true }) });
    mount({ api });
    await waitFor("口令框出现", () => !!byAttr("input[aria-label='访问口令']"));
    setInputValue(byAttr<HTMLInputElement>("input[aria-label='访问口令']")!, "new-one");
    await clickAsync(byAttr("[data-group-share-update='1']"));
    await waitFor("api 收到更新", () => rec.update.length > 0);
    assert.equal(rec.update[0][2], "new-one", "填了要重设");
});

test("更新失败（后端回 null）要提示原因", async () => {
    const { api, notes } = makeApi({ config: cfg(), updated: null });
    mount({ api, onNotify: (m, s) => notes.push([m, s]) });
    await waitFor("更新按钮出现", () => !!byAttr("[data-group-share-update='1']"));
    await clickAsync(byAttr("[data-group-share-update='1']"));
    await waitFor("提示更新失败", () => notes.some(n => n[0].includes("更新失败")));
    assert.deepEqual(notes[0], ["更新失败：分享不存在", "error"]);
});

// ---------- 撤销：必须先确认 ----------

test("撤销要点两次：先弹确认，确认后才真调后端", async () => {
    const { api, rec, notes } = makeApi({ config: cfg() });
    mount({ api, onNotify: (m, s) => notes.push([m, s]) });
    await waitFor("撤销按钮出现", () => !!byAttr("[data-group-share-revoke='1']"));

    await clickAsync(byAttr("[data-group-share-revoke='1']"));
    await waitFor("确认弹窗出现", () => !!byAttr("[data-confirm-action='confirm']"));
    assert.deepEqual(rec.revoke, [], "弹窗阶段绝不能调后端");
    // 确认框要说清后果（站内 ConfirmDialog 的硬规则：危险操作必须说清影响）
    assert.ok(pageText().includes("立即失效"), "确认框要说明链接会失效");

    await clickAsync(byAttr("[data-confirm-action='confirm']"));
    await waitFor("后端收到撤销", () => rec.revoke.length > 0);
    assert.deepEqual(rec.revoke, [GROUP_ID]);
    assert.deepEqual(notes[0], ["分享已撤销", "success"]);
    // 撤销后回到创建态
    await waitFor("回到创建态", () => !!byAttr("[data-group-share-create='1']"));
    assert.equal(byAttr("[data-group-share-link='1']"), null, "撤销后不该还显示旧链接");
});

test("撤销确认框点取消：不调后端，也不离开已分享态", async () => {
    const { api, rec } = makeApi({ config: cfg() });
    mount({ api });
    await waitFor("撤销按钮出现", () => !!byAttr("[data-group-share-revoke='1']"));
    await clickAsync(byAttr("[data-group-share-revoke='1']"));
    await waitFor("确认弹窗出现", () => !!byAttr("[data-confirm-action='cancel']"));
    await clickAsync(byAttr("[data-confirm-action='cancel']"));
    await settle();
    assert.deepEqual(rec.revoke, [], "取消绝不能调后端");
    assert.ok(byAttr("[data-group-share-link='1']"), "取消后要还在已分享态");
});

// ---------- 关闭 ----------

test("标题栏关闭按钮调 onClose", async () => {
    let closed = 0;
    const { api } = makeApi({ config: null });
    mount({ api, onClose: () => { closed += 1; } });
    await waitFor("创建表单出现", () => !!byAttr("[data-group-share-create='1']"));
    await clickAsync(byAttr("button[aria-label='关闭']"));
    assert.equal(closed, 1, "点关闭要通知外层");
});

// ---------- 读取失败 ----------

test("读配置失败要提示，且不能卡在「读取中…」", async () => {
    const notes: Array<[string, string | undefined]> = [];
    const rec = { get: 0 };
    const api: ShareApi = {
        getGroupShareConfig: async () => {
            rec.get += 1;
            throw new Error("网络断了");
        },
        createGroupShare: async () => null,
        updateGroupShare: async () => null,
        revokeGroupShare: async () => ({ success: true }),
    };
    mount({ api, onNotify: (m, s) => notes.push([m, s]) });
    await waitFor("提示读取失败", () => notes.some(n => n[0].includes("读取分享配置失败")));
    assert.equal(notes[0][1], "error");
    // 关键是 loadedOnce 仍然被置位：否则界面永远停在「读取中…」，用户什么都做不了
    await waitFor("脱离读取中", () => !pageText().includes("读取中"));
});
