// tests/vaultAutofillFirefox.dom.test.tsx
// Firefox 回退路径（CSS.supports('-webkit-text-security','disc') === false）。
//
// Gecko 没实现 -webkit-text-security，utils/secretInput.ts 会退回 type='password'。
// 这条路径是**安全的**：Firefox 不做 formless 登录表单检测，没有 <form> 时
// 不会拿保存的登录凭据来填；但必须保证回退之后框还能打字、还能提交 ——
// 否则「修好了自动填充、却把主密码框改坏了」比原 bug 更糟。
//
// ⚠️ secretInput.ts 有模块级探测缓存：本文件必须与 Chromium 路径
// （tests/vaultAutofill.dom.test.tsx）分开成两个 bundle，且 mock 要在首次渲染前生效。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VaultPanel } from "../src/components/VaultDialog";
import type { VaultTransport } from "../src/utils/vaultSession";

if (typeof CSS === "undefined") {
    Object.defineProperty(globalThis, "CSS", {
        value: { supports: () => false },
        configurable: true,
    });
} else {
    CSS.supports = () => false;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(cleanup);

/** exists=true 直接进解锁态；keys 故意是坏的，让 unlock 快速失败（不跑 60 万次 PBKDF2） */
function fakeClient(exists: boolean): VaultTransport {
    return {
        getVaultKeys: async () => (exists ? { kdf_salt: "AA==" } : null),
        saveVaultKeys: async () => true,
        listVaultEntries: async () => [],
        saveVaultEntry: async () => ({}),
        deleteVaultEntry: async () => true,
    } as unknown as VaultTransport;
}

function mount(client: VaultTransport) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<VaultPanel client={client} onNotify={() => {}} />);
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

async function settle(ms = 20) {
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, ms));
    });
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > deadline) assert.fail(`等了 ${timeoutMs}ms 也没等到：${label}`);
        await settle(10);
    }
}

function buttonByText(text: string): HTMLButtonElement {
    const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );
    assert.ok(btn, `应能找到「${text}」按钮`);
    return btn;
}

/** 给受控输入赋值：走原生 value setter 再派发 input */
function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

test("Firefox 回退：主密码框是 type=password，但 autoComplete/name/忽略标记一个不少", async () => {
    mount(fakeClient(true));
    await waitFor("解锁表单出现", () =>
        !!document.querySelector('input[name="vault-master-unlock"]')
    );

    const inputs = [
        ...document.querySelectorAll<HTMLInputElement>('input[name^="vault-master-"]'),
    ];
    assert.equal(inputs.length, 2, "解锁态两个主密码框（解锁 / 恢复码重置）");
    for (const input of inputs) {
        assert.equal(input.type, "password", "Gecko 不支持 CSS 遮蔽，必须回退成 password 才不裸奔");
        assert.equal(input.getAttribute("autocomplete"), "off");
        assert.ok(!/password|username/i.test(input.getAttribute("name") ?? ""));
        assert.equal(input.getAttribute("data-lpignore"), "true");
    }
    const recovery = document.querySelector<HTMLInputElement>('input[name="vault-recovery-code"]');
    assert.ok(recovery, "恢复码框要在");
    assert.equal(recovery.getAttribute("autocomplete"), "off");
});

test("Firefox 回退：主密码框能输入、能提交（不会变成打字没反应的死框）", async () => {
    mount(fakeClient(true));
    await waitFor("解锁表单出现", () =>
        !!document.querySelector('input[name="vault-master-unlock"]')
    );

    const input = document.querySelector<HTMLInputElement>('input[name="vault-master-unlock"]')!;
    typeInto(input, "supersecret");
    assert.equal(input.value, "supersecret", "受控输入要能真的打进字");

    act(() => {
        buttonByText("解锁").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 坏 keys 会让 unlockVault 抛错 → doUnlock 捕获后显示「主密码不正确」。
    // 若值没被读到，显示的会是「请输入主密码」——这一句就是回退路径的验收点。
    await waitFor("提交后给出反馈", () =>
        (document.body.textContent || "").includes("主密码不正确")
    );
    assert.ok(
        !(document.body.textContent || "").includes("请输入主密码"),
        "值没被 onChange 读到，说明 type 切换把输入框改坏了"
    );
});

test("Firefox 回退：建库两个主密码框同样能输入", async () => {
    mount(fakeClient(false));
    await waitFor("建库表单出现", () =>
        !!document.querySelector('input[name="vault-master-setup"]')
    );

    const setup = document.querySelector<HTMLInputElement>('input[name="vault-master-setup"]')!;
    const confirm = document.querySelector<HTMLInputElement>(
        'input[name="vault-master-setup-confirm"]'
    )!;
    assert.equal(setup.type, "password");
    assert.equal(confirm.type, "password");
    typeInto(setup, "eightchars");
    typeInto(confirm, "eightchars");
    assert.equal(setup.value, "eightchars");
    assert.equal(confirm.value, "eightchars", "确认框也要能打字（name 不带 password 但值照常读写）");
});
