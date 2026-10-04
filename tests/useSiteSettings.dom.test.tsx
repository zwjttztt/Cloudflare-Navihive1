// tests/useSiteSettings.dom.test.tsx
// 「网站设置 / 管理员凭据」这一块的写逻辑。
//
// 为什么补它：这里是全站最容易「悄悄写坏」的一处 ——
// 配置保存是**批量**的（一次请求写完所有改动项），凭据保存成功后要**把用户踢回登录页**
// （服务端令牌版本 +1，旧令牌立刻失效）。写反了的表现都不是报错：
//   - 没变化也发请求 → 每次点保存都多一次写库，还会弹「设置已保存」骗人；
//   - 改完凭据不踢回登录页 → 用户留在页面上，之后每个请求都是 401，一脸茫然；
//   - 保存失败却报成功 → 用户以为存好了，刷新才发现没有。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSiteSettings, type SettingsApi } from "../src/hooks/useSiteSettings";
import { clearRememberedLogin, saveRememberedLogin } from "../src/utils/rememberedLogin";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** 外部可观察的记录 */
type Log = {
    notify: Array<{ text: string; level?: string }>;
    errors: string[];
    logout: number;
    dataError: string[];
    menuClose: number;
    setConfigsCalls: Array<Record<string, string>>;
    updateAuthCalls: Array<{ username: string; password: string; currentPassword: string }>;
    openConfig: boolean;
    authUsername: string;
    authCurrentPassword: string;
    authNewPassword: string;
};

interface HarnessProps {
    api: SettingsApi;
    log: Log;
    /** 已保存的配置 */
    configs: Record<string, string>;
    /** 弹窗里的临时配置（模拟用户在弹窗里改过什么） */
    tempConfigs: Record<string, string>;
    /** 预填的管理员凭据三个输入框 */
    auth?: { username: string; currentPassword: string; newPassword: string };
}

function Harness({
    api,
    log,
    configs: initialConfigs,
    tempConfigs: initialTemp,
    auth = { username: "", currentPassword: "", newPassword: "" },
}: HarnessProps) {
    const [configs, setConfigs] = useState(initialConfigs);
    const [tempConfigs, setTempConfigs] = useState(initialTemp);
    const [authUsername, setAuthUsername] = useState(auth.username);
    const [authCurrentPassword, setAuthCurrentPassword] = useState(auth.currentPassword);
    const [authNewPassword, setAuthNewPassword] = useState(auth.newPassword);
    const [savingAuth, setSavingAuth] = useState(false);
    const [openConfig, setOpenConfig] = useState(false);
    const [accentPreview, setAccentPreview] = useState<string | null>("#ff0000");
    const [, setSavingConfig] = useState(false);
    const [, setOpenAccount] = useState(false);

    const s = useSiteSettings({
        api,
        notify: (text, level) => void log.notify.push({ text, level }),
        onError: msg => void log.errors.push(msg),
        onMenuClose: () => void log.menuClose++,
        onLogout: () => void log.logout++,
        onDataError: msg => void log.dataError.push(msg),
        configs,
        setConfigs,
        tempConfigs,
        setTempConfigs,
        setAccentPreview,
        setOpenConfig,
        authUsername,
        authCurrentPassword,
        authNewPassword,
        setAuthUsername,
        setAuthCurrentPassword,
        setAuthNewPassword,
        savingAuth,
        setSavingAuth,
        setOpenAccount,
        setSavingConfig,
    });

    log.openConfig = openConfig;
    log.authUsername = authUsername;
    log.authCurrentPassword = authCurrentPassword;
    log.authNewPassword = authNewPassword;

    return (
        <div>
            <button data-testid="open" onClick={s.handleOpenConfig}>open</button>
            <button data-testid="close" onClick={s.handleCloseConfig}>close</button>
            <button data-testid="save" onClick={() => void s.handleSaveConfig()}>save</button>
            <button data-testid="saveAuth" onClick={() => void s.handleSaveAuthCredentials()}>
                saveAuth
            </button>
            <span data-testid="temp">{JSON.stringify(tempConfigs)}</span>
            <span data-testid="preview">{String(accentPreview)}</span>
        </div>
    );
}

