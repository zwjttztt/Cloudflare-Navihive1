// tests/auditDetailText.test.ts
// 审计日志的展示层翻译（用户 2026-11-01 反馈「两块内容看不懂」）。
//
// 为什么值得钉：这两块内容以前是把代码内部代号（save-error）和一整段上报 JSON
// 直接怼给用户，而且「前端错误」视图要真崩一次才有数据 —— 手点验不出来，
// 只能靠这一层单测保证那五个真实出现过的代号确实翻成了人话。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    errorSourceLabel,
    formatAuditDetail,
    formatAuditPath,
} from "../src/utils/auditDetailText";

const HAS_CHINESE = /[\u4e00-\u9fa5]/;

/** 截图里真实出现过的五个来源代号（用户看不懂的就是它们） */
const SEEN_SOURCES = [
    "save-error",
    "note-full",
    "notes-sync-poll",
    "notes-tags-list",
    "notes-list",
];

test("截图里那五个来源代号都要翻成中文，不能把代号甩给用户", () => {
    for (const source of SEEN_SOURCES) {
        const label = errorSourceLabel(source);
        assert.notEqual(label, source, `${source} 必须翻译，不能原样返回`);
        assert.match(label, HAS_CHINESE, `${source} 要译成中文，实际是 ${label}`);
    }
});

test("几个典型组合的译法（词表拼出来的结果要读得懂）", () => {
    assert.equal(errorSourceLabel("save-error"), "保存数据");
    assert.equal(errorSourceLabel("load-error"), "加载数据");
    assert.equal(errorSourceLabel("note-full"), "笔记 正文");
    assert.equal(errorSourceLabel("notes-sync-poll"), "笔记 同步 轮询");
    assert.equal(errorSourceLabel("notes-tags-list"), "笔记 标签 列表");
    assert.equal(errorSourceLabel("notes-list"), "笔记 列表");
    assert.equal(errorSourceLabel("site-bulk-delete"), "站点 批量 删除");
});

test("没见过的词半中半英地拼出来，不许丢掉原文", () => {
    // brand-new-thing 三个词都不在词表里 -> 整串原样返回
    const unknownCompound = errorSourceLabel("brand-new-thing");
    assert.doesNotThrow(() => errorSourceLabel("brand-new-thing"));
    assert.ok(unknownCompound.length > 0, "不能返回空串");
    assert.equal(unknownCompound, "brand-new-thing");

    // 只有一部分词认识：认识的译，不认识的原样留着（可追溯性比好看重要）
    const half = errorSourceLabel("note-revision-get");
    assert.match(half, /笔记/);
    assert.match(half, /get/, "译不出来的词要保留");
});

test("来源缺省 / 非字符串时说「未知来源」", () => {
    assert.equal(errorSourceLabel(""), "未知来源");
    assert.equal(errorSourceLabel("   "), "未知来源");
    assert.equal(errorSourceLabel(undefined as unknown as string), "未知来源");
});

test("前端错误上报的 JSON 要拆成人话，且不含 JSON 原文", () => {
    const detail = JSON.stringify({
        source: "save-error",
        path: "/",
        name: "NonError",
        message: "加载数据失败: 认证失败: 请先登录",
        rid: "-",
    });
    const text = formatAuditDetail("client-error", detail);
    assert.match(text, /保存数据/, "要出现中文来源名");
    assert.match(text, /加载数据失败: 认证失败: 请先登录/, "原始错误信息要完整保留");
    assert.equal(text.includes('{"source"'), false, "不能把 JSON 原文甩出来");
});

test("有 requestId 时带上请求号，没有就不占位", () => {
    assert.match(
        formatAuditDetail("client-error", '{"source":"x","message":"boom","requestId":"abc12345"}'),
        /abc12345/
    );
    const withoutRid = formatAuditDetail("client-error", '{"source":"x","message":"boom"}');
    assert.equal(withoutRid.includes("请求号"), false, "没有请求号就不该出现这四个字");
});

