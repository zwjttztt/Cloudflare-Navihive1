// worker/webdav/transport.ts 里**还没**被 webdav.test.ts 盖到的那部分。
//
// 分工：webdav.test.ts 盯着地址校验、重定向守卫、错误提示；
// 这个文件盯的是另外三件事 ——
//   1. parseWebDavList：解析网盘返回的 XML。它的**排序决定了恢复哪一份备份**，
//      排反了会拿三天前的旧备份覆盖现在的数据，而且全程不报错；
//   2. 文件名/目录的 URL 编码（中文与空格）；
//   3. Basic 凭据的编码：base64Encode 那段是专门为**中文密码**写的
//      （直接 btoa(明文) 遇到非 ASCII 会抛），但一直没人盯着。

import assert from "node:assert/strict";
import test from "node:test";
import {
    buildWebDavFileUrl,
    buildWebDavFolderUrl,
    davFetch,
    ensureWebDavFolder,
    parseWebDavList,
} from "../worker/webdav/transport";
import type { WebDavConfig } from "../worker/webdav/types";

const cfg = (over: Partial<WebDavConfig> = {}): WebDavConfig => ({
    url: "https://dav.example.com",
    username: "user",
    password: "pw",
    path: "navihive-backup",
    ...over,
});

/** 造一段 PROPFIND 响应：collection 是目录，其余是文件 */
function multistatus(items: Array<{ href: string; collection?: boolean; size?: number; modified?: string }>) {
    const blocks = items
        .map(item => {
            const type = item.collection ? "<d:collection/>" : "";
            const size = item.size === undefined ? "" : `<d:getcontentlength>${item.size}</d:getcontentlength>`;
            const modified = item.modified ? `<d:getlastmodified>${item.modified}</d:getlastmodified>` : "";
            return `<d:response><d:href>${item.href}</d:href><d:propstat><d:prop>${type}${size}${modified}</d:prop></d:propstat></d:response>`;
        })
        .join("");
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${blocks}</d:multistatus>`;
}

// ---------------- PROPFIND 解析 ----------------

test("parseWebDavList：按修改时间倒序 —— 这个顺序决定了恢复哪一份备份", () => {
    const xml = multistatus([
        { href: "/dav/old.json.gz", size: 100, modified: "Mon, 01 Jan 2026 00:00:00 GMT" },
        { href: "/dav/new.json.gz", size: 200, modified: "Fri, 02 Jan 2026 00:00:00 GMT" },
    ]);
    const files = parseWebDavList(xml);
    assert.deepEqual(
        files.map(f => f.name),
        ["new.json.gz", "old.json.gz"],
        "最新的必须排在最前：恢复流程取的是第一份"
    );
});

test("parseWebDavList：目录（collection）不算文件", () => {
    const xml = multistatus([
        { href: "/dav/navihive-backup/", collection: true },
        { href: "/dav/navihive-backup/a.json.gz", size: 10, modified: "Fri, 02 Jan 2026 00:00:00 GMT" },
    ]);
    const files = parseWebDavList(xml);
    assert.deepEqual(
        files.map(f => f.name),
        ["a.json.gz"]
    );
});

test("parseWebDavList：href 里的 URL 编码要解回来（中文/空格文件名）", () => {
    const xml = multistatus([
        { href: "/dav/navihive-backup/%E5%A4%87%E4%BB%BD%20A.json.gz", size: 1, modified: "Fri, 02 Jan 2026 00:00:00 GMT" },
    ]);
    assert.equal(parseWebDavList(xml)[0].name, "备份 A.json.gz");
});

test("parseWebDavList：只取最后一段路径（服务器常返回完整 href）", () => {
    const xml = multistatus([
        { href: "https://dav.example.com/dav/navihive-backup/a.json.gz", size: 1, modified: "Fri, 02 Jan 2026 00:00:00 GMT" },
    ]);
    assert.equal(parseWebDavList(xml)[0].name, "a.json.gz");
});

test("parseWebDavList：缺 size / 缺时间不崩，size 归 0、排到最后", () => {
    const xml = multistatus([
        { href: "/dav/nosize.json.gz" },
        { href: "/dav/ok.json.gz", size: 5, modified: "Fri, 02 Jan 2026 00:00:00 GMT" },
    ]);
    const files = parseWebDavList(xml);
    assert.equal(files.length, 2);
    assert.equal(files.find(f => f.name === "nosize.json.gz")?.size, 0);
    assert.equal(files[0].name, "ok.json.gz", "有时间的那份排在前面");
});

test("parseWebDavList：畸形 / 空响应返回空数组，不抛", () => {
    assert.deepEqual(parseWebDavList(""), []);
    assert.deepEqual(parseWebDavList("不是 XML"), []);
    // 只有开始标签没有结束标签：正则匹配不到整块，应当安静跳过
    assert.deepEqual(parseWebDavList("<d:multistatus><d:response><d:href>/a"), []);
});

test("parseWebDavList：没有命名空间前缀的服务器也能解析", () => {
    const xml = `<?xml version="1.0"?><multistatus><response><href>/dav/a.json.gz</href>` +
        `<propstat><prop><getcontentlength>7</getcontentlength>` +
        `<getlastmodified>Fri, 02 Jan 2026 00:00:00 GMT</getlastmodified></prop></propstat></response></multistatus>`;
    const files = parseWebDavList(xml);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "a.json.gz");
    assert.equal(files[0].size, 7);
});

// ---------------- 文件名 / 目录地址 ----------------

test("buildWebDavFileUrl：文件名做 URL 编码（中文与空格）", () => {
    assert.equal(
        buildWebDavFileUrl("https://dav.example.com/navihive-backup/", "备份 A.json.gz"),
        "https://dav.example.com/navihive-backup/%E5%A4%87%E4%BB%BD%20A.json.gz"
    );
});

test("buildWebDavFileUrl：目录地址末尾的斜杠不会被吃掉", () => {
    assert.equal(buildWebDavFileUrl("https://dav.example.com/dav/", "a.json"), "https://dav.example.com/dav/a.json");
});

// ---------------- Basic 凭据编码（中文密码） ----------------

/** 按服务端视角把 Basic 凭据解回原文（atob 之后还要按 UTF-8 解一次） */
function decodeBasic(authorization: string): string {
    const binary = atob(authorization.slice("Basic ".length));
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}
async function captureAuth(config: WebDavConfig) {
    const realFetch = globalThis.fetch;
    let authorization: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        authorization = new Headers((init?.headers as Record<string, string>) ?? {}).get("authorization");
        return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
        await davFetch("https://dav.example.com/dav/a.json", "GET", config);
    } finally {
        globalThis.fetch = realFetch;
    }
    // 回调里的赋值 TS 追踪不到，不加这个断言会被收窄成 null/never
    return authorization as string | null;
}

test("中文密码的 Basic 编码正确（btoa 直接吃非 ASCII 会抛，必须先转字节）", async () => {
    const auth = await captureAuth(cfg({ username: "张三", password: "密码·123" }));
    assert.ok(auth?.startsWith("Basic "), `没有带 Authorization：${auth}`);
    // atob 吐回来的是「一个字节一个字符」的串，得再按 UTF-8 解一次才是原文 ——
    // 直接拿 atob 的结果比对，中文一定会显示成乱码（那是用例的问题，不是编码的问题）
    assert.equal(decodeBasic(auth!), "张三:密码·123");
});

test("Basic 编码走 UTF-8：服务端解出来必须与账号密码逐字相同", async () => {
    // 常见错法是 btoa(`${u}:${p}`) —— 非 ASCII 直接抛 InvalidCharacterError，
    // 表现为「中文密码的用户怎么都登录不上网盘」，且报错信息跟密码毫无关系。
    const auth = await captureAuth(cfg({ username: "user", password: "pässwörd" }));
    assert.equal(decodeBasic(auth!), "user:pässwörd");
});

test("没填用户名时不发 Authorization（匿名 WebDAV）", async () => {
    assert.equal(await captureAuth(cfg({ username: "", password: "pw" })), null);
});

test("空密码也要能把用户名带出去（只填账号的网盘）", async () => {
    const auth = await captureAuth(cfg({ username: "user", password: "" }));
    assert.equal(atob(auth!.slice("Basic ".length)), "user:");
});

// ---------------- 逐级建目录 ----------------

test("ensureWebDavFolder：逐级 MKCOL，且每段都编码", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method} ${String(input)}`);
        return new Response(null, { status: 201 });
    }) as typeof fetch;
    try {
        const folder = buildWebDavFolderUrl(cfg({ path: "navihive-backup/子目录" }));
        await ensureWebDavFolder(cfg({ path: "navihive-backup/子目录" }), folder);
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.equal(calls.length, 2, `应逐级建两级目录，实际：${calls.join(" | ")}`);
    assert.match(calls[0], /^MKCOL https:\/\/dav\.example\.com\/navihive-backup\/$/);
    assert.match(calls[1], /^MKCOL https:\/\/dav\.example\.com\/navihive-backup\/%E5%AD%90%E7%9B%AE%E5%BD%95\/$/);
});

