// tests/bookmarkImport.dom.test.tsx
// 书签导入的写库过程：hooks/useBookmarkImport。
//
// 解析（utils/bookmarks）、差异（utils/importDiff）、预览（ImportPreviewDialog）三处
// 都有用例，唯独「点确认之后到底往库里写了什么」这一层没有。而这层写错的后果是
// **数据错的**：分组重复建、排序号算错、图标模板没生效 —— 界面上都看不出来，
// 用户要等到翻列表才发现多了一排同名的分组。
//
// 搬出来的目的就是这个：让这层能被单独测到。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    BOOKMARK_IMPORT_CONCURRENCY,
    useBookmarkImport,
    type BookmarkImportApi,
} from "../src/hooks/useBookmarkImport";
import type { Group, Site } from "../src/API/http";
import type { GroupWithSites } from "../src/types";
import type { ParsedBookmarkGroup } from "../src/utils/bookmarks";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Recorded {
    createdGroups: Group[];
    createdSites: Site[];
    refreshCalls: { silent: boolean }[];
    notes: string[];
    /** 同一时刻在飞的请求数（用来验证并发真的有上限） */
    maxInflight: number;
}

let rec: Recorded;
let nextId = 1;
/** 让 createSite 变慢，才能观测到并发上限 */
let siteDelayMs = 0;

function makeApi(): BookmarkImportApi {
    let inflight = 0;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    return {
        createGroup: async (input: Group) => {
            const g = { ...input, id: nextId++ } as Group;
            rec.createdGroups.push(g);
            return g;
        },
        createSite: async (input: Site) => {
            inflight += 1;
            rec.maxInflight = Math.max(rec.maxInflight, inflight);
            if (siteDelayMs) await sleep(siteDelayMs);
            rec.createdSites.push(input);
            inflight -= 1;
            return { ...input, id: nextId++ } as Site;
        },
    };
}

type Harness = {
    groups: GroupWithSites[];
    iconApi?: string;
};

let latestImport:
    | ((parsed: ParsedBookmarkGroup[]) => Promise<number>)
    | null = null;

function Probe({ groups, iconApi = "" }: Harness) {
    const { importBookmarks } = useBookmarkImport({
        api: sharedApi,
        groups,
        iconApi,
        refresh: async (opts?: { silent?: boolean }) => {
            rec.refreshCalls.push({ silent: Boolean(opts?.silent) });
        },
        onNotify: m => {
            rec.notes.push(m);
        },
    });
    latestImport = importBookmarks;
    return null;
}

let sharedApi: BookmarkImportApi;

function mount(harness: Harness) {
    rec = {
        createdGroups: [],
        createdSites: [],
        refreshCalls: [],
        notes: [],
        maxInflight: 0,
    };
    nextId = 1;
    siteDelayMs = 0;
    sharedApi = makeApi();

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<Probe {...harness} />);
    });
}

const cleanup = () => {
    if (root) {
        act(() => root!.unmount());
    }
    host?.remove();
    root = null;
    host = null;
    latestImport = null;
};

afterEach(cleanup);

async function run(parsed: ParsedBookmarkGroup[]): Promise<number> {
    assert.ok(latestImport);
    let n = 0;
    await act(async () => {
        n = await latestImport!(parsed);
    });
    return n;
}

const folder = (
    name: string,
    items: { title: string; url: string }[]
): ParsedBookmarkGroup => ({ folder: name, items } as ParsedBookmarkGroup);

const existingGroup = (id: number, name: string, siteCount = 0): GroupWithSites =>
    ({
        id,
        name,
        sites: Array.from({ length: siteCount }, (_, i) => ({ id: i + 1 })),
    }) as unknown as GroupWithSites;

// ---------- 分组 ----------

test("没有同名分组时才新建", async () => {
    mount({ groups: [] });
    const n = await run([folder("书签栏", [{ title: "A", url: "https://a.com" }])]);

    assert.equal(n, 1);
    assert.deepEqual(
        rec.createdGroups.map(g => g.name),
        ["书签栏"]
    );
});

test("同名文件夹复用已有分组，不重复建", async () => {
    // 浏览器导出的书签里「书签栏」几乎一定存在，每次导入都新建的话，
    // 库里会躺一排同名分组
    mount({ groups: [existingGroup(7, "书签栏", 2)] });
    await run([folder("书签栏", [{ title: "A", url: "https://a.com" }])]);

    assert.deepEqual(rec.createdGroups, [], "已有的分组不该再建一个");
    assert.equal(rec.createdSites[0].group_id, 7, "卡片要建到那个已有分组里");
    // 已有 2 张卡，新卡片从 2 开始排
    assert.equal(rec.createdSites[0].order_num, 2);
});

