// src/components/BookmarkImportDialog.tsx 的直测（380 行，此前零覆盖）。
//
// 为什么是它：覆盖率体检（docs/coverage-checkup-2026-10-13.md）里，分享 UI 三件套
// 补完之后它就是清单上「坏了最难发现」的第一名 —— 备份恢复是「最后一次机会」功能，
// 界面层零覆盖意味着「恢复了但用户看不懂」没人管。具体到这个弹窗：它做的是
// **导入前的体检**（新增 / 重复 / 无效三类），判错的后果不是报错，而是
// 把库里已有的卡片再复制一份、或者把 javascript: 书签脚本导成点不动的卡。
//
// 夹具用真的 Netscape 书签 HTML：collectRaw 里走 DOMParser，嵌套与并列两种
// 文件夹写法都要覆盖（见 utils/bookmarks.ts 的 folderOf 注释 —— 只认并列写法时
// Chrome/Edge/Firefox 的导出会整份落进兜底分组，之前就是这样）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BookmarkImportDialog from "../src/components/BookmarkImportDialog";
import type { GroupWithSites } from "../src/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** 嵌套写法：浏览器（Chrome/Edge/Firefox）导出用的就是这种 */
function nestedHtml(): string {
    return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>工具栏</H3>
  <DL><p>
    <DT><A HREF="https://a.example/">站点 A</A>
    <DT><A HREF="https://b.example/">站点 B</A>
    <DT><A HREF="javascript:void(0)">脚本书签</A>
  </DL><p>
  <DT><H3>稍后读</H3>
  <DL><p>
    <DT><A HREF="https://c.example/">站点 C</A>
    <DT><A HREF="https://existing.example/">库里已有的</A>
  </DL><p>
</DL><p>`;
}

/** 并列写法：手写或老一点的导出 */
function siblingHtml(): string {
    return `<DL><p>
  <DT><H3>并列分组</H3></DT>
  <DL><p>
    <DT><A HREF="https://s.example/">并列站点</A>
  </DL><p>
</DL><p>`;
}

const EXISTING: GroupWithSites[] = [
    {
        id: 1,
        name: "已有分组",
        order_num: 0,
        sites: [{ id: 11, group_id: 1, name: "老站", url: "https://existing.example/" }],
    } as unknown as GroupWithSites,
];

async function mount(opts: {
    html?: string;
    groups?: GroupWithSites[];
    onImport?: (groups: unknown[]) => Promise<number>;
    onClose?: () => void;
} = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <BookmarkImportDialog
                open
                onClose={opts.onClose ?? (() => {})}
                onImport={(opts.onImport ?? (async () => 3)) as never}
                groups={opts.groups ?? []}
            />
        );
    });
    // ⚠️ 必须 await：selectFile 内部也有一次 act，与调用方随后的 act 交叠会让
    // 第二次挂载整个渲染不出来（实测：第二次 mount 后 document.body 只剩一个空 div）。
    if (opts.html !== undefined) await selectFile(opts.html, "bookmarks.html");
}

/** 往隐藏的 file input 里塞一个「文件」：只用到 name 与 text()，所以不必真是 jsdom File */
async function selectFile(html: string, name = "bookmarks.html") {
    const input = document.querySelector<HTMLInputElement>("input[type='file']");
    assert.ok(input, "要有隐藏的文件选择 input");
    Object.defineProperty(input, "files", {
        value: [{ name, text: async () => html }],
        configurable: true,
    });
    await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

afterEach(cleanup);

const pageText = () => document.body.textContent ?? "";
const byAttr = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const buttonByText = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

async function clickAsync(el: Element | null | undefined) {
    assert.ok(el, "要点的元素不在");
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

/** 等条件成立，而不是睡固定时长：file.text() 是真的 promise 链 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > deadline) assert.fail(`等了 ${timeoutMs}ms 也没等到：${label}`);
        await act(async () => {
            await new Promise(r => setTimeout(r, 10));
        });
    }
}

/**
 * 切一下复选框/开关。
 *
 * ⚠️ 必须用 **click**：React 的 ChangeEventPlugin 对 checkbox/radio 走的是
 * shouldUseClickEvent（监听 click），派发 change 事件它理都不理。
 * 用原生 .click() 而不是手搓 MouseEvent —— 前者会跑激活行为把 checked 真翻过来。
 */
async function toggle(el: HTMLInputElement) {
    assert.ok(el, "要切的复选框不在");
    await act(async () => {
        el.click();
        await Promise.resolve();
    });
}

/** 导入按钮（标签是「导入 N 个」，N 随勾选变，所以按前缀找） */
function importBtn(): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>("button")].find(b =>
        (b.textContent ?? "").trim().startsWith("导入")
    );
}

// ---------- 解析与体检统计 ----------

test("选文件后解析出计划：三类统计各自成 chip，文件夹成为分组行", async () => {
    await mount({ html: nestedHtml(), groups: EXISTING });
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));

    // 5 条 = A / B / 脚本书签 / C / 库里已有
    assert.ok(pageText().includes("新增 3"), "A、B、C 是新增");
    assert.ok(pageText().includes("重复 1"), "库里已有那条算重复");
    assert.ok(pageText().includes("无效 1"), "javascript: 不是网页链接");
    // 两个顶层文件夹各一行
    const rows = [...document.querySelectorAll(".MuiListItem-root")].filter(el =>
        (el.textContent ?? "").includes("个")
    );
    assert.ok(rows.length >= 2, "工具栏与稍后读各一行");
    assert.ok(pageText().includes("工具栏"), "要显示文件夹名");
    assert.ok(pageText().includes("稍后读"), "要显示第二个文件夹名");
});

test("文件夹行上说清「将导入几个、跳过几个」（跳过的原因用户在行上就看得见）", async () => {
    await mount({ html: nestedHtml(), groups: EXISTING });
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));
    // 工具栏：A、B 新增，脚本书签无效 → 2 个将导入 · 跳过 1 个
    assert.ok(pageText().includes("2 个将导入 · 跳过 1 个"), "工具栏行要写清跳过数");
    // 稍后读：C 新增，库里已有重复 → 同样跳 1 个
    assert.ok(pageText().includes("1 个将导入 · 跳过 1 个"), "稍后读行要写清跳过数");
});

test("全部可导入时只说「N 个链接」，不出现「跳过」字样", async () => {
    await mount({ html: `<DL><p><DT><H3>干净</H3><DL><p><DT><A HREF="https://x.example/">X</A></DL><p></DL><p>` });
    await waitFor("统计出现", () => pageText().includes("共 1 条链接"));
    assert.ok(pageText().includes("1 个链接"), "没有跳过时不该提跳过");
    assert.ok(!pageText().includes("跳过"), "没有跳过时不该提跳过");
});

test("并列写法的文件夹也要认（只认嵌套会让老导出整份落进兜底分组）", async () => {
    await mount({ html: siblingHtml() });
    await waitFor("统计出现", () => pageText().includes("共 1 条链接"));
    assert.ok(pageText().includes("并列分组"), "并列写法的 H3 要被当成文件夹名");
    assert.ok(!pageText().includes("导入的书签"), "不该落进兜底分组");
});

test("没有顶层文件夹时落进兜底分组「导入的书签」", async () => {
    await mount({ html: `<DL><p><DT><A HREF="https://loose.example/">散链接</A></DL><p>` });
    await waitFor("统计出现", () => pageText().includes("共 1 条链接"));
    assert.ok(pageText().includes("导入的书签"), "散链接要有个容身之处");
});

// ---------- 重复预览 ----------

test("重复链接可展开预览，并说清「已存在于哪个分组」", async () => {
    await mount({ html: nestedHtml(), groups: EXISTING });
    await waitFor("重复按钮出现", () => !!byAttr("button[aria-label='查看重复链接']"));
    assert.ok(pageText().includes("这 1 条库里已经有了"), "要说清有几条重复");

    // 默认收起：看不到具体条目
    assert.ok(!pageText().includes("已存在于「已有分组」"), "默认不该展开明细");
    await clickAsync(byAttr("button[aria-label='查看重复链接']"));
    await waitFor("明细展开", () => pageText().includes("已存在于「已有分组」"));
    assert.ok(pageText().includes("库里已有的"), "要显示那条重复链接的标题");

    // 再点一次收起
    await clickAsync(byAttr("button[aria-label='查看重复链接']"));
    await waitFor("明细收起", () => !pageText().includes("已存在于「已有分组」"));
});

// ---------- 「连重复一起导入」开关 ----------

test("打开「连重复一起导入」后重新算计划：重复数并进将导入数", async () => {
    await mount({ html: nestedHtml(), groups: EXISTING });
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));

    // 默认只算新增：工具栏 2（A、B）、稍后读 1（C）
    assert.equal(importBtn()!.textContent!.trim(), "导入 3 个", "默认只算新增");
    assert.ok(pageText().includes("稍后读1 个将导入 · 跳过 1 个"), "稍后读默认跳掉重复那条");

    await toggle(byAttr<HTMLInputElement>("input[aria-label='连重复一起导入']")!);
    await waitFor("重算完成", () => importBtn()!.textContent!.trim() === "导入 4 个");

    // 稍后读现在没什么可跳了（C 新增 + 原本重复的那条也导）：
    // 必须显示「2 个链接」而不是「2 个将导入 · 跳过 1 个」—— 后者自相矛盾，
    // 因为 items.length 已经把重复那条算进将导入里了。
    assert.ok(pageText().includes("稍后读2 个链接"), "打开开关后稍后读不再跳过");
    // 工具栏仍是 2 个将导入 · 跳过 1 个：脚本书签是**无效**，与这个开关无关
    assert.ok(pageText().includes("工具栏2 个将导入 · 跳过 1 个"), "无效链接不受开关影响");
});

test("取消某个文件夹：导入按钮计数跟着少，onImport 只收到选中的", async () => {
    const sent: unknown[] = [];
    await mount({
        html: nestedHtml(),
        groups: EXISTING,
        onImport: async (gs: unknown[]) => {
            sent.push(gs);
            return 3;
        },
    });
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));
    assert.equal(importBtn()!.disabled, false, "有可导入的就该能点");

    const laterRow = [...document.querySelectorAll(".MuiListItem-root")].find(r =>
        (r.textContent ?? "").includes("稍后读")
    );
    assert.ok(laterRow, "要有稍后读那一行");
    await toggle(laterRow!.querySelector<HTMLInputElement>("input[type='checkbox']")!);

    await waitFor("计数变成 2", () => importBtn()!.textContent!.trim() === "导入 2 个");
    await clickAsync(importBtn());
    await waitFor("onImport 被调用", () => sent.length > 0);

    const picked = sent[0] as Array<{ folder: string; items: unknown[] }>;
    assert.equal(picked.length, 1, "只该收到选中的那一个文件夹");
    assert.equal(picked[0].folder, "工具栏");
    assert.equal(picked[0].items.length, 2, "只含新增条目（A、B），不含无效与重复");
});

test("无可导入的新链接：给出说明，导入按钮禁用", async () => {
    // 全是无效链接 → groups 为空
    await mount({ html: `<DL><p><DT><H3>全是脚本</H3><DL><p><DT><A HREF="javascript:x">脚本</A></DL><p></DL><p>` });
    await waitFor("说明出现", () => pageText().includes("这份文件里没有可导入的新链接"));
    const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b =>
        (b.textContent ?? "").startsWith("导入")
    );
    assert.ok(btn, "要有导入按钮");
    assert.equal(btn!.disabled, true, "一条都导入不了时必须禁用");
});

test("导入过程中：显示进度条且按钮禁用（防重复点）", async () => {
    // 放对象里而不是裸 let：TS 会把「只在回调里赋值」的变量收窄成 null，
    // 后面 release!() 就报 Type 'never' has no call signatures
    const gate: { release: (() => void) | null } = { release: null };
    await mount({
        html: nestedHtml(),
        onImport: () => new Promise<number>(resolve => {
            gate.release = () => resolve(2);
        }),
    });
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));
    const btn = importBtn()!;
    await clickAsync(btn);

    await waitFor("进入 busy", () => !!document.querySelector(".MuiLinearProgress-root"));
    assert.equal(importBtn()!.disabled, true, "导入中必须禁用，防止重复建一份");
    assert.ok(gate.release, "onImport 该被调用");
    gate.release!();
    await waitFor("busy 结束", () => !document.querySelector(".MuiLinearProgress-root"));
});

test("导入成功后关弹窗，且内部状态被清干净（再打开不是上一份的残留）", async () => {
    let closed = 0;
    await mount({
        html: nestedHtml(),
        onImport: async () => 3,
        onClose: () => { closed += 1; },
    });
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));
    await clickAsync(importBtn());
    await waitFor("弹窗关闭", () => closed === 1);
    // 关之后 rawHtml 已清空：重新挂载同一个组件实例时不该还带着上一份
    assert.ok(!pageText().includes("共 5 条链接"), "导入后要清掉计划");
});

test("取消也走同一条 reset：关掉再打开是干净状态", async () => {
    let closed = 0;
    await mount({ html: nestedHtml(), onClose: () => { closed += 1; } });
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));
    await clickAsync(buttonByText("取消"));
    await waitFor("弹窗关闭", () => closed === 1);
    assert.ok(!pageText().includes("共 5 条链接"), "取消要清掉计划");
});

test("标题栏关闭按钮同样 reset 并通知外层", async () => {
    let closed = 0;
    await mount({ html: nestedHtml(), onClose: () => { closed += 1; } });
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));
    await clickAsync(byAttr("button[aria-label='关闭导入书签']"));
    assert.equal(closed, 1, "点关闭要通知外层");
    assert.ok(!pageText().includes("共 5 条链接"), "关闭要清掉计划");
});

// ---------- 文件名与说明 ----------

test("选完文件显示文件名（用户得知道导的是哪一份）", async () => {
    await mount();
    await selectFile(nestedHtml(), "我的书签.html");
    await waitFor("统计出现", () => pageText().includes("共 5 条链接"));
    assert.ok(pageText().includes("我的书签.html"), "要显示文件名");
});
