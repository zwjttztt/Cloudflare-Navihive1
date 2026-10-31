// tests/accountDialog.dom.test.tsx
// 账号管理弹窗，之前零覆盖。这里盯的是几条「改坏了不会报错、但会坑到人」的分支：
// 改密按钮的脏检查（没填新账号/新密码就不该能提交）、生成私钥要先验当前密码、
// 邀请码的显示时机，以及「登录设备」一节的渲染。
//
// 角色边界（2026-10-17 用户要求，v3.1.0 起）：「注销当前账号」只对普通账号开放——
// 站点所有者不提供入口（后端也拒绝 owner），站点不能没有管理者。而「沉睡治理」在
// v3.1.1 恢复给所有者可见：owner 在「账号管理」里能看到其它账号多久没登录、谁快被
// 停用/清除（只读 + 手动扫描 + 重新启用），但**不能在此改阈值**（改阈值的入口统一
// 在「设置 → 全站设置 → 数据保留」）。用例钉住：owner 看得到治理清单、普通账号看不到。
//
// 组件所有值都由父组件持有（auth / invite / sessions），所以用一个 Harness 持有状态，
// 尽量贴近 App 里的真实用法。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import AccountDialog, { type AccountAuthDraft } from "../src/components/AccountDialog";
import type { AccountInfo, InviteInfo, SessionInfo } from "../src/API/http";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: window.localStorage,
        configurable: true,
        writable: true,
    });
}

const DAY = 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

function makeAccount(over: Partial<AccountInfo> = {}): AccountInfo {
    return {
        id: 7,
        username: "alice",
        role: "user",
        status: "active",
        lastActiveAt: now() - 3 * DAY,
        disabledAt: null,
        createdAt: now() - 100 * DAY,
        willDisableAt: now() + 20 * DAY,
        willDeleteAt: null,
        ...over,
    };
}

function makeSession(over: Partial<SessionInfo> = {}): SessionInfo {
    return {
        jti: "jti-1",
        userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36",
        ip: "1.2.3.4",
        createdAt: now() - 3600,
        lastSeenAt: now() - 60,
        expiresAt: now() + 30 * 24 * 3600,
        current: false,
        ...over,
    };
}

type Calls = {
    authChanges: Array<[keyof AccountAuthDraft, string]>;
    saves: number;
    generateKeys: string[];
    invites: number;
    revoked: string[];
    revokeOthers: number;
    exempts: number[];
    policies: Array<{ disableDays: number; graceDays: number }>;
    deletes: number;
    closes: number;
};

