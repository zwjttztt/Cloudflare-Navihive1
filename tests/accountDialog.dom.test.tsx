// tests/accountDialog.dom.test.tsx
// 账号管理弹窗，之前零覆盖。这里盯的是几条「改坏了不会报错、但会坑到人」的分支：
// 改密按钮的脏检查（没填新账号/新密码就不该能提交）、生成私钥要先验当前密码、
// 邀请码的显示时机，以及「登录设备」一节的渲染。
//
// 另有一条回归守卫：「不活跃停用」与「注销当前账号」两个功能 2026-10-17 按站点
// 所有者要求整体关闭（入口 + cron 自动扫描一并停），用例钉住它们不再出现。
//
// 组件所有值都由父组件持有（auth / invite / sessions），所以用一个 Harness 持有状态，
// 尽量贴近 App 里的真实用法。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import AccountDialog, { type AccountAuthDraft } from "../src/components/AccountDialog";
import type { InviteInfo, SessionInfo } from "../src/API/http";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: window.localStorage,
        configurable: true,
        writable: true,
    });
}

const now = () => Math.floor(Date.now() / 1000);

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
    closes: number;
};

type Opts = {
    currentUser?: { username: string; role: "owner" | "user" } | null;
    recoveryKeyConfigured?: boolean;
    generateResult?: { success: boolean; message?: string };
    inviteResult?: { success: boolean; message?: string; code?: string; expiresAt?: number };
    sessions?: SessionInfo[];
    withSessions?: boolean;
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

// ---------------- 回归守卫：两个功能已按站点所有者要求关闭（2026-10-17） ----------------

test("账号：「注销当前账号」入口已移除（单账号部署不该能把自己删了）", () => {
    render();
    assert.equal(button("注销当前账号"), undefined, "注销入口必须不再出现");
    assert.equal(pageText().includes("注销账号"), false, "整节都不该渲染");
});

test("账号：「不活跃停用 / 沉睡治理」整节已移除", () => {
    render();
    assert.equal(pageText().includes("账号与沉睡治理"), false, "治理节必须不再出现");
    assert.equal(pageText().includes("沉睡"), false, "相关文案一并清掉");
    assert.equal(button("立即扫描"), undefined, "手动扫描入口不再有");
    assert.equal(button("重新启用"), undefined, "豁免入口不再有");
    // 顶部说明也不再提「注销 / 站点治理」
    assert.equal(pageText().includes("再往下是站点治理"), false);
});
