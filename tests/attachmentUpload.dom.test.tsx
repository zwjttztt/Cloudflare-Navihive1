// tests/attachmentUpload.dom.test.tsx
//
// 附件上传（V3，2026-11-02）：拖拽 / 选择上传入口的组件级守卫。
//
// 单独成文件：附件管理器挂载的是 MUI Drawer（重 Portal），在共享的 dom 测试进程里
// 反复挂载会累积内存触发 OOM；这些用例独立一个进程，互不干扰。
//
// 盯两件事：
//   1. 门控：老部署没有 uploadAttachment 时，整个上传入口（按钮 + 隐藏文件框）必须隐藏；
//   2. 接线：有上传能力时，拖拽放下 / 选择文件确实逐个调到 mgr.upload，结束后重拉列表。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AttachmentManager from "../src/components/AttachmentManager";

const ATT_ID = "abcdef01-2345-6789-abcd-ef0123456789";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(ui: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(ui);
    });
}

function cleanup() {
    if (root) {
        act(() => {
            root!.unmount();
        });
    }
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

async function flush(ms = 30) {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms));
    });
}

const FileCtor = (window as unknown as { File: new (parts: BlobPart[], name: string, opts?: object) => Blob }).File;

test("附件管理器：没有上传能力时不显示上传入口（老部署自动降级）", async () => {
    mount(
        <AttachmentManager
            open
            onClose={() => {}}
            mgr={{ list: async () => [], remove: async () => {} }}
        />
    );
    await flush(40);
    assert.equal(document.querySelector("[data-attachment-action='upload']"), null, "无 upload 时不应有上传按钮");
    cleanup();
});

test("附件管理器：有上传能力时显示上传按钮与隐藏文件框", async () => {
    mount(
        <AttachmentManager
            open
            onClose={() => {}}
            mgr={{
                list: async () => [{ id: ATT_ID, filename: "说明.txt", mime: "text/plain", size: 12 }],
                remove: async () => {},
                upload: async () => {},
            }}
        />
    );
    await flush(60);
    assert.ok(document.querySelector("[data-attachment-action='upload']"), "有 upload 时要有上传按钮");
    assert.ok(document.querySelector("[data-attachment-action='file-input']"), "有 upload 时要有隐藏文件框");
    cleanup();
});

test("附件管理器：拖拽放下文件会逐个调用 mgr.upload 并重拉列表", async () => {
    const uploaded: string[] = [];
    let listCalls = 0;
    mount(
        <AttachmentManager
            open
            onClose={() => {}}
            mgr={{
                list: async () => {
                    listCalls++;
                    return [];
                },
                remove: async () => {},
                upload: async (file: File) => {
                    uploaded.push(file.name);
                },
            }}
        />
    );
    await flush(40);
    const rootBox = document.querySelector<HTMLElement>("[data-attachment-root='1']");
    assert.ok(rootBox, "附件管理器根容器要挂载");
    const fileA = new FileCtor(["a"], "a.txt", { type: "text/plain" });
    const fileB = new FileCtor(["b"], "b.txt", { type: "text/plain" });
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
        dataTransfer?: { files: File[] };
    };
    Object.defineProperty(ev, "dataTransfer", {
        value: { files: [fileA, fileB] },
        configurable: true,
    });
    act(() => {
        rootBox!.dispatchEvent(ev);
    });
    await flush(80);
    assert.deepEqual(uploaded, ["a.txt", "b.txt"], "拖拽放下的两个文件都应调到 mgr.upload");
    assert.ok(listCalls >= 2, "上传完成后要重拉列表（初始 1 次 + 上传后 1 次）");
    assert.equal(document.querySelector("[data-att-state='drag-over']"), null, "上传结束后拖拽高亮应消失");
    cleanup();
});

test("附件管理器：选择文件（file input change）会逐个调用 mgr.upload", async () => {
    const uploaded: string[] = [];
    mount(
        <AttachmentManager
            open
            onClose={() => {}}
            mgr={{
                list: async () => [],
                remove: async () => {},
                upload: async (file: File) => {
                    uploaded.push(file.name);
                },
            }}
        />
    );
    await flush(40);
    const input = document.querySelector<HTMLInputElement>("[data-attachment-action='file-input']");
    assert.ok(input, "有 upload 时要有隐藏文件框");
    const fileA = new FileCtor(["a"], "a.txt", { type: "text/plain" });
    const fileB = new FileCtor(["b"], "b.txt", { type: "text/plain" });
    Object.defineProperty(input!, "files", { configurable: true, value: [fileA, fileB] });
    await act(async () => {
        input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush(80);
    assert.deepEqual(uploaded, ["a.txt", "b.txt"], "选择的两个文件都应调到 mgr.upload");
    cleanup();
});
