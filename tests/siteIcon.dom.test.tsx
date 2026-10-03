// tests/siteIcon.dom.test.tsx
// useSiteIcon / useSiteThumb：卡片图标的候选源状态机与缩略图超时兜底。
//
// 这两个是从 SiteCard（1186 行）里搬出来的。搬的价值在于它们错了**不报错**：
// 主源全挂却没补兜底源 → 图标一直显示首字母块，看着像「这个站点没图标」；
// 缩略图超时兜底没了 → 截图服务被限流时卡片上永远留一块灰骨架。
// 在几百张卡片的列表里滚一遍，这两种都不会被当成 bug。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSiteIcon, type SiteIconState } from "../src/hooks/useSiteIcon";
import { useSiteThumb, THUMB_TIMEOUT_MS, type SiteThumbState } from "../src/hooks/useSiteThumb";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
});

function mount(node: React.ReactNode) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(node);
    });
}

/** effect 里有 await，要让出几轮宏任务才能拿到最终状态 */
async function flush() {
    await act(async () => {
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
    });
}

const iconProbe: { current: SiteIconState | null } = { current: null };

function IconHarness(props: Parameters<typeof useSiteIcon>[0]) {
    iconProbe.current = useSiteIcon(props);
    return null;
}

async function mountIcon(props: Parameters<typeof useSiteIcon>[0]) {
    mount(<IconHarness {...props} />);
    await flush();
    return iconProbe.current!;
}

test("有自带图标时第一个候选就是它", async () => {
    const s = await mountIcon({ icon: "https://a.com/logo.png", url: "https://a.com", iconApi: "" });
    // 候选统一走 /api/icon 代理（不直连第三方：既不带 Referer，也能统一缓存）
    assert.equal(decodeURIComponent(s.currentIcon), "/api/icon?u=https://a.com/logo.png");
    assert.equal(s.iconError, false);
});

test("隐私模式：一个候选都不给，直接交给首字母块", async () => {
    const s = await mountIcon({
        icon: "https://a.com/logo.png",
        url: "https://a.com",
        iconApi: "",
        privacy: true,
    });
    assert.equal(s.currentIcon, "");
    assert.equal(s.iconError, true);
});

test("换源：handleIconError 推进到下一个候选", async () => {
    const s = await mountIcon({
        icon: "https://a.com/logo.png",
        url: "https://a.com",
        iconApi: "",
    });
    const first = s.currentIcon;
    await act(async () => {
        s.handleIconError();
    });
    await flush();
    assert.notEqual(iconProbe.current!.currentIcon, first, "报错之后该换下一个源");
});

test("全部候选都试过之后 iconError 置位（交给首字母块，不会停在空地址上）", async () => {
    await mountIcon({ icon: "", url: "https://no-icon.example", iconApi: "" });
    // 反复报错直到候选耗尽
    for (let i = 0; i < 12; i++) {
        await act(async () => {
            iconProbe.current!.handleIconError();
        });
    }
    await flush();
    assert.equal(iconProbe.current!.iconError, true);
});

test("主源全挂之后兜底源要接上来 —— 否则图标永远是首字母块", async () => {
    // 注意：iconApi 留空不等于没有主源（会回落到内置图标服务），
    // 所以要一路报错把主源耗尽，看兜底源接不接得上
    await mountIcon({
        icon: "https://fallback.example/a.png",
        url: "https://fallback.example",
        iconApi: "",
    });

    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
        await act(async () => {
            iconProbe.current!.handleIconError();
        });
        await flush();
        const c = decodeURIComponent(iconProbe.current!.currentIcon);
        if (c) seen.add(c);
    }
    // 只认「站点自己的 favicon.ico」：内置图标服务地址里也有 favicon 字样，
    // 用宽松的 /favicon/ 会把主源误当成兜底源，变异就抓不住了
    assert.ok(
        [...seen].some(c => /fallback\.example\/favicon\.ico/.test(c)),
        `兜底源里要有站点自己的 favicon.ico，实际只见到：${[...seen].join(" | ")}`
    );
});

