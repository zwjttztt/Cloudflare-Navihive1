// tests/BackupDialog.dom.test.tsx
// 第三个组件级用例：备份与恢复弹窗（729 行）。
//
// 为什么是它：这是站内**唯一能一键覆盖全部数据**的入口。写错一条就是「用户点了一下，
// 整个站的数据被换成备份里的那份」，而且不可逆。最该锁死的是那条闸门——
// 恢复前必须先弹差异预览，用户在预览里点取消就**绝不能**真导入。
import { test, afterEach } from "node:test";
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
    onImportData?: (data: ExportData) => Promise<unknown>;
    onRequestImportPreview?: (data: ExportData) => Promise<ExportData | null>;
    onIncludeCredentialsChange?: (enabled: boolean) => void;
    includeCredentials?: boolean;
    initialTab?: number;
}

// 兜底清理：这个文件的用例过去全都用 initialTab={1}（「恢复」页），
// 于是「备份」页出过一次「三元表达式丢了开头的 {、整段代码被当文本渲染」的
// 事故而无人发现（tab 0 从来没被渲染过）。afterEach 保证一条失败不会污染下一条。
afterEach(cleanup);

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
 * 等一个条件成立，而不是「睡固定时长」。
 *
 * 这个文件里的等待对象都是 **FileReader.onload**：它是真的异步回调，固定睡 30ms
 * 在负载高的机器（或 CI）上会偶发不够用 —— 表现为用例随机红一条，
 * 而偶发红的测试比没有测试更糟，因为它会训练人忽略红色。
 * 所以一律改成轮询：条件先成立就立刻往下走，真等不到再失败并说明等的是什么。
 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > deadline) {
            assert.fail(`等了 ${timeoutMs}ms 也没等到：${label}`);
        }
        await settle(10);
    }
}

