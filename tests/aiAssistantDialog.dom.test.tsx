// src/components/AiAssistantDialog.tsx 的直测（480 行，此前零覆盖）。
//
// 为什么是它：这里是跟着登录账号走的私密凭据（token/密钥）唯一的编辑入口，
// 两点硬规矩必须有测试钉着 —— ① 默认关，没显式打开不往外发；
// ② 「测试连接」用**当前填的这份**（不必先保存）。另外「读配置失败也能编辑、
// 改字段清掉旧测试结果」这类状态机问题不报错、只会让人干等或被旧结果误导。
//
// MUI 坑（见 memory）：TextField 的 aria-label 经 slotProps.input 落在真 input 上，
// 用 input[aria-label=…] 找；Select 弹层在 jsdom 里易偶发红，provider 切换
// 一律用「预置配置」而不是模拟点击菜单。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AiAssistantDialog from "../src/components/AiAssistantDialog";
import type { AiAssistant, AiTestOutcome } from "../src/hooks/useAiAssistant";
import {
    AI_API_KEY_KEY,
    AI_CF_ACCOUNT_KEY,
    AI_CF_TOKEN_KEY,
    AI_EMBED_MODEL_KEY,
    AI_ENABLED_KEY,
    AI_ENDPOINT_KEY,
    AI_PROVIDER_KEY,
    AI_TEXT_MODEL_KEY,
} from "../src/API/configKeys";

const ALL_AI_KEYS = [
    AI_ENABLED_KEY,
    AI_PROVIDER_KEY,
    AI_ENDPOINT_KEY,
    AI_TEXT_MODEL_KEY,
    AI_EMBED_MODEL_KEY,
    AI_API_KEY_KEY,
    AI_CF_TOKEN_KEY,
    AI_CF_ACCOUNT_KEY,
];

interface ConfigClientLike {
    getConfigs(): Promise<Record<string, string>>;
    setConfigs(configs: Record<string, string>): Promise<boolean>;
}

function makeApi(configs: Record<string, string> = {}, over: {
    getConfigs?: () => Promise<Record<string, string>>;
    setConfigs?: (c: Record<string, string>) => Promise<boolean>;
} = {}) {
    const saved: Record<string, string>[] = [];
    const api: ConfigClientLike = {
        getConfigs: over.getConfigs ?? (async () => ({ ...configs })),
        setConfigs: async c => {
            saved.push(c);
            if (over.setConfigs) return over.setConfigs(c);
            return true;
        },
    };
    return { api, saved };
}

// 弹窗里的 ai 是 hook（useAiAssistant）给的，test() 返回的已经是转换后的
// AiTestOutcome（{ok,message,...}），不是 POST ai/test 的原始响应 —— 假体照它做。
function fakeAi(
    testImpl: (settings: Partial<Record<string, string>>) => Promise<AiTestOutcome>
): AiAssistant {
    return {
        status: null,
        ready: false,
        reason: null,
        refresh: async () => {},
        siteMeta: async () => ({ ok: false, message: "unused" }),
        suggestTags: async () => ({ ok: false, message: "unused" }),
        embed: async () => ({ ok: false, message: "unused" }),
        search: async () => ({ ok: false, message: "unused" }),
        test: testImpl,
    };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface MountOpts {
    open?: boolean;
    configs?: Record<string, string>;
    api?: ConfigClientLike;
    ai?: AiAssistant;
    statusText?: string;
    onSaved?: () => void;
    onClose?: () => void;
}

async function mount(opts: MountOpts = {}) {
    const api = opts.api ?? makeApi(opts.configs ?? {}).api;
    const ai =
        opts.ai ??
        fakeAi(async () => ({
            ok: true,
            message: "连接成功，文本与嵌入都通",
            text: { ok: true },
            embed: { ok: true, dim: 768 },
        }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <AiAssistantDialog
                open={opts.open ?? true}
                onClose={opts.onClose ?? (() => {})}
                api={api}
                ai={ai}
                onSaved={opts.onSaved}
                statusText={opts.statusText}
            />
        );
    });
    // 冲掉打开时读配置的那一趟
    await act(async () => {});
    return { api, ai };
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

afterEach(cleanup);

const inputOf = (label: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const buttonByLabel = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const buttonByText = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

async function click(el: Element | null | undefined, msg = "要点的元素不在") {
    assert.ok(el, msg);
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

async function typeInto(input: HTMLInputElement | null, value: string, msg = "输入框不在") {
    assert.ok(input, msg);
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input!, value);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
    });
}

