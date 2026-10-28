// tests/NotesBackupTab.dom.test.tsx
// 设置→备份页（NotesBackupTab，909 行，此前零用例）。
//
// 为什么补它：这一页是「备份只出不进」的补丁面 —— 立即备份 / 测连接 / 列网盘 /
// 恢复 / 删记录都从这里发起，每一条都直接对着用户的真实数据。而且它一直在
// 覆盖率报表上显示 100%（旧口径只数「文件被 import 过」），实际一行都没跑过。
//
// 挑的分支都是**坏了会让人丢数据或丢信任**的那些，不是逐行点名：
//   - 未配置 / 已配置 / 没有记录 三种状态的说法（用户靠这几句话判断能不能备份）
//   - 危险按钮的禁用条件（没配网盘就不该能点「立即备份」）
//   - 删除备份记录的二次确认，以及「文件删不掉就别删记录」这条铁律
//   - 加密备份的补口令回路（口令没输对不能硬恢复）
//   - 恢复链路在部署不支持时的降级文案
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NotesBackupTab from "../src/components/notes/NotesBackupTab";
import type { NotesDataTab as NotesDataTabData } from "../src/components/NotesSettingsDialog";
import type { NotesBackupRun, NotesBackupState } from "../src/API/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(cleanup);

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

// ---------------- 数据工厂 ----------------

function run(over: Partial<NotesBackupRun> = {}): NotesBackupRun {
    return {
        id: "r1",
        startedAt: "2026-10-01T10:00:00.000Z",
        trigger: "manual",
        status: "success",
        ...over,
    };
}

function state(over: Partial<NotesBackupState> = {}): NotesBackupState {
    return {
        webdavUrl: "https://dav.example.com/dav",
        webdavUsername: "me",
        path: "navihive-notes-backup",
        backupPassword: "",
        schedule: "off",
        retention: 7,
        runs: [],
        ...over,
    };
}

function makeData(over: Partial<NotesDataTabData> = {}): NotesDataTabData {
    return {
        stats: { notes: 0, folders: 0, tags: 0, words: 0, trashed: null },
        onExportAll: () => {},
        onEmptyTrash: async () => {},
        onNotesBackupGetState: async () => state(),
        ...over,
    };
}

/** 收集 onNotify 的调用：这一页所有结果都靠它反馈，说错了用户就不知道成没成 */
function notifier() {
    const calls: { message: string; kind: string }[] = [];
    return {
        calls,
        fn: (message: string, kind?: "success" | "error") =>
            void calls.push({ message, kind: kind ?? "success" }),
        last: () => calls[calls.length - 1],
    };
}

// ---------------- 渲染与查询工具 ----------------

async function mount(data: NotesDataTabData, notify = notifier()) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<NotesBackupTab data={data} onNotify={notify.fn} />);
    });
    return notify;
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
    return document.querySelector(sel) as T | null;
}

function qa<T extends Element = HTMLElement>(sel: string): T[] {
    return [...document.querySelectorAll(sel)] as T[];
}

function text(): string {
    return document.body.textContent ?? "";
}