test("多个新分组的排序号递增，不撞车", async () => {
    mount({ groups: [] });
    await run([
        folder("甲", [{ title: "A", url: "https://a.com" }]),
        folder("乙", [{ title: "B", url: "https://b.com" }]),
    ]);

    assert.deepEqual(rec.createdGroups.map(g => g.order_num), [0, 1]);
});

test("已有的分组数量会算进新分组的排序号", async () => {
    mount({ groups: [existingGroup(1, "旧分组"), existingGroup(2, "旧分组2")] });
    await run([folder("新的", [{ title: "A", url: "https://a.com" }])]);

    assert.equal(rec.createdGroups[0].order_num, 2, "不能盖掉已有分组的位置");
});

test("空文件夹跳过，不建分组", async () => {
    mount({ groups: [] });
    const n = await run([folder("空的", [])]);

    assert.equal(n, 0);
    assert.deepEqual(rec.createdGroups, []);
});

// ---------- 卡片 ----------

test("卡片字段：标题截断到 60、带图标、带排序号", async () => {
    mount({ groups: [existingGroup(3, "G")], iconApi: "https://ico/{domain}.png" });
    await run([
        folder("G", [
            { title: "A".repeat(200), url: "https://a.example.com/x" },
            { title: "B", url: "https://b.example.com/y" },
        ]),
    ]);

    const [a, b] = rec.createdSites;
    assert.equal(a.name.length, 60, "书签标题可能很长，要截断");
    assert.equal(a.url, "https://a.example.com/x");
    assert.equal(a.icon, "https://ico/a.example.com.png", "图标要按模板拼出来");
    assert.deepEqual(
        [a.order_num, b.order_num],
        [0, 1],
        "同一批里的排序号要连续"
    );
});

test("没配图标 API 时回落到默认服务，而不是留空", async () => {
    mount({ groups: [existingGroup(3, "G")], iconApi: "" });
    await run([folder("G", [{ title: "A", url: "https://a.example.com/x" }])]);

    assert.ok(rec.createdSites[0].icon, "留空的话卡片就没有图标了");
    assert.ok(rec.createdSites[0].icon.includes("a.example.com"));
});

test("并发有上限：几百条书签不会同一时刻全发出去", async () => {
    mount({ groups: [existingGroup(3, "G")] });
    siteDelayMs = 5; // 让每条变慢，才观测得到同时在飞几个
    const items = Array.from({ length: 30 }, (_, i) => ({
        title: `站点${i}`,
        url: `https://s${i}.example.com`,
    }));
    await run([folder("G", items)]);

    assert.equal(rec.createdSites.length, 30, "全都得建出来");
    assert.ok(
        rec.maxInflight <= BOOKMARK_IMPORT_CONCURRENCY,
        `同时在飞的请求数 ${rec.maxInflight} 超过了上限 ${BOOKMARK_IMPORT_CONCURRENCY}`
    );
    assert.ok(rec.maxInflight > 1, "完全串行的话一份大书签要等很久");
});

// ---------- 收尾 ----------

test("导入完会刷新，而且是静默的（过程本身没有加载态）", async () => {
    mount({ groups: [] });
    await run([folder("G", [{ title: "A", url: "https://a.com" }])]);

    assert.equal(rec.refreshCalls.length, 1);
    assert.equal(rec.refreshCalls[0].silent, true, "再弹一个加载态会显得卡");
});

test("提示里报的是实际建了多少条", async () => {
    mount({ groups: [] });
    await run([
        folder("甲", [
            { title: "A", url: "https://a.com" },
            { title: "B", url: "https://b.com" },
        ]),
        folder("乙", [{ title: "C", url: "https://c.com" }]),
    ]);

    assert.deepEqual(rec.notes, ["已导入 3 个网站"]);
});

test("导入失败会往上抛，不会被静默吞掉", async () => {
    mount({ groups: [] });
    sharedApi = {
        ...makeApi(),
        createGroup: async () => {
            throw new Error("写入失败");
        },
    };
    // 换 api 之后要重新渲染一次才拿得到新的回调
    act(() => {
        root!.render(<Probe groups={[]} />);
    });

    await assert.rejects(() => run([folder("G", [{ title: "A", url: "https://a.com" }])]));
    assert.deepEqual(rec.notes, [], "失败了就不能报「已导入」");
});
