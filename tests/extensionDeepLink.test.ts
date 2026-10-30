// tests/extensionDeepLink.test.ts
// 浏览器扩展 ↔ 主站深链契约的双向测试 + 字符集静态守卫（F-2）。
//
// 为什么这个契约必须被测试钉住：
//   扩展（extension/popup.js）不在 tsconfig 的 include 里、不在 lint 范围、不在 CI ——
//   它和主站之间唯一的耦合就是「?add-site=<base64url 的 JSON>」这一个字符串格式。
//   两侧各写一遍编解码，一改就漂移，而漂移的表现是**点扩展没反应**（页面认不出参数，
//   静默什么都不做）。用户不会为此报 bug，因为看起来就像「这个按钮本来就没用」。
//
// 为什么用 vm 而不是把 popup.js 改成 ESM：
//   它是零构建的普通脚本（`document.addEventListener("DOMContentLoaded", …)`），
//   改成 ESM 就得给它加构建步骤 —— 那会让「改完刷新扩展即可生效」这个特性消失。
//   vm 里跑一份并注入桩，等价于在扩展环境里调它，且不需要任何新依赖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

import { ADD_SITE_PARAM, buildAddSiteLink, encodeAddSitePrefill, readAddSitePrefill } from "../src/utils/addSiteDeepLink";
import { normalizeUrl } from "../src/utils/url";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function projectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

/** 剥掉块注释与整行行注释（注释里写着「正确写法」时不能算数） */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

/** popup.js 导出的两个纯函数（在 vm 里跑一遍再取出来） */
interface PopupApi {
    encodePayload: (prefill: { url: string; name?: string; icon?: string }) => string;
    normalizeSite: (input: string | undefined) => string;
}

/**
 * 在 vm 里加载 extension/popup.js 并按需取出顶层函数。
 *
 * 桩只补它真的会碰到的全局：`document`（末尾注册 DOMContentLoaded）、`chrome`、
 * base64 与 UTF-8 的编解码、`URL`。**故意不补更多** —— 哪天 popup.js 引入了新全局，
 * 这里会直接 ReferenceError，那就是「测试该跟着补桩」的信号，而不是悄悄跳过。
 */
function loadPopup(): PopupApi {
    const src = readFileSync(resolve(projectDir(), "extension/popup.js"), "utf8");
    const noop = () => undefined;
    const sandbox: Record<string, unknown> = {
        document: { addEventListener: noop, getElementById: () => null },
        chrome: {},
        btoa,
        atob,
        TextEncoder,
        TextDecoder,
        URL,
        console,
        setTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: "extension/popup.js" });
    const encodePayload = sandbox.encodePayload;
    const normalizeSite = sandbox.normalizeSite;
    assert.equal(typeof encodePayload, "function", "popup.js 里没有 encodePayload（改名了？）");
    assert.equal(typeof normalizeSite, "function", "popup.js 里没有 normalizeSite（改名了？）");
    return { encodePayload: encodePayload as PopupApi["encodePayload"], normalizeSite: normalizeSite as PopupApi["normalizeSite"] };
}

test("扩展编码的载荷，主站 readAddSitePrefill 能原样还原（含中文与 & ? # 这类危险字符）", () => {
    const { encodePayload } = loadPopup();
    const prefill = {
        url: "https://example.com/a?b=1&c=2#frag",
        name: "中文标题 & 半个问号 ?",
        icon: "https://example.com/favicon.ico",
    };
    const encoded = encodePayload(prefill);
    // 只含 base64url 字符集：这是「塞进任何位置都安全」的前提
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, `编码结果含非法字符：${encoded}`);

    const restored = readAddSitePrefill(`?${ADD_SITE_PARAM}=${encoded}`);
    assert.ok(restored, "主站解不出扩展编的载荷 —— 这就是「点扩展没反应」");
    // decodeAddSitePrefill 的返回形状固定带四个键（没传的字段是 undefined），
    // 所以期望值也要显式写出来：少写会让断言在「键不存在」与「值是 undefined」之间失真。
    assert.deepEqual(restored, { ...prefill, description: undefined }, "深链往返后字段必须一字不差");
});

test("主站 buildAddSiteLink 拼出来的链接，参数名与扩展一致（改名就必须两边一起改）", () => {
    const { encodePayload } = loadPopup();
    const link = buildAddSiteLink("https://nav.example.com/", { url: "https://a.test", name: "A" });
    assert.ok(link.includes(`${ADD_SITE_PARAM}=`), `链接里没有 ${ADD_SITE_PARAM} 参数：${link}`);
    // 两侧对同一个对象应该算出**完全相同**的载荷：否则「扩展写的」与「站内分享的」互不通用
    assert.equal(
        new URL(link).searchParams.get(ADD_SITE_PARAM),
        encodePayload({ url: "https://a.test", name: "A" }),
        "扩展与主站对同一对象的编码结果必须一致"
    );
    // 反方向也要通：主站编码的载荷主站能解开（守 decode/encode 自身一致）
    assert.deepEqual(readAddSitePrefill(new URL(link).search), {
        url: "https://a.test",
        name: "A",
        icon: undefined,
        description: undefined,
    });
});

