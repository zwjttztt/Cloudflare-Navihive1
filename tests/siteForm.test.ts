// tests/siteForm.test.ts
// 新建卡片表单的纯计算单测。锁的是两条很容易被改坏、改坏了又不报错的行为：
//   1. 账号 / 密码输入框为了躲浏览器识别叫 site-account / site-secret，
//      落到状态里必须还原成 username / password（写错 = 打字没反应）；
//   2. 改网址时图标要自动跟着变，**但只能覆盖自动生成的那个值** ——
//      用户手填过的图标被冲掉，是那种「用户说不清哪不对但很烦」的 bug。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Site } from "../src/API/http";
import { applySiteInputChange, emptySiteDraft, nextSiteOrderNum } from "../src/utils/siteForm";

const ICON_API = "https://icon.example/{domain}";
const autoIcon = (url: string) => `https://icon.example/${new URL(url).hostname}`;

test("初始草稿：字段齐全且都是空值", () => {
    assert.deepEqual(emptySiteDraft(), {
        name: "",
        url: "",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: "",
        order_num: 0,
        group_id: 0,
    });
});

test("普通字段按原样写入状态", () => {
    const next = applySiteInputChange({}, ICON_API, "name", "云设");
    assert.equal(next.name, "云设");
});

test("账号 / 密码框的别名还原成 username / password", () => {
    const account = applySiteInputChange({}, ICON_API, "site-account", "alice");
    assert.equal(account.username, "alice");
    assert.equal((account as Record<string, unknown>)["site-account"], undefined);

    const secret = applySiteInputChange({}, ICON_API, "site-secret", "s3cret");
    assert.equal(secret.password, "s3cret");
    assert.equal((secret as Record<string, unknown>)["site-secret"], undefined);
});

test("改网址：图标为空时自动生成", () => {
    const next = applySiteInputChange({ url: "", icon: "" }, ICON_API, "url", "https://yunso.net/x");
    assert.equal(next.url, "https://yunso.net/x");
    assert.equal(next.icon, autoIcon("https://yunso.net/x"));
});

test("改网址：图标就是上一次自动生成的值时，跟着一起更新", () => {
    const prev: Partial<Site> = {
        url: "https://old.com",
        icon: autoIcon("https://old.com"),
    };
    const next = applySiteInputChange(prev, ICON_API, "url", "https://new.com");
    assert.equal(next.icon, autoIcon("https://new.com"));
});

test("改网址：用户手填过的图标**绝不能**被冲掉", () => {
    const prev: Partial<Site> = {
        url: "https://old.com",
        icon: "https://cdn.example/my-logo.png",
    };
    const next = applySiteInputChange(prev, ICON_API, "url", "https://new.com");
    assert.equal(next.icon, "https://cdn.example/my-logo.png");
});

test("改别的字段时不动图标", () => {
    const prev: Partial<Site> = { url: "https://a.com", icon: "https://cdn.example/keep.png" };
    const next = applySiteInputChange(prev, ICON_API, "description", "说明");
    assert.equal(next.icon, "https://cdn.example/keep.png");
    assert.equal(next.description, "说明");
});

test("清空网址：自动图标跟着清空（用户手填的仍然保留）", () => {
    // 顺带说明：这里不做「网址合不合法」的判断 —— getDomainFromUrl 很宽松
    // （填「不是一个网址」也会被 new URL 转成 punycode 域名，照样生成图标）。
    // 合法性交给提交时的 normalizeUrl（见 utils/url.ts），两件事别混在一起。
    const auto = applySiteInputChange(
        { url: "https://a.com", icon: autoIcon("https://a.com") },
        ICON_API,
        "url",
        ""
    );
    assert.equal(auto.icon, "");

    const kept = applySiteInputChange(
        { url: "https://a.com", icon: "https://cdn.example/keep.png" },
        ICON_API,
        "url",
        ""
    );
    assert.equal(kept.icon, "https://cdn.example/keep.png");
});

test("新卡片排在当前分组末尾", () => {
    assert.equal(nextSiteOrderNum({ sites: [] }), 0);
    assert.equal(nextSiteOrderNum(undefined), 0, "分组不存在时也从 0 开始");
    assert.equal(
        nextSiteOrderNum({ sites: [{ order_num: 0 }, { order_num: 7 }, { order_num: 3 }] }),
        8
    );
});
