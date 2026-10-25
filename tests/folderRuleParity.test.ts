// tests/folderRuleParity.test.ts
// 3.3 mock 同源化的守卫（2026-10-22）。
//
// 同源化不是「把 1531 行 mock 删掉」，而是：**规则级别的东西只准有一份实现**。
// 第一刀选的是「文件夹不能移入自身或子文件夹」—— 这条在
//   src/API/methods/notes.ts（真机，查库）  与  src/API/mock.ts（本地，查内存数组）
// 各有一份，连报错文案都不一样。分叉的后果很隐蔽：本地 mock 跑通、真机换个说法，
// 而这种差异只在真机上才暴露。
//
// 守卫钉两件事：
//   1. 两侧都不许再内联自己的环路判定（见到 while/Set 那套就地实现的痕迹就红）；
//   2. 共享那份的行为本身要正确（移入自身 / 移入子级 / 多级 / 父级不存在 / 非法 ID）。
//
// ⚠️ 只断言字符串与布尔：断言失败路径里不放 DOM 元素（node:assert 会 util.inspect 它，
//    2026-10-21 因此把进程堆打爆过）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { projectDir as findProjectDir } from "./helpers/notesSource";
import {
    FOLDER_CYCLE_ERROR,
    FOLDER_ID_INVALID,
    validateFolderMove,
} from "../src/utils/folderTree";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = () => findProjectDir(here);
const read = (rel: string) => readFileSync(resolve(projectDir(), rel), "utf8");

/** 1 -> 根，2 -> 1，3 -> 2（3 在 1 下面） */
const tree: Record<number, number | null> = { 1: null, 2: 1, 3: 2 };
const lookup = async (id: number) => (id in tree ? tree[id] : undefined);

test("共享校验：移到根 / 移到合法父级都放行", async () => {
    await validateFolderMove({ parent: null, lookup });
    await validateFolderMove({ parent: 1, moving: 5, lookup });
});

test("共享校验：移入自身要拦", async () => {
    await assert.rejects(
        () => validateFolderMove({ parent: 2, moving: 2, lookup }),
        (e: Error) => e.message === FOLDER_CYCLE_ERROR,
        "把 2 移到 2 自己是环"
    );
});

test("共享校验：移入自己的子文件夹要拦（多级也算）", async () => {
    await assert.rejects(
        () => validateFolderMove({ parent: 3, moving: 1, lookup }),
        (e: Error) => e.message === FOLDER_CYCLE_ERROR,
        "1 是 3 的祖先，把 1 移到 3 下面会成环"
    );
});

test("共享校验：父级不存在要拦，且说法可定制（mock 侧没有账号概念）", async () => {
    await assert.rejects(
        () => validateFolderMove({ parent: 99, lookup }),
        (e: Error) => e.message === "目标文件夹不存在或不属于当前账号"
    );
    await assert.rejects(
        () => validateFolderMove({ parent: 99, lookup, notFoundMessage: "目标文件夹不存在" }),
        (e: Error) => e.message === "目标文件夹不存在"
    );
});

test("共享校验：ID 非法要拦（0 / 负数 / 非整数）", async () => {
    for (const bad of [0, -1, 1.5]) {
        await assert.rejects(
            () => validateFolderMove({ parent: bad, lookup }),
            (e: Error) => e.message === FOLDER_ID_INVALID,
            `parent=${bad} 应判为非法`
        );
    }
});

test("真机侧与 mock 侧都走共享实现（不许再各写一份）", () => {
    const real = read("src/API/methods/notes/notesShared.ts");
    const mock = read("src/API/mock.ts");
    for (const [name, src] of [["真机 notesShared.ts", real], ["mock.ts", mock]] as const) {
        assert.match(src, /utils\/folderTree/, `${name} 要引共享模块`);
        assert.match(src, /validateFolderMove/, `${name} 要调共享校验`);
    }
    // 反向验证：不许再出现「自己手写一套 while + Set 的环路判定」
    for (const [name, src] of [["真机 notesShared.ts", real], ["mock.ts", mock]] as const) {
        const inlineCycle = /new Set<number>\([\s\S]{0,120}while[\s\S]{0,400}不能移入自身或子文件夹/.test(src);
        assert.equal(inlineCycle, false, `${name} 里不该再有内联的环路判定`);
    }
});
