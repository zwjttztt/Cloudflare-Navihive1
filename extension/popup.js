// extension/popup.js
// 「一键收藏」弹窗的逻辑。零依赖、无构建，改完刷新扩展即可生效。
//
// 工作方式：**不直接调 API**，而是拼一条深链在新标签页打开：
//   https://<你的站点>/?add-site=<base64url 的 {url,name,icon}>
// 页面认出这个参数就自动打开「新增站点」弹窗并填好字段。
//
// 为什么不直接 POST 写接口：写接口要带登录态（httpOnly cookie + CSRF 校验），
// 扩展想复用它就得申请 cookies 权限、还要自己处理跨域与令牌过期 —— 等于把鉴权面
// 扩大一圈，还会在「没登录」时给出一句没头没尾的 401。深链把意图交给已登录的页面，
// 扩展这一侧不持有任何凭据，没登录时也就是正常跳到登录页，行为可预期。
//
// 与站点侧的实现同源：src/utils/addSiteDeepLink.ts（参数名 add-site、base64url 编码）。

/** 参数名与站点侧保持一致；改名必须两边同时改 */
const ADD_SITE_PARAM = "add-site";
const SITE_KEY = "navihive.siteUrl";

const $ = id => document.getElementById(id);
const setTip = (text, isError = false) => {
    const tip = $("tip");
    tip.textContent = text;
    tip.classList.toggle("err", isError);
};

/** 与站点侧 encodeAddSitePrefill 同一套：UTF-8 → base64 → base64url */
function encodePayload(prefill) {
    const bytes = new TextEncoder().encode(JSON.stringify(prefill));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 站点地址补全成可用的 https 前缀，并去掉结尾斜杠。
 *
 * ⚠️ 判据必须与主站 src/utils/url.ts 的 normalizeUrl **逐条对齐**：
 * 这里存的「站点地址」会被拼成深链打开，两边归一化结果不一致时，
 * 用户会得到「https://file///etc/passwd」这种既打不开、又看不出错在哪的地址。
 * 差异由 tests/extensionDeepLink.test.ts 逐个用例钉住（含危险协议）。
 */
function normalizeSite(input) {
    const raw = (input || "").trim();
    if (!raw) return "";
    // 显式写了别的协议（file: / javascript: / data: …）直接拒绝，
    // 不要硬补 https:// —— 补出来的是个假地址，比空值更难排查
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    if (scheme && !/^https?:$/i.test(`${scheme[1]}:`)) return "";
    // 没写协议就补 https，先抹掉开头多余的斜杠（//example.com 是协议相对地址）
    const withScheme = scheme ? raw : `https://${raw.replace(/^\/+/, "")}`;
    try {
        const url = new URL(withScheme);
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        if (!url.hostname) return "";
        // 默认端口去掉：http://a.com:80 与 http://a.com 是同一个地址
        if (
            (url.protocol === "http:" && url.port === "80") ||
            (url.protocol === "https:" && url.port === "443")
        ) {
            url.port = "";
        }
        if (url.pathname === "/" && !url.search && !url.hash) return `${url.protocol}//${url.host}`;
        return url.href.replace(/\/+$/, "");
    } catch {
        return "";
    }
}

async function currentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
}

/** 第一次用时让用户填站点地址；之后记住 */
async function loadSite() {
    const saved = await chrome.storage.local.get(SITE_KEY);
    return saved?.[SITE_KEY] ?? "";
}

async function fillForm() {
    const site = await loadSite();
    $("site").value = site;
    const tab = await currentTab();
    if (!tab) {
        setTip("读不到当前标签页（可能在扩展商店等受限页面上）", true);
        return;
    }
    // 扩展自己的页面 / 空白页没有可收藏的地址：让用户手填，别把 chrome:// 存进去
    const usable = /^https?:/i.test(tab.url ?? "");
    $("name").value = tab.title ?? "";
    $("url").value = usable ? tab.url : "";
    $("icon").value = usable && tab.favIconUrl ? tab.favIconUrl : "";
    if (!usable) setTip("当前页面不是普通网页，请手动填写链接");
}

async function save() {
    const site = normalizeSite($("site").value);
    const url = ($("url").value || "").trim();
    if (!site) {
        setTip("先填你的导航站地址（例如 https://home.example.com）", true);
        $("site").focus();
        return;
    }
    if (!/^https?:\/\//i.test(url)) {
        setTip("链接要以 http:// 或 https:// 开头", true);
        $("url").focus();
        return;
    }
    await chrome.storage.local.set({ [SITE_KEY]: site });

    const prefill = { url };
    const name = ($("name").value || "").trim();
    const icon = ($("icon").value || "").trim();
    if (name) prefill.name = name;
    if (icon) prefill.icon = icon;

    const target = `${site}/?${ADD_SITE_PARAM}=${encodePayload(prefill)}`;
    await chrome.tabs.create({ url: target });
    setTip("已打开你的导航站，确认分组后保存即可");
    // 弹窗自己关掉，省得用户再点一次外面
    setTimeout(() => window.close(), 600);
}

document.addEventListener("DOMContentLoaded", () => {
    $("save").addEventListener("click", () => {
        save().catch(error => setTip(String(error?.message ?? error), true));
    });
    fillForm().catch(error => setTip(String(error?.message ?? error), true));
});
