// tests/loginForm.dom.test.tsx
// 登录页是整站唯一的安全入口（726 行，之前零覆盖）。这里盯几件改坏了会直接出事的事：
// 提交时「记住我」有没有如实传出去、打开时会不会回填上次的账号密码、
// 注册的三道前端校验、邀请码自动转大写、以及**新密码明文不能出现在恢复令牌里**。
//
// 环境注意：启动脚本没把 localStorage 挂到 globalThis，而「记住账号密码」是直读
// localStorage 的（utils/rememberedLogin.ts），不挂就一渲染就 ReferenceError。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import LoginForm from "../src/components/LoginForm";
import { generateRecoveryKeyPair } from "../src/utils/recoveryKey";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: window.localStorage,
        configurable: true,
        writable: true,
    });
}

// 「忘记密码」这条路径要一份真私钥才能走到本地签名，生成一次给相关用例共用。
// Node 22 的 Web Crypto 支持 Ed25519，generateRecoveryKeyPair 会走 EdDSA 分支。
const KEY_PAIR = await generateRecoveryKeyPair();
const KEY_FILE_JSON = JSON.stringify({
    v: 1,
    alg: KEY_PAIR.alg,
    publicKey: KEY_PAIR.publicKey,
    privateKey: KEY_PAIR.privateKey,
    createdAt: "2026-09-30",
});

