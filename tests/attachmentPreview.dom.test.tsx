// tests/attachmentPreview.dom.test.tsx
//
// 附件预览 / 编辑 / 重命名的组件级用例（2026-10-19）。
//
// 这一组盯的是「点了之后到底发生了什么」，四种最容易静默坏掉的接法：
//   1. 正文里的附件链接**没拦住** → 浏览器整页跳走，记事本被顶掉（没有报错，只是很难受）；
//   2. 附件管理器里点文件名**没反应** → 用户以为管理器坏了；
//   3. 弹窗里改了内容但**保存没接上** → 关掉就没了，而且不会有任何提示；
//   4. 重命名**没把结果写回显示名** → 提示说改名成功，标题还是旧的。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AttachmentPreviewDialog from "../src/components/AttachmentPreviewDialog";
import AttachmentManager from "../src/components/AttachmentManager";
import { AttachmentPreviewProvider } from "../src/utils/attachmentPreview";
import { renderMarkdownToReact } from "../src/utils/markdownToReact";

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

/** 给 textarea / input 赋值：直接改 .value 不会触发 React 的 onChange，必须走原生 setter */
function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------- 正文链接

test("正文里的附件链接：点了走预览弹窗，不整页跳走", async () => {
    const opened: Array<{ id: string; filename?: string }> = [];
    const rendered = await renderMarkdownToReact(
        `看这个：[说明.txt](</api/notes/attachments/${ATT_ID}>)`,
        {}
    );
    mount(
        <AttachmentPreviewProvider value={{ open: request => opened.push(request) }}>
            <>{rendered as ReactNode}</>
        </AttachmentPreviewProvider>
    );
    const link = document.querySelector<HTMLAnchorElement>(`[data-attachment-link='${ATT_ID}']`);
    assert.ok(link, "附件链接要被标记出来（data-attachment-link）");
    // jsdom 的 click() 会派发可取消事件，preventDefault 之后 defaultPrevented 才是 true
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
        link!.dispatchEvent(event);
    });
    assert.equal(event.defaultPrevented, true, "必须拦掉默认跳转，否则整页被附件顶掉");
    assert.deepEqual(opened, [{ id: ATT_ID, filename: "说明.txt" }]);
    cleanup();
});

test("没有预览上下文（分享页）时，附件链接保持普通 <a>，行为不变", async () => {
    const rendered = await renderMarkdownToReact(
        `看这个：[说明.txt](/api/notes/attachments/${ATT_ID})`,
        {}
    );
    mount(<>{rendered as ReactNode}</>);
    const link = document.querySelector<HTMLAnchorElement>(`[data-attachment-link='${ATT_ID}']`);
    assert.ok(link);
    assert.equal(link!.getAttribute("href"), `/api/notes/attachments/${ATT_ID}`);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
        link!.dispatchEvent(event);
    });
    assert.equal(event.defaultPrevented, false, "没有弹窗可开时不该吃掉默认行为");
    cleanup();
});

// ---------------------------------------------------------------- 管理器

test("附件管理器：点文件名开预览（不直接下载）", async () => {
    const seen: string[] = [];
    mount(
        <AttachmentManager
            open
            onClose={() => {}}
            mgr={{ list: async () => [
                { id: ATT_ID, filename: "说明.txt", mime: "text/plain", size: 12 },
            ], remove: async () => {} }}
            onPreview={file => seen.push(file.id)}
        />
    );
    await flush(60);
    const btn = document.querySelector<HTMLElement>("[data-attachment-action='preview']");
    assert.ok(btn, "文件名要是可点的按钮");
    act(() => {
        btn!.click();
    });
    assert.deepEqual(seen, [ATT_ID]);
    cleanup();
});

// ---------------------------------------------------------------- 弹窗

/** 把附件内容请求打个桩：返回一份纯文本 */
function stubTextFetch(body: string) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response(body, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } })) as typeof fetch;
    return () => {
        globalThis.fetch = realFetch;
    };
}

