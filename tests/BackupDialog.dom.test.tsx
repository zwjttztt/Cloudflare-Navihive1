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
    // ---- 备份页（tab 0）要看的「上次备份」状态 ----
    autoBackup?: boolean;
    lastBackupAt?: string;
    lastBackupInfo?: string;
    lastAutoBackupAt?: string;
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
                autoBackup={handlers.autoBackup ?? true}
                lastBackupAt={handlers.lastBackupAt ?? ""}
                lastBackupInfo={handlers.lastBackupInfo ?? ""}
                lastAutoBackupAt={handlers.lastAutoBackupAt ?? ""}
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

test("「备份」页要写清哪些内容跟着备份走、哪些不会（AI 设置 / 凭据）", () => {
    // 用户 2026-10-24 直接问「ai 设置、全站设置等内容是否会随着导入导出」——
    // 说明界面上原来一个字都没写。规则本身在 utils/backupScope 里有单测，
    // 这条只盯「用户看不看得见」。当天用户进一步要求 AI 整组进备份，
    // 于是文案里它从「不会跟着走」挪到了「会跟着走」，并带上密钥提醒。
    mount({ initialTab: 0 });
    const text = document.body.textContent || "";
    assert.ok(text.includes("会跟着走"), "要有「哪些会跟着走」");
    assert.ok(text.includes("AI 设置整组"), "AI 设置整组进备份，必须点名");
    assert.ok(text.includes("不会跟着走"), "要有「哪些不会跟着走」");
    assert.ok(text.includes("记事本"), "笔记走独立备份，要说清楚");
    assert.ok(
        text.includes("妥善保管") || text.includes("备份口令"),
        "密钥会进文件，必须提醒设口令 / 保管文件"
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

function mountBackupTab(
    handlers: {
        lastBackupAt?: string;
        lastBackupInfo?: string;
        lastAutoBackupAt?: string;
        autoBackup?: boolean;
        includeCredentials?: boolean;
    } = {}
) {
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
                includeCredentials={handlers.includeCredentials ?? true}
                onIncludeCredentialsChange={() => {}}
                autoBackup={handlers.autoBackup ?? true}
                lastBackupAt={handlers.lastBackupAt ?? ""}
                lastBackupInfo={handlers.lastBackupInfo ?? ""}
                lastAutoBackupAt={handlers.lastAutoBackupAt ?? ""}
            />
        );
    });
}

// 「上次备份」那一块 2026-10-29 拆成两行（自动 / 手动）——为什么必须拆：
//   `webdav.lastBackupAt` 只记「最后一次」，手动备份会把它刷成新时间。
//   于是「自动备份整整一周没跑」在界面上完全看不出来：时间那行是正常的。
//   线上就靠这个假象把一次静默失效藏了两周。

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

test("备份页展示上次自动备份的体积与耗时", () => {
    mountBackupTab({
        lastBackupAt: "2026-10-12T10:00:00.000Z",
        lastAutoBackupAt: "2026-10-12T10:00:00.000Z",
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-auto-2026-10-12.json.gz",
            size: 5 * 1024 * 1024,
            mode: "auto",
            durationMs: 42_000,
        }),
    });
    const text = document.body.textContent || "";
    assert.ok(text.includes("最近一次自动备份"), `该有「最近一次自动备份」这一行，实际：${text.slice(0, 400)}`);
    assert.ok(text.includes("5.00 MB"), `该显示体积，实际：${text.slice(0, 400)}`);
    assert.ok(text.includes("42.0 秒"), "该显示耗时");
    assert.ok(
        !text.includes("最近一次手动备份"),
        "最后一次是自动备份时，就不该编一句「最近一次手动备份」出来（那个时间我们并不知道）"
    );
});

test("lastBackupInfo 是坏 JSON 时安静退化：不崩、不显示体积，但时间还在", () => {
    mountBackupTab({
        lastBackupAt: "2026-10-12T10:00:00.000Z",
        // 老库没这个键 / 写入被截断都会得到这种值
        lastBackupInfo: '{"filename":"x.json.gz","size":12',
    });
    const text = document.body.textContent || "";
    assert.ok(text.includes("最近一次备份"), `分不清自动还是手动时也要把时间显示出来，实际：${text.slice(0, 400)}`);
    assert.ok(!text.includes("MB"), "解析失败就不该硬显示体积");
});

test("没有备份记录时显示引导文案", () => {
    mountBackupTab({});
    assert.ok(
        (document.body.textContent || "").includes("还没有自动备份记录"),
        `该说清「还没有自动备份记录」，实际：${document.body.textContent?.slice(0, 300)}`
    );
});

test("自动备份超过 8 天没成功：用警示色给出「请检查网盘配置」", () => {
    // 这就是线上那次事故的形态：lastBackupAt 被手动备份刷成 1 天前，
    // 而自动备份其实 30 天没成功了。只看 lastBackupAt 会得到「一切正常」。
    mountBackupTab({
        lastBackupAt: daysAgo(1),
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-2026-10-28.json.gz",
            size: 1024,
            mode: "manual",
            durationMs: 1000,
            encrypted: true,
        }),
        lastAutoBackupAt: daysAgo(30),
    });
    const text = document.body.textContent || "";
    assert.ok(
        text.includes("自动备份已 30 天没有成功，请检查网盘配置"),
        `该有那句警示，实际：${text.slice(0, 400)}`
    );
    assert.ok(text.includes("最近一次手动备份"), "手动那行也该在（最后一次确实是手动）");
    const warning = document.querySelector(".nav-backup-auto-stale");
    assert.ok(warning, "警示那行要有独立节点，才谈得上用警示色");
});