type Props = {
    loading?: boolean;
    error?: string | null;
    recoverConfigured?: boolean;
    /** 渲染前先写进 localStorage 的内容（如 navihive:rememberedLogin） */
    prefs?: Record<string, string>;
    onLogin?: (username: string, password: string, remember: boolean) => void;
    onRegister?: (
        username: string,
        password: string,
        inviteCode: string
    ) => Promise<{ success: boolean; message?: string }>;
    onRecover?: (token: string) => Promise<{ success: boolean; message?: string }>;
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let loginCalls: Array<[string, string, boolean]> = [];

function render(props: Props = {}) {
    localStorage.clear();
    // 注意顺序：先清空再写 prefs —— 反过来会被清掉
    for (const [k, v] of Object.entries(props.prefs ?? {})) localStorage.setItem(k, v);
    loginCalls = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <LoginForm
                onLogin={(u, p, r) => {
                    loginCalls.push([u, p, r]);
                    props.onLogin?.(u, p, r);
                }}
                loading={props.loading ?? false}
                error={props.error ?? null}
                recoverConfigured={props.recoverConfigured ?? false}
                onRegister={props.onRegister}
                onRecover={props.onRecover}
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

/** 按可见文案找按钮（MUI 的按钮里有图标节点，只能靠 textContent 包含匹配） */
const button = (text: string) =>
    [...document.querySelectorAll("button")].find(b => (b.textContent ?? "").includes(text));

/**
 * 当前视图的提交按钮。不能按文案找：提交中按钮里换成了进度圈、没有文字，
 * 按文案查会直接找不到人。
 */
const submitButton = () => document.querySelector<HTMLButtonElement>('form button[type="submit"]');

const inputById = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`);

/** 按 MUI 的 label 找输入框；必填字段的 label 后面会有个「*」，比对前抹掉 */
function inputByLabel(label: string): HTMLInputElement | null {
    const norm = (s: string) => (s ?? "").trim().replace(/\s*\*\s*$/, "").trim();
    const fc = [...document.querySelectorAll(".MuiFormControl-root")].find(
        el => norm(el.querySelector("label")?.textContent ?? "") === norm(label)
    );
    return fc ? fc.querySelector("input") : null;
}

/**
 * 给受控输入赋值：必须走原生 value setter 再派发 input，
 * 直接改 el.value 会被 React 的 value tracker 吞掉，onChange 不触发。
 */
function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/**
 * 提交表单。jsdom 点 submit 按钮不会真的走提交流程，直接对 <form> 派发 submit
 * （React 的 onSubmit 是委托到根节点的，submit 会冒泡，所以这样能进到 handler）。
 */
async function submitForm() {
    const form = document.querySelector("form");
    assert.ok(form, "页面上没有 form");
    await act(async () => {
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
}

/**
 * 等异步真正落地：Web Crypto（PBKDF2 / Ed25519）走的是 Node 的线程池，
 * 是**宏任务**，光 `await` 一次只 drain 完微任务队列，回调还没回来。
 * 所以要空转几轮 setTimeout 把宏任务也等掉。
 */
async function settle(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
        await act(async () => {
            await new Promise<void>(r => setTimeout(r, 10));
        });
    }
}

const alerts = () =>
    [...document.querySelectorAll(".MuiAlert-root")].map(el => (el.textContent ?? "").trim());

test.afterEach(cleanup);

test("登录：填好账号密码提交，onLogin 收到 Remember=false", async () => {
    render();
    setInputValue(inputById("username")!, "admin");
    setInputValue(inputById("password")!, "s3cret-pass");
    await submitForm();
    assert.deepEqual(loginCalls, [["admin", "s3cret-pass", false]]);
});

test("登录：勾选「记住我」后提交，remember 如实传成 true", async () => {
    render();
    setInputValue(inputById("username")!, "admin");
    setInputValue(inputById("password")!, "s3cret-pass");
    const box = document.querySelector<HTMLInputElement>('input[aria-label="记住账号密码"]')!;
    assert.ok(box, "没找到「记住账号密码」勾选框");
    click(box);
    await submitForm();
    assert.deepEqual(loginCalls, [["admin", "s3cret-pass", true]]);
});

test("登录：打开时回填上次记住的账号密码，并自动勾上记住我", () => {
    render({
        prefs: {
            "navihive:rememberedLogin": JSON.stringify({
                username: "saved",
                password: "saved-pass",
            }),
        },
    });
    assert.equal(inputById("username")!.value, "saved");
    assert.equal(inputById("password")!.value, "saved-pass");
    const box = document.querySelector<HTMLInputElement>('input[aria-label="记住账号密码"]')!;
    assert.equal(box.checked, true, "回填了账号密码就应该把记住我勾上");
});

test("登录：没填全时提交按钮是禁用的，loading 时也禁用", () => {
    render();
    assert.equal(submitButton()!.disabled, true, "空表单不该能提交");
    setInputValue(inputById("username")!, "admin");
    assert.equal(submitButton()!.disabled, true, "只填了账号仍不该能提交");
    setInputValue(inputById("password")!, "pw");
    assert.equal(submitButton()!.disabled, false);

    cleanup();
    render({ loading: true });
    assert.equal(submitButton()!.disabled, true, "提交中不许再点");
    assert.equal(
        submitButton()!.textContent?.includes("登录"),
        false,
        "提交中应该换成进度圈，而不是继续显示「登录」"
    );
});

test("登录：error 属性渲染成错误提示，且只在登录视图显示", () => {
    render({ error: "账号或密码错误" });
    assert.ok(
        alerts().some(t => t.includes("账号或密码错误")),
        `没看到错误提示，当前 alerts=${JSON.stringify(alerts())}`
    );
    click(button("忘记密码")!);
    assert.equal(
        alerts().some(t => t.includes("账号或密码错误")),
        false,
        "切到找回视图后不该继续显示登录错误"
    );
});

test("登录：没传 onRegister 时不给注册入口", () => {
    render();
    assert.equal(button("注册"), undefined, "单账号部署不该出现注册按钮");
    assert.equal(
        document.body.textContent?.includes("还没有账号"),
        false,
        "不该出现「还没有账号」分隔线"
    );
});

test("登录：传了 onRegister 才有注册入口，点进去是注册表单", () => {
    render({ onRegister: async () => ({ success: true }) });
    const entry = button("注册");
    assert.ok(entry, "多账号部署应该给注册入口");
    click(entry!);
    assert.ok(inputByLabel("邀请码"), "注册视图应该有邀请码输入框");
    assert.equal(document.querySelector("form")?.contains(inputByLabel("邀请码")!), true);
});

test("注册：账号名不足 2 个字符时拦下，不调用 onRegister", async () => {
    let called = 0;
    render({
        onRegister: async () => {
            called++;
            return { success: true };
        },
    });
    click(button("注册")!);
    setInputValue(inputByLabel("账号名")!, "a");
    setInputValue(inputById("register-password")!, "pw-123456");
    setInputValue(inputById("register-password-confirm")!, "pw-123456");
    setInputValue(inputByLabel("邀请码")!, "A2BC3DEF");
    await submitForm();
    assert.equal(called, 0, "账号名太短不该发出请求");
    assert.ok(
        alerts().some(t => t.includes("账号名至少 2 个字符")),
        `应提示账号名太短，实际 alerts=${JSON.stringify(alerts())}`
    );
});

test("注册：两次密码不一致 / 没填邀请码，都在本地拦下", async () => {
    let called = 0;
    render({
        onRegister: async () => {
            called++;
            return { success: true };
        },
    });
    click(button("注册")!);
    setInputValue(inputByLabel("账号名")!, "newbie");
    setInputValue(inputById("register-password")!, "pw-123456");
    setInputValue(inputById("register-password-confirm")!, "pw-654321");
    setInputValue(inputByLabel("邀请码")!, "A2BC3DEF");
    await submitForm();
    assert.equal(called, 0);
    assert.ok(alerts().some(t => t.includes("两次输入的密码不一致")));

    setInputValue(inputById("register-password-confirm")!, "pw-123456");
    setInputValue(inputByLabel("邀请码")!, "   ");
    await submitForm();
    assert.equal(called, 0);
    assert.ok(alerts().some(t => t.includes("请填写邀请码")));
});

test("注册：邀请码自动转大写后再发给服务端", async () => {
    let got = "";
    render({
        onRegister: async (_u, _p, code) => {
            got = code;
            return { success: true };
        },
    });
    click(button("注册")!);
    setInputValue(inputByLabel("账号名")!, "newbie");
    setInputValue(inputById("register-password")!, "pw-123456");
    setInputValue(inputById("register-password-confirm")!, "pw-123456");
    setInputValue(inputByLabel("邀请码")!, "a2bc3def");
    assert.equal(inputByLabel("邀请码")!.value, "A2BC3DEF", "输入时就该转成大写");
    await submitForm();
    assert.equal(got, "A2BC3DEF");
});

test("注册：成功后回到登录视图并清空表单", async () => {
    render({ onRegister: async () => ({ success: true }) });
    click(button("注册")!);
    setInputValue(inputByLabel("账号名")!, "newbie");
    setInputValue(inputById("register-password")!, "pw-123456");
    setInputValue(inputById("register-password-confirm")!, "pw-123456");
    setInputValue(inputByLabel("邀请码")!, "A2BC3DEF");
    await submitForm();
    assert.equal(inputByLabel("邀请码"), null, "注册成功后应该切回登录视图");
    assert.ok(inputById("username"), "登录视图的账号框应该回来了");
    assert.equal(inputById("username")!.value, "", "登录表单不该带着注册时的输入");
});

test("找回：没选私钥就提交，提示先选文件且不调用 onRecover", async () => {
    let called = 0;
    render({
        onRecover: async () => {
            called++;
            return { success: true };
        },
    });
    click(button("忘记密码")!);
    await submitForm();
    assert.equal(called, 0);
    assert.ok(
        alerts().some(t => t.includes("请先选择私钥文件")),
        `实际 alerts=${JSON.stringify(alerts())}`
    );
});

test("找回：两次新密码不一致时拦下", async () => {
    render({ onRecover: async () => ({ success: true }) });
    click(button("忘记密码")!);
    await pickKeyFile();
    setInputValue(inputById("recover-new-password")!, "new-pass-1");
    setInputValue(inputById("recover-confirm-password")!, "new-pass-2");
    await submitForm();
    assert.ok(alerts().some(t => t.includes("两次输入的新密码不一致")));
});

test("找回：选了私钥文件后显示已载入的文件名与算法", async () => {
    render({ onRecover: async () => ({ success: true }) });
    click(button("忘记密码")!);
    await pickKeyFile();
    const text = document.body.textContent ?? "";
    assert.ok(
        text.includes("navihive-recovery-key.json"),
        `应显示已载入的文件名，页面文本里没有找到`
    );
    assert.ok(text.includes("Ed25519") || text.includes("P-256"), "应一并显示算法名");
});

test("找回：走完本地签名后交给 onRecover，且令牌里没有密码明文", async () => {
    let token = "";
    render({
        onRecover: async t => {
            token = t;
            return { success: true };
        },
    });
    click(button("忘记密码")!);
    await pickKeyFile();
    setInputValue(inputById("recover-new-password")!, "brand-new-pass");
    setInputValue(inputById("recover-confirm-password")!, "brand-new-pass");
    await submitForm();
    await settle();
    assert.ok(token, "onRecover 应该收到令牌");
    const parts = token.split(".");
    assert.equal(parts.length, 3, `令牌应是 JWS compact 三段式，实际：${token.slice(0, 40)}…`);

    // 最关键的一条：新密码在本地算成哈希后才进令牌，明文绝不能出现在里面
    assert.equal(
        token.includes("brand-new-pass"),
        false,
        "密码明文绝对不能出现在恢复令牌里 —— 这是本地哈希的意义所在"
    );
    const payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    ) as Record<string, unknown>;
    assert.equal(payload.username, "", "没填账号名时应该是空串（只重置密码）");
    assert.ok(
        typeof payload.passwordHash === "string" && payload.passwordHash.length > 0,
        "payload 里应该带密码哈希"
    );
});

/** 模拟选私钥文件：jsdom 里没法真弹文件框，直接把 File 塞进 input.files 再派发 change */
async function pickKeyFile() {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(input, "找回视图里应该有隐藏的 file input");
    const file = {
        name: "navihive-recovery-key.json",
        text: async () => KEY_FILE_JSON,
    } as unknown as File;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
        input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
}
