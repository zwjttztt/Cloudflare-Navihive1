// tests/BackupDialog.dom.test.tsx
// 第三个组件级用例：备份与恢复弹窗（729 行）。
//
// 为什么是它：这是站内**唯一能一键覆盖全部数据**的入口。写错一条就是「用户点了一下，
// 整个站的数据被换成备份里的那份」，而且不可逆。最该锁死的是那条闸门——
// 恢复前必须先弹差异预览，用户在预览里点取消就**绝不能**真导入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BackupDialog from "../src/components/BackupDialog";
import type { NavigationClient } from "../src/API/client";
import type { ExportData, WebDavConfig } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const WEBDAV: WebDavConfig = { url: "", username: "", password: "", path: "" };

function makeBackup(): ExportData {
    return {
        version: "1.2",
        exportDate: new Date().toISOString(),
        configs: {},
        groups: [{ id: 1, name: "常用工具", order_num: 0 }] as ExportData["groups"],
        sites: [{ id: 11, group_id: 1, name: "示例", url: "https://a.com" }] as ExportData["sites"],
    };
}

interface Handlers {
    onImportData?: (data: ExportData, overwrite: boolean) => Promise<void>;
    onRequestImportPreview?: (
        data: ExportData,
        overwrite: boolean
    ) => Promise<ExportData | null>;
    onIncludeCredentialsChange?: (enabled: boolean) => void;
    includeCredentials?: boolean;
    initialTab?: number;
}

function mount(handlers: Handlers = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <BackupDialog
                open
                // 恢复页（tab 1）；这几个用例不碰 WebDAV，所以 client 给个空壳
                initialTab={handlers.initialTab ?? 1}
                client={{} as unknown as NavigationClient}
                webdavConfig={WEBDAV}
                onSaveWebdavConfig={async () => {}}
                onBuildExportData={makeBackup}
                onDownloadLocal={() => {}}
                onImportData={handlers.onImportData ?? (async () => {})}
                onRequestImportPreview={handlers.onRequestImportPreview}
                onNotify={() => {}}
                onClose={() => {}}
                includeCredentials={handlers.includeCredentials ?? true}
                onIncludeCredentialsChange={handlers.onIncludeCredentialsChange ?? (() => {})}
            />
        );
    });
}

