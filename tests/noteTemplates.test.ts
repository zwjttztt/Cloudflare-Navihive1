// tests/noteTemplates.test.ts
// B3 笔记模板（2026-10-22）的纯函数部分。
//
// 模板正文是**纯函数**（同 id + 同 now → 同字符串），所以这里直接对着它断言，
// 不用挂组件。挂组件的那半边在 noteTemplatePicker.dom.test.tsx。
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTE_TEMPLATES, findNoteTemplate, isoDate, noteTemplateDraft, type NoteTemplateId } from "../src/utils/noteTemplates";

const AT = new Date(2026, 9, 22, 14, 30); // 2026-10-22 14:30 本地时间

test("三套内置模板：日报 / 会议 / 读书笔记", () => {
    assert.deepEqual(
        NOTE_TEMPLATES.map(t => t.id),
        ["daily", "meeting", "reading"],
        "模板集合就是这三套，顺序即菜单里的顺序"
    );
    for (const t of NOTE_TEMPLATES) {
        assert.ok(t.label.length > 0, `${t.id} 要有名字`);
        assert.ok(t.hint.length > 0, `${t.id} 要有一句说明（菜单副标题）`);
    }
});

test("isoDate：补零 + 本地时区（日报标题要的就是「今天」）", () => {
    assert.equal(isoDate(AT), "2026-10-22");
    assert.equal(isoDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05", "月/日要补零");
});

test("日报模板：标题带当天日期，正文四节齐全", () => {
    const { title, content } = noteTemplateDraft("daily", AT);
    assert.equal(title, "2026-10-22 日报");
    for (const section of ["## 今日完成", "## 进行中", "## 明日计划", "## 备注"]) {
        assert.ok(content.includes(section), `日报要有「${section}」节`);
    }
    // 列表项要给一根空子弹：用户直接接着打字，不用自己敲 "- "
    assert.ok(content.includes("- "), "列表项要带空子弹");
});

test("会议模板：头部字段 + 结论待办是任务复选框", () => {
    const { content } = noteTemplateDraft("meeting", AT);
    assert.ok(content.includes("- 时间："));
    assert.ok(content.includes("- 参与人："));
    assert.ok(content.includes("## 议题"));
    assert.ok(content.includes("- [ ] "), "结论与待办要用任务复选框（预览里能勾）");
});

test("读书模板：标题留空（书名要用户自己填），正文有摘录/想法", () => {
    const { title, content } = noteTemplateDraft("reading", AT);
    assert.equal(title, "", "读书笔记不预设标题 —— 《》占位比瞎猜一个书名好");
    assert.ok(content.includes("# 《》"));
    assert.ok(content.includes("## 摘录"));
    assert.ok(content.includes("## 想法"));
});

test("同一模板同一时刻 → 逐字节相同（纯函数，可放心进单测）", () => {
    const a = noteTemplateDraft("daily", AT);
    const b = noteTemplateDraft("daily", new Date(2026, 9, 22, 23, 59));
    assert.equal(a.content, b.content);
    assert.equal(a.title, b.title, "同一天的不同时刻标题也一样");
});

test("findNoteTemplate：未知 id 直接抛（别静默给第一份）", () => {
    assert.throws(() => findNoteTemplate("nope" as NoteTemplateId), /unknown note template/);
});
