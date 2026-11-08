// tests/sensorRefStability.test.ts
// dnd-kit sensor options 的**引用稳定性**守卫（静态）。
//
// 为什么值得静态守卫：sensors 的 options 一旦写成内联对象字面量，每次渲染都会新建
// 一份 —— options 引用变 → useSensors 返回的 sensors 引用变 → 下游 memo 化的列表
// 组件 props 浅比较永远失败，「数据没动」却整列表重渲染。这类回退**不报错**，只会以
// 「莫名卡顿」的形式出现，常规单元测试也看不出来 —— 只能用静态守卫钉住形状。
//
// 契约：两个文件的 sensor options 都必须是**模块级常量**，调用处只传常量名。
//   · App.tsx：POINTER_/TOUCH_/KEYBOARD_SENSOR_OPTS
//   · GroupCard.tsx：GROUP_POINTER_/GROUP_TOUCH_/GROUP_KEYBOARD_SENSOR_OPTS
// 且两份是**独立策略**（触摸 100ms/3px vs 250ms/5px），不要为了去重合并成一份。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身
function readProjectFile(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

/** 剥掉行 / 块注释：注释里可能出现 `useSensor(PointerSensor, {…})` 这类说明文字，不该误判 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            const idx = line.indexOf("//");
            if (idx === -1) return line;
            return /:\/\/[\s\S]*$/.test(line.slice(0, idx)) ? line : line.slice(0, idx);
        })
        .join("\n");
}

const APP_SRC = stripComments(readProjectFile("src/App.tsx"));
const GROUP_CARD_SRC = stripComments(readProjectFile("src/components/GroupCard.tsx"));

/** 断言某文件里 `useSensor(X, 常量名)` 存在（\s* 容许换行 / 缩进差异） */
function assertUsesConst(src: string, sensor: string, constName: string, label: string) {
    const re = new RegExp(`useSensor\\(\\s*${sensor}\\s*,\\s*${constName}\\s*\\)`);
    assert.match(src, re, `${label}：${sensor} 的 options 必须传模块级常量 ${constName}`);
}

/** 断言某文件里不再有 `useSensor(X, { … })` 这种内联对象字面量 */
function assertNoInline(src: string, sensor: string, label: string) {
    const re = new RegExp(`useSensor\\(\\s*${sensor}\\s*,\\s*\\{`);
    assert.doesNotMatch(
        src,
        re,
        `${label}：${sensor} 的 options 不能是内联对象字面量（每次渲染都新建引用）`
    );
}

test("指针距离约束不能混入无 tolerance 的 delay 分支", () => {
    const policies: Array<[string, string]> = [
        [APP_SRC, "POINTER_SENSOR_OPTS"],
        [GROUP_CARD_SRC, "GROUP_POINTER_SENSOR_OPTS"],
    ];
    for (const [source, name] of policies) {
        const options = source.match(new RegExp(`const ${name} = (\\{[^;]+\\});`))?.[1];
        assert.ok(options, `${name} 必须存在`);
        assert.match(options, /distance:\s*5/);
        assert.doesNotMatch(options, /delay:/, "distance 指针策略不应进入延迟容差分支");
    }
});

test("App.tsx：三个 useSensor 都吃模块级常量，不是内联对象字面量", () => {
    assertUsesConst(APP_SRC, "PointerSensor", "POINTER_SENSOR_OPTS", "App.tsx");
    assertUsesConst(APP_SRC, "TouchSensor", "TOUCH_SENSOR_OPTS", "App.tsx");
    assertUsesConst(APP_SRC, "KeyboardSensor", "KEYBOARD_SENSOR_OPTS", "App.tsx");

    assertNoInline(APP_SRC, "PointerSensor", "App.tsx");
    assertNoInline(APP_SRC, "TouchSensor", "App.tsx");
    assertNoInline(APP_SRC, "KeyboardSensor", "App.tsx");
});

test("GroupCard.tsx：三个 useSensor 都吃 GROUP_* 模块级常量，不是内联对象字面量", () => {
    assertUsesConst(GROUP_CARD_SRC, "PointerSensor", "GROUP_POINTER_SENSOR_OPTS", "GroupCard.tsx");
    assertUsesConst(GROUP_CARD_SRC, "TouchSensor", "GROUP_TOUCH_SENSOR_OPTS", "GroupCard.tsx");
    assertUsesConst(GROUP_CARD_SRC, "KeyboardSensor", "GROUP_KEYBOARD_SENSOR_OPTS", "GroupCard.tsx");

    assertNoInline(GROUP_CARD_SRC, "PointerSensor", "GroupCard.tsx");
    assertNoInline(GROUP_CARD_SRC, "TouchSensor", "GroupCard.tsx");
    assertNoInline(GROUP_CARD_SRC, "KeyboardSensor", "GroupCard.tsx");
});

test("常量必须是模块级（在组件定义之前）声明，不能藏在组件体里", () => {
    // App.tsx 的组件是 `function App(`（文件底部 `export default App`）；
    // GroupCard 的组件是 `const GroupCard`。indexOf 比位置：常量必须排在组件之前，
    // 否则每次渲染仍会在组件体内重建 options，引用照样不稳定。
    const appConstAt = APP_SRC.indexOf("const POINTER_SENSOR_OPTS");
    const appComponentAt = APP_SRC.indexOf("function App(");
    assert.ok(appConstAt >= 0, "App.tsx 里找不到 `const POINTER_SENSOR_OPTS`");
    assert.ok(appComponentAt >= 0, "App.tsx 里找不到 `function App(`");
    assert.ok(
        appConstAt < appComponentAt,
        "App.tsx 的 sensor 常量必须在函数组件之外（模块级）声明，否则每次渲染都会重建"
    );

    const groupConstAt = GROUP_CARD_SRC.indexOf("const GROUP_POINTER_SENSOR_OPTS");
    const groupComponentAt = GROUP_CARD_SRC.indexOf("const GroupCard");
    assert.ok(groupConstAt >= 0, "GroupCard.tsx 里找不到 `const GROUP_POINTER_SENSOR_OPTS`");
    assert.ok(groupComponentAt >= 0, "GroupCard.tsx 里找不到 `const GroupCard`");
    assert.ok(
        groupConstAt < groupComponentAt,
        "GroupCard.tsx 的 sensor 常量必须在组件之外（模块级）声明，否则每次渲染都会重建"
    );
});

test("两份 options 是独立策略：数值不同，没有为了去重合并成一份", () => {
    // App.tsx：触摸延迟 100ms / 容差 3px；GroupCard：250ms / 5px。
    // 卡片更小更易误触，故 GroupCard 更保守 —— 别把两份硬合成一份共用。
    assert.match(
        APP_SRC,
        /TOUCH_SENSOR_OPTS\s*=\s*\{[^}]*delay:\s*100[^}]*tolerance:\s*3/,
        "App.tsx 的触摸阈值应保持 100ms / 3px（首页整行更宽容）"
    );
    assert.match(
        GROUP_CARD_SRC,
        /GROUP_TOUCH_SENSOR_OPTS\s*=\s*\{[^}]*delay:\s*250[^}]*tolerance:\s*5/,
        "GroupCard.tsx 的触摸阈值应保持 250ms / 5px（卡片更小更易误触，更保守）"
    );
});