test("打开即重读配置并回填（含预置过嵌入模型就默认展开）", async () => {
    await mount({
        configs: {
            [AI_ENABLED_KEY]: "true",
            [AI_CF_TOKEN_KEY]: "tok-from-db",
            [AI_CF_ACCOUNT_KEY]: "acc-from-db",
            [AI_EMBED_MODEL_KEY]: "emb-from-db",
        },
        statusText: "已启用",
    });
    assert.equal(inputOf("Cloudflare API token")!.value, "tok-from-db");
    assert.equal(inputOf("Cloudflare 账号 ID")!.value, "acc-from-db");
    // 已配过嵌入模型 → 展开免得用户以为配置丢了
    const expand = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").includes("收起嵌入模型设置")
    );
    assert.ok(expand, "预置过嵌入模型要默认展开");
    assert.equal(inputOf("嵌入模型")!.value, "emb-from-db");
    assert.ok(
        (document.body.textContent || "").includes("当前生效：已启用"),
        "statusText 要摆在开关旁边"
    );
});

test("读配置失败也能正常编辑（落空配置，不卡「读取中」）", async () => {
    const { api } = makeApi();
    const broken: ConfigClientLike = { ...api, getConfigs: async () => { throw new Error("网络挂了"); } };
    await mount({ api: broken });
    assert.equal(
        document.querySelector(".MuiLinearProgress-root"),
        null,
        "读失败后不能停在加载态"
    );
    const save = buttonByText("保存");
    assert.ok(save && !save.disabled, "保存按钮要可用");
    assert.ok(
        (document.body.textContent || "").includes("还不能测：还没填 Cloudflare API token"),
        "空配置要说出缺什么"
    );
});

test("默认 provider 是 Workers AI：显示 CF 字段，不显示接口地址/API 密钥", async () => {
    await mount();
    assert.ok(inputOf("Cloudflare API token"), "默认要有 CF token 字段");
    assert.ok(inputOf("Cloudflare 账号 ID"), "默认要有账号 ID 字段");
    assert.equal(inputOf("接口地址"), null, "workers-ai 不该有接口地址");
    assert.equal(inputOf("API 密钥"), null, "workers-ai 不该有 API 密钥");
});

test("预置 openai-compatible：显示接口地址与 API 密钥并回填，CF 字段不渲染", async () => {
    await mount({
        configs: {
            [AI_PROVIDER_KEY]: "openai-compatible",
            [AI_ENDPOINT_KEY]: "https://api.deepseek.com/v1",
            [AI_API_KEY_KEY]: "sk-123",
        },
    });
    assert.equal(inputOf("接口地址")!.value, "https://api.deepseek.com/v1");
    assert.equal(inputOf("API 密钥")!.value, "sk-123");
    assert.equal(inputOf("Cloudflare API token"), null);
    assert.equal(inputOf("Cloudflare 账号 ID"), null);
});

test("缺什么测试按钮就说缺什么：按钮置灰 + 文案点名", async () => {
    await mount();
    const testBtn = buttonByLabel("测试连接");
    assert.ok(testBtn, "要有测试连接按钮");
    assert.equal(testBtn!.disabled, true);
    assert.ok((document.body.textContent || "").includes("还不能测：还没填 Cloudflare API token"));
});

test("补齐凭据后测试可用，测试用当前填的这份（不必先保存），成功结果摆出来", async () => {
    const calls: Partial<Record<string, string>>[] = [];
    const ai = fakeAi(async settings => {
        calls.push(settings);
        return {
            ok: true,
            message: "连接成功，文本与嵌入都通",
            text: { ok: true },
            embed: { ok: true, dim: 768 },
        };
    });
    await mount({ ai });
    await typeInto(inputOf("Cloudflare API token"), "tok-typed");
    await typeInto(inputOf("Cloudflare 账号 ID"), "acc-typed");

    const testBtn = buttonByLabel("测试连接");
    assert.ok(testBtn && !testBtn!.disabled, "凭据补齐后测试按钮要可用");
    await click(testBtn!);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]![AI_CF_TOKEN_KEY], "tok-typed", "用当前填的，不是库里那份");
    assert.equal(calls[0]![AI_CF_ACCOUNT_KEY], "acc-typed");
    assert.equal(calls[0]![AI_TEXT_MODEL_KEY], "", "没填的键也原样带上");

    assert.ok((document.body.textContent || "").includes("连接成功，文本与嵌入都通"));
    assert.ok((document.body.textContent || "").includes("通（768 维）"), "嵌入维度要显示");
});

