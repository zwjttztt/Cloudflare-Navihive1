// tests/a11yNamedRules.dom.test.tsx
// 「可访问名」判据的行为用例（R16，2026-11-04）。
//
// 为什么必须有用例、而且必须是**行为**用例：
// 审计脚本原来的判据是
//     const nameOf = el => (el.getAttribute('aria-label') || el.getAttribute('title')
//                           || el.textContent || '').trim();
// 它的错法全都是「往一个方向」错的，而其中三条**互相抵消**：
//   · 不认 `aria-labelledby` → 用委托标签的控件一律假红（弹窗、表单最常用这种写法）；
//   · `title` 排在文本内容前面 → 既有文案又有 title 的按钮，读屏念的和我量的不是一个；
//   · `!getAttribute('alt')` → 把合法的装饰图 `alt=""` 判成违规，同时又让
//     `aria-hidden` 子树里那些装饰图标全部参与统计。
// 假红会让门禁失去信任（然后被人关掉），假绿会让缺陷上线 —— 两个方向都得钉住。
//
// 判据只有一份：`script/auditEnv.mjs` 的 `accessibleNameCore`。这里
//   ① 直接调它（同一份源码，Node 侧）；
//   ② 再把它 `toString()` 出来的 `A11Y_NAME_CORE`（**页面里跑的就是这个字符串**）
//      放进 `new Function` 里跑一遍，确认注入路径与直接调用结论一致。
// 两条一起，才叫「测的是页面里跑的那份」。

import { test } from "node:test";
import assert from "node:assert/strict";
// auditEnv.mjs 是纯 JS（项目里没有给 script/ 配 .d.mts），tsc 在 strict 下会报 TS7016。
// 与其给审计脚本再养一份会漂开的类型声明，不如在这里挂住告警、用下面的接口显式收窄类型。
// @ts-expect-error - script/auditEnv.mjs 没有类型声明文件
import { A11Y_NAME_CORE, accessibleNameCore } from "../script/auditEnv.mjs";

/** 工厂返回的那套 API（类型由用例自己声明，见上面 @ts-expect-error 的理由） */
type NameApi = {
    accessibleName: (el: Element, opts?: { content?: boolean; title?: boolean }) => string | null;
    nameFromLabelledBy: (el: Element) => string;
    contentName: (el: Element) => string;
    exclusionReason: (el: Element) => string | null;
    isExcluded: (el: Element) => boolean;
    isUnnamed: (el: Element) => boolean;
    imgFails: (el: Element) => boolean;
    isInteractive: (el: Element) => boolean;
};

/** Node 侧：直接调那一份实现 */
const NH: NameApi = (accessibleNameCore as () => NameApi)();

/** 页面侧：把注入用的字符串求值出来（`NHNAME` 就是 a11y-audit 里用的名字） */
const INJECTED: NameApi = new Function(`${A11Y_NAME_CORE}\nreturn NHNAME;`)() as NameApi;

/** 铺一段 DOM，返回按 id 取节点的便捷函数 */
function mount(html: string): (id: string) => Element {
    document.body.innerHTML = html;
    return (id: string) => {
        const el = document.getElementById(id);
        assert.ok(el, `用例 DOM 里没有 #${id}（用例自己写错了？）`);
        return el as Element;
    };
}

// ---------------- aria-labelledby ----------------

test("aria-labelledby：递归解析（a → b → c），多个 id 用空格连接", () => {
    const $ = mount(`
        <span id="a" aria-labelledby="b"></span>
        <span id="b" aria-labelledby="c"></span>
        <span id="c">删除这条笔记</span>
        <button id="btn" aria-labelledby="a"></button>
        <span id="extra">（草稿）</span>
        <button id="multi" aria-labelledby="c extra"></button>
    `);
    assert.equal(NH.accessibleName($("btn")), "删除这条笔记", "只解一层的旧实现会在这里拿到空串");
    assert.equal(NH.accessibleName($("multi")), "删除这条笔记 （草稿）", "多个 id 要按空格连接");
});

test("aria-labelledby：成环（a → b → a）不会无限递归，也能拿到 b 的内容", () => {
    const $ = mount(`
        <span id="x" aria-labelledby="y">A</span>
        <span id="y" aria-labelledby="x">B</span>
        <button id="btn" aria-labelledby="x"></button>
        <span id="self" aria-labelledby="self">自己</span>
        <button id="selfBtn" aria-labelledby="self"></button>
    `);
    // 只要求「终止 + 非空」：环上的顺序不同实现可以不同，但绝不能抛 RangeError
    assert.equal(NH.accessibleName($("btn")), "B");
    assert.equal(NH.accessibleName($("selfBtn")), "自己", "自引用要退到自己的文本内容，而不是空串");
});

