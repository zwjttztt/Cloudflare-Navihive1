// tests/bookmarks.test.ts
// 书签导入前的「体检」：新增 / 重复 / 无效 三态判定。
// 判重判错只有两种后果：要么漏掉该有的卡片，要么把库里已有的再复制一份 ——
// 都属于「导完了才发现、还得手工收拾」的那类，所以用单测钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    bookmarkInvalidReason,
    classifyBookmarkEntries,
    countBookmarkStatus,
} from "../src/utils/bookmarks";
import type { GroupWithSites } from "../src/types";

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

test("库里没有的链接算新增", () => {
    const plan = classifyBookmarkEntries(
        [{ title: "示例", url: "https://example.com", folder: "工具栏" }],
        existing
    );
    assert.equal(plan.entries[0].status, "new");
    assert.deepEqual(plan.stats, { total: 1, added: 1, duplicate: 0, invalid: 0 });
    assert.deepEqual(plan.groups, [
        { folder: "工具栏", items: [{ title: "示例", url: "https://example.com", folder: "工具栏" }] },
    ]);
});

test("协议 / www / 末尾斜杠不同也算同一条，判为已存在", () => {
    const plan = classifyBookmarkEntries(
        [
            { title: "云设 http", url: "http://www.yunso.net/", folder: "工具栏" },
            { title: "云设 大写", url: "HTTPS://YUNSO.NET", folder: "收藏栏" },
        ],
        existing
    );
    assert.deepEqual(
        plan.entries.map(e => e.status),
        ["duplicate", "duplicate"]
    );
    assert.match(plan.entries[0].note ?? "", /已存在于「常用工具」/);
    assert.equal(plan.stats.added, 0);
    assert.equal(plan.stats.duplicate, 2);
    // 重复项默认不进导入清单
    assert.deepEqual(plan.groups, []);
});

test("javascript: / place: 这类伪协议算无效，并说清原因", () => {
    const plan = classifyBookmarkEntries(
        [
            { title: "小脚本", url: "javascript:alert(1)", folder: "工具栏" },
            { title: "最近标签", url: "place:type=6&sort=14", folder: "工具栏" },
            { title: "空链接", url: "   ", folder: "工具栏" },
        ],
        existing
    );
    assert.deepEqual(
        plan.entries.map(e => e.status),
        ["invalid", "invalid", "invalid"]
    );
    assert.equal(plan.entries[0].note, "javascript: 不是网页链接");
    assert.equal(plan.entries[1].note, "place: 不是网页链接");
    assert.equal(plan.entries[2].note, "链接为空");
    assert.equal(plan.stats.invalid, 3);
});

test("同一个链接跨文件夹只留第一次出现的那处", () => {
    const plan = classifyBookmarkEntries(
        [
            { title: "A", url: "https://a.com", folder: "文件夹一" },
            { title: "B", url: "https://b.com", folder: "文件夹一" },
            { title: "A 又一份", url: "https://a.com/", folder: "文件夹二" },
        ],
        existing
    );
    assert.deepEqual(
        plan.entries.map(e => e.status),
        ["new", "new", "duplicate"]
    );
    assert.match(plan.entries[2].note ?? "", /与「文件夹一」里的同一链接重复/);
    // 只留第一次出现的那处，文件夹二里这条不生成分组
    assert.deepEqual(plan.groups.map(g => g.folder), ["文件夹一"]);
});

test("库里已有优先于文件内重复：先报用户最该知道的", () => {
    const plan = classifyBookmarkEntries(
        [
            { title: "云设", url: "https://yunso.net", folder: "文件夹一" },
            { title: "云设 副本", url: "https://yunso.net", folder: "文件夹二" },
        ],
        existing
    );
    assert.deepEqual(
        plan.entries.map(e => e.note),
        ["已存在于「常用工具」", "已存在于「常用工具」"]
    );
});

test("includeDuplicates 打开后重复项也进导入清单，仍按文件夹聚合", () => {
    const plan = classifyBookmarkEntries(
        [
            { title: "云设", url: "https://yunso.net", folder: "文件夹一" },
            { title: "新的", url: "https://new.com", folder: "文件夹一" },
        ],
        existing,
        { includeDuplicates: true }
    );
    assert.deepEqual(plan.groups.map(g => g.folder), ["文件夹一"]);
    assert.deepEqual(
        plan.groups[0].items.map(i => i.title),
        ["云设", "新的"]
    );
    // 无效项永远不进
    const withInvalid = classifyBookmarkEntries(
        [{ title: "脚本", url: "javascript:void 0", folder: "F" }],
        existing,
        { includeDuplicates: true }
    );
    assert.deepEqual(withInvalid.groups, []);
});

test("文件夹顺序取第一次出现的顺序", () => {
    const plan = classifyBookmarkEntries(
        [
            { title: "1", url: "https://one.com", folder: "后一个" },
            { title: "2", url: "https://two.com", folder: "前一个" },
            { title: "3", url: "https://three.com", folder: "后一个" },
        ],
        existing
    );
    assert.deepEqual(plan.groups.map(g => g.folder), ["后一个", "前一个"]);
    assert.equal(plan.groups[0].items.length, 2);
});

test("空文件得到空计划，不会崩", () => {
    const plan = classifyBookmarkEntries([], existing);
    assert.deepEqual(plan.entries, []);
    assert.deepEqual(plan.groups, []);
    assert.deepEqual(plan.stats, { total: 0, added: 0, duplicate: 0, invalid: 0 });
});

test("bookmarkInvalidReason：只有 http/https 放行，大小写不敏感", () => {
    assert.equal(bookmarkInvalidReason("https://a.com"), null);
    assert.equal(bookmarkInvalidReason("HTTPS://A.COM"), null);
    assert.equal(bookmarkInvalidReason("http://a.com"), null);
    assert.equal(bookmarkInvalidReason("ftp://a.com"), "ftp: 不是网页链接");
    assert.equal(bookmarkInvalidReason("about:blank"), "about: 不是网页链接");
    assert.equal(bookmarkInvalidReason("www.a.com"), "不是完整网址");
    assert.equal(bookmarkInvalidReason(""), "链接为空");
});

test("countBookmarkStatus：三类各算各的，总数等于条目数", () => {
    assert.deepEqual(countBookmarkStatus([]), {
        total: 0,
        added: 0,
        duplicate: 0,
        invalid: 0,
    });
    const mixed = classifyBookmarkEntries(
        [
            { title: "新", url: "https://new.com", folder: "F" },
            { title: "旧", url: "https://yunso.net", folder: "F" },
            { title: "坏", url: "javascript:x", folder: "F" },
        ],
        existing
    ).entries;
    assert.deepEqual(countBookmarkStatus(mixed), {
        total: 3,
        added: 1,
        duplicate: 1,
        invalid: 1,
    });
});
