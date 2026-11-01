// tests/attachmentEmptyStates.test.ts
// 附件抽屉「空态 / 无命中 / 拉取失败」三条提示的配色守卫。
//
// 为什么需要（2026-11-01）：这三条是抽屉里**独立于列表**的渲染分支，各自有一套
// 文字与配色，而它们从来没进过任何审计面 —— 加进对比度审计之后当场抓出亮色
// **2.68:1**（`text.disabled` 的 rgba(0,0,0,.38) 压在抽屉底上，12px 小字线 4.5）。
//
// 现在三态**都已进审计**（`contrast-audit.mjs` 的「附件抽屉·空态 / 拉取失败 / 无命中」
// 三段，最后一段靠 `setAttachmentMode('images')` + 点「文档」筛选造出来）。
// 这条源码守卫仍然留着，理由变了：它跑在单测里（秒级、不需要浏览器），
// 能在审计之前先把「有人把颜色改回去」这种情况挡住 —— 便宜的第一道闸。
//   ① 三条提示都不许用 text.disabled（那是「停用控件」的语义，说明文字没有豁免）；
//   ② 空态 / 无命中要跟「正在读取附件列表…」用同一个 token，别各写各的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，这里逐级向上找源码 */
function findSource(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, "src/components/AttachmentManager.tsx"), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到 src/components/AttachmentManager.tsx");
}
const src = findSource();

/** 取出某个 data-att-state 那一整个 <Typography …> 开始标签 */
function tagOf(state: string): string {
    const at = src.indexOf(`data-att-state='${state}'`);
    assert.ok(at > 0, `找不到 data-att-state='${state}' 的节点 —— 选择器漂了，守卫失效`);
    const from = src.lastIndexOf("<Typography", at);
    const to = src.indexOf(">", at);
    return src.slice(from, to);
}

for (const state of ["empty", "none-match"]) {
    test(`附件抽屉·${state}：提示文字不能用 text.disabled（那是停用控件的语义）`, () => {
        const tag = tagOf(state);
        assert.ok(
            !/color:\s*"text\.disabled"/.test(tag),
            `${state} 又用回 text.disabled 了：亮色 rgba(0,0,0,.38) 压在抽屉底上只有 2.68:1，` +
                "12px 小字线是 4.5；WCAG 只豁免「停用的控件」，不豁免说明文字"
        );
        assert.match(
            tag,
            /color:\s*"text\.secondary"/,
            `${state} 的文字色不是 text.secondary —— 与同区域的「正在读取附件列表…」不一致`
        );
    });
}

test("附件抽屉·error：失败文案保留 error.main（警示语义，且实测达线）", () => {
    assert.match(
        tagOf("error"),
        /color:\s*"error\.main"/,
        "失败态的文字色被改了：它是警示语义，实测亮 4.6+ / 暗 5.5+，本来就过线"
    );
});