test("aria-labelledby：引用目标 aria-hidden / display:none 时跳过（看不见的不参与命名）", () => {
    const $ = mount(`
        <span id="hidden" aria-hidden="true">不该被念</span>
        <span id="gone" style="display:none">隐藏文案</span>
        <span id="ok">该被念</span>
        <button id="btn" aria-labelledby="hidden gone ok"></button>
    `);
    const name = NH.accessibleName($("btn"));
    assert.equal(name, "该被念", `aria-hidden / display:none 的引用目标不该贡献名字，实际：${name}`);
});

test("aria-labelledby：引用不存在的 id 只跳过那一条（不许整条名字作废）", () => {
    const $ = mount(`
        <span id="ok">保存</span>
        <button id="btn" aria-labelledby="nope ok"></button>
    `);
    assert.equal(NH.accessibleName($("btn")), "保存");
});

// ---------------- img 的 alt ----------------

test("img：alt=\"\" 是合法的装饰图（旧判据在这里假红）", () => {
    const $ = mount(`<div><img id="deco" alt="" src="dot.png"></div>`);
    assert.equal(NH.imgFails($("deco")), false, 'alt="" 是 WCAG 允许的装饰图写法，不该判违规');
});

test("img：压根没写 alt 才算违规（与 alt=\"\" 必须区分开）", () => {
    const $ = mount(`<div><img id="noalt" src="dot.png"></div>`);
    assert.equal(NH.imgFails($("noalt")), true, "没有 alt 属性 = 缺文本替代");
});

test("img：实际可交互的图 alt=\"\" 仍算无名（除非另有 aria-label）", () => {
    const $ = mount(`
        <img id="roleBtn" alt="" role="button" src="a.png">
        <img id="tabbable" alt="" tabindex="0" src="b.png">
        <button id="host"><img id="inner" alt="" src="c.png"></button>
        <img id="labelled" alt="" role="button" aria-label="关闭预览" src="d.png">
    `);
    assert.equal(NH.isInteractive($("roleBtn")), true, 'role="button" 的图是可交互的');
    assert.equal(NH.imgFails($("roleBtn")), true, '可交互的图 alt="" → 读屏念出一个没有名字的按钮');
    assert.equal(NH.imgFails($("tabbable")), true, 'tabindex="0" 的图同样参与 Tab 序列');
    assert.equal(NH.imgFails($("inner")), true, "放在 button 里的图也算交互面的一部分");
    assert.equal(NH.imgFails($("labelled")), false, "有 aria-label 就真的有名字了，不该再判违规");
});

// ---------------- 名字来源与顺序 ----------------

test("名字来自文本内容，且**内容优先于 title**（旧实现把 title 排前面）", () => {
    const $ = mount(`
        <button id="plain">  保存  </button>
        <button id="withTitle" title="保存当前表单">保存</button>
        <a id="link" href="#x" title="去首页">回到首页</a>
    `);
    assert.equal(NH.accessibleName($("plain")), "保存", "空白要归一化");
    assert.equal(
        NH.accessibleName($("withTitle")),
        "保存",
        "既有文案又有 title 时必须念文案 —— 旧判据（title 优先）量出来的名字和读屏念的不是同一个"
    );
    assert.equal(NH.accessibleName($("link")), "回到首页");
});

test("表单控件：label[for] 优先于 placeholder，placeholder 也算名字（规范顺序）", () => {
    const $ = mount(`
        <label for="q">关键字</label>
        <input id="q" placeholder="搜索网站">
        <input id="ph" placeholder="搜索网站">
        <label id="wrap"><span>备注</span><textarea id="ta"></textarea></label>
        <select id="sel"><option>全部</option></select>
    `);
    assert.equal(NH.accessibleName($("q")), "关键字", "label[for] 是比 placeholder 更靠前的名字来源");
    assert.equal(NH.accessibleName($("ph")), "搜索网站", "没有 label 时 placeholder 兜底");
    assert.equal(NH.accessibleName($("ta")), "备注", "包住控件的 label 也算（不能把控件自己的内容念进来）");
    assert.equal(NH.accessibleName($("sel")), "", "只有 option 文本的 select 不该被当成有名字");
});