function mount(props: HarnessProps) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness {...props} />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

async function click(id: string) {
    const el = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    assert.ok(el, `应有 [data-testid="${id}"]`);
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // 保存是 async 的，等一下微任务让状态落下来
    await act(async () => {
        await Promise.resolve();
    });
}

const text = (id: string) =>
    (document.querySelector(`[data-testid="${id}"]`)?.textContent || "").trim();

function makeApi(overrides: Partial<SettingsApi> = {}) {
    const log: Log = {
        notify: [],
        errors: [],
        logout: 0,
        dataError: [],
        menuClose: 0,
        setConfigsCalls: [],
        updateAuthCalls: [],
        openConfig: false,
        authUsername: "",
        authCurrentPassword: "",
        authNewPassword: "",
    };
    const api: SettingsApi = {
        updateAuthCredentials: (username, password, currentPassword) => {
            log.updateAuthCalls.push({ username, password, currentPassword });
            return Promise.resolve({ success: true });
        },
        setConfigs: c => {
            log.setConfigsCalls.push(c);
            return Promise.resolve(true);
        },
        ...overrides,
    };
    return { api, log };
}

test("打开设置：先收起「更多选项」，把当前配置快照进临时区，清空上次的凭据输入", async t => {
    t.after(cleanup);
    const { api, log } = makeApi();
    mount({
        api,
        log,
        configs: { "site.title": "导航站", "site.glassBlur": "14" },
        tempConfigs: { 残留: "上一次没保存的" },
        auth: { username: "admin", currentPassword: "x", newPassword: "y" },
    });

    await click("open");
    assert.equal(log.menuClose, 1, "不先收菜单的话菜单会失去锚点跑到左上角");
    assert.equal(log.openConfig, true);
    assert.deepEqual(
        JSON.parse(text("temp")),
        { "site.title": "导航站", "site.glassBlur": "14" },
        "应快照当前配置，把上次没保存的残留盖掉"
    );
    assert.equal(log.authUsername, "");
    assert.equal(log.authNewPassword, "", "凭据每次打开都要重填，避免误存上一次的输入");
});

test("保存配置：只提交有变化的项，且一次请求写完", async t => {
    t.after(cleanup);
    const { api, log } = makeApi();
    mount({
        api,
        log,
        configs: { a: "1", b: "2", c: "3" },
        tempConfigs: { a: "1", b: "改过了", c: "3" },
    });

    await click("save");
    assert.equal(log.setConfigsCalls.length, 1, "十项改动也该是一次请求，不是一个一个发");
    assert.deepEqual(log.setConfigsCalls[0], { b: "改过了" }, "没变的项不该混进去");
    assert.ok(
        log.notify.some(n => n.text.includes("设置已保存")),
        `应提示保存成功，实际 ${JSON.stringify(log.notify)}`
    );
});

test("保存配置：一项都没改时不发请求、也不谎报「已保存」", async t => {
    t.after(cleanup);
    const { api, log } = makeApi();
    mount({ api, log, configs: { a: "1" }, tempConfigs: { a: "1" } });

    await click("save");
    assert.equal(log.setConfigsCalls.length, 0, "没改动就不该写库");
    assert.equal(
        log.notify.some(n => n.text.includes("设置已保存")),
        false,
        "什么都没改却提示「已保存」是在骗人"
    );
});

test("保存配置：服务端说没写成功要报错，且绝不报成功", async t => {
    t.after(cleanup);
    const { api, log } = makeApi({ setConfigs: () => Promise.resolve(false) });
    mount({ api, log, configs: { a: "1" }, tempConfigs: { a: "2" } });

    await click("save");
    assert.ok(
        log.errors.some(e => e.includes("保存配置失败")),
        `应报错，实际 ${JSON.stringify(log.errors)}`
    );
    assert.equal(
        log.notify.some(n => n.text.includes("设置已保存")),
        false,
        "失败了绝不能报成功"
    );
});

