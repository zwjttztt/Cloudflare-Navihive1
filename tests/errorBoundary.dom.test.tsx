// tests/errorBoundary.dom.test.tsx
// 渲染兜底（src/components/ErrorBoundary.tsx）：组件树抛错时拦住、给可自助恢复的页面。
//
// 2026-10-20 评估时它被列进「9 个从未被用例引入的源文件」（148 行）。
// 它的价值全在「出事那一刻」—— 平时完全不出现，所以更需要钉住：
// 一旦有人改坏（比如把 children 无条件渲染、或把恢复按钮删了），
// 表现是白屏，而白屏是用户最先看到的东西。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ErrorBoundary from "../src/components/ErrorBoundary";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(ui: React.ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(ui);
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

afterEach(() => {
    cleanup();
    // 恢复被桩替换掉的全局
    Reflect.deleteProperty(globalThis, "__ebReported");
});

/** 一定会抛错的组件 */
function Boom(): React.ReactElement {
    throw new Error("渲染炸了");
}

/** 让 componentDidCatch 的 console.error 不污染测试输出 */
test("子组件抛错：渲染出自助恢复页，而不是白屏", t => {
    t.after(cleanup);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args);
    };
    try {
        mount(
            <ErrorBoundary>
                <Boom />
            </ErrorBoundary>
        );
    } finally {
        console.error = original;
    }

    const text = document.body.textContent ?? "";
    assert.ok(text.includes("页面出了点问题"), "要有标题，不能是白屏");
    assert.ok(text.includes("重新加载"), "要给重载入口");
    assert.ok(text.includes("清理本机数据并重载"), "要给清本机数据的入口");
    assert.ok(text.includes("连登录一起清理"), "要给连登录一起清的入口");
    // 错误详情要能展开看到原文：用户截图过来时这是唯一线索
    const pre = document.querySelector("pre");
    assert.ok(pre !== null, "要有错误详情区");
    assert.ok((pre.textContent ?? "").includes("渲染炸了"), "详情里要带错误原文");
});

test("没抛错：原样渲染 children，不掺任何兜底 UI", t => {
    t.after(cleanup);
    mount(
        <ErrorBoundary>
            <p data-child='1'>正常内容</p>
        </ErrorBoundary>
    );
    assert.ok(document.querySelector("[data-child='1']"), "children 要正常渲染");
    assert.equal(document.body.textContent?.includes("页面出了点问题"), false, "没出错不该出现兜底页");
});

test("点「清理本机数据并重载」：清本机偏好但不动记住的账号名", t => {
    t.after(cleanup);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args);
    };
    try {
        // 预置本机数据：一个带前缀的偏好 + 记住的账号名 + 别人的 key
        localStorage.setItem("navihive:theme", "dark");
        localStorage.setItem("theme", "dark");
        localStorage.setItem("rememberedLogin", JSON.stringify({ username: "root" }));
        localStorage.setItem("someone-elses", "keep-me");

        mount(
            <ErrorBoundary>
                <Boom />
            </ErrorBoundary>
        );
        const buttons = [...document.querySelectorAll("button")];
        const clearBtn = buttons.find(b => (b.textContent ?? "").includes("清理本机数据"));
        assert.ok(clearBtn, "要有「清理本机数据并重载」按钮");
        act(() => {
            clearBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        // 偏好被清（坏缓存正是要清的东西）
        assert.equal(localStorage.getItem("navihive:theme"), null, "本机偏好要清掉");
        assert.equal(localStorage.getItem("theme"), null, "无前缀的本机状态也要清");
        // ⚠️ 但「记住的账号名」不在这个按钮的职责里：用户只是想清坏缓存，
        // 顺手把登录表单的便利也清掉属于越界（localAppData.ts 的注释写着这条）
        assert.ok(localStorage.getItem("rememberedLogin"), "这个按钮不该动记住的账号名");
        // 别人的 key 一概不碰
        assert.equal(localStorage.getItem("someone-elses"), "keep-me", "别动不属于本站的数据");
    } finally {
        console.error = original;
    }
});

test("点「连登录一起清理」：连记住的账号名一起清", t => {
    t.after(cleanup);
    const original = console.error;
    console.error = () => {};
    try {
        localStorage.setItem("navihive:theme", "dark");
        localStorage.setItem("rememberedLogin", JSON.stringify({ username: "root" }));
        mount(
            <ErrorBoundary>
                <Boom />
            </ErrorBoundary>
        );
        const buttons = [...document.querySelectorAll("button")];
        const btn = buttons.find(b => (b.textContent ?? "").includes("连登录一起清理"));
        assert.ok(btn, "要有「连登录一起清理」按钮");
        act(() => {
            btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        assert.equal(localStorage.getItem("rememberedLogin"), null, "这个按钮才该清账号名");
        assert.equal(localStorage.getItem("navihive:theme"), null, "偏好照清");
    } finally {
        console.error = original;
    }
});
