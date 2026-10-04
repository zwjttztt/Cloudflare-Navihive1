// tests/clipboard.dom.test.tsx
// 复制文本到剪贴板。
//
// 这段代码只有 30 行，但它是「导出配置 / 复制链接」这类功能的唯一出口，而且中间夹着
// 一条很容易被人「顺手清理」的兼容性分支：navigator.clipboard 只在**安全上下文**
// （https 或 localhost）里才有，用 http 打开自建站点的人走的是 execCommand 那条老路。
// 哪天有人把回落分支删了（"现在谁还用 http"），那批人会突然复制不了任何东西，
// 而且不报错 —— 因为失败会被 catch 吞掉、返回 false。
//
// 另一条要钉的：失败是**返回值 false**而不是抛异常。调用方（复制按钮）靠它决定
// 提示「复制成功」还是「复制失败」，一抛就是整页崩。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyToClipboard } from "../src/utils/clipboard";

/** 记录回落方案有没有被用到、以及它拿到什么 */
let execCommandCalls: string[] = [];
let execCommandResult = true;
let clipboardWrites: string[] = [];
let clipboardAvailable = true;
let secureContext = true;

beforeEach(() => {
    execCommandCalls = [];
    execCommandResult = true;
    clipboardWrites = [];
    clipboardAvailable = true;
    secureContext = true;

    Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        value: secureContext,
    });
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: clipboardAvailable
            ? {
                  writeText: async (t: string) => {
                      clipboardWrites.push(t);
                  },
              }
            : undefined,
    });
    (document as unknown as { execCommand: (c: string) => boolean }).execCommand = (
        cmd: string
    ) => {
        execCommandCalls.push(cmd);
        return execCommandResult;
    };
});

afterEach(() => {
    document.body.innerHTML = "";
});

test("正常路径走异步 Clipboard API", async () => {
    const ok = await copyToClipboard("hello");

    assert.equal(ok, true);
    assert.deepEqual(clipboardWrites, ["hello"]);
    assert.deepEqual(execCommandCalls, [], "有现代 API 就不该再走老路");
});

test("空文本直接返回 false，不去碰剪贴板", async () => {
    assert.equal(await copyToClipboard(""), false);
    assert.deepEqual(clipboardWrites, []);
    assert.deepEqual(execCommandCalls, []);
});

test("非安全上下文（http 自建站点）回落到 execCommand", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });

    const ok = await copyToClipboard("hello");

    assert.equal(ok, true, "http 下也要能复制 —— 自建站点很多人就是这么访问的");
    assert.deepEqual(execCommandCalls, ["copy"]);
});

test("没有 navigator.clipboard 时回落到 execCommand", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });

    const ok = await copyToClipboard("hello");

    assert.equal(ok, true);
    assert.deepEqual(execCommandCalls, ["copy"]);
});

test("回落后要复制的是原文（走的是临时 textarea 的 value）", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });

    await copyToClipboard("https://example.com/a?b=1");

    // textarea 用完就移除了，所以从 execCommand 被调用这件事本身推断内容已经复制；
    // 这里额外确认没有把 DOM 垃圾留在页面上
    assert.deepEqual(execCommandCalls, ["copy"]);
    assert.equal(document.querySelectorAll("textarea").length, 0, "临时元素要清掉");
});

test("异步 API 抛错时不崩，回落到老方案", async () => {
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
            writeText: async () => {
                throw new Error("NotAllowedError");
            },
        },
    });

    const ok = await copyToClipboard("hello");

    assert.equal(ok, true, "用户拒绝剪贴板权限时还有老方案兜着");
    assert.deepEqual(execCommandCalls, ["copy"]);
});

test("两条路都失败时返回 false，而不是抛出去", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    (document as unknown as { execCommand: (c: string) => boolean }).execCommand = () => {
        throw new Error("nope");
    };

    const ok = await copyToClipboard("hello");

    assert.equal(ok, false, "复制失败是预期结果，调用方靠这个返回值决定提示什么");
});
