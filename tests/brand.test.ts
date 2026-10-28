// tests/brand.test.ts
// 品牌信息只准有一个来源（src/brand.ts）。登录页读常量、manifest 是静态文件、
// index.html 里还有一份 <title>，改名字的人往往只改一处 —— 这里把三处钉在一起，
// 漂了就红。真正的写回动作在 npm run sync:brand（script/sync-brand.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BRAND, brandTitle } from "../src/brand";

const here = dirname(fileURLToPath(import.meta.url));
// 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身
function readProjectFile(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

/** 二进制版：favicon.ico 要按字节读（ICO 头 + PNG 负载） */
function readProjectFileBytes(rel: string): Buffer {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel));
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

const html = readProjectFile("index.html");
const manifest = JSON.parse(readProjectFile("public/manifest.webmanifest"));

test("manifest 与 src/brand.ts 同源", () => {
    assert.equal(manifest.name, BRAND.fullName, "manifest.name 应等于品牌全名");
    assert.equal(manifest.short_name, BRAND.name, "manifest.short_name 应等于品牌短名");
    assert.equal(manifest.description, BRAND.description);
    assert.equal(manifest.theme_color, BRAND.themeColor);
});

test("index.html 的标题与分享卡片也来自同一份品牌信息", () => {
    assert.ok(
        html.includes(`<title>${BRAND.fullName}</title>`),
        "index.html 的 <title> 应与品牌全名一致"
    );
    assert.ok(
        html.includes(`content="${BRAND.themeColor}"`) &&
            html.includes('name="theme-color"'),
        "theme-color 应来自品牌配置"
    );
    assert.ok(
        html.includes(`content="${BRAND.name}"`) &&
            html.includes('name="apple-mobile-web-app-title"'),
        "apple-mobile-web-app-title 应等于品牌短名"
    );
    assert.ok(
        html.includes(`content="${BRAND.fullName}"`) &&
            html.includes('property="og:title"'),
        "og:title 应等于品牌全名"
    );
});

// 2026-10-28：换 logo 后用户看到的还是旧图 —— 因为 index.html 里图标链接的
// URL 没变，浏览器的 favicon 缓存（键是 URL，不看 Cache-Control）就一直喂旧图。
// 这条守卫把「链接必须带版本占位符」「构建期必须真替换」两件事钉在一起：
// 只加占位符不注册插件 = 线上出现一个字面量 `__ICON_V__` 的死链。
test("图标链接带版本占位符，且构建期真的会被替换（否则换 logo 用户看不到）", () => {
    for (const href of ["/favicon.svg", "/favicon.ico", "/icons/apple-touch-icon.png"]) {
        assert.ok(
            html.includes(`href="${href}?v=__ICON_V__"`),
            `${href} 的链接必须带 ?v=__ICON_V__：不加版本号，浏览器会一直用缓存里的旧图标`
        );
    }

    const viteConfig = readProjectFile("vite.config.ts");
    assert.ok(
        viteConfig.includes("__ICON_V__"),
        "vite.config.ts 里要有一个把 __ICON_V__ 换成版本号的 transformIndexHtml 插件"
    );
    assert.ok(
        /plugins:\s*\[[^\]]*versionedIcons\(\)/.test(viteConfig),
        "versionedIcons() 必须注册进 plugins 数组（写了函数不注册等于没写）"
    );

    // .ico 是 SVG 不支持时的兜底，最容易被换 logo 时漏掉（2026-10-28 就漏过一次：
    // 文件还停在 2026-09-26 的旧图）。这里只钉「它至少是个多尺寸真 ICO」，
    // 图形内容交给设计侧肉眼确认；换图时跑 npm run icons:ico（script/gen-favicon-ico.mjs）。
    const ico = readProjectFileBytes("public/favicon.ico");
    assert.equal(ico.readUInt16LE(2), 1, "favicon.ico 头里 type 必须是 1（icon）");
    assert.ok(ico.readUInt16LE(4) >= 4, "favicon.ico 里至少要有 4 个尺寸档");
    assert.equal(
        ico.subarray(ico.readUInt32LE(6 + 12), ico.readUInt32LE(6 + 12) + 8).toString("hex"),
        "89504e470d0a1a0a",
        "favicon.ico 的负载必须是 PNG（换图时用 script 里的 sharp 流程重建过）"
    );
});

test("brandTitle：改过标题就用改过的，空值回落到品牌全名", () => {    assert.equal(brandTitle("老张的书签"), "老张的书签");
    assert.equal(brandTitle("  "), BRAND.fullName, "全空白也要回落");
    assert.equal(brandTitle(""), BRAND.fullName);
    assert.equal(brandTitle(null), BRAND.fullName);
    assert.equal(brandTitle(undefined), BRAND.fullName);
    assert.equal(brandTitle("  导航  "), "导航", "两端空白要去掉");
});

test("品牌配置里不含任何私密内容", () => {
    // 这个文件会打进前端 bundle，等于公开。别在这里放域名、账号、密钥。
    const dump = JSON.stringify(BRAND);
    for (const bad of ["http", "token", "secret", "password", "key", "@"]) {
        assert.ok(
            !dump.toLowerCase().includes(bad),
            `品牌配置里出现了疑似私密内容：${bad}`
        );
    }
});
