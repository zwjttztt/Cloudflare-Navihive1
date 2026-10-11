// tests/SiteSettingsModal.dom.test.tsx
// 第二个组件级用例：网站设置弹窗（改站点信息的主入口，737 行）。
//
// 为什么是它：所有「改一张卡片」的操作都走这里。它身上有几个错了就会被用户立刻察觉、
// 但黑盒冒烟很难钉死的约定：
//   - 没改动就点保存，应该静默关闭（不该弹「已更新」，更不该写库）
//   - 点「删除」不能直接删，必须先弹站内确认框
//   - 站点没图标时，打开就按「图标 API 模板 + 链接」自动补一个
// 这几条散在 265 条冒烟里覆盖不全，在这里几行就能锁死。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SiteSettingsModal from "../src/components/SiteSettingsModal";
import { AppConfigProvider } from "../src/context/AppConfigContext";
import type { AppConfigContextValue } from "../src/context/appConfigStore";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Site } from "../src/API/http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const CONFIG: AppConfigContextValue = {
    iconApi: "https://ico.example/{domain}",
    thumbApi: "",
    backgroundImage: "",
    backgroundMaskOpacity: "0.15",
};

function makeSite(overrides: Partial<Site> = {}): Site {
    return {
        id: 7,
        group_id: 3,
        name: "示例站点",
        url: "https://www.example.com",
        icon: "",
        description: "",
        notes: "",
        order_num: 0,
        ...overrides,
    };
}

/** 组件依赖 AppConfig（图标 API）与 UIPrefs（星标/标签），用真实 Provider 包一层 */
function mount(ui: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <AppConfigProvider value={CONFIG}>
                <UIPrefsProvider>{ui}</UIPrefsProvider>
            </AppConfigProvider>
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

afterEach(cleanup);

/**
 * 等 MUI 的 Dialog 关闭过渡走完（225ms）。
 * 关闭时 DOM 不会被立刻移除 —— 「paper 还在」不等于「没关」，
 * 必须给过渡时间，否则每条测「关掉了没」的用例都会假失败。
 */
const settle = async () => {
    // 轮询等「放大窗真的从 DOM 消失」，上限 400ms —— 固定睡 350ms 在慢机（CI）
    // 上会偶发假红（过渡没走完就断言了），改坏实现也不会红的问题倒不大，
    // 主要是别让时序噪声污染这一组用例。
    for (let i = 0; i < 40; i++) {
        if (!document.querySelector("#notes-expanded")) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

const buttonByText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

/** 弹窗会叠加（主弹窗 + 删除确认），取最后一个才是当前最上层的那个 */
const topDialogButtons = (): HTMLButtonElement[] => {
    const papers = [...document.querySelectorAll(".MuiDialog-paper")];
    const top = papers[papers.length - 1];
    return top ? [...top.querySelectorAll<HTMLButtonElement>("button")] : [];
};

/**
 * 按 MUI 的 label 文案找到对应输入框（比按 DOM 顺序稳）。
 * 必填字段 MUI 会在 label 后面追加一个「*」，比对前先抹掉。
 */
function inputByLabel(label: string): HTMLInputElement | null {
    const norm = (s: string) => (s || "").trim().replace(/\s*\*\s*$/, "").trim();
    const fc = [...document.querySelectorAll(".MuiFormControl-root")].find(
        el => norm(el.querySelector("label")?.textContent ?? "") === norm(label)
    );
    return fc ? fc.querySelector("input") : null;
}

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/**
 * 给受控输入赋值：必须走原生 value setter 再派发 input，
 * 直接改 el.value 会被 React 的 value tracker 吞掉，onChange 不触发。
 */
function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

function counter<T = unknown>() {
    const calls: T[] = [];
    return {
        calls,
        // rest 参数：onUpdate 要 (site) => void、onClose 只要 () => void，
        // 形参个数写死成 1 就没法赋给零参数的那个
        fn: (...args: unknown[]) => void calls.push(args[0] as T),
        get count() {
            return calls.length;
        },
    };
}

test("SiteSettingsModal：站点没图标时，打开就按图标 API 模板自动补一个", t => {
    t.after(cleanup);
    const update = counter<Site>();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "" })}
            onUpdate={update.fn}
            onDelete={() => {}}
            onClose={() => {}}
        />
    );

    const iconInput = inputByLabel("图标 URL");
    assert.ok(iconInput, "应能找到「图标 URL」输入框");
    assert.equal(
        iconInput!.value,
        "https://ico.example/www.example.com",
        `应把 {domain} 换成真实域名，实际 ${iconInput!.value}`
    );
});