/** 等「开始恢复」变成可用（等价于：备份文件解析完了） */
async function waitRestoreEnabled() {
    await waitFor("「开始恢复」按钮可用（备份解析完成）", () => {
        const btn = buttonByText("开始恢复");
        return !!btn && !btn.disabled;
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
        // rest 参数而不是写死几个：这样 fn 既能接 (data, onProgress) 这种多参回调，
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
    assert.equal(restoreBtn!.disabled, true, "没选文件时不该能点");
});

test("BackupDialog：选中合法备份文件后，恢复按钮才可用", async t => {
    t.after(cleanup);
    mount();
    await selectBackupFile(JSON.stringify(makeBackup()));
    await waitRestoreEnabled();

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
    await waitRestoreEnabled();

    await clickAsync(buttonByText("开始恢复")!);
    await waitFor("差异预览被弹出", () => previewed.count === 1);

    assert.equal(previewed.count, 1, "恢复前必须弹差异预览，不能直接导入");
});

test("BackupDialog：预览里点了取消（返回 null）→ 绝不导入", async t => {
    t.after(cleanup);
    const imported = counter();
    const previewed = counter();
    mount({
        onRequestImportPreview: async () => {
            previewed.fn();
            return null;
        },
        onImportData: async () => {
            imported.fn();
        },
    });
    await selectBackupFile(JSON.stringify(makeBackup()));
    await waitRestoreEnabled();

    await clickAsync(buttonByText("开始恢复")!);
    await waitFor("差异预览被弹出（取消分支等的是它，不是导入）", () => previewed.count === 1);

    assert.equal(
        imported.count,
        0,
        "用户在预览里取消就不该导入——错了就是「点取消却把数据全换了」"
    );
});

test("BackupDialog：预览确认后才真导入", async t => {
    t.after(cleanup);
    const imported = counter<[ExportData]>();
    mount({
        onRequestImportPreview: async data => data,
        onImportData: async data => {
            imported.fn(data);
        },
    });
    await selectBackupFile(JSON.stringify(makeBackup()));
    await waitRestoreEnabled();

    await clickAsync(buttonByText("开始恢复")!);
    await waitFor("预览确认后导入一次", () => imported.count === 1);

    assert.equal(imported.count, 1, "预览确认后应导入一次");
});

test("BackupDialog：默认合并导入；覆盖导入是显式开关且默认关", async t => {
    t.after(cleanup);
    mount();

    const text = document.body.textContent || "";
    // 默认语义是「不删任何数据」的合并导入 —— 这句必须写在动作之前
    assert.ok(
        text.includes("合并导入（不会删除任何现有数据）"),
        "默认态要写明是合并导入"
    );
    // 覆盖导入的开关回来了（用户要求保留这个选项），但必须默认关、
    // 且开着时给红色警示 —— 它是这一页唯一会删数据的动作
    const overwriteSwitch = document.querySelector<HTMLInputElement>(
        'input[aria-label="覆盖导入"]'
    );
    assert.ok(overwriteSwitch, "要保留覆盖导入的开关（用户明确要求）");
    assert.equal(
        overwriteSwitch!.checked,
        false,
        "覆盖导入默认必须关着 —— 打开是要有意识的选择"
    );
    // Switch 是 checkbox 的角色，但勾选态由 checked 而非 checkbox 数量体现
    assert.ok(
        !text.includes("覆盖恢复"),
        "老的「覆盖恢复」叫法不该回来（现在的措辞是覆盖导入）"
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

test("「备份」页能正常渲染（tab 0 曾经整段变成裸文本）", () => {
    // 这条钉的是一个真实事故：`{tab === 0 ? (` 的开头的 `{` 丢过一次，
    // 于是 `tab === 0 ? (` 被当成文本直接渲染在页面上，
    // **两个 tab 的内容同时可见**、按钮全部点不动。
    // TS 编译抓不到（缺 `{` 在 JSX 文本位置是合法语法），
    // 而本文件原有的用例全都渲染 tab 1，所以一直没暴露。
    mount({ initialTab: 0 });
    const text = document.body.textContent || "";
    assert.ok(
        !text.includes("tab === 0"),
        "页面里出现了 `tab === 0` 这类源码文本 —— JSX 的 `{` 丢了，条件渲染变成了纯文本"
    );
    assert.ok(text.includes("备份到本地"), "「备份」页的内容该出现");
    assert.ok(
        !text.includes("恢复到本地"),
        "「恢复」页的内容不该同时出现（两个 tab 一起渲染就是条件渲染失效的表现）"
    );
});

test("「备份」页不再有「备份包含记事本」开关（导航备份一律不含笔记）", () => {
    mount({ initialTab: 0 });
    const sw = document.querySelector<HTMLInputElement>('input[aria-label="备份包含记事本"]');
    assert.ok(sw === null, "记事本开关已移除，不该再出现");
});

// ---- 上次备份详情（webdav.lastBackupInfo）----
// 备份失败最难排的就是「卡在哪」：只显示一个时间的话，用户既不知道备份多大、
// 也不知道上次传了多久。详情 JSON 是**服务端写进来的用户配置**（不是编译期常量），
// 老库没这个键、写入被截断都会让 JSON.parse 抛 —— 而这是在渲染路径上，
// 抛出去整个备份对话框打不开。所以两条都要锁：正常时显示出来，坏值时安静退化。

function mountBackupTab(handlers: { lastBackupAt?: string; lastBackupInfo?: string } = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <BackupDialog
                open
                initialTab={0}
                client={{} as unknown as NavigationClient}
                webdavConfig={WEBDAV}
                onSaveWebdavConfig={async () => {}}
                onBuildExportData={makeBackup}
                onDownloadLocal={() => {}}
                onImportData={async () => {}}
                onNotify={() => {}}
                onClose={() => {}}
                includeCredentials
                onIncludeCredentialsChange={() => {}}
                lastBackupAt={handlers.lastBackupAt ?? ""}
                lastBackupInfo={handlers.lastBackupInfo ?? ""}
            />
        );
    });
}

test("备份页展示上次备份的体积与耗时", () => {
    mountBackupTab({
        lastBackupAt: "2026-10-12T10:00:00.000Z",
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-auto-2026-10-12.json.gz",
            size: 5 * 1024 * 1024,
            mode: "auto",
            durationMs: 42_000,
        }),
    });
    const text = document.body.textContent || "";
    assert.ok(text.includes("上次备份"), "该显示「上次备份」");
    assert.ok(text.includes("自动"), "该标明是自动备份");
    assert.ok(text.includes("5.00 MB"), `该显示体积，实际：${text.slice(0, 400)}`);
    assert.ok(text.includes("42.0 秒"), "该显示耗时");
});

test("lastBackupInfo 是坏 JSON 时安静退化，只显示时间（不能把对话框搞崩）", () => {
    mountBackupTab({
        lastBackupAt: "2026-10-12T10:00:00.000Z",
        // 老库没这个键 / 写入被截断都会得到这种值
        lastBackupInfo: '{"filename":"x.json.gz","size":12',
    });
    const text = document.body.textContent || "";
    assert.ok(text.includes("上次备份"), "时间照常显示");
    assert.ok(!text.includes("MB"), "解析失败就不该硬显示体积");
});

test("没有备份记录时显示引导文案", () => {
    mountBackupTab({});
    assert.ok((document.body.textContent || "").includes("还没有备份记录"));
});
