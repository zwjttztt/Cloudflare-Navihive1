// src/components/AddSiteDialog.tsx 的直测（397 行，此前零覆盖）。
//
// 它是**用户最高频的一条路径**（加个网站），却一条用例都没有 ——
// 改坏这里的表现不是报错，而是「按钮点了没反应」或者「字段顺序乱了填错地方」。
//
// 这个组件只管渲染：状态与提交逻辑都在 App 的 useSiteCreator 里，全部走 props 下发，
// 所以这里不需要任何真实网络，把 props 摆好就能钉住界面行为。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AddSiteDialog from "../src/components/AddSiteDialog";
import type { SiteAi } from "../src/context/AiContext";
import type { Site } from "../src/API/types";
import { secretInputSx } from "../src/utils/secretInput";

// jsdom 不实现 -webkit-text-security，CSS.supports 一律返回 false，
// 于是 secretInputType 会走「Firefox 回退」分支给 type=password。
// 但真机上主流浏览器（Chromium / WebKit）走的是**另一条路**：type=text + CSS 遮蔽，
// 那才是「让浏览器根本认不出这是密码字段」的核心，也是要钉住的那条。
// 所以这里把探测结果改成「支持」，让这批用例覆盖真机路径。
// （注意 secretInput.ts 里有模块级缓存，这个 mock 必须在**第一次渲染之前**生效。）
if (typeof CSS === "undefined") {
    Object.defineProperty(globalThis, "CSS", {
        value: { supports: () => true },
        configurable: true,
    });
} else {
    CSS.supports = () => true;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(node);
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

type Opts = {
    site?: Partial<Site>;
    ai?: SiteAi | null;
    aiBusy?: boolean;
    aiMessage?: string;
    aiMessageError?: boolean;
    creating?: boolean;
    showPassword?: boolean;
};

function render(opts: Opts = {}) {
    mount(
        <AddSiteDialog
            open
            onClose={() => {}}
            site={{ name: "", url: "https://example.com/", ...(opts.site ?? {}) }}
            onInputChange={() => {}}
            showPassword={opts.showPassword ?? false}
            onTogglePassword={() => {}}
            creating={opts.creating ?? false}
            onFetchIcon={() => {}}
            onCreate={() => {}}
            ai={opts.ai === undefined ? null : opts.ai}
            aiBusy={opts.aiBusy ?? false}
            aiMessage={opts.aiMessage ?? ""}
            aiMessageError={opts.aiMessageError ?? false}
            onAiComplete={() => {}}
        />
    );
}

// 每个用例之后清干净：上一条要是断言失败抛了异常，残留的 Dialog（portal 到 body）
// 会被下一条用例查到，表现为「明明传了 creating，按钮却没禁用」这种假故障。
afterEach(cleanup);

const byLabel = (label: string) =>
    document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const byId = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`);

// ---------- 字段顺序 ----------

test("字段顺序是 名称 → 链接 → 图标 → 描述 → 备注 → 凭据", () => {
    render();
    const order = ["site-name", "site-url", "site-icon", "site-description", "site-notes", "site-username", "site-password"];
    const found = order.filter(id => byId(id));
    assert.deepEqual(
        found,
        order,
        "顺序和「网站设置」保持一致，改乱了用户会填错地方（这是注释里写明的约定）"
    );
});

// ---------- AI 补全入口 ----------

test("没有可用 AI（ai=null）时，补全入口一个都不出现", () => {
    render({ ai: null });
    assert.equal(
        byLabel("AI 补全名称与简介"),
        null,
        "注释写明：ai 为 null 表示这台机器上没有可用 AI，入口不出现"
    );
});

test("AI 没启用时也不出现入口（默认关，一个字节都不往外发）", () => {
    render({ ai: { enabled: false, ready: false, reason: "没开", siteMeta: async () => ({ ok: false, message: "x" }) } });
    assert.equal(byLabel("AI 补全名称与简介"), null);
});

test("AI 可用时入口出现", () => {
    render({
        ai: { enabled: true, ready: true, reason: "", siteMeta: async () => ({ ok: false, message: "x" }) },
    });
    const btn = byLabel("AI 补全名称与简介");
    assert.ok(btn, "AI 开了就该有入口");
    assert.equal(btn!.hasAttribute("disabled"), false);
});

test("还没填链接时补全按钮禁用（没 URL 无从补全）", () => {
    render({
        site: { url: "" },
        ai: { enabled: true, ready: true, reason: "", siteMeta: async () => ({ ok: false, message: "x" }) },
    });
    assert.equal(byLabel("AI 补全名称与简介")!.hasAttribute("disabled"), true);
});

test("正在补全时按钮禁用，避免连点发出去好几个请求", () => {
    render({
        aiBusy: true,
        ai: { enabled: true, ready: true, reason: "", siteMeta: async () => ({ ok: false, message: "x" }) },
    });
    assert.equal(byLabel("AI 补全名称与简介")!.hasAttribute("disabled"), true);
});

test("AI 消息在失败时也要渲染出来（不能静默吞掉原因）", () => {
    render({ aiMessage: "模型返回超时", aiMessageError: true });
    assert.ok(
        (document.body.textContent || "").includes("模型返回超时"),
        "补全失败却什么都不说，用户只会以为按钮坏了"
    );
});

// ---------- 抓取图标 ----------

test("图标框旁边只有一个「获取图标」按钮", () => {
    render();
    const fetchBtns = [...document.querySelectorAll<HTMLElement>('[aria-label="根据网站链接获取图标URL"]')];
    assert.equal(fetchBtns.length, 1);
    // 钉住一次产品决策：URL 框旁边**曾经**还有个「抓取网站标题和描述」按钮，
    // 用户明确要求去掉了。它要是哪天被加回来，这条会红。
    const allLabels = [...document.querySelectorAll<HTMLElement>("[aria-label]")].map(el =>
        el.getAttribute("aria-label")
    );
    assert.equal(
        allLabels.filter(l => l && /抓取|标题|描述/.test(l)).length,
        0,
        `不该再有抓取标题/描述的入口，实际：${JSON.stringify(allLabels)}`
    );
});

test("没填链接时「获取图标」按钮禁用", () => {
    render({ site: { url: "" } });
    assert.equal(byLabel("根据网站链接获取图标URL")!.hasAttribute("disabled"), true);
});

// ---------- 凭据输入 ----------

test("密码框用 text + CSS 遮蔽，且 name 不是 password", () => {
    render();
    const pwd = byId("site-password");
    assert.ok(pwd);
    assert.equal(
        pwd!.getAttribute("type"),
        "text",
        "type=password 会被密码管理器与浏览器自动填充盯上；用 text + webkit-text-security"
    );
    assert.equal(
        pwd!.getAttribute("name"),
        "site-secret",
        "name 也不能叫 password，否则照样被引擎当成登录字段"
    );
});

test("遮蔽样式本身：支持 CSS 遮蔽时要遮成圆点，点「显示」后撤掉", () => {
    // 遮蔽样式走 MUI 的 sx（emotion 生成 class，不在 inline style 上），
    // 所以直接测这个函数，比在 DOM 上找 style 属性可靠。
    assert.deepEqual(
        secretInputSx(false),
        { "& input": { WebkitTextSecurity: "disc" } },
        "type 换成 text 之后，全靠这条把内容遮成圆点 —— 丢了就是明文显示在输入框里"
    );
    assert.deepEqual(secretInputSx(true), { "& input": { WebkitTextSecurity: "none" } });
});

// ---------- 提交 ----------

test("正在创建时「添加」按钮禁用，防止连点建出两张一样的卡", () => {
    render({ creating: true });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    const submit = buttons.find(b => /创建/.test(b.textContent || ""));
    assert.ok(
        submit,
        `没找到提交按钮，实际按钮：${JSON.stringify(buttons.map(b => b.textContent))}`
    );
    assert.equal(
        submit!.hasAttribute("disabled"),
        true,
        "creating 期间不禁用，手快一点就是两个重复站点"
    );
});

test("关闭按钮带无障碍名字", () => {
    render();
    assert.ok(byLabel("关闭"), "关闭图标按钮要有 aria-label，否则读屏只念出一个图标");
});