type Opts = {
    currentUser?: { username: string; role: "owner" | "user" } | null;
    recoveryKeyConfigured?: boolean;
    generateResult?: { success: boolean; message?: string };
    inviteResult?: { success: boolean; message?: string; code?: string; expiresAt?: number };
    sessions?: SessionInfo[];
    withSessions?: boolean;
    accounts?: AccountInfo[];
    withPolicy?: boolean;
    withInvite?: boolean;
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let calls: Calls = emptyCalls();

function emptyCalls(): Calls {
    return {
        authChanges: [],
        saves: 0,
        generateKeys: [],
        invites: 0,
        revoked: [],
        revokeOthers: 0,
        exempts: [],
        policies: [],
        deletes: 0,
        closes: 0,
    };
}

function Harness(o: Opts) {
    const [auth, setAuth] = useState<AccountAuthDraft>({
        username: "",
        currentPassword: "",
        newPassword: "",
    });
    const [invite, setInvite] = useState<InviteInfo | null>(null);
    return (
        <AccountDialog
            open
            onClose={() => calls.closes++}
            sites={[]}
            auth={auth}
            onAuthChange={(field, value) => {
                calls.authChanges.push([field, value]);
                setAuth(prev => ({ ...prev, [field]: value }));
            }}
            onSaveAuth={() => calls.saves++}
            currentUser={o.currentUser ?? { username: "admin", role: "owner" }}
            recoveryKeyConfigured={o.recoveryKeyConfigured ?? false}
            onGenerateRecoveryKey={async pwd => {
                calls.generateKeys.push(pwd);
                return o.generateResult ?? { success: true };
            }}
            invite={invite}
            onCreateInvite={
                o.withInvite === false
                    ? undefined
                    : async () => {
                          calls.invites++;
                          const r = o.inviteResult ?? {
                              success: true,
                              code: "A2BC3DEF",
                              expiresAt: now() + 1800,
                          };
                          if (r.success && r.code) {
                              setInvite({ code: r.code, expiresAt: r.expiresAt ?? 0, ttlSeconds: 1800 });
                          }
                          return r;
                      }
            }
            sessions={o.withSessions === false ? undefined : (o.sessions ?? [makeSession()])}
            onRevokeSession={jti => calls.revoked.push(jti)}
            onRevokeOthers={() => calls.revokeOthers++}
            // 与 App 同一条门控：站点所有者不传 onDeleteAccount
            onDeleteAccount={
                (o.currentUser ?? { username: "admin", role: "owner" }).role === "owner"
                    ? undefined
                    : () => calls.deletes++
            }
            accounts={o.accounts}
            onExemptUser={uid => calls.exempts.push(uid)}
            inactivePolicy={o.withPolicy === false ? undefined : { disableDays: 180, graceDays: 30 }}
            onSaveInactivePolicy={async p => {
                calls.policies.push(p);
                return { success: true };
            }}
        />
    );
}

function render(o: Opts = {}) {
    calls = emptyCalls();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<Harness {...o} />);
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

/** 按可见文案找按钮（MUI 按钮里有图标节点，只能靠 textContent 匹配） */
const button = (text: string) =>
    [...document.querySelectorAll("button")].find(b => (b.textContent ?? "").includes(text));

/** 精确匹配：「生成并下载私钥」是「重新生成并下载私钥」的子串，包含匹配会找错人 */
const buttonExact = (text: string) =>
    [...document.querySelectorAll("button")].find(
        b => (b.textContent ?? "").trim() === text
    );

const inputById = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`);

/** 按 MUI 的 label 找输入框（label 后面可能带「*」，比对前抹掉） */
function inputByLabel(label: string): HTMLInputElement | null {
    const norm = (s: string) => (s ?? "").trim().replace(/\s*\*\s*$/, "").trim();
    const fc = [...document.querySelectorAll(".MuiFormControl-root")].find(
        el => norm(el.querySelector("label")?.textContent ?? "") === norm(label)
    );
    return fc ? fc.querySelector("input") : null;
}

/** 弹窗正文里所有可见文字（两个 Dialog 都会挂到 body 上，一起搜） */
const pageText = () => document.body.textContent ?? "";

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/**
 * 等异步 handler（生成私钥 / 邀请码都是 async）落定。
 *
 * 注意 jsdom 里 MUI 的关闭动画**走不完**（没有 transitionend），所以想断言
 * 「弹窗关了」不能等 DOM 消失 —— 得找别的信号，见下面那条用例。
 */
async function flush() {
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, 0));
    });
}

/** 给受控输入赋值：必须走原生 value setter 再派发 input，直接改 el.value 会被 React 吞掉 */
function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

test.afterEach(cleanup);

test("账号：显示当前账号名与所有者标注，普通账号不标", () => {
    render({ currentUser: { username: "admin", role: "owner" } });
    assert.ok(pageText().includes("当前账号："), "应该显示「我是谁」");
    assert.ok(pageText().includes("（站点所有者）"), "所有者该有标注");

    cleanup();
    render({ currentUser: { username: "alice", role: "user" } });
    assert.ok(pageText().includes("alice"));
    assert.equal(pageText().includes("（站点所有者）"), false, "普通账号不该标所有者");
});

test("治理清单：owner 行不显示「约 N 天后停用」（历史残留 willDisableAt 不外显）", () => {
    render({
        accounts: [
            makeAccount({
                id: 1,
                username: "boss",
                role: "owner",
                willDisableAt: now() + 180 * DAY,
            }),
            makeAccount({ id: 2, username: "alice", willDisableAt: now() + 20 * DAY }),
        ],
    });
    const t = pageText();
    const bossPart = t.slice(t.indexOf("boss"), t.indexOf("alice"));
    assert.ok(bossPart.includes("最近活跃"), "owner 行仍显示最近活跃");
    assert.ok(!bossPart.includes("天后停用"), "owner 不参与停用，不该显示倒计时");
    const alicePart = t.slice(t.indexOf("alice"));
    assert.ok(alicePart.includes("约 20 天后停用"), "普通账号照常显示");
});

test("账号：没填新账号或新密码时「保存」禁用，填任一即可用", () => {
    render();
    const save = button("保存账号与密码")!;
    assert.ok(save);
    assert.equal(save.disabled, true, "什么都没改不该能提交");
    assert.ok(pageText().includes("填写新账号或新密码后才能保存"));

    setInputValue(inputById("account-username")!, "newname");
    assert.equal(button("保存账号与密码")!.disabled, false, "改账号名就该能提交");
    assert.deepEqual(calls.authChanges, [["username", "newname"]]);

    cleanup();
    render();
    setInputValue(inputById("account-new-password")!, "new-pass-123");
    assert.equal(button("保存账号与密码")!.disabled, false, "只改密码也该能提交");

    click(button("保存账号与密码")!);
    assert.equal(calls.saves, 1);
});

test("账号：恢复密钥按钮文案跟随是否已配置", () => {
    render({ recoveryKeyConfigured: false });
    assert.ok(buttonExact("生成并下载私钥"), "没配过应该是「生成并下载私钥」");
    assert.equal(buttonExact("重新生成并下载私钥"), undefined);

    cleanup();
    render({ recoveryKeyConfigured: true });
    assert.ok(buttonExact("重新生成并下载私钥"), "配过之后应该是「重新生成并下载私钥」");
});

test("账号：生成私钥要先单独验当前密码，没填不能确认", async () => {
    render();
    click(buttonExact("生成并下载私钥")!);
    assert.ok(pageText().includes("验证身份后生成恢复私钥"), "应该弹出独立的验密弹窗");

    const pwd = inputById("account-recovery-current-password")!;
    assert.ok(pwd, "验密弹窗里应该有密码框");
    assert.equal(
        button("确认并下载私钥")!.disabled,
        true,
        "没填密码不该能确认 —— 否则等于绕过了身份验证"
    );

    setInputValue(pwd, "my-current-pwd");
    assert.equal(button("确认并下载私钥")!.disabled, false);
    click(button("确认并下载私钥")!);
    await flush();
    assert.deepEqual(calls.generateKeys, ["my-current-pwd"], "当前密码要如实传给父组件");
});

test("账号：验密失败时弹窗留着并给出原因，成功才关闭", async () => {
    // jsdom 里没有 transitionend，MUI 的 Fade 走不完退出动画，弹窗关闭后 DOM 仍在，
    // 所以不能拿「标题还在不在」判断。改用两个只在关闭时才会变的地方：
    // 验密弹窗内消息的渲染条件是 `recoveryMsg && recoveryPwdOpen`（关了就不再渲染），
    // 以及成功后会把密码框清空。
    const verifyDialogText = () =>
        [...document.querySelectorAll(".MuiDialog-root")][1]?.textContent ?? "";
    const pwdBox = () => inputById("account-recovery-current-password")!;

    render({ generateResult: { success: false, message: "当前密码不正确" } });
    click(buttonExact("生成并下载私钥")!);
    setInputValue(pwdBox(), "wrong");
    click(button("确认并下载私钥")!);
    await flush();

    assert.ok(
        verifyDialogText().includes("当前密码不正确"),
        "失败原因要显示在验密弹窗里，用户才知道自己错在哪"
    );
    assert.equal(pwdBox().value, "wrong", "失败了密码要留着，不然得重新输一遍");

    cleanup();
    render({ generateResult: { success: true, message: "私钥文件已下载" } });
    click(buttonExact("生成并下载私钥")!);
    setInputValue(pwdBox(), "right");
    click(button("确认并下载私钥")!);
    await flush();

    assert.equal(
        verifyDialogText().includes("私钥文件已下载"),
        false,
        "成功后验密弹窗应该关掉（消息不再在弹窗内渲染）"
    );
    assert.equal(pwdBox().value, "", "成功后要把当前密码从框里清掉");
    assert.ok(
        [...document.querySelectorAll(".MuiDialog-root")][0]!.textContent!.includes(
            "私钥文件已下载"
        ),
        "成功提示要留在主弹窗上"
    );
});

test("账号：邀请码生成成功后显示码本身，失败只显示原因", async () => {
    render();
    assert.equal(pageText().includes("A2BC3DEF"), false, "还没生成时不该有码");
    click(button("生成邀请码")!);
    await flush();
    assert.ok(pageText().includes("A2BC3DEF"), "生成成功后要把码显示出来");

    cleanup();
    render({ inviteResult: { success: false, message: "邀请码功能未启用" } });
    click(button("生成邀请码")!);
    await flush();
    assert.ok(pageText().includes("邀请码功能未启用"));
    assert.equal(pageText().includes("A2BC3DEF"), false, "失败时不该显示任何码");
});

test("账号：登录设备的名字要能区分「自动化 / 脚本」和真机（否则看着就是重复）", () => {
    // 2026-10-24：截图上两条都是「Chrome · Windows」，其中一条其实是
    // HeadlessChrome（自动化）。它的 UA 里同样带 Chrome/ 和 Windows NT，
    // 老逻辑照普通浏览器念，于是和用户的真机撞名。
    render({
        sessions: [
            makeSession({
                jti: "jti-real",
                current: true,
                ip: "1.2.3.4",
                userAgent:
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36 Core/1.116.617.400 QQBrowser/20.1.7233.400",
            }),
            makeSession({
                jti: "jti-headless",
                ip: "1.2.3.4",
                userAgent:
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36",
            }),
            makeSession({ jti: "jti-script", ip: "127.0.0.1", userAgent: "curl/8.18.0" }),
        ],
    });
    const text = pageText();
    assert.ok(text.includes("QQ 浏览器 · Windows"), `真机要认出 QQ 浏览器，实际：${text.slice(0, 400)}`);
    assert.ok(text.includes("无头浏览器"), "自动化客户端不能显示成 Chrome · Windows");
    assert.ok(text.includes("curl"), "命令行客户端原样显示");
});

test("账号：登录设备一节列出设备、标出当前这台、别的可踢", () => {
    render({
        sessions: [
            makeSession({ jti: "jti-a", current: true, ip: "1.2.3.4" }),
            makeSession({ jti: "jti-b", userAgent: "Mozilla/5.0 (iPhone) Version/17.4 Safari/604.1", ip: "5.6.7.8" }),
        ],
    });
    assert.ok(pageText().includes("登录设备"), "有设备时要渲染这一节");
    assert.ok(pageText().includes("（当前设备）"), "当前这台要标出来");
    assert.ok(pageText().includes("1.2.3.4"), "设备要带 IP");
    assert.ok(pageText().includes("5.6.7.8"), "第二台设备也要在");

    // 当前这台不给踢（踢了等于把自己踢下线），另一台给
    const kicks = [...document.querySelectorAll("button")].filter(
        b => (b.textContent ?? "").trim() === "踢下线"
    );
    assert.equal(kicks.length, 1, "只有非当前设备有「踢下线」");
    click(kicks[0]);
    assert.deepEqual(calls.revoked, ["jti-b"], "踢的必须是非当前那台");

    const revokeOthers = [...document.querySelectorAll("button")].find(
        b => (b.textContent ?? "").trim() === "退出其它设备"
    );
    assert.ok(revokeOthers, "要有「退出其它设备」入口");
    assert.equal(revokeOthers!.disabled, false, "有其它设备时不该置灰");
    click(revokeOthers!);
    assert.equal(calls.revokeOthers, 1);
});

test("账号：没有其它设备时「退出其它设备」置灰但保留入口", () => {
    render({ sessions: [makeSession({ current: true })] });
    const revokeOthers = [...document.querySelectorAll("button")].find(
        b => (b.textContent ?? "").trim() === "退出其它设备"
    );
    assert.ok(revokeOthers, "入口要在，否则用户会以为没有这个功能");
    assert.equal(revokeOthers!.disabled, true, "没有其它设备可踢时置灰");
});

// ---------------- 角色边界：「注销账号」只给普通账号（2026-10-17 用户要求） ----------------

test("账号：站点所有者看不到「注销当前账号」入口（站点不能没有管理者）", () => {
    // owner 时父组件不传 onDeleteAccount（App 里的门控），弹窗里就不该有这一节
    render({ currentUser: { username: "admin", role: "owner" } });
    assert.equal(button("注销当前账号"), undefined, "所有者不该有注销入口");
    assert.equal(
        pageText().includes("删除当前账号及其全部分组、卡片与备份配置，无法恢复"),
        false,
        "注销那一节不该渲染（说明文案里提到「注销账号」三个字不算）"
    );
    assert.ok(
        pageText().includes("站点所有者不提供注销入口"),
        "要跟所有者说清为什么没有这个入口"
    );
});

test("账号：普通账号有「注销当前账号」入口，点了只触发、二次确认交给父组件", () => {
    render({ currentUser: { username: "alice", role: "user" } });
    const del = button("注销当前账号")!;
    assert.ok(del, "普通账号该有注销入口");
    click(del);
    assert.equal(calls.deletes, 1, "注销只负责触发，二次确认交给父组件");
});

// ---------------- 角色边界：沉睡治理清单只给站点所有者（2026-10-17 用户要求：功能保留，
// 普通账号照样被治理，只是 owner 的弹窗里要能看到「其他账号多久没登录」） ----------------

test("账号：非所有者看不到账号清单与沉睡治理", () => {
    // 普通账号即使父组件误传了 accounts，也不该渲染治理小节（App 里 owner 才传，这里守边界）
    render({
        currentUser: { username: "alice", role: "user" },
        accounts: [makeAccount()],
    });
    assert.equal(pageText().includes("账号与沉睡治理"), false, "账号清单只有所有者能看");
    assert.equal(button("重新启用"), undefined);
});

test("账号：所有者的清单里只给已停用的账号「重新启用」", () => {
    render({
        accounts: [
            makeAccount({ id: 7, username: "alice", status: "active" }),
            makeAccount({
                id: 8,
                username: "bob",
                status: "disabled",
                disabledAt: now() - 5 * DAY,
                willDisableAt: null,
                willDeleteAt: now() + 25 * DAY,
            }),
        ],
    });
    assert.ok(pageText().includes("账号与沉睡治理"), "所有者应该看得到这一节");
    assert.ok(pageText().includes("bob"));
    assert.ok(pageText().includes("已停用"), "停用账号要标出状态与倒计时");

    const revive = [...document.querySelectorAll("button")].filter(
        b => (b.textContent ?? "").trim() === "重新启用"
    );
    assert.equal(revive.length, 1, "只有 bob 是停用的，不该给 alice 也来一个按钮");
    click(revive[0]);
    assert.deepEqual(calls.exempts, [8]);
});

test("账号：沉睡阈值只展示不在这儿改（编辑入口统一在设置 → 全站设置）", () => {
    // 整块只在「所有者 + 有账号清单」时才渲染，所以这里必须带上 accounts
    render({ accounts: [makeAccount()] });

    // 阈值显示的是父组件（服务端）读回来的值
    const disableInput = inputByLabel("多久没登录就停用（天）");
    const graceInput = inputByLabel("停用后保留多久再清除（天）");
    assert.ok(disableInput, "应显示停用阈值");
    assert.ok(graceInput, "应显示清除宽限期");
    assert.equal(disableInput!.value, "180");
    assert.equal(graceInput!.value, "30");

    // 两个输入框都是只读，且不再有「保存阈值」按钮 —— 改配置的入口只有「设置 → 全站设置 → 数据保留」一处
    assert.equal(disableInput!.disabled, true, "停用阈值应为只读");
    assert.equal(graceInput!.disabled, true, "清除宽限期应为只读");
    assert.equal(button("保存阈值"), undefined, "这里不该再提供保存阈值的按钮");
    assert.ok(
        pageText().includes("设置 → 全站设置 → 数据保留"),
        "要说明去哪儿改这两个天数"
    );

    // 阈值不再往父组件回写（onSaveInactivePolicy 这一段已经没人调了）
    assert.equal(calls.policies.length, 0, "这一页不该再提交阈值");
});