test("测试失败（带分项）→ warning 警示条，分项原话摆出来", async () => {
    const ai = fakeAi(async () => ({
        ok: false,
        message: "嵌入没通",
        text: { ok: true },
        embed: { ok: false, message: "维度不支持" },
    }));
    await mount({
        ai,
        configs: { [AI_CF_TOKEN_KEY]: "t", [AI_CF_ACCOUNT_KEY]: "a" },
    });
    await click(buttonByLabel("测试连接"));
    // ⚠️ 这套 MUI 的 warning 警示条类名是 MuiAlert-colorWarning（不是 standardWarning）
    const alert = document.querySelector(".MuiAlert-colorWarning");
    assert.ok(alert, "失败要有 warning 警示条");
    assert.ok((alert!.textContent || "").includes("维度不支持"));
    assert.ok((alert!.textContent || "").includes("没通"), "分项失败要有兜底文案");
});

test("test 抛异常 → 兜底一句话摆出来，不白屏", async () => {
    const ai = fakeAi(async () => {
        throw new Error("boom");
    });
    await mount({
        ai,
        configs: { [AI_CF_TOKEN_KEY]: "t", [AI_CF_ACCOUNT_KEY]: "a" },
    });
    await click(buttonByLabel("测试连接"));
    assert.ok((document.body.textContent || "").includes("boom"));
});

test("改字段清掉上一次的测试结果（旧结果对新配置不算数）", async () => {
    await mount({ configs: { [AI_CF_TOKEN_KEY]: "t", [AI_CF_ACCOUNT_KEY]: "a" } });
    await click(buttonByLabel("测试连接"));
    assert.ok((document.body.textContent || "").includes("连接成功"), "先确认结果出现了");
    await typeInto(inputOf("Cloudflare API token"), "changed");
    assert.equal(
        document.querySelector(".MuiAlert-standardSuccess"),
        null,
        "改了配置旧结果必须消失"
    );
});

test("保存：全量写 8 个键（含空串），先 onSaved 再 onClose", async () => {
    const order: string[] = [];
    const { api, saved } = makeApi({ [AI_CF_TOKEN_KEY]: "tok-typed" });
    await mount({
        api,
        onSaved: () => order.push("saved"),
        onClose: () => order.push("closed"),
    });
    // 没动过的表单直接保存：8 个键一个不落，全部显式写
    await click(buttonByText("保存"));
    assert.equal(saved.length, 1, "保存正好写一次");
    for (const key of ALL_AI_KEYS) {
        assert.ok(key in saved[0]!, `保存的 payload 必须含 ${key}`);
    }
    assert.equal(saved[0]![AI_CF_TOKEN_KEY], "tok-typed");
    assert.deepEqual(order, ["saved", "closed"], "先刷新 App 状态，再收起弹窗");
});

test("保存返回 false：报错文案、弹窗不关", async () => {
    const { api } = makeApi({}, { setConfigs: async () => false });
    let closed = false;
    await mount({ api, onClose: () => { closed = true; } });
    await click(buttonByText("保存"));
    assert.ok((document.body.textContent || "").includes("保存没有成功，再试一次"));
    assert.equal(closed, false, "没保存成功不能收弹窗");
});

test("保存抛错：错误原样显示，弹窗不关", async () => {
    const { api } = makeApi({}, {
        setConfigs: async () => {
            throw new Error("网络挂了");
        },
    });
    let closed = false;
    await mount({ api, onClose: () => { closed = true; } });
    await click(buttonByText("保存"));
    assert.ok((document.body.textContent || "").includes("网络挂了"));
    assert.equal(closed, false);
});

test("嵌入模型的展开/收起按钮状态跟着配置走（Collapse 收起时子节点仍在 DOM，不能拿元素在不在判）", async () => {
    await mount();
    const expand = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").includes("嵌入模型（语义搜索用）")
    );
    assert.ok(expand, "收起状态要有展开按钮");
    assert.equal(expand!.getAttribute("aria-expanded"), null, "收起时 aria-expanded 不置");
    await click(expand!);
    const collapse = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").includes("收起嵌入模型设置")
    );
    assert.ok(collapse, "点开后按钮换文案");
    assert.equal(collapse!.getAttribute("aria-expanded"), "true");
    assert.ok(
        (document.body.textContent || "").includes("一个字节都不会往外发"),
        "默认关的说明要摆在界面上"
    );
});

test("标题栏关闭按钮与「关闭」按钮都触发 onClose", async () => {
    let closed = 0;
    await mount({ onClose: () => { closed += 1; } });
    await click(buttonByLabel("关闭 AI 助手"));
    await click(buttonByText("关闭"));
    assert.equal(closed, 2);
});
