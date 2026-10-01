// script/sync-brand.mjs
// 把 src/brand.ts 里的公开品牌信息同步到 index.html 与 public/manifest.webmanifest。
//
// 为什么要有这一步：manifest 是静态文件、index.html 也是静态的，而登录页读的是
// TS 常量。三处各写一份，改名字的人只记得改一处，另外两处就漂了 ——
// 装到桌面后图标下面还是旧名字，登录页又是另一个名字。
//
// 用法：
//   node script/sync-brand.mjs          写回两个文件（缺啥补啥）
//   node script/sync-brand.mjs --check  只检查，不一致就退出码 1（CI 用）
//
// 这里刻意不 import src/brand.ts：那是 TS，node 直接跑不了；也懒得为它单独开一次
// esbuild（仓库里的单测才需要）。改成读常量 —— 值都是简单字符串，够稳。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const checkOnly = process.argv.includes("--check");

function readBrand() {
    const src = readFileSync(resolve(root, "src/brand.ts"), "utf8");
    const pick = key => {
        const m = new RegExp(`${key}:\\s*"([^"]+)"`).exec(src);
        if (!m) throw new Error(`src/brand.ts 里读不到 ${key}`);
        return m[1];
    };
    return {
        name: pick("name"),
        fullName: pick("fullName"),
        description: pick("description"),
        themeColor: pick("themeColor"),
    };
}

const brand = readBrand();

// ---- manifest ----
const manifestPath = resolve(root, "public/manifest.webmanifest");
const currentManifest = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(currentManifest);
manifest.name = brand.fullName;
manifest.short_name = brand.name;
manifest.description = brand.description;
manifest.theme_color = brand.themeColor;
manifest.lang = manifest.lang || "zh-CN";
const nextManifest = JSON.stringify(manifest, null, 4) + "\n";

// ---- index.html ----
const htmlPath = resolve(root, "index.html");
let html = readFileSync(htmlPath, "utf8");
const setMeta = (attr, key, value) => {
    const re = new RegExp(`(<meta[^>]*${attr}="${key}"[^>]*content=")[^"]*(")`);
    if (!re.test(html)) throw new Error(`index.html 里找不到 ${attr}="${key}"`);
    html = html.replace(re, `$1${value}$2`);
};
const setTag = (tag, value) => {
    const re = new RegExp(`(<${tag}>)[^<]*(</${tag}>)`);
    if (!re.test(html)) throw new Error(`index.html 里找不到 <${tag}>`);
    html = html.replace(re, `$1${value}$2`);
};

setMeta("name", "theme-color", brand.themeColor);
setMeta("name", "apple-mobile-web-app-title", brand.name);
setMeta("property", "og:site_name", brand.name);
setMeta("property", "og:title", brand.fullName);
setMeta("property", "og:description", brand.description);
setMeta("name", "twitter:title", brand.fullName);
setMeta("name", "twitter:description", brand.description);
setMeta("name", "description", brand.description);
setTag("title", brand.fullName);

if (checkOnly) {
    let bad = false;
    if (currentManifest !== nextManifest) {
        console.error("✗ public/manifest.webmanifest 与 src/brand.ts 不一致（跑 npm run sync:brand）");
        bad = true;
    }
    if (html !== readFileSync(htmlPath, "utf8")) {
        console.error("✗ index.html 与 src/brand.ts 不一致（跑 npm run sync:brand）");
        bad = true;
    }
    if (bad) process.exit(1);
    console.log("✓ 品牌信息三处一致");
    process.exit(0);
}

if (currentManifest !== nextManifest) {
    writeFileSync(manifestPath, nextManifest);
    console.log("· 已更新 public/manifest.webmanifest");
}
writeFileSync(htmlPath, html);
console.log("· 已更新 index.html");
console.log("✓ 品牌信息已从 src/brand.ts 同步到 manifest 与 index.html");
