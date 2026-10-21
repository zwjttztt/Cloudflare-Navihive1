// tests/densityMetrics.test.ts
// 卡片密度三档（2026-10-21 加的「超紧凑」，质量评估 A2）。
//
// 钉三件事：
//   ① **紧凑档的数值必须与加档之前完全一致** —— 老用户切回紧凑档不该看到任何变化；
//   ② 三档在「尺寸类」数值上必须单调收紧，否则「超紧凑」名不副实；
//   ③ 组件里不许再出现 `density === "compact"` 这种二元判断 ——
//      那是「每加一档都要改 N 处」的老结构，漏一处就会出现某个角落还是旧档位。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { densityMetrics, normalizeDensity } from "../src/utils/densityMetrics";
import { projectDir } from "./helpers/notesSource";

test("紧凑档的数值 = 加第三档之前的历史值（老用户视觉零变化）", () => {
    const m = densityMetrics("compact");
    // 这些数字来自 2026-10-21 之前的 SiteCard / GroupCard 里的三元表达式，逐个抄下来钉住
    assert.equal(m.listAvatar, 28);
    assert.equal(m.listPaddingY, 0.5);
    assert.equal(m.showListDescription, false);
    assert.deepEqual(m.cardContentPadding, { xs: 1.25, sm: 1.25 });
    assert.equal(m.cardTitleGap, 0.5);
    assert.equal(m.wallAvatar, 40);
    assert.equal(m.wallPadding, 1);
    assert.equal(m.wallFontSize, 10);
    assert.equal(m.cellPadding, 0.5);
    assert.equal(m.gridGap, -0.5);
    assert.equal(m.groupCardHeight, 120);
});

test("舒适档的数值 = 历史值", () => {
    const m = densityMetrics("comfortable");
    assert.equal(m.listAvatar, 36);
    assert.equal(m.listPaddingY, 1);
    assert.equal(m.showListDescription, true);
    assert.deepEqual(m.cardContentPadding, { xs: 1.5, sm: 2 });
    assert.equal(m.wallAvatar, 48);
    assert.equal(m.gridGap, -1);
    assert.equal(m.groupCardHeight, 150);
});

test("三档尺寸单调收紧：舒适 > 紧凑 > 超紧凑", () => {
    const c = densityMetrics("comfortable");
    const k = densityMetrics("compact");
    const u = densityMetrics("ultra");
    assert.ok(c.listAvatar > k.listAvatar && k.listAvatar > u.listAvatar, "列表头像要越来越小");
    assert.ok(c.wallAvatar > k.wallAvatar && k.wallAvatar > u.wallAvatar, "图标墙头像要越来越小");
    assert.ok(c.listPaddingY > k.listPaddingY && k.listPaddingY > u.listPaddingY, "内边距要越来越小");
    assert.ok(c.groupCardHeight > k.groupCardHeight && k.groupCardHeight > u.groupCardHeight);
    // gap 是负数（重叠收紧），越紧越接近 0
    assert.ok(c.gridGap < k.gridGap && k.gridGap < u.gridGap, "网格间距要越来越紧");
    // 描述只在舒适档显示
    assert.equal(k.showListDescription, false);
    assert.equal(u.showListDescription, false);
});

test("认不出来的档位按舒适处理（脏数据不能把卡片压扁）", () => {
    assert.deepEqual(densityMetrics("ultra").listAvatar, 22);
    assert.equal(densityMetrics("nonsense").listAvatar, 36);
    assert.equal(densityMetrics(null).listAvatar, 36);
    assert.equal(densityMetrics(undefined).listAvatar, 36);
});

test("normalizeDensity：白名单，非法值回落舒适档", () => {
    assert.equal(normalizeDensity("comfortable"), "comfortable");
    assert.equal(normalizeDensity("compact"), "compact");
    assert.equal(normalizeDensity("ultra"), "ultra");
    assert.equal(normalizeDensity("ULTRA"), "comfortable");
    assert.equal(normalizeDensity(""), "comfortable");
    assert.equal(normalizeDensity(null), "comfortable");
    assert.equal(normalizeDensity(42), "comfortable");
});

test("组件里不许再写 `density === \"compact\"` 这种二元判断", () => {
    // 为什么要这条：加第三档时真正的风险不是「写错数值」，而是「漏改一处」——
    // 漏掉的那处仍然只会区分「紧凑 / 非紧凑」，于是超紧凑档在那一处表现成舒适档。
    // 而且它长得完全合法，code review 和类型检查都拦不住。
    const dir = join(projectDir(), "src", "components");
    const offenders: string[] = [];
    const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.tsx?$/.test(entry.name)) continue;
            const src = readFileSync(full, "utf-8");
            src.split("\n").forEach((line, i) => {
                // 只盯裸 `density`：记事本自己有 `uiSettings.density`（独立的两档设置），
                // 它跟这张表无关，不该被这条守卫管
                if (/(?<![.\w])density\s*===\s*["']compact["']/.test(line)) {
                    offenders.push(`${entry.name}:${i + 1}  ${line.trim().slice(0, 80)}`);
                }
            });
        }
    };
    walk(dir);
    assert.deepEqual(offenders, [], "密度判断请走 utils/densityMetrics.ts，别再写二元判断");
});
