// tests/siteNoteLink.test.ts
// D2「站点 ↔ 笔记双向绑定」的判据层用例。
//
// 这一层是**两边共用的同一套判据**：笔记侧 `[[GitHub]]` 点了跳站点、
// 站点侧列出「关于它的笔记」。判据一旦两边长得不一样，
// 就会出现「笔记里点得开、站点里列不出来」—— 两边单看都正常，合起来才是 bug。
// 所以这里钉的就是那几条容易写歪的匹配规则。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    findSiteByTarget,
    normalizeSiteLabel,
    siteMatchKeys,
    siteMatchesTarget,
    siteUrlKey,
} from "../src/utils/siteMatch";
import { noteMentionsSite, notesMentioningSite } from "../src/utils/siteNoteLink";
import { clearSiteIndex, findIndexedSite, getSiteIndex, setSiteIndex } from "../src/utils/siteIndex";

const GH = { id: 1, name: "GitHub", url: "https://github.com/zwjttztt" };

test("网址归一化：协议 / www / 尾斜杠 都不影响同一个站的判定", () => {
    // 用户手写网址时这四样每一种都可能不一样 —— 不归一的话「笔记里写了
    // https://x.com、站点里存的是 x.com」会被判成两个不相干的站。
    assert.equal(siteUrlKey("https://www.Example.com/foo/"), "example.com/foo");
    assert.equal(siteUrlKey("http://example.com/foo"), "example.com/foo");
    assert.equal(siteUrlKey("example.com/foo"), "example.com/foo");
    assert.equal(siteUrlKey("EXAMPLE.com"), "example.com");
});

test("站点别名：名字 + host+path + 纯 host 三个都能命中", () => {
    assert.deepEqual(siteMatchKeys(GH), [
        "github",
        "github.com/zwjttztt",
        "github.com",
    ]);
    // 名字归一化：大小写与多余空白不算差别
    assert.equal(normalizeSiteLabel("  GitHub  Docs "), "github docs");
});

test("[[目标]] 认名字，也认网址", () => {
    assert.ok(siteMatchesTarget(GH, "github"), "站名（大小写不敏感）");
    assert.ok(siteMatchesTarget(GH, "GitHub"), "站名原样");
    assert.ok(siteMatchesTarget(GH, "github.com"), "纯 host");
    assert.ok(siteMatchesTarget(GH, "https://github.com/zwjttztt"), "完整网址");
    assert.ok(!siteMatchesTarget(GH, "gitlab"), "别的站不能命中");
    assert.ok(!siteMatchesTarget(GH, "   "), "空目标不命中");
});

test("找站点：名字优先于网址（用户打 [[GitHub]] 想的是叫这个名字的那个）", () => {
    const sites = [
        { id: 2, name: "我的镜像", url: "https://github.com" },
        { id: 1, name: "GitHub", url: "https://example.com" },
    ];
    assert.equal(findSiteByTarget(sites, "GitHub")?.id, 1, "同名优先，不是 host 那个");
    assert.equal(findSiteByTarget(sites, "https://github.com")?.id, 2, "打网址时按网址找");
    assert.equal(findSiteByTarget(sites, "不存在"), null);
});

test("提到站点：[[双链]] / 网址 / 站名 三种写法都算", () => {
    assert.ok(
        noteMentionsSite({ id: 1, title: "周报", content: "参考 [[GitHub]] 上的 issue" }, GH),
        "[[站名]] 是最显式的关联"
    );
    assert.ok(
        noteMentionsSite({ id: 2, title: "周报", content: "见 https://github.com/zwjttztt/x" }, GH),
        "直接贴网址也算"
    );
    assert.ok(
        noteMentionsSite({ id: 3, title: "周报", content: "今天把 github 的 CI 调通了" }, GH),
        "正文里提到站名也算"
    );
});

test("提到站点：行内代码 / 围栏里的不认（与双链同一套口径）", () => {
    // 双链解析本来就跳过代码区：示例代码里出现的站名不算「我提到了这个站」，
    // 否则一条写满 curl 命令的笔记会被所有站都认领。
    assert.ok(
        !noteMentionsSite(
            { id: 1, title: "笔记", content: "命令：`git clone https://github.com/x`" },
            GH
        ),
        "行内代码里的网址不算"
    );
    assert.ok(
        !noteMentionsSite(
            { id: 2, title: "笔记", content: "```\nhttps://github.com/x\n```" },
            GH
        ),
        "围栏代码里的网址不算"
    );
});

test("单字站名不做名字子串匹配（否则叫「A」的站会把半本笔记都认领）", () => {
    const a = { id: 9, name: "A", url: "https://a.example.com" };
    assert.ok(
        !noteMentionsSite({ id: 1, title: "笔记", content: "A 和 B 都在推进" }, a),
        "站名只有一个字符时不认名字子串（噪音比漏掉更糟）"
    );
    // 显式关联的两条判据不受影响
    assert.ok(
        noteMentionsSite({ id: 2, title: "笔记", content: "见 https://a.example.com/docs" }, a),
        "写了网址仍然算"
    );
    assert.ok(noteMentionsSite({ id: 3, title: "笔记", content: "[[A]] 又更新了" }, a), "[[A]] 仍然算");
    // 两字符及以上的中文站名照常认（「知乎」就是两个字，漏了才是 bug）
    assert.ok(
        noteMentionsSite({ id: 4, title: "笔记", content: "在知乎上看到的" }, { id: 8, name: "知乎", url: "" }),
        "两字站名不该被当成噪音漏掉"
    );
});

test("notesMentioningSite 只回跳得过去的（没有 id 的结果不给）", () => {
    const notes = [
        { id: 1, title: "甲", content: "[[GitHub]]" },
        { title: "乙（没 id）", content: "[[GitHub]]" },
        { id: 3, title: "丙", content: "无关内容" },
    ];
    assert.deepEqual(notesMentioningSite(notes, GH), [{ id: 1, title: "甲" }]);
});

test("站点索引：为空时退化成「不认」，不是报错", () => {
    // 没打开过首页 / 还没拉到站点时索引是空的。那时 `[[GitHub]]` 应当退化成
    // 原来的死链提示（只是不认），绝不能抛错或误判成笔记。
    clearSiteIndex();
    assert.equal(getSiteIndex().length, 0);
    assert.equal(findIndexedSite("GitHub"), null);

    setSiteIndex([GH]);
    assert.equal(findIndexedSite("github")?.id, 1);
    assert.equal(findIndexedSite("https://github.com/zwjttztt")?.id, 1);

    // 传 null / 空数组也要清干净（退出登录时不该还认得上一个账号的站）
    setSiteIndex(null);
    assert.equal(findIndexedSite("GitHub"), null);
});
