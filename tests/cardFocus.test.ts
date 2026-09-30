// tests/cardFocus.test.ts
// 方向键在卡片网格里移动焦点（从 App.tsx 抽出来的 utils/cardFocus.ts）。
//
// 抽出来的理由就是为了能这样测：它在 App 里的时候，想验证「向右到底另起一行」得先
// 起整个 React 树；现在喂几个矩形就能验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { focusCardByDirection, NavCard } from "../src/utils/cardFocus";

interface Fake extends NavCard {
    name: string;
    focused: number;
}

function card(name: string, left: number, top: number, width = 160, height = 96): Fake {
    return {
        name,
        focused: 0,
        getAttribute: () => "true",
        getBoundingClientRect: () => ({
            left,
            right: left + width,
            top,
            bottom: top + height,
        }),
        focus() {
            this.focused++;
        },
    };
}

/** 3 列 × 2 行：A B C / D E F */
function grid(): Fake[] {
    return [
        card("A", 0, 0),
        card("B", 180, 0),
        card("C", 360, 0),
        card("D", 0, 120),
        card("E", 180, 120),
        card("F", 360, 120),
    ];
}

function focusedName(cards: Fake[]): string | null {
    return cards.find(c => c.focused > 0)?.name ?? null;
}

test("当前没有卡片被聚焦时，聚焦第一个", () => {
    const cards = grid();
    focusCardByDirection("right", { cards, active: null });
    assert.equal(focusedName(cards), "A");
});

test("向右 / 向左：在同一行里按 X 位置取最近的一个", () => {
    const cards = grid();
    focusCardByDirection("right", { cards, active: cards[0] }); // A -> B
    assert.equal(focusedName(cards), "B");

    const back = grid();
    focusCardByDirection("left", { cards: back, active: back[2] }); // C -> B
    assert.equal(focusedName(back), "B");
});

test("向下 / 向上：在同一列里按 Y 位置取最近的一个", () => {
    const cards = grid();
    focusCardByDirection("down", { cards, active: cards[1] }); // B -> E
    assert.equal(focusedName(cards), "E");

    const up = grid();
    focusCardByDirection("up", { cards: up, active: up[4] }); // E -> B
    assert.equal(focusedName(up), "B");
});

test("到边界时保持当前焦点（不会跳到别的列/行去）", () => {
    const first = grid();
    focusCardByDirection("left", { cards: first, active: first[0] }); // A 左边没有
    assert.equal(focusedName(first), "A", "原地不动");

    const bottom = grid();
    focusCardByDirection("down", { cards: bottom, active: bottom[3] }); // D 下面没有
    assert.equal(focusedName(bottom), "D");
});

test("行判定有容差：标题换行的卡片比同伴高十几像素也仍算同一行", () => {
    // B 比 A 高 20px（标题换了两行），但垂直中心只差 10px < 16px 容差
    const tallRowB = card("B", 180, -10, 160, 116);
    const cards = [card("A", 0, 0), tallRowB, card("C", 360, 0)];
    focusCardByDirection("right", { cards, active: cards[0] });
    assert.equal(focusedName(cards), "B", "高度不同但中心接近，仍应左右移动");
});

test("明显错开的卡片不算同一行：右边没有同伴就原地不动", () => {
    // 唯一在右边的卡片在下一行（垂直中心差 200px，远超 16px 容差）
    const cards = [card("A", 0, 0), card("X", 180, 200)];
    focusCardByDirection("right", { cards, active: cards[0] });
    assert.equal(focusedName(cards), "A", "下一行的卡片不该被当成右边邻居");
});

test("列判定同理：错开的卡片不算同一列", () => {
    const cards = [card("A", 0, 0), card("X", 300, 120)];
    focusCardByDirection("down", { cards, active: cards[0] });
    assert.equal(focusedName(cards), "A");
});

test("当前焦点不是卡片时，当作没聚焦（聚焦第一个）", () => {
    const other = { getAttribute: () => null };
    const cards = grid();
    focusCardByDirection("down", {
        cards,
        active: { ...other, getBoundingClientRect: () => card("z", 0, 0).getBoundingClientRect(), focus() {} } as NavCard,
    });
    assert.equal(focusedName(cards), "A");
});

test("没有卡片时不报错", () => {
    focusCardByDirection("down", { cards: [], active: null });
});