test("SiteSettingsModal：什么都不改点「保存」→ 只关闭，不写库", t => {
    t.after(cleanup);
    const update = counter<Site>();
    const close = counter();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "https://already/set.png" })}
            onUpdate={update.fn}
            onDelete={() => {}}
            onClose={close.fn}
        />
    );

    const saveBtn = buttonByText("保存");
    assert.ok(saveBtn, "应有保存按钮");
    click(saveBtn!);

    assert.equal(close.count, 1, "应关闭弹窗");
    assert.equal(update.count, 0, "没改动就不该触发 onUpdate（否则会误弹「已更新」）");
});

test("SiteSettingsModal：改了名称再保存 → onUpdate 收到新值且 group_id 是数字", t => {
    t.after(cleanup);
    const update = counter<Site>();
    const close = counter();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "https://already/set.png" })}
            onUpdate={update.fn}
            onDelete={() => {}}
            onClose={close.fn}
        />
    );

    const nameInput = inputByLabel("网站名称");
    assert.ok(nameInput, "应能找到「网站名称」输入框");
    setInputValue(nameInput!, "改过的名字");

    const saveBtn = buttonByText("保存");
    click(saveBtn!);

    assert.equal(update.count, 1, "改动后保存应触发 onUpdate");
    const payload = update.calls[0] as Site;
    assert.equal(payload.name, "改过的名字", "新名称应带出去");
    assert.equal(typeof payload.group_id, "number", "group_id 应转成数字");
    assert.equal(payload.id, 7, "站点 id 应保留");
    assert.equal(close.count, 1, "保存后应关闭");
});

test("SiteSettingsModal：点「删除」不直接删，先弹站内二次确认", t => {
    t.after(cleanup);
    const del = counter<number>();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "x" })}
            onUpdate={() => {}}
            onDelete={del.fn}
            onClose={() => {}}
        />
    );

    const deleteBtn = buttonByText("删除");
    assert.ok(deleteBtn, "应有删除按钮");
    click(deleteBtn!);

    assert.equal(del.count, 0, "第一次点删除不能直接删——必须等用户再确认一次");
    const text = document.body.textContent || "";
    assert.ok(text.includes("删除这个网站？"), "应弹出确认框");
});

test("SiteSettingsModal：确认框里点「删除」→ 才真的删，并带上站点 id", t => {
    t.after(cleanup);
    const del = counter<number>();
    const close = counter();
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "x" })}
            onUpdate={() => {}}
            onDelete={del.fn}
            onClose={close.fn}
        />
    );

    click(buttonByText("删除")!);
    // 确认框是后弹出的，取最上层那个弹窗里的「删除」
    const confirmBtn = topDialogButtons().find(b => (b.textContent || "").trim() === "删除");
    assert.ok(confirmBtn, "确认框里应有确认删除按钮");
    click(confirmBtn!);

    assert.equal(del.count, 1, "确认后应触发 onDelete");
    assert.equal(del.calls[0], 7, "onDelete 应收到站点 id");
    assert.equal(close.count, 1, "删除后应关闭弹窗");
});