test("图标按钮：title 只是最后兜底（既没内容也没 aria-* 时才算名字）", () => {
    const $ = mount(`
        <button id="iconOnly" title="关闭"><svg></svg></button>
        <button id="labelled" aria-label="关闭"><svg></svg></button>
    `);
    assert.equal(NH.accessibleName($("iconOnly")), "关闭", "纯图标按钮靠 title 也能有名字（规范允许）");
    assert.equal(NH.isUnnamed($("iconOnly")), false);
    assert.equal(NH.accessibleName($("labelled")), "关闭");
});

// ---------------- 不在可访问树上 ----------------

test("aria-hidden 子树整体排除：返回明确标记（不是空串），且不参与违规统计", () => {
    const $ = mount(`
        <div aria-hidden="true">
            <button id="decoBtn"><svg></svg></button>
            <img id="decoImg" src="dot.png">
            <input id="decoInput">
        </div>
        <button id="real">真按钮</button>
    `);
    assert.equal(NH.isExcluded($("decoBtn")), true);
    assert.equal(
        NH.accessibleName($("decoBtn")),
        null,
        "排除项必须返回 null 这个**明确标记** —— 返回空串会和「没名字」混成一个东西"
    );
    assert.equal(NH.isUnnamed($("decoBtn")), false, "不在可访问树上的元素不该算「无名」");
    assert.equal(NH.imgFails($("decoImg")), false, "aria-hidden 子树里的 img 压根不该进统计");
    assert.equal(NH.exclusionReason($("decoInput")), "aria-hidden");

    assert.equal(NH.isUnnamed($("real")), false, "对照组：正常按钮不能被一起排除掉");
    assert.equal(NH.accessibleName($("real")), "真按钮");
});

test("display:none / hidden 属性同样不在可访问树上", () => {
    const $ = mount(`
        <button id="gone" style="display:none">看不见</button>
        <div hidden><button id="hiddenAttr">也看不见</button></div>
        <button id="visible">看得见</button>
    `);
    assert.equal(NH.isExcluded($("gone")), true);
    assert.equal(NH.exclusionReason($("gone")), "display-none");
    assert.equal(NH.isExcluded($("hiddenAttr")), true);
    assert.equal(NH.isExcluded($("visible")), false);
});

// ---------------- 弹窗口径 ----------------

test("role=\"dialog\"：不许拿正文文字当名字（content:false），但 aria-labelledby 要认", () => {
    const $ = mount(`
        <div role="dialog" id="d1"><h2>设置中心</h2><button>关闭</button></div>
        <h2 id="title2">审计日志</h2>
        <div role="dialog" id="d2" aria-labelledby="title2"><button>关闭</button></div>
    `);
    assert.equal(
        NH.accessibleName($("d1"), { content: false }),
        "",
        "弹窗必须有作者提供的名字：正文文字能当名字的话，「没有可访问名」这条判据会静默失效"
    );
    assert.match(String(NH.accessibleName($("d1"))), /设置中心/, "对照：允许内容时当然能取到正文");
    assert.equal(NH.accessibleName($("d2"), { content: false }), "审计日志", "labelledby 是弹窗最常用的命名方式");
});

// ---------------- 注入路径 ----------------

test("注入页面用的 A11Y_NAME_CORE 与直接调用的实现结论一致（判据只有一份）", () => {
    mount(`
        <span id="c">保存</span>
        <span id="a" aria-labelledby="c"></span>
        <button id="btn" aria-labelledby="a"></button>
        <img id="deco" alt="" src="x.png">
        <img id="noalt" src="y.png">
        <div aria-hidden="true"><button id="decoBtn"></button></div>
    `);
    for (const id of ["btn", "deco", "noalt", "decoBtn"]) {
        const el = document.getElementById(id) as Element;
        assert.equal(
            INJECTED.accessibleName(el),
            NH.accessibleName(el),
            `#${id} 的可访问名：注入版与直接调用不一致 —— 说明 A11Y_NAME_CORE 不是那份源码`
        );
        assert.equal(INJECTED.imgFails(el), NH.imgFails(el), `#${id} 的 imgFails 不一致`);
        assert.equal(INJECTED.isUnnamed(el), NH.isUnnamed(el), `#${id} 的 isUnnamed 不一致`);
    }
});