test("自动备份 2 天前成功：不报「没有成功」，只显示「2 天前」", () => {
    mountBackupTab({
        lastAutoBackupAt: daysAgo(2),
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-auto-x.json.gz",
            size: 1024,
            mode: "auto",
            durationMs: 1000,
            encrypted: true,
        }),
    });
    const text = document.body.textContent || "";
    assert.ok(text.includes("（2 天前）"), `要显示「2 天前」，实际：${text.slice(0, 400)}`);
    assert.ok(!text.includes("没有成功"), "正常的自动备份不该报警");
});

test("自动备份开关关着：就算很久没备份也不报警（用户自己选的）", () => {
    mountBackupTab({ autoBackup: false, lastAutoBackupAt: daysAgo(30) });
    assert.ok(
        !(document.body.textContent || "").includes("没有成功"),
        "关掉自动备份的用户不该被「自动备份已 N 天没有成功」骚扰"
    );
});

test("上次备份详情里的 encrypted 字段：true 显示「已加密」，false 显示「未加密」", () => {
    mountBackupTab({
        lastAutoBackupAt: daysAgo(1),
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-auto-x.json.gz",
            size: 1024,
            mode: "auto",
            durationMs: 1000,
            encrypted: true,
        }),
    });
    assert.ok((document.body.textContent || "").includes("已加密"), "加密过就要说出来");

    cleanup();
    mountBackupTab({
        lastAutoBackupAt: daysAgo(1),
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-auto-x.json.gz",
            size: 1024,
            mode: "auto",
            durationMs: 1000,
            encrypted: false,
        }),
    });
    const text = document.body.textContent || "";
    assert.ok(text.includes("未加密"), "明文 gzip 必须明说 —— 这是这次要暴露的事实");
});

test("加密状态不知道时不瞎猜（老记录没有 encrypted 字段）", () => {
    mountBackupTab({
        lastAutoBackupAt: daysAgo(1),
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-auto-x.json.gz",
            size: 1024,
            mode: "auto",
            durationMs: 1000,
        }),
    });
    const text = document.body.textContent || "";
    assert.ok(!text.includes("已加密"), "老记录没这个字段，不能凭空说它加密了");
    // 「未加密」这三个字可能出现在常驻说明里（「留空 = 备份文件不加密」不含这三个字），
    // 所以这里只检查「，未加密」这个后缀形态
    assert.ok(!text.includes("，未加密"), "老记录也不能瞎猜成未加密");
});

test("备份口令框下面常驻说明「留空 = 不加密，里面有账号密码和 AI 密钥」", () => {
    mountBackupTab({});
    const text = document.body.textContent || "";
    assert.ok(text.includes("留空 = 备份文件不加密"), `要有这句常驻说明，实际：${text.slice(0, 400)}`);
    assert.ok(text.includes("AI 密钥"), "一定要点明 AI 密钥 —— 它不受「含账号密码」开关控制");
    assert.ok(text.includes("站点账号密码"), "含账号密码开着时要说明文件里有站点密码");
    // 关掉「含账号密码」后措辞也要跟着变，不能继续声称文件里有站点密码
    cleanup();
    mountBackupTab({ includeCredentials: false });
    const text2 = document.body.textContent || "";
    assert.ok(!text2.includes("站点账号密码"), `关掉后不该再说有站点密码，实际：${text2.slice(0, 400)}`);
    assert.ok(text2.includes("AI 密钥"), "AI 密钥仍然在文件里（那条通道不受开关控制）");
});

test("最后一次是自动备份时，不编造「最近一次手动备份」这一行", () => {
    mountBackupTab({
        lastBackupAt: daysAgo(2),
        lastAutoBackupAt: daysAgo(2),
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-auto-x.json.gz",
            size: 1024,
            mode: "auto",
            durationMs: 1000,
        }),
    });
    assert.ok(
        !(document.body.textContent || "").includes("最近一次手动备份"),
        "lastBackupAt 只记最后一次，那一次是自动备份 —— 手动那次的时间我们并不知道"
    );
});

test("老库升级：没有 lastAutoBackupAt 但最后那次是自动备份，用 lastBackupAt 兜底显示", () => {
    mountBackupTab({
        lastBackupAt: daysAgo(2),
        lastBackupInfo: JSON.stringify({
            filename: "navihive-backup-auto-x.json.gz",
            size: 1024,
            mode: "auto",
            durationMs: 1000,
        }),
    });
    const text = document.body.textContent || "";
    assert.ok(
        text.includes("最近一次自动备份") && text.includes("（2 天前）"),
        `升级后不该显示「还没有自动备份记录」，实际：${text.slice(0, 400)}`
    );
});
