// tests/bookmarks.dom.test.tsx
// 书签 HTML 的解析部分：文件夹归属、伪协议链接、以及整条 planBookmarkImport 链路。
// 纯判定逻辑在 tests/bookmarks.test.ts，这里只补「DOMParser 那一段」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBookmarksHtml, planBookmarkImport } from "../src/utils/bookmarks";
import type { GroupWithSites } from "../src/types";

// Chrome 导出书签的典型片段：DT/H3 是文件夹，后面跟一个 DL 装链接
const HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1">工具栏</H3>
    <DL><p>
        <DT><A HREF="https://example.com" ADD_DATE="1">示例</A>
        <DT><A HREF="https://yunso.net" ADD_DATE="1">云设</A>
        <DT><A HREF="javascript:alert(1)">点我</A>
    </DL><p>
    <DT><H3 ADD_DATE="1">开发</H3>
    <DL><p>
        <DT><A HREF="https://github.com">GitHub</A>
        <DT><A HREF="https://example.com/">示例（另一份）</A>
    </DL><p>
</DL><p>`;

const existing: GroupWithSites[] = [
    {
        id: 1,
        name: "常用工具",
        order_num: 0,
        sites: [
            {
                id: 11,
                group_id: 1,
                name: "云设",
                url: "https://yunso.net",
                icon: "",
                description: "",
                notes: "",
                username: "",
                password: "",
                order_num: 0,
            },
        ],
    },
];

test("文件夹归属：链接归到它上面最近的那个 H3", () => {
    const groups = parseBookmarksHtml(HTML);
    assert.deepEqual(
        groups.map(g => g.folder),
        ["工具栏", "开发"]
    );
    assert.deepEqual(
        groups[0].items.map(i => i.title),
        ["示例", "云设"]
    );
    assert.equal(groups[1].items[0].url, "https://github.com");
});

test("伪协议链接不会被当成可用卡片", () => {
    const groups = parseBookmarksHtml(HTML);
    const titles = groups.flatMap(g => g.items.map(i => i.title));
    assert.equal(titles.includes("点我"), false);
});

test("planBookmarkImport：解析出来的五条里两新增、两重复、一无效", () => {
    const plan = planBookmarkImport(HTML, existing);
    assert.deepEqual(plan.stats, { total: 5, added: 2, duplicate: 2, invalid: 1 });

    const byTitle = new Map(plan.entries.map(e => [e.title, e]));
    assert.equal(byTitle.get("示例")?.status, "new");
    assert.equal(byTitle.get("GitHub")?.status, "new");
    assert.equal(byTitle.get("云设")?.status, "duplicate");
    assert.match(byTitle.get("云设")?.note ?? "", /已存在于「常用工具」/);
    // 工具栏里的 https://example.com 先出现，开发里那份（多了末尾斜杠）算重复
    assert.equal(byTitle.get("示例（另一份）")?.status, "duplicate");
    assert.equal(byTitle.get("点我")?.status, "invalid");

    // 导入清单里只剩真新增的
    assert.deepEqual(plan.groups.map(g => g.folder), ["工具栏", "开发"]);
    assert.deepEqual(
        plan.groups.flatMap(g => g.items.map(i => i.title)),
        ["示例", "GitHub"]
    );
});

test("planBookmarkImport 在没有现有库时全部算新增", () => {
    const plan = planBookmarkImport(HTML, []);
    // 少了「已存在」那两条，但文件内部的重复（示例 / 示例另一份）照样只留一处
    assert.deepEqual(plan.stats, { total: 5, added: 3, duplicate: 1, invalid: 1 });
});
