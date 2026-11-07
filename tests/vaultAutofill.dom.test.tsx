// tests/vaultAutofill.dom.test.tsx
// 「设置 → 密码保险库」主密码框 + 设置中心搜索框的**防自动填充**回归。
//
// 用户实测（2026-11）：解锁弹窗的主密码框被填进浏览器保存的导航站登录密码，
// 顶栏 / 设置搜索框被填进登录账号名 zvj。根因是页面上有 type='password'：
// Chromium 把整页当登录表单做「用户名 + 密码」配对填充，
// autoComplete='off' / 'new-password' 都拦不住（见 utils/secretInput.ts 头部）。
//
// 这里模拟 **Chromium / WebKit**（CSS.supports('-webkit-text-security','disc') === true）：
// 主密码框必须是 type=text + CSS 遮蔽，页面上不许再留任何 type=password。
// Firefox 回退路径在 tests/vaultAutofillFirefox.dom.test.tsx 单独跑 ——
// secretInput.ts 有模块级缓存，两条路径必须放在不同的 bundle（不同测试文件）里。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VaultPanel } from "../src/components/VaultDialog";
import WorkspaceNavFilter from "../src/components/settingsWorkspace/SettingsWorkspaceNavFilter";
import type { VaultTransport } from "../src/utils/vaultSession";

// jsdom 的 CSS.supports 一律返回 false，会让 secretInput 走 Firefox 回退。
// 真机主流浏览器走的是「type=text + CSS 遮蔽」这条，才是要钉住的核心路径。
// ⚠️ secretInput.ts 有模块级缓存，这个 mock 必须在第一次渲染之前生效。
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

afterEach(cleanup);

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const ROOT = findProjectDir();

/**
 * 假传输层：exists=false → 建库态，true → 解锁态。
 * 只有「改主密码」那条用例会真跑 setup/unlock（走浏览器原生 WebCrypto），
 * 其余用例只用到 getVaultKeys 探测建库状态。
 */
function fakeClient(exists: boolean, store?: { keys: unknown }): VaultTransport {
    return {
        // 传了 store 就以它为准：建库时 saveVaultKeys 会写进去，随后 unlockVault
        // 必须读得到同一份 keys，否则「尚未创建保险库」会让建库流程半途而废。
        getVaultKeys: async () => (store ? store.keys : exists ? { kdf_salt: "AA==" } : null),
        saveVaultKeys: async (input: unknown) => {
            if (store) store.keys = input;
            return true;
        },
        listVaultEntries: async () => [],
        saveVaultEntry: async () => ({}),
        deleteVaultEntry: async () => true,
    } as unknown as VaultTransport;
}

function mountVault(client: VaultTransport) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<VaultPanel client={client} onNotify={() => {}} />);
    });
}

