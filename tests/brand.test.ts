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

test("brandTitle：改过标题就用改过的，空值回落到品牌全名", () => {
    assert.equal(brandTitle("老张的书签"), "老张的书签");
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