test("保存凭据：既没新账号也没新密码 → 提示「没有需要保存的改动」，不调接口", async t => {
    t.after(cleanup);
    const { api, log } = makeApi();
    mount({ api, log, configs: {}, tempConfigs: {} });

    await click("saveAuth");
    assert.equal(log.updateAuthCalls.length, 0);
    assert.ok(
        log.notify.some(n => n.text.includes("没有需要保存的改动")),
        `实际 ${JSON.stringify(log.notify)}`
    );
});

test("保存凭据：要改却没填当前密码 → 明确报错，不把请求发出去", async t => {
    t.after(cleanup);
    const { api, log } = makeApi();
    mount({
        api,
        log,
        configs: {},
        tempConfigs: {},
        auth: { username: "admin2", currentPassword: "", newPassword: "newpass" },
    });

    await click("saveAuth");
    assert.equal(log.updateAuthCalls.length, 0, "缺当前密码时不该调接口");
    assert.ok(
        log.errors.some(e => e.includes("当前密码")),
        `应提示先填当前密码，实际 ${JSON.stringify(log.errors)}`
    );
});

test("保存凭据成功：清掉「记住登录」并踢回登录页，且说明为什么被踢", async t => {
    t.after(cleanup);
    saveRememberedLogin({ username: "old" });
    const { api, log } = makeApi();
    mount({
        api,
        log,
        configs: {},
        tempConfigs: {},
        auth: { username: "admin2", currentPassword: "oldpass", newPassword: "newpass" },
    });

    await click("saveAuth");
    assert.equal(log.updateAuthCalls.length, 1);
    assert.deepEqual(log.updateAuthCalls[0], {
        username: "admin2",
        password: "newpass",
        currentPassword: "oldpass",
    });
    assert.equal(log.logout, 1, "改完凭据服务端令牌版本 +1，必须踢回登录页");
    assert.ok(
        log.dataError.some(m => m.includes("重新登录")),
        `要说明为什么被踢，实际 ${JSON.stringify(log.dataError)}`
    );
    assert.equal(
        localStorage.getItem("navihive:rememberedLogin"),
        null,
        "「记住登录」里存的是旧账号，留着只会误导"
    );
});

test("保存凭据被服务端拒绝（当前密码不对）：报错、不踢人、不清「记住登录」", async t => {
    t.after(cleanup);
    saveRememberedLogin({ username: "old" });
    const { api, log } = makeApi({
        updateAuthCredentials: () => Promise.resolve({ success: false, message: "当前密码不正确" }),
    });
    mount({
        api,
        log,
        configs: {},
        tempConfigs: {},
        auth: { username: "admin2", currentPassword: "wrong", newPassword: "newpass" },
    });

    await click("saveAuth");
    assert.ok(
        log.errors.some(e => e.includes("当前密码不正确")),
        `应把服务端的理由原样报出来，实际 ${JSON.stringify(log.errors)}`
    );
    assert.equal(log.logout, 0, "没改成就不该把人踢出去");
    assert.ok(localStorage.getItem("navihive:rememberedLogin"), "没改成就不该清掉记住登录");
    cleanup();
    clearRememberedLogin();
});

test("关闭设置：撤掉主色预览（没保存就回滚，不能让预览色一直挂着）", async t => {
    t.after(cleanup);
    const { api, log } = makeApi();
    mount({ api, log, configs: {}, tempConfigs: {} });
    assert.equal(text("preview"), "#ff0000");
    await click("close");
    assert.equal(log.openConfig, false);
    assert.equal(text("preview"), "null", "关掉要把预览色撤掉，改由已保存的配置驱动主题");
});