function mountNode(node: React.ReactElement) {
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

async function settle(ms = 20) {
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, ms));
    });
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000) {
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

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/** 给受控输入赋值：必须走原生 value setter 再派发 input，直接改 el.value 会被 React 吞掉 */
function typeInto(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

const masterInputs = (): HTMLInputElement[] => [
    ...document.querySelectorAll<HTMLInputElement>('input[name^="vault-master-"]'),
];

/** 每个主密码框都必须具备的四件事 */
function assertMasterField(input: HTMLInputElement) {
    const name = input.getAttribute("name") ?? "";
    assert.equal(input.type, "text", `「${name}」在 Chromium 下必须是 type=text（浏览器认不出是密码框）`);
    assert.equal(input.getAttribute("autocomplete"), "off", `「${name}」要 autoComplete=off`);
    assert.ok(!/password|username/i.test(name), `「${name}」的 name 不能带 password/username 语义`);
    assert.equal(input.getAttribute("data-lpignore"), "true", `「${name}」要带 data-lpignore`);
    assert.equal(input.getAttribute("data-1p-ignore"), "true", `「${name}」要带 data-1p-ignore`);
    assert.equal(input.getAttribute("data-bwignore"), "true", `「${name}」要带 data-bwignore`);
}

/** 保险库这一屏不许再留任何 type=password / 密码语义的 autocomplete */
function assertNoLoginFormSignal() {
    assert.equal(
        document.querySelectorAll('input[type="password"]').length,
        0,
        "保险库里还留着 type=password —— 它一出现 Chromium 就把整页当登录表单"
    );
    assert.equal(
        document.querySelectorAll(
            'input[autocomplete="current-password"], input[autocomplete="new-password"]'
        ).length,
        0,
        "current-password / new-password 会招来浏览器保存/填充提示"
    );
}

// ── 建库态：两个主密码框 ──────────────────────────────────────────────────
test("建库两个主密码框：type=text + off + 无 password 语义 name + 忽略标记", async () => {
    mountVault(fakeClient(false));
    await waitFor("建库表单出现", () => masterInputs().length === 2);

    const inputs = masterInputs();
    assert.deepEqual(
        inputs.map(i => i.getAttribute("name")).sort(),
        ["vault-master-setup", "vault-master-setup-confirm"],
        "两个框的 name 要各不相同"
    );
    for (const input of inputs) assertMasterField(input);
    assertNoLoginFormSignal();
});

// ── 解锁态：解锁框 + 恢复码框 + 恢复码重置的新主密码框 ─────────────────────
test("解锁态（用户截图那一屏）：主密码/恢复码/新主密码都不再是登录表单的一部分", async () => {
    mountVault(fakeClient(true));
    await waitFor("解锁表单出现", () =>
        !!document.querySelector('input[name="vault-master-unlock"]')
    );

    const unlock = document.querySelector<HTMLInputElement>('input[name="vault-master-unlock"]');
    const reset = document.querySelector<HTMLInputElement>('input[name="vault-master-reset"]');
    const recovery = document.querySelector<HTMLInputElement>('input[name="vault-recovery-code"]');
    assert.ok(unlock && reset && recovery, "三个框都要在");

    assertMasterField(unlock);
    assertMasterField(reset);
    assert.equal(recovery.getAttribute("autocomplete"), "off", "恢复码框也要 autoComplete=off");
    assert.equal(
        recovery.getAttribute("data-lpignore"),
        "true",
        "恢复码框也要挡第三方密码管理器"
    );
    assert.equal(masterInputs().length, 2, "解锁态两个主密码框");
    assertNoLoginFormSignal();
});

// ── 已解锁态：改主密码那两个框（真跑一次建库 + 解锁，覆盖全部 6 个框）──────
test("改主密码两个主密码框：同样是 type=text + off + 无 password 语义 name", async () => {
    const store: { keys: unknown } = { keys: null };
    mountVault(fakeClient(false, store));
    await waitFor("建库表单出现", () => masterInputs().length === 2);

    const setup = document.querySelector<HTMLInputElement>('input[name="vault-master-setup"]')!;
    const confirm = document.querySelector<HTMLInputElement>(
        'input[name="vault-master-setup-confirm"]'
    )!;
    typeInto(setup, "correct-horse-battery");
    typeInto(confirm, "correct-horse-battery");
    click(buttonByText("创建保险库"));

    // 建库会出一份一次性恢复码，点掉才进得了已解锁界面
    await waitFor("恢复码展示出来", () =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].some(
            b => (b.textContent || "").trim() === "我已保存，进入保险库"
        )
    );
    click(buttonByText("我已保存，进入保险库"));
    await waitFor("进入已解锁态", () => (document.body.textContent || "").includes("已解锁"));
    click(buttonByText("修改主密码"));
    await waitFor("改主密码表单出现", () =>
        !!document.querySelector('input[name="vault-master-change"]')
    );

    const change = document.querySelector<HTMLInputElement>('input[name="vault-master-change"]')!;
    const changeConfirm = document.querySelector<HTMLInputElement>(
        'input[name="vault-master-change-confirm"]'
    )!;
    assertMasterField(change);
    assertMasterField(changeConfirm);
    assertNoLoginFormSignal();
});

// ── 源码守卫：六个框的名字都在，且 VaultDialog 里再没有 type='password' ────
test("源码守卫：VaultDialog 六个主密码框各不重名，且不再有 type='password'", () => {
    // 注释里会写 `type='password'` 解释历史坑，不剥注释会被当成仍在使用的代码
    const src = stripComments(
        readFileSync(join(ROOT, "src", "components", "VaultDialog.tsx"), "utf8")
    );
    const names = [
        "vault-master-change",
        "vault-master-change-confirm",
        "vault-master-setup",
        "vault-master-setup-confirm",
        "vault-master-unlock",
        "vault-master-reset",
    ];
    for (const name of names) {
        assert.ok(src.includes(`"${name}"`), `缺少 ${name} 这个框`);
    }
    assert.equal(new Set(names).size, 6, "六个框的 name 不能重复");
    assert.ok(!/type=['"]password['"]/.test(src), "源码里不该再有写死的 type='password'");
    assert.ok(!/autoComplete=['"]current-password['"]/.test(src), "不该再有 current-password");
    assert.ok(!/autoComplete=['"]new-password['"]/.test(src), "不该再有 new-password");
    assert.ok(src.includes('name=\'vault-recovery-code\''), "恢复码框要有专用 name");
});

/** 剥注释：注释里写 `type='password'` 解释历史坑，源码守卫不能把它当成实现 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map(line => {
            const i = line.indexOf("//");
            if (i < 0) return line;
            return line.slice(0, i).includes("://") ? line : line.slice(0, i);
        })
        .join("\n");
}

// ── 设置中心左栏「搜索设置」框 ────────────────────────────────────────────
test("设置搜索框：原生 input 带 autocomplete=off / 专用 name / data-lpignore", () => {
    mountNode(
        <WorkspaceNavFilter value='' onChange={() => {}} onArrowDown={() => {}} />
    );
    const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]');
    assert.ok(input, "aria-label 必须挂在原生 input 上（读屏 + 选择器都靠它）");
    assert.equal(input.getAttribute("autocomplete"), "off");
    assert.equal(input.getAttribute("name"), "settings-nav-filter");
    assert.ok(!/password|username/i.test(input.getAttribute("name") ?? ""));
    assert.equal(input.getAttribute("data-lpignore"), "true");
    assert.equal(input.getAttribute("data-1p-ignore"), "true");
    assert.equal(input.getAttribute("data-bwignore"), "true");
    assert.equal(input.type, "text", "搜索框本来就是普通文本框，别被改成 password");
});

// ── 顶栏搜索框：加固标记挂在 htmlInput 上，且 readOnly 锁没被破坏 ─────────
test("源码守卫：顶栏搜索框的忽略标记挂在 htmlInput，readOnly 锁仍在", () => {
    const src = readFileSync(join(ROOT, "src", "components", "HeaderSearchBox.tsx"), "utf8");
    const htmlInputAt = src.indexOf("htmlInput: {");
    assert.ok(htmlInputAt > 0, "顶栏搜索框要用 slotProps.htmlInput 挂原生属性");
    const slot = src.slice(htmlInputAt, htmlInputAt + 700);
    assert.ok(slot.includes("readOnly: autofillLocked"), "readOnly 自动填充锁不能丢");
    assert.ok(slot.includes("onMouseDown: unlockAutofill"), "mousedown 解锁不能丢");
    assert.ok(slot.includes("onTouchStart: unlockAutofill"), "touchstart 解锁不能丢");
    assert.ok(slot.includes("onKeyDown: unlockAutofill"), "keydown 解锁不能丢");
    assert.ok(slot.includes("SECRET_IGNORE_ATTRS"), "忽略标记要挂在同一层 htmlInput 上");
    assert.ok(/autoComplete:\s*"off"/.test(src), "自动填充总开关还在");
});
