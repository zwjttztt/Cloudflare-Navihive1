// script/prod-smoke.mjs
// 对**线上实例**打一遍只读冒烟：只发 GET / HEAD，不写任何数据、不需要任何口令。
//
// 为什么要有它：CI 里那些端到端跑的全是本地 wrangler dev / 本地自托管，
// 证明的是「代码对」，证明不了「线上跑的是这份代码、而且没被环境改坏」。
// 环境那一层（反代、CDN、卷权限、CSP 头有没有被反代吃掉、SPA 回退是不是被
// 平台覆盖了）在 2026-10 一连串事故里反复出问题，而每次都是人肉 curl 才发现的。
//
// 只读是硬约束：线上可能是别人正在用的实例，冒烟脚本**不许**建站/删站/改配置。
// 需要登录的接口一概不打 —— 它们不该出现在「不需要凭据就能跑」的检查里。
//
// 用法：
//   node script/prod-smoke.mjs                     打 NAVIHIVE_PROD_URL 或内置的默认地址
//   node script/prod-smoke.mjs https://nav.example.com
//   node script/prod-smoke.mjs <url> --json        输出 JSON（给别的脚本用）
//   node script/prod-smoke.mjs <url> --tolerate-down  实例不可达时也算通过（CI 定时任务用）
//   环境变量：NAVIHIVE_PROD_URL（同上）、NAVIHIVE_PROD_MIN_VERSION（要求构建号不低于它）
//
// 退出码：0 通过 / 1 有断言失败 / 2 用法或配置问题

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const JSON_ONLY = process.argv.includes("--json");
const TOLERATE_DOWN = process.argv.includes("--tolerate-down");

const url = (args[0] || process.env.NAVIHIVE_PROD_URL || "").replace(/\/+$/, "");
if (!url) {
    console.error("用法：node script/prod-smoke.mjs <线上地址>（或设 NAVIHIVE_PROD_URL）");
    process.exit(2);
}
let base;
try {
    base = new URL(url);
} catch {
    console.error(`地址不合法：${url}`);
    process.exit(2);
}
if (base.protocol !== "https:" && base.protocol !== "http:") {
    console.error(`只支持 http/https：${url}`);
    process.exit(2);
}

const TIMEOUT_MS = 15_000;
const UA = "navihive-prod-smoke/1.0 (read-only)";

/** 随机串：探针路径不能与真实路由撞上，也不能被 CDN 缓存成 200 */
const RANDOM = Math.random().toString(36).slice(2, 10);

async function get(pathname, { method = "GET", headers } = {}) {
    const started = Date.now();
    let res;
    try {
        res = await fetch(new URL(pathname, base).href, {
            method,
            redirect: "manual",
            headers: { "User-Agent": UA, ...headers },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
    }
    const text = method === "HEAD" ? "" : await res.text().catch(() => "");
    return {
        ok: true,
        status: res.status,
        ms: Date.now() - started,
        headers: res.headers,
        text,
        json: (() => {
            try {
                return JSON.parse(text);
            } catch {
                return null;
            }
        })(),
    };
}

const results = [];
function check(name, pass, detail = "") {
    results.push({ name, pass, detail });
    if (!JSON_ONLY) {
        console.log(`  ${pass ? "✔" : "✖"} ${name}${detail ? ` —— ${detail}` : ""}`);
    }
}

// ============ 0. 连通性 ============

if (!JSON_ONLY) console.log(`线上只读冒烟：${base.href}\n`);

let probe;
try {
    probe = await get("/api/init");
} catch {
    probe = { ok: false, error: "throw" };
}
if (!probe.ok) {
    const msg = `连不上（${probe.error}）`;
    if (JSON_ONLY) {
        console.log(JSON.stringify({ url: base.href, reachable: false, error: probe.error, results: [] }, null, 2));
    } else {
        console.error(`✖ ${msg}`);
    }
    // 「线上挂了」和「冒烟脚本写错了」是两件事：定时任务不该因为机房断网就把仓库染红，
    // 但手动跑的时候必须看得见 —— 所以降级开关是显式的 --tolerate-down，不是默认行为。
    process.exit(TOLERATE_DOWN ? 0 : 1);
}

// ============ 1. 首页 ============

const home = await get("/");
check("首页 GET / 返回 200", home.status === 200, `status=${home.status} · ${home.ms}ms`);
check(
    "首页吐的是真 HTML（含挂载点，不是反代的错误页）",
    home.text.includes('id="root"') && home.text.includes("<script"),
    `长度 ${home.text.length}`
);
// ⚠️ 构建号**不在 HTML 里**（__NAVIHIVE_BUILD_VERSION__ 是编译期烘进 JS 产物里的），
// 服务端那一份只有 /precache-manifest.json 的 version —— 前端的「版本漂移自查」用的
// 也正是它（见 utils/buildVersion.fetchServerVersion）。所以这里照同一条路子取。
const manifest = await get("/precache-manifest.json");
const version =
    manifest.json && typeof manifest.json.version !== "undefined"
        ? String(manifest.json.version)
        : null;
check("清单 /precache-manifest.json 可取且带 version", Boolean(version), version ? `version=${version}` : `status=${manifest.status}`);

// 发版后白屏的真实成因：浏览器拿着旧 HTML 去要一个已被新版删掉的 chunk，
// 或者 HTML 刷新了但资产还没同步。抽首页引用的第一个脚本打一下，两头对不上就在这里红。
const firstScript = /<script[^>]+src="([^"]+\.js)"/.exec(home.text)?.[1] ?? null;
if (firstScript) {
    const asset = await get(firstScript);
    const assetType = asset.headers?.get("content-type") ?? "";
    check(
        `首页引用的首屏脚本可取且是 JS（${firstScript}）`,
        asset.status === 200 && assetType.includes("javascript"),
        `status=${asset.status} · ${assetType || "无 Content-Type"}`
    );
} else {
    check("首页能解析出首屏脚本引用", false, "HTML 里没找到 <script src=...js>");
}

