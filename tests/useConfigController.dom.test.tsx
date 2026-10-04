// tests/useConfigController.dom.test.tsx
// 「网站设置 / 管理员凭据 / WebDAV 备份配置」这一整套状态的归口。
//
// 为什么补它：App 里原来是十几行 useState 摊在组件顶部，收进来之后却一条直测都没有。
// 这里三条规矩写反了都不报错，只是**悄悄出问题**：
//   1. **WebDAV 配置必须单独存放** —— 它带着网盘地址 / 账号 / 口令，
//      混进 configs 就会被写进备份文件，等于把网盘凭据塞进一份可能到处传的 JSON；
//   2. **落地 bootstrap 配置时 tempConfigs 要跟着一起刷新** ——
//      不刷新的话，用户先开一次设置弹窗再拉数据，弹窗里还是上一次的旧草稿；
//   3. **主色只有合法的 #rgb / #rrggbb 才采用，且预览值优先** ——
//      脏数据会把主题搞坏（MUI 拿到非法颜色会直接抛），预览值不优先则「选色即时生效」失效。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useConfigController } from "../src/hooks/useConfigController";
import { DEFAULT_CONFIGS, DEFAULT_WEBDAV_CONFIG } from "../src/appDefaults";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let api: ReturnType<typeof useConfigController> | null = null;

function Harness() {
    api = useConfigController();
    return (
        <div>
            <span data-testid="title">{api.configs["site.title"] ?? ""}</span>
            <span data-testid="temp-title">{api.tempConfigs["site.title"] ?? ""}</span>
            <span data-testid="accent">{api.accent}</span>
            <span data-testid="preview">{String(api.accentPreview)}</span>
            <span data-testid="dav-url">{api.webdavConfig.url}</span>
            <span data-testid="dav-private">{String(api.webdavConfig.allowPrivateNetwork)}</span>
            <span data-testid="auth">{api.authUsername}|{api.authCurrentPassword}|{api.authNewPassword}</span>
            <span data-testid="saving">{String(api.savingConfig)}|{String(api.savingAuth)}</span>
            <span data-testid="dav-in-configs">
                {Object.keys(api.configs).filter(k => k.startsWith("webdav.")).join(",")}
            </span>
        </div>
    );
}

function mount() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    api = null;
    document.body.innerHTML = "";
}

const text = (id: string) =>
    (document.querySelector(`[data-testid="${id}"]`)?.textContent || "").trim();

async function run(fn: () => void) {
    await act(async () => {
        fn();
        await Promise.resolve();
    });
}

// ---------------- 初始值 ----------------

test("初始：配置取默认值，弹窗全关，凭据为空", t => {
    t.after(cleanup);
    mount();
    assert.equal(text("title"), DEFAULT_CONFIGS["site.title"]);
    assert.equal(api!.openConfig, false);
    assert.equal(api!.openAccount, false);
    assert.equal(text("auth"), "||");
    assert.equal(text("saving"), "false|false");
    assert.deepEqual(api!.webdavConfig, DEFAULT_WEBDAV_CONFIG);
});

// ---------------- applyConfigs ----------------

test("落地远端配置：configs 与 tempConfigs 一起刷新", async t => {
    t.after(cleanup);
    // tempConfigs 不跟着刷的话：先开一次设置弹窗（草稿已生成）再拉一次数据，
    // 弹窗里显示的还是上一次的旧草稿，改完保存会把新拉下来的配置盖掉。
    mount();
    await run(() => api!.applyConfigs({ "site.title": "新站名" }));
    assert.equal(text("title"), "新站名");
    assert.equal(text("temp-title"), "新站名");
});

test("WebDAV 配置从 configs 里拆出来单独存放（它不该被写进备份文件）", async t => {
    t.after(cleanup);
    mount();
    await run(() =>
        api!.applyConfigs({
            "webdav.url": "https://dav.example.com",
            "webdav.username": "alice",
            "webdav.backupPassword": "secret",
            "webdav.allowPrivateNetwork": "1",
            "site.title": "站名",
        })
    );
    assert.equal(text("dav-url"), "https://dav.example.com");
    assert.equal(text("dav-private"), "true");
    assert.equal(
        text("dav-in-configs"),
        "",
        "webdav.* 不该留在 configs 里 —— 留在那儿就会被写进备份文件"
    );
    assert.equal(text("title"), "站名");
});

test("传 null / undefined：回落到默认配置，不是把界面清空", async t => {
    t.after(cleanup);
    mount();
    await run(() => api!.applyConfigs({ "site.title": "改过" }));
    await run(() => api!.applyConfigs(null));
    assert.equal(text("title"), DEFAULT_CONFIGS["site.title"]);
    assert.deepEqual(api!.webdavConfig, DEFAULT_WEBDAV_CONFIG);
});

// ---------------- 主色 ----------------

test("主色：预览值优先于已保存值（选色要即时生效）", async t => {
    t.after(cleanup);
    mount();
    await run(() => api!.setConfigs({ ...DEFAULT_CONFIGS, "site.primaryColor": "#123456" }));
    await run(() => api!.setAccentPreview("#abcdef"));
    assert.equal(text("accent"), "#abcdef", "有预览值时应该用预览值");
});

test("主色：非法值一律丢掉（脏数据会让 MUI 直接抛错）", async t => {
    t.after(cleanup);
    mount();
    for (const bad of ["red", "#12345", "rgb(1,2,3)", "#gggggg", "  "]) {
        await run(() => api!.setConfigs({ ...DEFAULT_CONFIGS, "site.primaryColor": bad }));
        await run(() => api!.setAccentPreview(null));
        assert.equal(text("accent"), "", `「${bad}」不是合法主色，应丢弃`);
    }
});

test("主色：#rgb 简写与带空格的 #rrggbb 都能用", async t => {
    t.after(cleanup);
    mount();
    await run(() => api!.setConfigs({ ...DEFAULT_CONFIGS, "site.primaryColor": "#abc" }));
    await run(() => api!.setAccentPreview(null));
    assert.equal(text("accent"), "#abc");

    await run(() => api!.setConfigs({ ...DEFAULT_CONFIGS, "site.primaryColor": "  #112233  " }));
    assert.equal(text("accent"), "#112233", "前后空格要去掉");
});

test("撤掉预览值后回到已保存的主色（关掉弹窗即回滚）", async t => {
    t.after(cleanup);
    mount();
    await run(() => api!.setConfigs({ ...DEFAULT_CONFIGS, "site.primaryColor": "#123456" }));
    await run(() => api!.setAccentPreview("#abcdef"));
    await run(() => api!.setAccentPreview(null));
    assert.equal(text("accent"), "#123456");
});

// ---------------- 弹窗与守卫 ----------------

test("设置弹窗的开关与「保存中」守卫各自独立", async t => {
    t.after(cleanup);
    mount();
    await run(() => api!.setOpenConfig(true));
    assert.equal(api!.openConfig, true);
    assert.equal(api!.openAccount, false, "开设置不该顺手开账号弹窗");
    await run(() => api!.setSavingConfig(true));
    assert.equal(text("saving"), "true|false", "保存配置的守卫不许把保存凭据的按钮也禁用");
});

test("临时配置改了不影响已保存的配置（关掉即丢）", async t => {
    t.after(cleanup);
    mount();
    await run(() => api!.applyConfigs({ "site.title": "已保存" }));
    await run(() => api!.setTempConfigs({ ...api!.tempConfigs, "site.title": "草稿" }));
    assert.equal(text("temp-title"), "草稿");
    assert.equal(text("title"), "已保存", "改草稿不该动已保存的");
});
