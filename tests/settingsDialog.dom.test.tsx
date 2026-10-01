// tests/settingsDialog.dom.test.tsx
// 全站设置弹窗 756 行，之前零覆盖。这里盯的是「改坏了没人会发现、但用户会很难受」的几条：
// 非站点所有者的权限降级（数据保留三项禁用 + 两处说明）、预设壁纸的选中 / 再点取消、
// 毛玻璃总开关关掉后强度滑块跟着失效、保存中按钮防连点、以及输入框是否带对了 name。
//
// 组件是受控的（值全在 tempConfigs 里，点保存才落库），所以这里用一个 Harness
// 组件持有状态，尽量贴近 App 里的真实用法，而不是直接喂死值。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import SettingsDialog from "../src/components/SettingsDialog";
import type { FontScale, RadiusStyle } from "../src/context/UIPrefsContext";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: window.localStorage,
        configurable: true,
        writable: true,
    });
}

type Calls = {
    /** 输入框改动：原样转发自组件，用来核对 name 有没有带对 */
    configChanges: Array<{ name: string; value: string }>;
    accents: string[];
    radius: RadiusStyle[];
    fontScale: FontScale[];
    glassEffects: boolean[];
    offlineFull: boolean[];
    iconPrivacy: boolean[];
    closes: number;
    saves: number;
    linkChecks: number;
};

function baseConfigs(over: Record<string, string> = {}): Record<string, string> {
    return {
        "site.title": "我的导航",
        "site.name": "导航站",
        "site.primaryColor": "#1976d2",
        "site.backgroundImage": "",
        "site.backgroundMaskOpacity": "0.3",
        "site.iconApi": "",
        "site.thumbApi": "",
        "site.customCss": "",
        "retention.days": "7",
        "inactive.disableDays": "",
        "inactive.deleteGraceDays": "",
        ...over,
    };
}

