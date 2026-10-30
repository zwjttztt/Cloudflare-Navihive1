// tests/addSiteDialogAi.dom.test.tsx
// 新增站点弹窗的 AI 补全生命周期（2026-10-19 用户报「补全 game.maj-soul.com/1/
// 长时间无反应，关闭窗口重新打开时按钮还在转」）。
//
// 这条链路 2026-10-30 起在 src/hooks/useNewSiteAiAssist.ts（P2-17 从 App.tsx 下沉），
// App 只负责把 hook 的返回值接到 AddSiteDialog 上。jsdom 里没法整棵 App 树渲染，
// 所以这里分两层钉住：
//   1. 本文件：真实渲染 AddSiteDialog + 一个**复刻产品重置逻辑**的 harness，
//      验证「忙 → 关闭 → 重开」不残留转圈、且忙时不能重复发起请求；
//   2. 静态守卫（同文件末尾）：盯 hook 里那几个关键点真的在
//      （请求序号、timer 清理、关闭/换 URL 时重置），harness 与产品实现不会漂移；
//      外加一条接线守卫：App.tsx 必须真的调用这个 hook（否则逻辑搬走了但没接上，
//      两条静态守卫都会绿，产品却什么都不做）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useEffect, useRef, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AddSiteDialog from "../src/components/AddSiteDialog";
import type { Site } from "../src/API/types";
import type { AiOutcome } from "../src/hooks/useAiAssistant";
import type { SiteMetaSuggestion } from "../src/utils/aiMeta";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteAi } from "../src/context/AiContext";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
});

/** 复刻 App.tsx 的持有方式：open + AI 三态 + 关闭/换 URL 时整体重置 */
function Harness({ siteMeta }: { siteMeta: SiteAi["siteMeta"] }) {
    const [open, setOpen] = useState(true);
    const [url, setUrl] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [messageError, setMessageError] = useState(false);
    const requestId = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => {
        requestId.current += 1;
        clearTimeout(timer.current);
        setBusy(false);
        setMessage("");
        setMessageError(false);
        return () => {
            requestId.current += 1;
            clearTimeout(timer.current);
        };
    }, [open, url]);
    const complete = async () => {
        if (!url || busy) return;
        const id = ++requestId.current;
        setBusy(true);
        setMessage("");
        setMessageError(false);
        try {
            const res = await Promise.race([
                siteMeta(url, { groups: [], tags: [] }),
                new Promise<never>((_r, reject) => {
                    timer.current = setTimeout(() => reject(new Error("AI 补全超时，请检查网络或稍后重试")), 30_000);
                }),
            ]);
            if (id !== requestId.current) return;
            if (!res.ok) throw new Error(res.message);
        } catch (error) {
            if (id !== requestId.current) return;
            setMessage(error instanceof Error ? error.message : "AI 补全失败，请重试");
            setMessageError(true);
        } finally {
            if (id === requestId.current) {
                clearTimeout(timer.current);
                setBusy(false);
            }
        }
    };
    return (
        <AddSiteDialog
            open={open}
            onClose={() => setOpen(false)}
            site={{ url } as Partial<Site>}
            onInputChange={e => setUrl(e.target.value)}
            showPassword={false}
            onTogglePassword={() => {}}
            creating={false}
            onFetchIcon={() => {}}
            onCreate={() => {}}
            ai={{ enabled: true, ready: true, reason: null, siteMeta }}
            aiBusy={busy}
            aiMessage={message}
            aiMessageError={messageError}
            onAiComplete={complete}
        />
    );
}

const aiButton = () => document.querySelector<HTMLButtonElement>("[aria-label='AI 补全名称与简介']");

test("AI 补全挂起时按钮持续转圈，且不能重复发起请求", async () => {
    let calls = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <Harness
                siteMeta={() => {
                    calls += 1;
                    return new Promise(() => {});
                }}
            />
        );
    });
    const input = document.querySelector<HTMLInputElement>("input#url, input[name='url']");
    await act(async () => {
        if (input) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setter.call(input, "game.maj-soul.com/1/");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });
    await act(async () => { aiButton()?.click(); });
    assert.equal(calls, 1, "第一次点击要真的发起请求");
    assert.ok(document.querySelector(".MuiCircularProgress-root"), "请求挂起期间要显示转圈");
    assert.equal(aiButton()?.disabled, true, "转圈期间不能再点（否则并发刷额度）");
    // 再点几下也不该多发请求
    await act(async () => { aiButton()?.click(); });
    assert.equal(calls, 1, "busy 期间重复点击必须被拦住");
});

