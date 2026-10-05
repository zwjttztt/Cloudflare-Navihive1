// Worker 响应安全头的守卫（2026-10-05 复查 B3）。
//
// 背景：安全头分散在两处 —— 静态资源在 `public/_headers` 的 `/*` 块，
// Worker 响应在 `worker/util.ts` 的 `securityHeaders()`。`/api/bootstrap`
// 这种返回全部站点数据的接口，走的是后者。两边各写一遍，**很容易漂移**。
//
// 但「统一」不等于「长得一样」。有三处是**故意不一样**的，理由都写在
// securityHeaders 的注释里：CSP / COOP / Permissions-Policy 这类都是
// 文档级指令，JSON 与图片响应加了不起作用；更关键的是图标代理要传自己的
// `default-src 'none'; sandbox`（见 worker/icon.ts），默认塞一条 CSP 把它盖掉，
// 那道沙箱就没了 —— 而白名单被绕过时它是最后一道防线。
//
// 所以这个用例钉的是「**该有的必须有，不该有的不许有**」，而不是「两边一样」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { securityHeaders } from "../worker/util";

const here = dirname(fileURLToPath(import.meta.url));

function findProjectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

/** 静态资源那边（`public/_headers` 的 `/*` 块）声明了哪些头 */
function staticHeaders(): Map<string, string> {
    const text = readFileSync(join(findProjectDir(), "public", "_headers"), "utf-8");
    const out = new Map<string, string>();
    let inBlock = false;
    // 两个坑都在这行注释里了，别改回去：
    //   1) 逐行扫，别用 indexOf 找块尾 —— 注释里就有 `/api/*`、`/assets/*` 这些路径，
    //      按子串找边界会切出一段不含任何头的碎片。
    //   2) 必须按 CRLF 切。这个仓库在 Windows 上开发，`_headers` 是 CRLF 行尾，
    //      而 JS 的 `.` **不匹配 `\r`** —— 用 `(.+)$` 去取值会永远返回 null，
    //      表现为「一个头都解析不到」，很容易被误判成文件格式坏了。
    for (const line of text.split(/\r?\n/)) {
        if (!inBlock) {
            if (line.trim() === "/*") inBlock = true;
            continue;
        }
        if (/^\/\S/.test(line)) break; // 遇到下一个路径块（/api/*、/assets/* …）
        const m = /^ {2}([A-Za-z-]+):\s*(.+)$/.exec(line);
        if (m) out.set(m[1].toLowerCase(), m[2].trim());
    }
    return out;
}

const headers = securityHeaders();
const get = (name: string) => headers.get(name);

test("Worker 响应必须带齐这几条安全头", () => {
    // 少任何一条都有实际后果，注释里逐条写了理由
    assert.equal(get("X-Content-Type-Options"), "nosniff", "少它浏览器会按内容猜 MIME");
    assert.equal(get("X-Frame-Options"), "DENY", "少它可以被嵌进 iframe（点击劫持）");
    assert.ok(
        (get("Strict-Transport-Security") || "").includes("max-age="),
        "HSTS 只在 HTTPS 响应里下发才有效，直接打到 /api 的客户端拿不到"
    );
    assert.equal(
        get("Cross-Origin-Resource-Policy"),
        "same-origin",
        "挡的是「别的源把这份响应当资源读走」"
    );
    assert.ok(get("Referrer-Policy"), "必须有 Referrer-Policy");
});

test("API 响应刻意不加 CSP / COOP / Permissions-Policy（加了会打断 icon 沙箱）", () => {
    // 这三条是**故意不统一**的，不是漏了：
    //   - 它们只对会被当成文档渲染的响应有意义，JSON / 图片响应加了没用；
    //   - 图标代理（worker/icon.ts）要传自己的 `default-src 'none'; sandbox`，
    //     如果这里给个默认 CSP，按 extra 之前 set 的写法会把那道沙箱盖掉。
    //     白名单哪天被绕过时，沙箱是最后一道防线。
    assert.equal(get("Content-Security-Policy"), null, "别给 API 响应塞默认 CSP —— 会盖掉 icon 的沙箱");
    assert.equal(get("Cross-Origin-Opener-Policy"), null, "COOP 是文档级指令，对 JSON 无意义");
    assert.equal(get("Permissions-Policy"), null, "Permissions-Policy 是文档级指令");
    assert.equal(
        get("X-Permitted-Cross-Domain-Policies"),
        null,
        "Flash/PDF 的跨域加载开关，早没人用了，不必装样子"
    );
});

test("图标代理的沙箱 CSP 必须真的生效（extra 里的头不能被默认值盖掉）", () => {
    // 直接照 icon.ts 的用法调一次：这是「刻意不加默认 CSP」的前提条件。
    // 一旦有人给 securityHeaders 加了默认 CSP，这条会立刻红。
    const sandbox = securityHeaders({
        "Content-Type": "image/png",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    assert.equal(
        sandbox.get("Content-Security-Policy"),
        "default-src 'none'; sandbox",
        "图标代理的沙箱被覆盖了 —— 白名单被绕过时脚本会执行"
    );
    assert.equal(sandbox.get("Content-Type"), "image/png", "extra 的其它头也要保住");
});

test("两处共有的头，取值不该悄悄漂移（Referrer-Policy 除外，它故意不同）", () => {
    const statics = staticHeaders();
    assert.ok(statics.size >= 8, `静态资源那块只解析到 ${statics.size} 个头，口径坏了`);

    // 这几条两边都有、值必须一致。少一条说明有一头被改名或删掉了。
    for (const name of [
        "x-content-type-options",
        "x-frame-options",
        "strict-transport-security",
        "cross-origin-resource-policy",
    ]) {
        assert.ok(statics.has(name), `public/_headers 里没有 ${name}，静态资源那边出问题了`);
        assert.equal(
            get(name),
            statics.get(name),
            `${name} 两处取值不一致（除了注释里说明过的那几条，其余必须同步）`
        );
    }

    // Referrer-Policy 是**故意**不同的：API 响应上它近乎无效，取更严的值没有副作用。
    // 这里的断言是防止它被"顺手统一"成宽松的值 —— 那样会让人误以为它在这里有用。
    assert.equal(get("Referrer-Policy"), "no-referrer");
    assert.equal(statics.get("referrer-policy"), "strict-origin-when-cross-origin");
});