test("加载成功后 imageLoaded 置位", async () => {
    const s = await mountIcon({ icon: "https://ok.example/x.png", url: "https://ok.example", iconApi: "" });
    assert.equal(s.imageLoaded, false);
    await act(async () => {
        s.handleImageLoad();
    });
    assert.equal(iconProbe.current!.imageLoaded, true);
});

// ---- 缩略图 ----

const thumbProbe: { current: SiteThumbState | null } = { current: null };

function ThumbHarness(props: Parameters<typeof useSiteThumb>[0]) {
    thumbProbe.current = useSiteThumb(props);
    return null;
}

async function mountThumb(props: Parameters<typeof useSiteThumb>[0]) {
    mount(<ThumbHarness {...props} />);
    await flush();
    return thumbProbe.current!;
}

const THUMB_API = "https://shot.example/?url={url}";

test("没配缩略图模板时不启用 —— 默认不能去请求第三方服务", async () => {
    const s = await mountThumb({ thumbApi: "", siteUrl: "https://a.com", enabled: true });
    assert.equal(s.useThumb, false);
    assert.equal(s.thumbUrl, "");
});

test("配了模板才启用，且解析出真实地址", async () => {
    const s = await mountThumb({ thumbApi: THUMB_API, siteUrl: "https://a.com", enabled: true });
    assert.equal(s.useThumb, true);
    assert.ok(s.thumbUrl.includes("a.com"));
});

test("列表 / 墙式版式不显示缩略图", async () => {
    const s = await mountThumb({ thumbApi: THUMB_API, siteUrl: "https://a.com", enabled: false });
    assert.equal(s.useThumb, false);
});

test("隐私模式下不发请求：截图服务拿走的是完整链接", async () => {
    const s = await mountThumb({
        thumbApi: THUMB_API,
        siteUrl: "https://a.com",
        enabled: true,
        privacy: true,
    });
    assert.equal(s.useThumb, false);
});

test("加载成功之后 thumbLoaded 置位（骨架屏让位）", async () => {
    await mountThumb({ thumbApi: THUMB_API, siteUrl: "https://a.com", enabled: true });
    await act(async () => {
        thumbProbe.current!.onLoad();
    });
    assert.equal(thumbProbe.current!.thumbLoaded, true);
});

test("显式报错后立刻放弃缩略图", async () => {
    const s = await mountThumb({ thumbApi: THUMB_API, siteUrl: "https://a.com", enabled: true });
    await act(async () => {
        s.onError();
    });
    assert.equal(thumbProbe.current!.useThumb, false);
});

test("已经加载成功的缩略图不该被超时判定干掉", async (t) => {
    const timers = t.mock.timers;
    timers.enable({ apis: ["setTimeout"] });
    try {
        mount(<ThumbHarness thumbApi={THUMB_API} siteUrl='https://a.com' enabled />);
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            thumbProbe.current!.onLoad();
        });
        timers.tick(THUMB_TIMEOUT_MS + 1);
        await act(async () => {
            await Promise.resolve();
        });
        assert.equal(thumbProbe.current!.useThumb, true, "都加载出来了再超时也没意义");
    } finally {
        timers.reset();
    }
});

test("截图服务既不成功也不失败时，超时兜底让骨架屏不至于一直挂着", async (t) => {
    const timers = t.mock.timers;
    // 先接管定时器再挂载：倒过来的话 flush 里的 setTimeout 会被 mock 吃掉，
    // 永远等不到回调，用例直接挂死（不是失败，是卡住）
    timers.enable({ apis: ["setTimeout"] });
    try {
        mount(<ThumbHarness thumbApi={THUMB_API} siteUrl='https://a.com' enabled />);
        await act(async () => {
            await Promise.resolve();
        });
        assert.equal(thumbProbe.current!.useThumb, true, "刚挂上时还抱着希望");

        timers.tick(THUMB_TIMEOUT_MS + 1);
        await act(async () => {
            await Promise.resolve();
        });
        assert.equal(thumbProbe.current!.useThumb, false, "超时之后该回到只有图标的版式");
    } finally {
        timers.reset();
    }
});