/** 按可见文字找按钮（MUI 的 Button 渲染成 <button>） */
function button(label: string): HTMLButtonElement | null {
    return (
        qa<HTMLButtonElement>("button").find(
            el => (el.textContent ?? "").replace(/\s+/g, " ").trim() === label
        ) ?? null
    );
}

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/** 点了会发请求 / 改 async state 的按钮：必须在 async act 里点，否则断言跑在 setState 之前 */
async function clickAsync(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

function action(name: string): HTMLButtonElement {
    const el = q<HTMLButtonElement>(`[data-backup-action='${name}']`);
    assert.ok(el, `找不到按钮 ${name}`);
    return el;
}

/** 受控输入赋值：必须走原生 value setter 再派发 input，否则 React 的 value tracker 会吞掉 */
function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

/** React 的 onBlur 走的是冒泡的 focusout */
async function blur(input: HTMLInputElement) {
    await act(async () => {
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
}

function inputByAriaLabel(label: string): HTMLInputElement {
    const el = q<HTMLInputElement>(`input[aria-label='${label}']`);
    assert.ok(el, `找不到输入框 ${label}`);
    return el;
}

function disabled(name: string): boolean {
    return action(name).disabled;
}

// ---------------- 状态分支：未配置 / 已配置 / 没有记录 ----------------

test("尚未配置网盘：概览如实说「尚未配置」，三个动作全部禁用", async () => {
    await mount(
        makeData({
            onNotesBackupGetState: async () =>
                state({ webdavUrl: "", webdavUsername: "", path: "" }),
        })
    );

    assert.match(text(), /尚未配置网盘/);
    assert.match(text(), /未配置（先在导航页保存网盘地址）/);
    assert.equal(disabled("run-now"), true, "没配网盘还能点「立即备份」就是骗人");
    assert.equal(disabled("test"), true, "没配网盘测连接没有意义");
});

test("已配置网盘：显示地址与账号，按钮可点", async () => {
    await mount(makeData());

    assert.match(text(), /WebDAV 备份目标已配置/);
    assert.match(text(), /https:\/\/dav\.example\.com\/dav/);
    assert.match(text(), /· me/, "账号要跟着地址一起显示，方便确认用的是哪个");
    assert.equal(disabled("run-now"), false);
    assert.equal(disabled("test"), false);
    assert.equal(inputByAriaLabel("备份目录").value, "navihive-notes-backup");
});

test("读取配置失败：报错文案出现，页面不假装「已配置」", async () => {
    await mount(
        makeData({
            onNotesBackupGetState: async () => {
                throw new Error("网络断了");
            },
        })
    );

    const err = q("[data-backup-state='error']");
    assert.ok(err, "配置读不出来必须明确报错");
    assert.match(err!.textContent ?? "", /网络断了/);
    assert.match(text(), /尚未配置网盘/, "读失败不能渲染成已配置");
    assert.equal(disabled("run-now"), true);
});

test("有配置但从未备份过：显示「还没有备份记录」而不是空白", async () => {
    await mount(makeData());
    assert.ok(q("[data-backup-runs-empty='1']"), "空状态要有个明确的说明");
    assert.match(text(), /还没有备份记录/);
});

// ---------------- 最近备份列表 ----------------

test("成功的记录：条数 / 附件 / 跳过 / 已自检 / 体积都要显示", async () => {
    await mount(
        makeData({
            onNotesBackupGetState: async () =>
                state({
                    runs: [
                        run({
                            id: "ok1",
                            noteCount: 12,
                            attachmentCount: 3,
                            skippedAttachments: 2,
                            verified: true,
                            bytes: 2048,
                        }),
                    ],
                }),
        })
    );

    const row = q("[data-backup-run='ok1']");
    assert.ok(row);
    const rowText = row!.textContent ?? "";
    assert.match(rowText, /12 条/);
    assert.match(rowText, /3 附件/);
    assert.match(rowText, /跳过 2/);
    assert.match(rowText, /已自检/);
    assert.match(rowText, /2 KB/);
    assert.match(rowText, /手动/, "触发方式要能区分手动与定时");
});

test("失败的记录：状态写「失败」，展开才给失败原因", async () => {
    await mount(
        makeData({
            onNotesBackupGetState: async () =>
                state({
                    runs: [run({ id: "bad1", status: "failure", trigger: "auto", error: "网盘 401" })],
                }),
        })
    );

    const row = q("[data-backup-run='bad1']")!;
    assert.match(row.textContent ?? "", /失败/);
    assert.match(row.textContent ?? "", /定时/);
    assert.equal(row.textContent?.includes("网盘 401"), false, "失败原因默认折叠，不塞满列表");

    const toggle = row.querySelector("button[aria-expanded]") as HTMLButtonElement;
    click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.match(q("[data-backup-run='bad1']")!.textContent ?? "", /网盘 401/);
});

test("成功的记录展开后显示文件名与用时（用户靠这个认出是哪一份）", async () => {
    await mount(
        makeData({
            onNotesBackupGetState: async () =>
                state({
                    runs: [
                        run({ id: "ok2", filename: "notes-2026-10-01.json.gz", durationMs: 4200 }),
                    ],
                }),
        })
    );

    const toggle = q("[data-backup-run='ok2'] button[aria-expanded]") as HTMLButtonElement;
    click(toggle);
    const detail = q("[data-backup-run='ok2']")!.textContent ?? "";
    assert.match(detail, /notes-2026-10-01\.json\.gz/);
    assert.match(detail, /用时 4\.2 秒/);
});

// ---------------- 危险操作：删除备份记录 ----------------

test("删除记录：二次确认说清「文件一起删、无法恢复」，确认后记录才消失", async () => {
    const saved: unknown[] = [];
    const deleted: string[] = [];
    const notify = await mount(
        makeData({
            onNotesBackupGetState: async () =>
                state({ runs: [run({ id: "d1", filename: "old.json.gz" }), run({ id: "d2" })] }),
            onNotesBackupDeleteRemote: async filename => {
                deleted.push(filename);
                return { success: true, message: "" };
            },
            onNotesBackupSave: async patch => void saved.push(patch),
        })
    );

    click(q("[aria-label^='删除这条备份记录']")!);

    assert.ok(button("删除"), "必须先弹确认，不能点一下就删");
    assert.match(text(), /删除这条备份？/);
    assert.match(text(), /old\.json\.gz/, "要说清删的是哪份");
    assert.match(text(), /无法恢复/);
    assert.deepEqual(saved, [], "确认前一笔都不能落库");

    await clickAsync(button("删除")!);

    assert.deepEqual(deleted, ["old.json.gz"], "有网盘文件的要先把文件删掉");
    assert.equal(saved.length, 1, "删除后要把剩下的记录整份写回");
    const patch = saved[0] as { runs: NotesBackupRun[] };
    assert.deepEqual(
        patch.runs.map(r => r.id),
        ["d2"],
        "只删这一条，别人的记录不能被顺手清掉"
    );
    assert.deepEqual(notify.last(), { message: "已删除这条备份", kind: "success" });
});

test("删除失败记录（没有网盘文件）：说明只是移出列表，不去调删除接口", async () => {
    let remoteCalls = 0;
    await mount(
        makeData({
            onNotesBackupGetState: async () => state({ runs: [run({ id: "f1", status: "failure" })] }),
            onNotesBackupDeleteRemote: async () => {
                remoteCalls++;
                return { success: true, message: "" };
            },
            onNotesBackupSave: async () => {},
        })
    );

    click(q("[aria-label^='删除这条备份记录']")!);
    assert.match(text(), /失败的记录/);
    await clickAsync(button("删除")!);
    assert.equal(remoteCalls, 0, "没有文件名就不该去删网盘上的东西");
});

test("网盘文件删不掉就整单不删：报错、弹窗留在原地、记录不动", async () => {
    const saved: unknown[] = [];
    const notify = await mount(
        makeData({
            onNotesBackupGetState: async () =>
                state({ runs: [run({ id: "x1", filename: "keep.json.gz" })] }),
            onNotesBackupDeleteRemote: async () => ({
                success: false,
                message: "网盘 503",
            }),
            onNotesBackupSave: async patch => void saved.push(patch),
        })
    );

    click(q("[aria-label^='删除这条备份记录']")!);
    await clickAsync(button("删除")!);

    assert.match(text(), /删除这条备份？/, "失败时弹窗不能关，用户要知道没成");
    assert.deepEqual(saved, [], "文件没删掉就不能把记录删掉 —— 否则网盘上多一份孤儿备份");
    assert.ok(
        notify.calls.some(c => c.kind === "error" && /网盘 503/.test(c.message)),
        "失败原因要如实告诉用户"
    );
});

// ---------------- 立即备份 / 测试连接 ----------------

test("立即备份：进行中按钮禁用（防重复点），成功后提示并重拉状态", async () => {
    let release!: (r: { success: boolean; message: string }) => void;
    let getStateCalls = 0;
    const notify = await mount(
        makeData({
            onNotesBackupGetState: async () => {
                getStateCalls++;
                return state();
            },
            onNotesBackupRun: () => new Promise<{ success: boolean; message: string }>(r => (release = r)),
        })
    );
    assert.equal(getStateCalls, 1, "挂载就拉一次");

    await act(async () => {
        action("run-now").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(disabled("run-now"), true, "跑到一半还能点第二下就会并发写网盘");

    await act(async () => {
        release({ success: true, message: "备份完成：8 条笔记" });
    });

    assert.deepEqual(notify.last(), { message: "备份完成：8 条笔记", kind: "success" });
    assert.equal(disabled("run-now"), false, "跑完要恢复可点");
    assert.equal(getStateCalls, 2, "备份完要重拉状态，否则列表还是旧的");
});

test("立即备份失败：如实报错，不假装成功", async () => {
    const notify = await mount(
        makeData({
            onNotesBackupRun: async () => ({ success: false, message: "网盘拒绝写入" }),
        })
    );

    await clickAsync(action("run-now"));
    assert.deepEqual(notify.last(), { message: "网盘拒绝写入", kind: "error" });
});

test("测试连接：成功与失败用不同的语义角色（读屏能区分）", async () => {
    await mount(
        makeData({
            onNotesBackupTest: async () => ({ success: true, message: "连接正常" }),
        })
    );
    await clickAsync(action("test"));
    const ok = q("[data-backup-test-result='ok']");
    assert.ok(ok);
    assert.equal(ok!.getAttribute("role"), "status");
    assert.match(ok!.textContent ?? "", /连接正常/);
});

test("测试连接抛错：落到失败态而不是让页面空着", async () => {
    await mount(
        makeData({
            onNotesBackupTest: async () => {
                throw new Error("证书过期");
            },
        })
    );
    await clickAsync(action("test"));
    const fail = q("[data-backup-test-result='fail']");
    assert.ok(fail, "异常也要有可见结果");
    assert.equal(fail!.getAttribute("role"), "alert");
    assert.match(fail!.textContent ?? "", /证书过期/);
});

test("口令提示：设了口令说加密上传，没设说明文与继承关系", async () => {
    await mount(makeData());
    assert.match(text(), /留空则明文上传/, "没口令时必须让用户知道备份是明文的");

    cleanup();
    await mount(
        makeData({ onNotesBackupGetState: async () => state({ backupPassword: "secret" }) })
    );
    assert.match(text(), /设口令的备份加密上传/);
});

// ---------------- 设置项写回（失焦才写，不逐键打接口）----------------

test("备份目录：改了失焦才保存，成功提示「已保存」", async () => {
    const saved: unknown[] = [];
    const notify = await mount(
        makeData({ onNotesBackupSave: async patch => void saved.push(patch) })
    );

    const input = inputByAriaLabel("备份目录");
    setInputValue(input, "  my-notes-backup  ");
    assert.deepEqual(saved, [], "还没失焦就不能写接口");

    await blur(input);
    assert.deepEqual(saved, [{ path: "my-notes-backup" }], "两端空白要 trim 掉");
    assert.deepEqual(notify.last(), { message: "备份设置已保存", kind: "success" });
});

test("备份目录：清空后失焦不保存，回填原值（空目录名会写到错误的路径）", async () => {
    const saved: unknown[] = [];
    await mount(makeData({ onNotesBackupSave: async patch => void saved.push(patch) }));

    const input = inputByAriaLabel("备份目录");
    setInputValue(input, "   ");
    await blur(input);

    assert.deepEqual(saved, [], "空路径不许提交");
    assert.equal(inputByAriaLabel("备份目录").value, "navihive-notes-backup");
});

// ---------------- 从网盘恢复 ----------------

test("部署没有列目录/取回端点时，整个「从网盘恢复」区块不出现", async () => {
    await mount(makeData());
    assert.equal(q("[data-backup-restore='1']"), null, "没有能力就不该画一个点不动的按钮");
});

test("列出备份：空目录给明确说明，有文件则列名字与体积", async () => {
    await mount(
        makeData({
            onNotesBackupListRemote: async () => ({ success: true, files: [], message: "" }),
        })
    );
    await clickAsync(action("list-remote"));
    assert.ok(q("[data-backup-remote-empty='1']"));
    assert.match(text(), /网盘上还没有备份文件/);

    cleanup();
    await mount(
        makeData({
            onNotesBackupListRemote: async () => ({
                success: true,
                message: "",
                files: [{ name: "notes-1.json.gz", size: 4096, lastModified: "2026-10-01T00:00:00Z" }],
            }),
        })
    );
    await clickAsync(action("list-remote"));
    const file = q("[data-backup-remote-file='notes-1.json.gz']");
    assert.ok(file);
    assert.match(file!.textContent ?? "", /4 KB/);
});

test("列出备份失败：错误文案可见，且不残留上次的文件列表", async () => {
    await mount(
        makeData({
            onNotesBackupListRemote: async () => ({
                success: false,
                files: [],
                message: "网盘认证失败",
            }),
        })
    );
    await clickAsync(action("list-remote"));
    const err = q("[data-backup-remote-error='1']");
    assert.ok(err);
    assert.equal(err!.getAttribute("role"), "alert");
    assert.match(err!.textContent ?? "", /网盘认证失败/);
});

test("加密备份：先补口令，口令带上去重试，成功后提示「已恢复」", async () => {
    const attempts: { filename: string; password: string }[] = [];
    const notify = await mount(
        makeData({
            onNotesBackupListRemote: async () => ({
                success: true,
                message: "",
                files: [{ name: "secret.json.gz", size: 10, lastModified: "2026-10-01T00:00:00Z" }],
            }),
            onNotesBackupFetch: async (filename, password) => {
                attempts.push({ filename, password });
                if (!password) {
                    return {
                        success: false,
                        message: "这份备份加密了，请输入备份密码",
                        code: "encrypted",
                    };
                }
                return { success: true, message: "", payload: { notes: [] } };
            },
            onImportNotes: async () => ({ created: 0, updated: 0, skipped: 0, removed: 0 }),
        })
    );

    await clickAsync(action("list-remote"));
    await clickAsync(action("restore"));

    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].password, "", "没设过口令就先空着试一次");
    assert.ok(q("[data-backup-restore-pwd='1']"), "加密的要就地展开口令框");
    assert.match(text(), /请输入备份密码/);

    setInputValue(inputByAriaLabel("恢复备份密码"), "hunter2");
    await clickAsync(action("restore-confirm"));

    assert.deepEqual(
        attempts[1],
        { filename: "secret.json.gz", password: "hunter2" },
        "重试必须带上用户刚输入的密码"
    );
    assert.equal(q("[data-backup-restore-pwd='1']"), null, "成功后口令框要收起");
    assert.ok(
        notify.calls.some(c => c.kind === "success" && /已从网盘恢复/.test(c.message)),
        "成功了要明确告诉用户"
    );
});

test("含附件的 ZIP 备份在不能回传附件的部署上要明确拒绝，不能半途停下", async () => {
    await mount(
        makeData({
            onNotesBackupListRemote: async () => ({
                success: true,
                message: "",
                files: [{ name: "with-attachments.zip", size: 10, lastModified: "2026-10-01T00:00:00Z" }],
            }),
            // 服务端回了 zipBase64，但这个部署没有 onImportFile（不能回传附件）
            onNotesBackupFetch: async () => ({
                success: true,
                message: "",
                zipBase64: "UEsDBAo=",
            }),
            onImportNotes: async () => ({ created: 0, updated: 0, skipped: 0, removed: 0 }),
        })
    );

    await clickAsync(action("list-remote"));
    await clickAsync(action("restore"));

    assert.match(
        text(),
        /当前部署不支持附件回传/,
        "拿不回来的备份必须当场说清，否则用户以为恢复了"
    );
});