function cleanup() {
    if (root) {
        act(() => {
            root!.unmount();
        });
    }
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

/** 按 label 文案找开关（覆盖/合并那个 Switch 没有 aria-label，只能靠文案） */
function switchByLabelText(text: string): HTMLInputElement | null {
    const label = [...document.querySelectorAll("label")].find(el =>
        (el.textContent || "").includes(text)
    );
    return label ? label.querySelector("input") : null;
}

async function clickAsync(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

/** 等 FileReader / promise 链跑完 */
async function settle(ms = 30) {
    await act(async () => {
        await new Promise(r => setTimeout(r, ms));
    });
}

/**
 * 给隐藏的 file input 塞一个文件。
 * 必须用 jsdom 自己的 File（Node 22 全局也有个 File，跟 jsdom 的 FileReader 不通用），
 * 且 files 是只读属性，只能 defineProperty 覆盖。
 */
async function selectBackupFile(json: string) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(input, "应有隐藏的文件选择 input");
    const FileCtor = (window as unknown as { File: new (parts: BlobPart[], name: string, opts?: object) => Blob }).File;
    const file = new FileCtor([json], "backup.json", { type: "application/json" });
    Object.defineProperty(input!, "files", { value: [file], configurable: true });
    await act(async () => {
        input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
}

function counter<T = unknown>() {
    const calls: T[] = [];
    return {
        calls,
        // rest 参数而不是写死几个：这样 fn 既能接 (data, overwrite) 这种多参回调，
        // 也能赋给零参数的 props（onClose）——形参比目标签名多会不兼容
        fn: (...args: unknown[]) => void calls.push(args as unknown as T),
        get count() {
            return calls.length;
        },
    };
}

test("BackupDialog：没选备份文件时「开始恢复」是禁用的（防呆）", t => {
    t.after(cleanup);
    mount();

    const restoreBtn = buttonByText("开始恢复");
    assert.ok(restoreBtn, "应有「开始恢复」按钮");
    assert.equal(restoreBtn!.disabled, true, "没选文件时不该能点——点了会覆盖全部数据");
});

test("BackupDialog：选中合法备份文件后，恢复按钮才可用", async t => {
    t.after(cleanup);
    mount();
    await selectBackupFile(JSON.stringify(makeBackup()));

    const restoreBtn = buttonByText("开始恢复");
    assert.ok(restoreBtn, "应有「开始恢复」按钮");
    assert.equal(restoreBtn!.disabled, false, "选了合法备份后应可点");
    const text = document.body.textContent || "";
    assert.ok(text.includes("已选择：backup.json"), "应显示已选文件名");
});

test("BackupDialog：恢复前会先过一遍差异预览", async t => {
    t.after(cleanup);
    const previewed = counter();
    mount({
        onRequestImportPreview: async data => {
            previewed.fn(data);
            return data;
        },
    });
    await selectBackupFile(JSON.stringify(makeBackup()));

    await clickAsync(buttonByText("开始恢复")!);
    await settle();

    assert.equal(previewed.count, 1, "恢复前必须弹差异预览，不能直接导入");
});

test("BackupDialog：预览里点了取消（返回 null）→ 绝不导入", async t => {
    t.after(cleanup);
    const imported = counter();
    mount({
        onRequestImportPreview: async () => null,
        onImportData: async () => {
            imported.fn();
        },
    });
    await selectBackupFile(JSON.stringify(makeBackup()));

    await clickAsync(buttonByText("开始恢复")!);
    await settle();

    assert.equal(
        imported.count,
        0,
        "用户在预览里取消就不该导入——错了就是「点取消却把数据全换了」"
    );
});

test("BackupDialog：预览确认后才真导入，并带上覆盖开关的状态", async t => {
    t.after(cleanup);
    const imported = counter<[ExportData, boolean]>();
    mount({
        onRequestImportPreview: async data => data,
        onImportData: async (data, overwrite) => {
            imported.fn(data, overwrite);
        },
    });
    await selectBackupFile(JSON.stringify(makeBackup()));

    // 默认是合并导入，点一下切成「覆盖恢复」
    const mergeSwitch = switchByLabelText("合并导入（保留现有数据并追加）");
    assert.ok(mergeSwitch, "应能找到覆盖/合并开关");
    await clickAsync(mergeSwitch!);

    await clickAsync(buttonByText("开始恢复")!);
    await settle();

    assert.equal(imported.count, 1, "预览确认后应导入一次");
    const [, overwrite] = imported.calls[0] as unknown as [ExportData, boolean];
    assert.equal(overwrite, true, "切成覆盖恢复后，overwrite 应为 true");
});

test("BackupDialog：默认合并导入，切到覆盖后文案与警告一起变", async t => {
    t.after(cleanup);
    mount();

    // 默认是合并：覆盖会清空现有数据，不该是默认值
    assert.ok(
        (document.body.textContent || "").includes("合并导入（保留现有数据并追加）"),
        "默认应是合并导入"
    );

    const sw = switchByLabelText("合并导入（保留现有数据并追加）");
    assert.ok(sw, "应能找到覆盖/合并开关");
    await clickAsync(sw!);

    const text = document.body.textContent || "";
    assert.ok(text.includes("覆盖恢复（清空现有数据后导入）"), "切换后应变覆盖文案");
    assert.ok(!text.includes("合并导入（保留现有数据并追加）"), "旧文案应消失");
    assert.ok(
        text.includes("覆盖恢复会先清空现有的分组与站点"),
        "切成覆盖时要给出不可逆提示"
    );
});

test("BackupDialog：凭据开关有 aria-label，切换会回调父级", async t => {
    t.after(cleanup);
    const toggled = counter<[boolean]>();
    mount({
        // 凭据开关在「备份」页（tab 0），不在恢复页
        initialTab: 0,
        includeCredentials: true,
        onIncludeCredentialsChange: (enabled: boolean) => toggled.fn(enabled),
    });

    const sw = document.querySelector<HTMLInputElement>(
        'input[aria-label="备份包含网站登录凭据"]'
    );
    assert.ok(sw, "凭据开关应有 aria-label（读屏要用）");
    await clickAsync(sw!);

    assert.equal(toggled.count, 1, "切换应回调一次");
    assert.equal((toggled.calls[0] as unknown as [boolean])[0], false, "应从 true 切到 false");
});
