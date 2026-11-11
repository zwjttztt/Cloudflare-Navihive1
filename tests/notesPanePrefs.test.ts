// tests/notesPanePrefs.test.ts
// 「打开记事本恢复上次编辑器档位」的读写层 + 源码接线守卫。
//
// 光测读写函数不够：真正容易坏的是 useNotesPageModel 又被人改回
// useState<Pane>("split")，或者写回 effect 掉了 —— 那种回归单测全绿但用户
// 每次打开还是分栏。所以最后两条直接钉源码接线。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_NOTES_PANE,
    NOTES_PANE_KEY,
    readNotesPane,
    writeNotesPane,
} from "../src/utils/notesSettings";
import { readNotesFile } from "./helpers/notesSource";

test("从没存过：默认仍是分栏（老用户 / 视觉基线不破）", () => {
    localStorage.clear();
    assert.equal(DEFAULT_NOTES_PANE, "split");
    assert.equal(readNotesPane(), "split");
});

test("三种档位都能往返：写完再读回来一致", () => {
    for (const pane of ["edit", "split", "preview"] as const) {
        localStorage.clear();
        writeNotesPane(pane);
        assert.equal(localStorage.getItem(NOTES_PANE_KEY), pane);
        assert.equal(readNotesPane(), pane);
    }
});

test("脏值一律回落到分栏，绝不把非法档位塞进渲染", () => {
    for (const bad of [
        "", "SPLIT", "both", "null", "undefined", "0",
        "<script>", "edit\n", JSON.stringify({ pane: "edit" }), "[]",
    ]) {
        localStorage.setItem(NOTES_PANE_KEY, bad);
        assert.equal(readNotesPane(), "split", `${JSON.stringify(bad)} 应回落到默认档`);
    }
    localStorage.removeItem(NOTES_PANE_KEY);
});

test("写入侧也过白名单：脏类型不会污染 localStorage", () => {
    localStorage.clear();
    writeNotesPane("bogus" as never);
    assert.equal(localStorage.getItem(NOTES_PANE_KEY), "split");
    assert.equal(readNotesPane(), "split");
});

test("键彼此独立：写档位不动 uiSettings，写 uiSettings 不动档位", () => {
    localStorage.clear();
    localStorage.setItem("notes.uiSettings", JSON.stringify({ previewFontSize: 18 }));
    writeNotesPane("preview");
    assert.equal(JSON.parse(localStorage.getItem("notes.uiSettings")!).previewFontSize, 18);
    assert.equal(readNotesPane(), "preview");
    localStorage.clear();
});

test("localStorage 抛错（隐私模式）：读回落默认、写静默不抛", () => {
    const original = globalThis.localStorage;
    const throwing = {
        getItem: () => { throw new Error("SecurityError"); },
        setItem: () => { throw new Error("QuotaExceededError"); },
    } as unknown as Storage;
    try {
        Object.defineProperty(globalThis, "localStorage", { value: throwing, configurable: true });
        assert.equal(readNotesPane(), "split");
        assert.doesNotThrow(() => writeNotesPane("edit"));
    } finally {
        Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
});

test("接线守卫：初值来自持久化，不能再写死 split", () => {
    const src = readNotesFile("useNotesPageModel.tsx");
    assert.doesNotMatch(
        src,
        /useState<Pane>\("split"\)/,
        "写死初始档位会让每次打开都回到分栏，必须走 readNotesPane"
    );
    assert.match(src, /useState<Pane>\(readNotesPane\)/, "初值要从 localStorage 恢复");
    assert.match(src, /readNotesPane/, "必须 import 读侧");
});

test("接线守卫：档位变化要写回，且挂载时不写默认值", () => {
    const src = readNotesFile("useNotesPageModel.tsx");
    assert.match(src, /writeNotesPane\(pane\)/, "切换档位要落盘，刷新才不丢");
    assert.match(src, /\[pane\]/, "写回 effect 的依赖里要有 pane");
    assert.match(
        src,
        /lastPaneRef\.current === pane/,
        "挂载那一次要跳过：没动过就别把默认值写进 localStorage（会串味到别的用例）"
    );
});