test("预览弹窗：把附件内容显示出来，默认就是可编辑状态，改完保存接得上", async () => {
    const restore = stubTextFetch("原始内容");
    const saved: Array<{ id: string; text: string }> = [];
    mount(
        <AttachmentPreviewDialog
            target={{ id: ATT_ID, filename: "说明.txt", mime: "text/plain" }}
            onClose={() => {}}
            onSaveContent={async (id, text) => {
                saved.push({ id, text });
                return { size: text.length };
            }}
        />
    );
    await flush(60);
    // 用户需求（2026-10-20）：文本附件打开就是可编辑态，正文直接在 textarea 里，
    // 不必先点「编辑」。所以内容现在在 [data-att-editor] 的 textarea，而非只读 <pre>。
    const editor = document.querySelector<HTMLTextAreaElement>("[data-att-editor='1'] textarea");
    assert.ok(editor, "可编辑文本附件打开就该是 textarea，不必先点编辑");
    assert.match(editor!.value || "", /原始内容/);

    act(() => {
        typeInto(editor!, "改过的内容");
    });
    const save = document.querySelector<HTMLElement>("[data-att-action='save']");
    assert.ok(save, "内容改过之后该出现「保存」按钮");
    act(() => {
        save!.click();
    });
    await flush(60);
    assert.deepEqual(saved, [{ id: ATT_ID, text: "改过的内容" }]);
    restore();
    cleanup();
});

test("预览弹窗：重命名成功后标题换成服务端返回的名字", async () => {
    const restore = stubTextFetch("内容");
    const renamed: Array<{ id: string; filename: string }> = [];
    mount(
        <AttachmentPreviewDialog
            target={{ id: ATT_ID, filename: "旧名字.txt", mime: "text/plain" }}
            onClose={() => {}}
            onRename={async (id, filename) => {
                renamed.push({ id, filename });
                return { filename, updatedNotes: 2 };
            }}
        />
    );
    await flush(60);
    act(() => {
        (document.querySelector("[data-att-action='rename']") as HTMLElement).click();
    });
    const input = document.querySelector<HTMLInputElement>("[data-att-rename-input]");
    assert.ok(input, "点「重命名」要出现输入框");
    act(() => {
        typeInto(input!, "新名字.txt");
    });
    act(() => {
        (document.querySelector("[data-att-action='rename-confirm']") as HTMLElement).click();
    });
    await flush(60);
    assert.deepEqual(renamed, [{ id: ATT_ID, filename: "新名字.txt" }]);
    assert.match(document.querySelector("[data-att-filename]")!.textContent || "", /新名字\.txt/);
    restore();
    cleanup();
});

test("预览弹窗：名字被清空时不发请求（别把附件改成无名）", async () => {
    const restore = stubTextFetch("内容");
    let called = 0;
    mount(
        <AttachmentPreviewDialog
            target={{ id: ATT_ID, filename: "旧名字.txt", mime: "text/plain" }}
            onClose={() => {}}
            onRename={async (_id, filename) => {
                called += 1;
                return { filename, updatedNotes: 0 };
            }}
        />
    );
    await flush(60);
    act(() => {
        (document.querySelector("[data-att-action='rename']") as HTMLElement).click();
    });
    act(() => {
        typeInto(document.querySelector<HTMLInputElement>("[data-att-rename-input]")!, "   ");
    });
    act(() => {
        (document.querySelector("[data-att-action='rename-confirm']") as HTMLElement).click();
    });
    await flush(60);
    assert.equal(called, 0);
    restore();
    cleanup();
});

test("预览弹窗：图片附件不显示编辑入口（改图内容没有意义）", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { "Content-Type": "image/png" },
        })) as typeof fetch;
    mount(
        <AttachmentPreviewDialog
            target={{ id: ATT_ID, filename: "图.png", mime: "image/png" }}
            onClose={() => {}}
            onSaveContent={async (_id, text) => ({ size: text.length })}
        />
    );
    await flush(60);
    assert.ok(document.querySelector("[data-att-body='image']"), "图片要直接显示");
    assert.equal(document.querySelector("[data-att-action='edit']"), null, "图片没有编辑入口");
    globalThis.fetch = realFetch;
    cleanup();
});