// ============ 2. 安全响应头（最容易被反代吃掉的一层）============

const h = (key) => home.headers?.get(key) ?? null;
check("CSP 在（反代最容易整条吃掉它）", Boolean(h("content-security-policy")), h("content-security-policy")?.slice(0, 60) ?? "缺失");
check("X-Content-Type-Options: nosniff", h("x-content-type-options") === "nosniff", h("x-content-type-options") ?? "缺失");
check("Referrer-Policy 在", Boolean(h("referrer-policy")), h("referrer-policy") ?? "缺失");
check("X-Frame-Options 在", Boolean(h("x-frame-options")), h("x-frame-options") ?? "缺失");

// ============ 3. 静态资产 ============

const favicon = await get("/favicon.ico");
check("静态资产 /favicon.ico 可取（200 或 304）", [200, 304].includes(favicon.status), `status=${favicon.status}`);
// ⚠️ 这条是 2026-10 白屏事故的根因守卫：缺失的带扩展名路径如果被 SPA 回退成整页 HTML，
// 浏览器会按 MIME 拒绝执行 module script。MIME 必须对得上。
const missingAsset = await get(`/assets/probe-missing-${RANDOM}.js`);
const assetType = missingAsset.headers?.get("content-type") ?? "";
check(
    "缺失的静态资源 404 且**不是** HTML（拿整页 HTML 顶替脚本 = 白屏）",
    missingAsset.status === 404 && !assetType.includes("text/html"),
    `status=${missingAsset.status} · ${assetType || "无 Content-Type"}`
);

// ============ 4. SPA 回退（P2-8 的线上验收）============

const bogusToken = "0".repeat(64);
const sharePath = await get(`/s/${bogusToken}`);
check(
    "分享路由 /s/<64位hex> 回整页 HTML（前端自己渲染 not-found）",
    sharePath.status === 200 && sharePath.text.includes('id="root"'),
    `status=${sharePath.status}`
);
const unknown = await get(`/probe-unknown-${RANDOM}`);
check(
    "未知无扩展名路径 404（不被 SPA 兜成 200）",
    unknown.status === 404,
    `status=${unknown.status}`
);

// ============ 5. 公开 API ============

check(
    "/api/init 返回 200 且是 JSON",
    probe.status === 200 && probe.json !== null,
    `status=${probe.status}`
);
// init 的语义是「这个实例有没有初始化过」——两种都合法，但必须是其中之一，
// 返回别的东西说明后端被改坏了（曾经出现过 500 却被反代缓存成 200 空白页）。
const initOk =
    probe.json !== null &&
    typeof probe.json === "object" &&
    ("initialized" in probe.json || "needsSetup" in probe.json || "status" in probe.json);
check("/api/init 的响应体形状对得上", initOk, JSON.stringify(probe.json).slice(0, 80));

// 未登录访问受保护 API 会被鉴权中间件挡成 401，路径不存在则 404 —— 两者都对，
// 唯一不对的是「200 + 空页」（曾经出现过：反代把 500 缓存成 200 空白页，
// 于是所有健康检查都是绿的，用户那边是白屏）。
const badApi = await get(`/api/probe-does-not-exist-${RANDOM}`);
check(
    "不存在的 API 路径不是 200（401 未登录 / 404 都对）",
    badApi.status === 401 || badApi.status === 404,
    `status=${badApi.status}`
);

// ============ 6. HEAD ============

const head = await get("/", { method: "HEAD" });
check("HEAD / 返回 200 且无正文", head.status === 200 && head.text === "", `status=${head.status}`);

// ============ 7. 版本新鲜度（可选）============

const minVersion = process.env.NAVIHIVE_PROD_MIN_VERSION;
// 老格式清单的 version 是 Date.now()（纯数字），跟语义版本没法比 —— 那种情况只报告不比。
if (minVersion && version && /^v?\d+\.\d+\.\d+/.test(version)) {
    const cmp = (a, b) => {
        const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
        for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
        return 0;
    };
    check(
        `线上构建号不低于 ${minVersion}（推了没生效就在这里暴露）`,
        cmp(version, minVersion.replace(/^v/, "")) >= 0,
        `线上 v${version}`
    );
}

// ============ 汇总 ============

const failed = results.filter(r => !r.pass);
if (JSON_ONLY) {
    console.log(
        JSON.stringify(
            { url: base.href, reachable: true, version, passed: results.length - failed.length, failed: failed.length, results },
            null,
            2
        )
    );
} else {
    console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
    if (version) console.log(`线上构建号：v${version}`);
    if (failed.length) {
        console.error("\n失败项：");
        for (const f of failed) console.error(`  ✖ ${f.name}${f.detail ? ` —— ${f.detail}` : ""}`);
    }
}
process.exit(failed.length ? 1 : 0);