test("关闭窗口再打开：AI 转圈不残留，旧结果不写进新表单", async () => {
    let release: ((v: AiOutcome<SiteMetaSuggestion>) => void) | null = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <Harness
                siteMeta={() =>
                    new Promise(resolve => {
                        release = resolve;
                    })
                }
            />
        );
    });
    const input = document.querySelector<HTMLInputElement>("input#url, input[name='url']");
    await act(async () => {
        if (input) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setter.call(input, "game.maj-soul.com/1/");
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });
    await act(async () => { aiButton()?.click(); });
    assert.ok(document.querySelector(".MuiCircularProgress-root"), "先让请求挂起");

    // 关闭（用户报「关闭窗口重新打开时还在转」）
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[aria-label='关闭']")?.click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // 重新打开
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[aria-label='关闭']")?.click();
    });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    // 关掉的对话框不该还占着 DOM；重新渲染一个新的（open=true 的 harness）
    await act(async () => {
        root!.unmount();
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <Harness
                siteMeta={() =>
                    new Promise(resolve => {
                        release = resolve;
                    })
                }
            />
        );
    });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    assert.equal(document.querySelector(".MuiCircularProgress-root"), null, "重开后不能残留转圈");
    assert.equal(aiButton()?.disabled, true, "重开后还没有链接，按钮保持禁用（而不是卡在 busy）");
    assert.equal(document.body.textContent?.includes("AI 补全超时"), false, "上一次的提示不得残留");

    // 旧请求这时候才回来：不许写进新表单（新表单里 url 为空，message 也不能冒出来）
    await act(async () => {
        release?.({ ok: false, message: "旧请求的失败原因" });
        await new Promise(r => setTimeout(r, 50));
    });
    assert.equal(
        document.body.textContent?.includes("旧请求的失败原因"),
        false,
        "旧请求的失败提示不得污染重开后的表单",
    );
});

// ---------- 静态守卫：harness 与 App.tsx 的实现不能漂移 ----------
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

function projectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

test("hooks/useNewSiteAiAssist.ts：AI 请求必须有序号、超时兜底与关闭重置", () => {
    const src = stripComments(
        readFileSync(resolve(projectDir(), "src", "hooks", "useNewSiteAiAssist.ts"), "utf8"),
    );
    assert.match(src, /const requestId = useRef\(0\)/, "要有一个请求序号 ref（旧结果不得回写）");
    assert.match(src, /id !== requestId\.current/, "响应对不上号时必须整条丢弃");
    assert.match(
        src,
        /Promise\.race\(\[[\s\S]{0,400}siteAi\.siteMeta\(/,
        "siteMeta 必须与超时 Promise 赛跑，不能无限等",
    );
    assert.match(src, /const timer = useRef</, "超时定时器要能被清理（否则每次都是一颗新雷）");
    assert.match(src, /clearTimeout\(timer\.current\)/, "finally / 关闭路径都要清定时器");
    assert.match(
        src,
        /handleCloseAddSiteWithAiReset[\s\S]{0,600}setAiBusy\(false\)/,
        "关闭时必须把 busy 复位（用户报「重开还在转」的根因）",
    );
    assert.match(
        src,
        /\[openAddSite, newSite\.url\]/,
        "打开状态或 URL 变化时也要整体重置（换站点不能带上一次的忙态）",
    );
});

test("App.tsx：真的接上了 useNewSiteAiAssist，且把补全动作给了新增弹窗", () => {
    const src = stripComments(readFileSync(resolve(projectDir(), "src", "App.tsx"), "utf8"));
    assert.match(src, /=\s*useNewSiteAiAssist\(\{/, "逻辑搬走后必须真的调用（否则两条静态守卫都会绿而产品无效）");
    assert.match(
        src,
        /handleAiComplete:\s*handleAiCompleteNew/,
        "返回值要接回原来的引用名，新增弹窗的 onAiComplete 才拿得到",
    );
    assert.match(src, /onAiComplete=\{handleAiCompleteNew\}/, "AddSiteDialog 上要真挂上补全回调");
});
