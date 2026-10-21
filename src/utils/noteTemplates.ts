// src/utils/noteTemplates.ts
// 记事本「新建笔记」时可选的内置模板（B3，2026-10-22）。
//
// 解决的事：面对空白页不知道从哪儿下手。日报 / 会议 / 读书笔记这三类
// 是写得最频繁、结构又最固定的 —— 把骨架给好，人只管填。
//
// ⚠️ 纯前端字符串，**不动任何数据结构**：模板只是在新建那一刻把一段
// Markdown 塞进 content（和手打一模一样），库里存的还是普通笔记。
// 老部署、同步、导入导出全都无感。
//
// ⚠️ 模板正文必须是**纯函数**（同样的 id + 同样的 now → 同样的字符串）：
// 单测直接对着它断言，不用挂组件。

export type NoteTemplateId = "daily" | "meeting" | "reading";

export interface NoteTemplate {
    id: NoteTemplateId;
    /** 菜单里显示的名字 */
    label: string;
    /** 一句话说明这份模板长什么样（菜单副标题） */
    hint: string;
    /** 新建时的默认标题（空串 = 留空让用户自己填） */
    defaultTitle: (now: Date) => string;
    /** 正文骨架 */
    content: (now: Date) => string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 2026-10-22 这种形式（本地时区；日报标题要的就是「今天」） */
export function isoDate(now: Date): string {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
    {
        id: "daily",
        label: "日报",
        hint: "今日完成 / 进行中 / 明日计划",
        defaultTitle: now => `${isoDate(now)} 日报`,
        content: () =>
            [
                "## 今日完成",
                "- ",
                "",
                "## 进行中",
                "- ",
                "",
                "## 明日计划",
                "- ",
                "",
                "## 备注",
                "",
            ].join("\n"),
    },
    {
        id: "meeting",
        label: "会议记录",
        hint: "时间 / 参与人 / 议题 / 结论与待办",
        defaultTitle: () => "会议记录",
        content: () =>
            [
                "- 时间：",
                "- 参与人：",
                "- 主题：",
                "",
                "## 议题",
                "",
                "## 结论与待办",
                "- [ ] ",
                "",
                "## 备注",
                "",
            ].join("\n"),
    },
    {
        id: "reading",
        label: "读书笔记",
        hint: "书名 / 作者 / 摘要 / 摘录 / 想法",
        defaultTitle: () => "",
        content: () =>
            [
                "# 《》",
                "",
                "- 作者：",
                "- 进度：",
                "",
                "## 摘要",
                "",
                "## 摘录",
                "",
                "## 想法",
                "",
            ].join("\n"),
    },
];

export function findNoteTemplate(id: NoteTemplateId): NoteTemplate {
    const hit = NOTE_TEMPLATES.find(t => t.id === id);
    if (!hit) throw new Error(`unknown note template: ${id}`);
    return hit;
}

/** 选中某个模板时，新建笔记要用的 { title, content } */
export function noteTemplateDraft(
    id: NoteTemplateId,
    now: Date = new Date()
): { title: string; content: string } {
    const t = findNoteTemplate(id);
    return { title: t.defaultTitle(now), content: t.content(now) };
}