test("message 缺失时给一句兜底，不留空洞", () => {
    assert.match(formatAuditDetail("client-error", '{"source":"save-error"}'), /无错误信息/);
});

test("本来就是人话的 detail 一个字都不许改", () => {
    assert.equal(formatAuditDetail("site.delete", "长期未登录，已停用"), "长期未登录，已停用");
    assert.equal(formatAuditDetail("auth.recover", "  已重置密码  "), "已重置密码");
});

test("不是 JSON 的记录原样保留，不吞掉", () => {
    assert.equal(formatAuditDetail("client-error", "not json"), "not json");
    // 看起来像 JSON 但解析失败：同样退回原文
    const broken = '{"source": "save-error", broken';
    assert.equal(formatAuditDetail("client-error", broken), broken);
});

test("空 detail 返回空串（调用方据此决定不拼那个分隔符）", () => {
    assert.equal(formatAuditDetail("client-error", ""), "");
    assert.equal(formatAuditDetail("client-error", "   "), "");
    assert.equal(formatAuditDetail("client-error", null), "");
    assert.equal(formatAuditDetail("client-error", undefined), "");
});

test("其它动作的 JSON 平铺成「键: 值」，嵌套结构跳过、最多四组", () => {
    const text = formatAuditDetail(
        "site.update",
        JSON.stringify({
            name: "站点 A",
            url: "https://a.example",
            nested: { a: 1 },
            tags: ["x"],
            empty: "",
            count: 3,
        })
    );
    assert.match(text, /name: 站点 A/);
    assert.match(text, /url: https:\/\/a\.example/);
    assert.match(text, /count: 3/);
    assert.equal(text.includes("nested"), false, "嵌套对象跳过");
    assert.equal(text.includes("tags"), false, "数组跳过");
    assert.equal(text.split(" · ").length <= 4, true, "最多四组");
});

test("超长内容截断，并让人看得出后面还有", () => {
    const long = "很长的记录".repeat(60);
    const text = formatAuditDetail("site.delete", long);
    assert.ok(text.length < long.length, "必须截断");
    assert.match(text, /…$/);
});

// server-error 的 detail 形状与前端上报不同（worker/index.ts 落的）：
// { method, path, code, message, rid } —— 没有 source、请求号叫 rid、path 是 API 路径。
test("服务端错误：用「方法 + API 路径」当来源，内部错误码不显示", () => {
    const text = formatAuditDetail(
        "server-error",
        '{"method":"POST","path":"/api/notes","code":"INTERNAL","message":"D1_ERROR: no such table","rid":"ab12cd34"}'
    );
    assert.match(text, /POST/);
    assert.match(text, /\/api\/notes/);
    assert.match(text, /D1_ERROR: no such table/);
    assert.match(text, /ab12cd34/, "rid 是去服务端日志里查哪一行的唯一线索");
    assert.equal(text.includes("INTERNAL"), false, "内部错误码对用户没意义");
    assert.equal(text.includes('{"method"'), false, "不能把 JSON 原文甩出来");
});

test("服务端错误：没有方法/路径/请求号时，只留消息，不留多余标点", () => {
    assert.equal(formatAuditDetail("server-error", '{"message":"boom"}'), "boom");
    assert.equal(
        formatAuditDetail("server-error", '{"message":"boom"}').includes("请求号"),
        false
    );
});

test("服务端错误的 path 是 API 路径：`/` 不能译成「首页」", () => {
    const text = formatAuditDetail("server-error", '{"method":"GET","path":"/","message":"x"}');
    assert.match(text, /\//, "API 根路径要原样显示");
    assert.equal(text.includes("首页"), false, "那是页面路由的译法，误用会把根接口说成首页");
    assert.equal(text, "GET /：x");
});

test("路径：首页的 `/` 不能显示成孤零零一个斜杠", () => {
    assert.equal(formatAuditPath("/"), "首页");
    assert.equal(formatAuditPath(""), "首页");
    assert.equal(formatAuditPath("/notes"), "记事本");
    assert.equal(formatAuditPath("/groups"), "/groups");
    assert.equal(formatAuditPath("notes"), "notes");
});