test("SiteSettingsModal：密码默认掩码，点「显示密码」才变明文", t => {
    t.after(cleanup);
    mount(
        <SiteSettingsModal
            site={makeSite({ icon: "x", password: "secret123" })}
            onUpdate={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
        />
    );

    const pwdInput = inputByLabel("密码");
    assert.ok(pwdInput, "应能找到密码输入框");
    assert.equal(pwdInput!.getAttribute("type"), "password", "默认应掩码");

    const eye = document.querySelector<HTMLButtonElement>('[aria-label="显示密码"]');
    assert.ok(eye, "应有显示密码按钮");
    click(eye!);

    assert.equal(
        inputByLabel("密码")?.getAttribute("type"),
        "text",
        "点过之后应切为明文"
    );
});

// ---------------------------------------------------------------------------
// 备注的放大编辑（2026-10-05 新增）
// ---------------------------------------------------------------------------
//
// 备注是这一屏里唯一可能写很长的字段，两行框里改长文本很难受。要钉的是四件事：
//   1. 放大入口在备注框右侧，且有可访问名
//   2. 弹出的窗**与网站设置同尺寸**（fullWidth + maxWidth='sm'），别做成小一号的框
//   3. 两边共用同一份内容 —— 在大窗里改字，主窗要跟着变（做两份再同步 = 多一处能写错的地方）
//   4. **关掉大窗不能连带关掉主窗** —— 弹窗套弹窗最容易写错的就是这条

/** 最上层弹窗（放大窗开着时它是最后一个） */
const topDialog = (): HTMLElement | null => {
    const papers = [...document.querySelectorAll<HTMLElement>(".MuiDialog-paper")];
    return papers[papers.length - 1] ?? null;
};

/** 大窗里的备注输入框（textarea） */
const expandedNotes = (): HTMLTextAreaElement | null =>
    topDialog()?.querySelector<HTMLTextAreaElement>("textarea#notes-expanded") ?? null;

function openExpanded(overrides: Partial<Site> = {}) {
    mount(
        <SiteSettingsModal
            site={makeSite(overrides)}
            groups={[] as never}
            onUpdate={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
        />
    );
    click(document.querySelector<HTMLElement>('[aria-label="放大编辑备注"]')!);
}

test("备注框右侧有放大入口", () => {
    mount(
        <SiteSettingsModal
            site={makeSite()}
            groups={[] as never}
            onUpdate={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
        />
    );
    const btn = document.querySelector<HTMLElement>('[aria-label="放大编辑备注"]');
    assert.ok(btn, "备注框右侧要有放大按钮");
    // 按钮必须在备注那个 FormControl 里面，否则它会飘到别的地方去
    const inNotes = btn!.closest(".MuiFormControl-root");
    assert.ok(
        inNotes?.querySelector("#notes"),
        "放大按钮要长在备注输入框里（写成了别处的按钮就等于没有这个功能）"
    );
});

test("两窗宽度与视觉是一套（但高度不要求相同）", () => {
    // 这条判据换过两次，都是因为用户实际看到了问题：
    //   ① 一开始只抄了 borderRadius → 放大窗没有毛玻璃/边框/阴影，肉眼小一号；
    //   ② 后来要求「整串 className 完全相同」→ 逼出了两窗共用样式，
    //      也顺带保证了宽度一致。现在**故意不要求高度相同**（见下面两条），
    //      但宽度与配色仍必须一致，所以关键 class 还是要逐个点名。
    openExpanded();
    const papers = [...document.querySelectorAll<HTMLElement>(".MuiDialog-paper")];
    assert.equal(papers.length, 2);
    for (const cls of [
        "MuiDialog-paperWidthSm",
        "MuiDialog-paperFullWidth",
        "nav-settings-dialog",
    ]) {
        assert.ok(papers[0].className.includes(cls), `主窗上应有 ${cls}`);
        assert.ok(papers[1].className.includes(cls), `放大窗上应有 ${cls}`);
    }
    // 毛玻璃那套也该一致（同一个 settingsPaper 派生来的）
    for (const paper of papers) {
        assert.ok(
            paper.className.includes("MuiPaper-root"),
            "两窗都该是 Paper 材质"
        );
    }
});

test("放大窗里带着当前备注内容，不是空的", () => {
    openExpanded({ notes: "第一行\n第二行\n第三行" });
    const area = expandedNotes();
    assert.ok(area, "放大窗里要有输入框");
    assert.equal(
        area!.value,
        "第一行\n第二行\n第三行",
        "打开时要把现有备注带进来，否则用户得先记住内容再重写一遍"
    );
});

test("在大窗里改字，主窗的备注跟着变（共用同一份内容）", () => {
    openExpanded({ notes: "旧内容" });
    const area = expandedNotes()!;
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value"
        )!.set!;
        setter.call(area, "新内容");
        area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const mainArea = document.querySelector<HTMLTextAreaElement>("#notes");
    assert.ok(mainArea, "主窗的备注框应该还在");
    assert.equal(
        mainArea!.value,
        "新内容",
        "两边必须共用一份内容 —— 各存一份再同步，迟早会出现「大窗改了、主窗没改」"
    );
});

test("关掉大窗（按「保存」）不连带关掉主窗", async () => {
    let closed = 0;
    mount(
        <SiteSettingsModal
            site={makeSite({ notes: "内容" })}
            groups={[] as never}
            onUpdate={() => {}}
            onDelete={() => {}}
            onClose={() => (closed += 1)}
        />
    );
    click(document.querySelector<HTMLElement>('[aria-label="放大编辑备注"]')!);
    assert.equal(document.querySelectorAll(".MuiDialog-paper").length, 2);

    click(topDialogButtons().find(b => (b.textContent || "").trim() === "保存")!);
    await settle();

    assert.equal(
        document.querySelectorAll("#notes-expanded").length,
        0,
        "点「完成」后放大窗该消失（它带着自己的 textarea 一起卸载）"
    );
    assert.equal(closed, 0, "主窗绝不能跟着关 —— 那等于用户白填一遍备注");
    assert.ok(
        document.querySelector("#notes"),
        "主窗还在，备注框也还在"
    );
});

test("大窗右上角的关闭按钮同样只关自己", async () => {
    openExpanded();
    // 放大窗的关闭按钮是最后一个弹窗里的那个（主窗也有一个同名按钮）
    const expanded = topDialog()!;
    const closeBtn = [...expanded.querySelectorAll<HTMLElement>('[aria-label="关闭"]')].pop()!;
    click(closeBtn);
    await settle();
    assert.equal(
        document.querySelectorAll("#notes-expanded").length,
        0,
        "关掉放大窗后它的输入框该没了"
    );
    assert.ok(
        document.querySelector("#notes"),
        "而主窗（连带它的备注框）要留着 —— 顶层是主窗的内容"
    );
});

test("没打开放大窗时，大窗的输入框不在 DOM 里", () => {
    mount(
        <SiteSettingsModal
            site={makeSite({ notes: "内容" })}
            groups={[] as never}
            onUpdate={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
        />
    );
    assert.equal(
        document.querySelector("#notes-expanded"),
        null,
        "没点放大就不该渲染大窗（省掉一棵无用的 textarea）"
    );
});

test("放大窗里不再挂可见标签（标题已写着「备注」，两个标签会叠字）", () => {
    openExpanded({ notes: "" });
    const area = expandedNotes();
    assert.ok(area, "放大窗里要有输入框");
    // 曾经这里挂了 label='备注'，而窗口标题也是「备注」；autoFocus 时 label 的收缩
    // 动画还没跑完，label 就压在 placeholder「可选的私人备注」上面（用户报的字重叠）。
    const label = area!.closest(".MuiFormControl-root")?.querySelector("label");
    assert.equal(
        label,
        null,
        "输入框上不该再有可见 label —— 标题已经说明了，再加一个既重复又叠字"
    );
    // 语义不能丢：读屏要能得到「备注」这个名字
    assert.equal(
        area!.getAttribute("aria-label"),
        "备注",
        "去掉可见 label 后要用 aria-label 补上，否则读屏用户听不出这是备注框"
    );
});

test("网站设置**不设任何高度**（恢复原来的自适应，别再撑出空白）", () => {
    // 用户连续三轮抱怨「网站设置下面空出一段」。根因是主窗被写了 minHeight / height，
    // 内容少时底部就空一块。这里钉死：主窗那份样式里不许出现任何高度。
    // 放大窗要高度由 notesPaper 单独给（那是内容一个大输入框，撑高不违和）。
    const source = readFileSync(
        join(findProjectDir(), "src", "components", "SiteSettingsModal.tsx"),
        "utf-8"
    );
    const body = source
        .slice(source.indexOf("function settingsPaper"), source.indexOf("function notesPaper"));
    assert.ok(
        !/\n\s+(min)?[Hh]eight:/.test(body),
        "settingsPaper（网站设置）里不许再写 height / minHeight —— " +
            "内容少时底部会空一段（用户报过三轮）。要撑高就改 notesPaper"
    );
});

test("放大窗的高度下限写在 notesPaper 里，且带视口兜底", () => {
    const source = readFileSync(
        join(findProjectDir(), "src", "components", "SiteSettingsModal.tsx"),
        "utf-8"
    );
    const start = source.indexOf("function notesPaper");
    const body = source.slice(start, source.indexOf("export default function"));
    assert.ok(body.includes("minHeight:"), "notesPaper 里要给放大窗一个高度下限");
    assert.ok(
        body.includes("calc(100vh"),
        "要用 min(…, calc(100vh …)) 收窄，否则小屏上弹窗会超出屏幕"
    );
    assert.ok(
        !/\n\s+height:/.test(body),
        "notesPaper 也别写死 height —— 内容（标题+20 行输入框+按钮）自己就够高了"
    );
    // rows 才是「撑满」的主力：写死高度 + 拉伸 textarea 会让内容垂直居中
    assert.ok(
        /rows=\{2\d\}/.test(source),
        "放大窗的输入框要用 rows 撑大（20 行以上），别用 height:100% 硬拉伸"
    );
    assert.ok(
        !source.includes("MuiInputBase-root"),
        "别再给 InputBase/textarea 设 height:100% —— 那是「光标落在框中间」的来源"
    );
});