test("ensureWebDavFolder：某一级创建失败（已存在/无权限）不中断，继续建下一级", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        calls.push(String(input));
        // 第一级抛网络错，第二级正常
        if (calls.length === 1) throw new Error("network down");
        return new Response(null, { status: 201 });
    }) as typeof fetch;
    try {
        const folder = buildWebDavFolderUrl(cfg({ path: "a/b" }));
        await ensureWebDavFolder(cfg({ path: "a/b" }), folder);
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.equal(calls.length, 2, "第一级失败不该影响第二级（否则目录永远建不全）");
});

// 路径留空**不等于**「不建目录」：buildWebDavFolderUrl 会回落到默认目录名，
// 否则备份文件会散在网盘根目录下、也没法按目录清理。
test("ensureWebDavFolder：路径留空时建默认目录，不会把备份散在根目录", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response(null, { status: 201 });
    }) as typeof fetch;
    try {
        await ensureWebDavFolder(cfg({ path: "" }), buildWebDavFolderUrl(cfg({ path: "" })));
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "https://dav.example.com/navihive-backup/");
});

// ---------------- 重定向跳数上限 ----------------

test("重定向超过上限时报错，而不是无限跳下去", async () => {
    const realFetch = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = (async () => {
        sent += 1;
        // 永远跳到同源的另一个路径，逼出跳数上限那条分支
        return new Response(null, { status: 302, headers: { location: `/hop-${sent}` } });
    }) as typeof fetch;
    let error = "";
    try {
        // 第 7 个参数是超时毫秒、第 8 个才是跳数上限
        await davFetch("https://dav.example.com/start", "GET", cfg(), undefined, undefined, 60000, 1);
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.match(error, /重定向次数过多/);
    assert.equal(sent, 2, `上限 1 跳时只该发出 2 次请求，实际 ${sent} 次`);
});

test("默认跳数上限是 4：不传参时也不会无限跳", async () => {
    const realFetch = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = (async () => {
        sent += 1;
        return new Response(null, { status: 302, headers: { location: `/hop-${sent}` } });
    }) as typeof fetch;
    try {
        await davFetch("https://dav.example.com/start", "GET", cfg());
    } catch {
        // 必然抛「重定向次数过多」，这里只关心发了几次
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.ok(sent <= 5, `默认上限下最多 5 次请求，实际 ${sent} 次`);
});
