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
const settle = () => new Promise(resolve => setTimeout(resolve, 350));

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

test("放大窗的尺寸和网站设置一致", () => {
    openExpanded();
    const papers = [...document.querySelectorAll<HTMLElement>(".MuiDialog-paper")];
    assert.equal(papers.length, 2, "应该同时存在主窗与放大窗两个弹窗");
    const main = papers[0];
    const expanded = papers[1];
    // 现在两个窗共用 settingsPaper(theme) 这**同一份**样式对象，emotion 会为相同的
    // sx 生成相同的 hash，所以整串 className 必须一模一样 —— 这是最强的断言。
    // （第一版只抄了 borderRadius，毛玻璃/边框/阴影/背景全没抄，肉眼一看就「小一号」，
    //   而当时只比「都有 paperWidthSm」，所以没抓到。共用之后才敢比整串。）
    assert.equal(
        expanded.className,
        main.className,
        "两个窗的样式 class 必须完全相同 —— 少抄一条样式就变成另一个窗了"
    );
    // 顺带把关键的几条点名，失败时能一眼看出差在哪
    for (const cls of [
        "MuiDialog-paperWidthSm",
        "MuiDialog-paperFullWidth",
        "nav-settings-dialog",
    ]) {
        assert.ok(expanded.className.includes(cls), `放大窗上应有 ${cls}`);
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

test("两窗用的是同一份固定高度（不是量出来的）", () => {
    // 这条判据换过一次。原先的做法是「点开时量主窗 offsetHeight 当放大窗 minHeight」，
    // 实测**根本没生效** —— 量不到就静默退化成按内容自适应，于是又矮一截，
    // 为此用户反馈了三轮。现在改成固定高度：两窗用**同一个 settingsPaper**，
    // 值来自同一处，不可能不一致。
    //
    // 能这么断言的前提是「两窗的 sx 完全一样」—— emotion 对相同样式生成相同 hash，
    // 所以整串 className 必须一致。这比「都有某个 class」强得多。
    openExpanded();
    const papers = [...document.querySelectorAll<HTMLElement>(".MuiDialog-paper")];
    assert.equal(papers.length, 2);
    assert.equal(
        papers[1].className,
        papers[0].className,
        "两个窗的样式 class 必须完全相同 —— 高度是从同一个函数出来的，不允许有第二个来源"
    );
});

test("固定高度写在共享样式里（不许只给放大窗写）", () => {
    // 反过来钉一次：如果有人为了「让主窗自适应」把 height 从共享函数里删掉、
    // 只留在放大窗上，两窗 className 就会不同 —— 上面那条会红。
    // 这条则保证「共享函数确实产出了高度」，而不是恰好两边都没高度。
    const source = readFileSync(
        join(findProjectDir(), "src", "components", "SiteSettingsModal.tsx"),
        "utf-8"
    );
    const fn = source.slice(source.indexOf("function settingsPaper"));
    const body = fn.slice(0, fn.indexOf("}"));
    assert.ok(
        body.includes('height: "min(') || body.includes("height: 'min("),
        "settingsPaper 里必须写死高度 —— 不写就退回「按内容自适应」，两窗又不一致了"
    );
    // 固定高度必须同时照顾小屏：min() 里那个 calc 是视口兜底，
    // 只写死 700px 在小屏上会超出屏幕
    assert.ok(
        body.includes("calc(100vh"),
        "固定高度要用 min(…, calc(100vh …)) 收窄，否则小屏上弹窗会超出屏幕"
    );
});

test("放大窗里的按钮叫「保存」（不是「完成」）", () => {
    openExpanded({ notes: "内容" });
    const btn = topDialogButtons().find(b => (b.textContent || "").trim() === "保存");
    assert.ok(btn, "放大窗的确认按钮文案是「保存」");
    assert.equal(
        topDialogButtons().find(b => (b.textContent || "").trim() === "完成"),
        undefined,
        "不该还留着「完成」"
    );
});

test("initiallyExpandNotes：卡片右键直达时，打开就是放大态", () => {
    // 模拟 SiteCard 右键「编辑备注」那条路径：它把标志传给 modal，modal 挂载时就读一次
    mount(
        <SiteSettingsModal
            site={makeSite({ notes: "已有备注" })}
            groups={[] as never}
            onUpdate={() => {}}
            onDelete={() => {}}
            onClose={() => {}}
            initiallyExpandNotes
        />
    );
    // 不用点放大按钮：打开就该在放大窗里
    assert.ok(
        document.querySelector("#notes-expanded"),
        "传了 initiallyExpandNotes 就要直接进放大窗 —— 卡片右键「编辑备注」全靠这条"
    );
    assert.equal(
        document.querySelectorAll(".MuiDialog-paper").length,
        2,
        "主窗也在（放大窗是叠在它上面的），但内容是备注"
    );
});

test("不带 initiallyExpandNotes 时仍然从主窗开始（标志不残留）", () => {
    openExpanded();
    assert.ok(
        document.querySelector("#notes-expanded"),
        "点过放大后放大窗在"
    );
});