test("扩展的 normalizeSite 与主站 normalizeUrl 归一化到同一个地址", () => {
    const { normalizeSite } = loadPopup();
    // 只比「站点根地址」这一档：扩展拿到结果后要拼 `<site>/?add-site=…`，
    // 所以它会**去掉结尾斜杠**（否则拼出 `//?add-site=`）；主站保留路径尾斜杠。
    // 这个差异是刻意的，且只影响带子路径的输入 —— 站点根地址必须一致。
    const cases = [
        " example.com/ ",
        "https://example.com/",
        "http://example.com",
        "EXAMPLE.com",
        "http://example.com:80/",
        "https://example.com:443",
        "//example.com",
    ];
    for (const input of cases) {
        const fromExtension = normalizeSite(input);
        const fromSite = normalizeUrl(input);
        assert.equal(fromSite.ok, true, `${input} 在主站侧应当合法`);
        assert.equal(
            fromExtension,
            fromSite.url,
            `同一个输入两侧归一化结果不同：扩展给 ${fromExtension}，主站给 ${fromSite.url}`
        );
    }
});

test("扩展的 normalizeSite 与主站一样拒绝危险协议（不能一边放行一边拦）", () => {
    const { normalizeSite } = loadPopup();
    for (const input of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd"]) {
        assert.equal(normalizeSite(input), "", `扩展侧必须拒绝 ${input}`);
        assert.equal(normalizeUrl(input).ok, false, `主站侧必须拒绝 ${input}`);
    }
});

test("两侧的 base64url 替换字符集必须一致（漂移了就是「点扩展没反应」）", () => {
    const root = projectDir();
    const popup = stripComments(readFileSync(resolve(root, "extension/popup.js"), "utf8"));
    const site = stripComments(readFileSync(resolve(root, "src/utils/addSiteDeepLink.ts"), "utf8"));

    // 编码侧：+ → -、/ → _、去掉尾部 =
    for (const src of [popup, site]) {
        assert.ok(src.includes('.replace(/\\+/g, "-")'), "编码侧必须把 + 换成 -");
        assert.ok(src.includes('.replace(/\\//g, "_")'), "编码侧必须把 / 换成 _");
        assert.ok(src.includes('.replace(/=+$/, "")'), "编码侧必须去掉尾部填充 =");
    }
    // 解码侧（只有主站有）：- → +、_ → /
    assert.ok(site.includes('.replace(/-/g, "+")'), "解码侧必须把 - 换回 +");
    assert.ok(site.includes('.replace(/_/g, "/")'), "解码侧必须把 _ 换回 /");

    // 参数名同样只能有一份真话
    assert.ok(popup.includes(`"${ADD_SITE_PARAM}"`), `popup.js 里的参数名与 ADD_SITE_PARAM 不一致`);
});

test("扩展被明确标注为实验性（manifest 的 description 前缀 + README 首段）", () => {
    const root = projectDir();
    const manifest = JSON.parse(readFileSync(resolve(root, "extension/manifest.json"), "utf8")) as {
        description?: string;
    };
    assert.match(
        String(manifest.description ?? ""),
        /^\[实验性\] /,
        "manifest.json 的 description 必须以「[实验性] 」开头 —— 装扩展的人第一眼就该看见"
    );
    const readme = readFileSync(resolve(root, "extension/README.md"), "utf8");
    assert.ok(readme.includes("实验性功能"), "extension/README.md 首段必须标注实验性");
    assert.ok(
        readme.indexOf("实验性功能") < 400,
        "实验性标注必须在首段（藏到文末等于没写）"
    );
});

test("反向验证：stripComments 真的会剥掉注释（否则「注释里写的正确写法」会蒙混过关）", () => {
    const broken = stripComments(`
        // .replace(/\\+/g, "-")
        // .replace(/\\//g, "_")
    `);
    assert.equal(broken.includes('.replace(/\\+/g, "-")'), false, "剥注释后不该再匹配到编码规则");
});

// 让 `encodeAddSitePrefill` 有使用点：它和扩展的 encodePayload 必须同为 base64url，
// 否则「站内分享出来的链接」与「扩展拼的链接」互不通用（上面第三条已经逐个字符比过）。
test("主站 encodeAddSitePrefill 与扩展 encodePayload 对同一输入逐字符相同", () => {
    const { encodePayload } = loadPopup();
    const prefill = { url: "https://x.test", name: "同名", icon: "" };
    assert.equal(encodeAddSitePrefill(prefill), encodePayload(prefill));
});