type Opts = {
    isSiteOwner?: boolean;
    saving?: boolean;
    onRunLinkCheck?: () => void;
    glassEffects?: boolean;
    radius?: RadiusStyle;
    fontScale?: FontScale;
    configs?: Record<string, string>;
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let calls: Calls = emptyCalls();
/** 当前弹窗里的临时配置副本，用例里改完要断言的话从这里读 */
let configs: Record<string, string> = {};

function emptyCalls(): Calls {
    return {
        configChanges: [],
        accents: [],
        radius: [],
        fontScale: [],
        glassEffects: [],
        offlineFull: [],
        iconPrivacy: [],
        closes: 0,
        saves: 0,
        linkChecks: 0,
    };
}

function Harness(o: Opts) {
    const [state, setState] = useState<Record<string, string>>(baseConfigs(o.configs));
    const [glass, setGlass] = useState(o.glassEffects ?? true);
    const [radius, setRadius] = useState<RadiusStyle>(o.radius ?? "soft");
    const [fontScale, setFontScale] = useState<FontScale>(o.fontScale ?? "normal");
    const [pinyin, setPinyin] = useState(false);
    const [offlineFull, setOfflineFull] = useState(false);
    const [iconPrivacy, setIconPrivacy] = useState(false);
    const [syncHealth, setSyncHealth] = useState(false);
    const [syncPrefs, setSyncPrefs] = useState(false);
    const [, setMaskOpacity] = useState(0.3);
    const [glassBlur, setGlassBlur] = useState(8);
    configs = state;
    return (
        <SettingsDialog
            open
            onClose={() => calls.closes++}
            onSave={() => calls.saves++}
            tempConfigs={state}
            setTempConfigs={setState}
            onConfigInputChange={e =>
                calls.configChanges.push({ name: e.target.name, value: e.target.value })
            }
            onMaskOpacityChange={(_e, v) => setMaskOpacity(Array.isArray(v) ? v[0] : v)}
            onPickAccent={c => calls.accents.push(c)}
            radius={radius}
            onRadiusChange={v => {
                calls.radius.push(v);
                setRadius(v);
            }}
            fontScale={fontScale}
            onFontScaleChange={v => {
                calls.fontScale.push(v);
                setFontScale(v);
            }}
            glassBlur={glassBlur}
            onGlassBlurChange={(_e, v) => setGlassBlur(Array.isArray(v) ? v[0] : v)}
            glassEffects={glass}
            onGlassEffectsChange={v => {
                calls.glassEffects.push(v);
                setGlass(v);
            }}
            offlineFull={offlineFull}
            onOfflineFullChange={v => {
                calls.offlineFull.push(v);
                setOfflineFull(v);
            }}
            iconPrivacy={iconPrivacy}
            onIconPrivacyChange={v => {
                calls.iconPrivacy.push(v);
                setIconPrivacy(v);
            }}
            saving={o.saving ?? false}
            pinyinSearch={pinyin}
            onPinyinSearchChange={setPinyin}
            syncHealth={syncHealth}
            onSyncHealthChange={setSyncHealth}
            syncPrefs={syncPrefs}
            onSyncPrefsChange={setSyncPrefs}
            onRunLinkCheck={o.onRunLinkCheck ? () => calls.linkChecks++ : undefined}
            isSiteOwner={o.isSiteOwner ?? true}
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

const button = (text: string) =>
    [...document.querySelectorAll("button")].find(b => (b.textContent ?? "").includes(text));

const byLabel = (label: string) =>
    document.querySelector<HTMLElement>(`[aria-label="${label}"]`);

const inputById = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`);

const alerts = () =>
    [...document.querySelectorAll(".MuiAlert-root")].map(el => (el.textContent ?? "").trim());

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

/** 两个滑块：0 是背景蒙版透明度、1 是毛玻璃强度（按 DOM 顺序，别按文案找） */
const sliders = () => [...document.querySelectorAll(".MuiSlider-root")];

test.afterEach(cleanup);

test("设置：站点所有者看不到「外观按账号保存」提示，数据保留三项可编辑", () => {
    render({ isSiteOwner: true });
    assert.equal(
        alerts().some(t => t.includes("外观按账号保存")),
        false,
        "所有者不该看到这条按账号保存的说明"
    );
    assert.equal(alerts().some(t => t.includes("只有站点所有者可以修改")), false);
    for (const id of ["retention-days", "inactive-disable-days", "inactive-grace-days"]) {
        assert.equal(inputById(id)?.disabled, false, `${id} 对所有者应该可编辑`);
    }
});

test("设置：非所有者会降级 —— 数据保留三项禁用，且两处都写清原因", () => {
    render({ isSiteOwner: false });
    assert.ok(
        alerts().some(t => t.includes("外观按账号保存")),
        "非所有者得说清楚改的是谁的样式"
    );
    assert.ok(
        alerts().some(t => t.includes("只有站点所有者可以修改")),
        "数据保留区要说明为什么改不了"
    );
    for (const id of ["retention-days", "inactive-disable-days", "inactive-grace-days"]) {
        assert.equal(inputById(id)?.disabled, true, `${id} 对非所有者应该禁用`);
    }
    // 外观类字段不受影响：非所有者照样能改自己那份
    assert.equal(inputById("site-title")?.disabled, false, "标题这类外观项非所有者也能改");
});

test("设置：输入框改动带上配置键名（name），保存才落库靠的就是它", () => {
    render();
    setInputValue(inputById("site-title")!, "新标题");
    setInputValue(inputById("retention-days")!, "30");
    assert.deepEqual(calls.configChanges, [
        { name: "site.title", value: "新标题" },
        { name: "retention.days", value: "30" },
    ]);
});

test("设置：点预设配色回调该颜色，「恢复默认」回调空串", () => {
    render();
    const picked = byLabel("使用配色 #2e7d32");
    assert.ok(picked, "应该有绿色预设的取色按钮");
    assert.equal(picked!.getAttribute("aria-pressed"), "false", "#2e7d32 不是当前色");
    assert.equal(
        byLabel("使用配色 #1976d2")?.getAttribute("aria-pressed"),
        "true",
        "当前主色是 #1976d2，对应按钮应呈选中态"
    );
    click(picked!);
    click(button("恢复默认")!);
    assert.deepEqual(calls.accents, ["#2e7d32", ""]);
});

test("设置：预设壁纸点一下写入背景、再点一下清空（同一个按钮来回切）", () => {
    render();
    const preset = byLabel("使用壁纸 极光")!;
    assert.ok(preset);
    click(preset);
    assert.ok(
        configs["site.backgroundImage"].startsWith("linear-gradient"),
        `应写入渐变背景，实际：${configs["site.backgroundImage"]}`
    );
    const applied = configs["site.backgroundImage"];
    click(byLabel("使用壁纸 极光")!);
    assert.equal(
        configs["site.backgroundImage"],
        "",
        `再点一次应取消（之前写入的是 ${applied}）`
    );
});

test("设置：毛玻璃总开关关掉后，强度滑块跟着失效，蒙版滑块不受影响", () => {
    render({ glassEffects: true });
    assert.equal(sliders().length, 2, "页面上应该有且只有两个滑块");
    assert.equal(
        sliders().filter(s => s.classList.contains("Mui-disabled")).length,
        0,
        "开关开着时两个滑块都该能用"
    );

    const toggle = byLabel("毛玻璃特效") as HTMLInputElement;
    assert.ok(toggle, "没找到毛玻璃开关");
    click(toggle);
    assert.deepEqual(calls.glassEffects, [false]);

    assert.equal(
        sliders()[1].classList.contains("Mui-disabled"),
        true,
        "第二个滑块（毛玻璃强度）应该变成禁用"
    );
    assert.equal(
        sliders()[0].classList.contains("Mui-disabled"),
        false,
        "背景蒙版透明度跟毛玻璃无关，不该一起禁用"
    );
});

test("设置：保存中按钮禁用且文案变「保存中…」，防连点重复提交", () => {
    render();
    const save = button("保存设置")!;
    assert.ok(save);
    assert.equal(save.disabled, false);
    click(save);
    assert.equal(calls.saves, 1);

    cleanup();
    render({ saving: true });
    const busy = button("保存设置");
    assert.equal(busy, undefined, "保存中不该还显示「保存设置」");
    const btn = button("保存中…")!;
    assert.ok(btn);
    assert.equal(btn.disabled, true, "保存中必须禁用，否则能连点出多次提交");
});

test("设置：取消按钮走 onClose；不传 onRunLinkCheck 就不显示失效检测按钮", () => {
    render();
    assert.equal(button("检测失效链接"), undefined, "没传回调时不该出现这个按钮");
    click(button("取消")!);
    assert.equal(calls.closes, 1);

    cleanup();
    render({ onRunLinkCheck: () => {} });
    const check = button("检测失效链接")!;
    assert.ok(check, "传了回调就该显示");
    click(check);
    assert.equal(calls.linkChecks, 1);
});

test("设置：圆角 / 字号切换回调对应档位；再点已选中的档位不会回传 null", () => {
    render({ radius: "soft", fontScale: "normal" });
    click(byLabel("锐利圆角")!);
    click(byLabel("宽松字号")!);
    assert.deepEqual(calls.radius, ["sharp"]);
    assert.deepEqual(calls.fontScale, ["large"]);

    // 分组是 exclusive 的，点已选中的那一档 MUI 会给 null —— 组件里有 `value &&` 挡着，
    // 这条就是盯那个护栏：回调不该收到 null
    click(byLabel("锐利圆角")!);
    assert.deepEqual(calls.radius, ["sharp"], "点已选中的档位不该再回调一次");
});
