# 覆盖率体检（2026-10-13）

`npm run coverage` 的数据化结论。目标只有一个：**把「哪些代码从来没被用例碰过」变成一张能查的表**，
然后按风险排序，决定下一批测试该补谁。

---

## 0. 先说一件顺手修掉的事：覆盖率脚本本身是坏的

跑 `npm run coverage` 直接崩：

```
X [ERROR] No loader is configured for ".woff" files: node_modules/katex/dist/fonts/...
Error: Build failed with 60 errors
```

原因：`script/coverage.mjs` 的 esbuild 配置少了字体/样式 loader。某些用例会连带引入
`katex.min.css`，里面 `url()` 指向十几张 woff2/ttf，esbuild 默认不认这些后缀。
`script/unit-tests.mjs` 早就配了（`loader: { ".css": "empty", ".woff": "file", ... }`，
见那里的注释），覆盖率脚本漏抄了。补上之后正常。

> 这条值得记一笔：**覆盖率工具坏了比没有覆盖率更糟** —— 它会让人以为「没数据」而不是「工具坏了」。

---

## 1. 总体数字

| 口径 | 体检时（上午） | 补完分享 UI 后（晚间） | 补完书签导入后（深夜） | 补完 AI 三件套后（深夜） |
|---|---|---|---|---|
| 源文件（src/ + worker/，排除 .d.ts） | 286 个 | 286 个 | 286 个 | 286 个 |
| 被任何用例间接引入 | 243 个（85%） | **246 个** | **247 个** | **250 个** |
| **从未被引入** | **43 个（15%），合计 8635 行** | **40 个，合计 8103 行** | **39 个，合计 7723 行** | **36 个，合计 6774 行** |

口径说明（`script/coverage.mjs` 文件头有完整版）：这是**文件触及率**，不是行覆盖率 ——
一个文件只被 import 了一行也算触及。所以它回答的是「哪个模块压根没人碰」，
回答不了「这个模块覆盖了百分之几」。要行覆盖率得装 c8（脚本第 2 层会自动接上）。

---

## 2. 后端：干净得令人意外

43 个未触及文件里，`worker/` 只占 **2 个**，而且两个都是**纯类型声明**：

| 文件 | 行数 | 运行时可执行声明 |
|---|---|---|
| `worker/types.ts` | 181 | 0 |
| `worker/routes/types.ts` | 32 | 0 |

（用 `^(export )?(async )?function | ^export const | ^export class` 数过，确实是 0。）

也就是说：**所有带逻辑的 worker 模块都至少被一个用例引入过**。分享、备份、WebDAV、
图标代理、迁移、登录守卫这些高风险路径的后端实现，没有一个是零覆盖的。
再加上本轮新增的 `script/share-e2e.mjs`（CI 自动跑），分享那条链的后端是真打过的。

**结论：风险不在后端。**

---

## 3. 前端：43 个零覆盖，风险集中在三类

### 3.1 分享 UI —— 本次体检最该注意的一处（**已于当晚补完**）

体检时（上午）的状态：

| 文件 | 行数 | 当时 | 现在 |
|---|---|---|---|
| `src/components/GroupShareDialog.tsx` | 243 | ❌ 零覆盖 | ✅ `tests/groupShareDialog.dom.test.tsx` 14 条 |
| `src/components/PublicGroupPage.tsx` | 158 | ❌ 零覆盖 | ✅ `tests/publicGroupPage.dom.test.tsx` 9 条 |
| `src/components/PublicNotePage.tsx` | 131 | ❌ 零覆盖 | ✅ `tests/publicNotePage.dom.test.tsx` 9 条 |
| `src/components/NoteShareDialog.tsx` | — | ✅ 已覆盖（`notes.dom.test.tsx` 有真渲染用例） | ✅ |

⚠️ 当时记录的两个观察，现在仍然有效：

- **一个不对称**：笔记分享的对话框有真用例，分组分享的对话框没有 —— 两者是同一天
  （2026-10-11 阶段④）按同一套语义加的，测试只跟着前一批写了。
- ⚠️ **「有测试提到」≠「有测试覆盖」**：这三个文件都有静态守卫提到它们，但那是**读源码字符串**的
  文本守卫（`groupShareMount.test.ts` 用 `readSrcFile`、`notes.dom.test.tsx` 同样），
  不是真的把组件拉起来跑。文本守卫能钉住「挂载条件写在哪儿」，钉不住「弹出口令框之后输入框到底出现没出现」。
  而分享的坑恰恰全在交互侧：口令错了提示什么、撤销之后界面怎么变、匿名访客看到什么。

补测试的收获超出了预期：**当场抓出两个「卡在加载态」的真 bug**（详见 CHANGELOG 同日条目）——
`GroupShareDialog` 读配置失败后永远停在「读取中…」、`PublicGroupPage` 网络失败后永远停在
「正在加载分享…」。两个都不报错，只是让人干等，静态守卫和类型检查都抓不到。

### 3.2 备份恢复的导入 UI

| 文件 | 行数 | 状态 |
|---|---|---|
| `src/components/BookmarkImportDialog.tsx` | 380 | ❌ 零覆盖 |

worker 侧的导入/恢复/WebDAV 都有覆盖（`backupRoutes.test.ts`、`webdav-e2e.mjs`），
但**用户实际点的那条路**（选文件 → 预览 → 确认 → 看到结果）没有。这是「备份恢复了但
用户在界面上不知道恢复了什么」这类问题的盲区。

### 3.3 其他值得知道的

| 文件 | 行数 | 备注 |
|---|---|---|
| `src/App.tsx` | 2076 | 全仓最大零覆盖文件。30 多个用例「提到」它，但都是文本守卫或走 mock 的 hook 测试 |
| `src/components/NotesOverlay.tsx` | 391 | 记事本入口 |
| ~~`src/components/AiAssistantDialog.tsx`~~ | ~~480~~ | ✅ 已于当天补完（14 条） |
| ~~`src/components/AiSuggestDialog.tsx`~~ | ~~288~~ | ✅ 已于当天补完（7 条） |
| ~~`src/hooks/useAiAssistant.ts`~~ | ~~181~~ | ✅ 已于当天补完（12 条） |
| `src/components/VisitsDialog.tsx` | 297 | 访问统计 |

~~AI 三个文件合计 949 行，是继分享 UI 之后的第二大空白。已于当天补完，见第 4 节。~~

---

## 4. 建议的补测试顺序（按「坏了有多难发现」排，不按行数排）

1. ~~**分享 UI 三件套（532 行）**~~ —— ✅ **已于当天补完**（32 条用例，并抓出两个真 bug）。
2. ~~**`BookmarkImportDialog`（380 行）**~~ —— ✅ **已于当天补完**（14 条用例，抓出一个自相矛盾的计数显示）。
3. ~~**AI 三件套（949 行）**~~ —— ✅ **已于当天补完**（33 条用例：hook 12 / AiAssistantDialog 14 / AiSuggestDialog 7，抓出一个假体形状错误但产品代码无恙）。
4. **`App.tsx`（2076 行）** —— 全仓最大零覆盖文件，30 多个用例「提到」它但都是文本守卫或 mock。**清单仅剩这一项**。

---

## 5. 明确不做的事

- **不设覆盖率门槛、不卡 CI**（`coverage.mjs` 文件头已写明）：覆盖率是导航用的，先有数据再谈数字。
  现在是 85% 文件触及率，拿它当门槛只会逼出「为覆盖而覆盖」的用例。
- **不装 c8**：那是新增一个 devDependency，会影响 CI 安装步骤，
  而第 1 层的清单已经够回答「下一个该补谁」。想要行覆盖率再说。

---

## 6. 复现方式

```bash
npm run coverage
```

第 1 层零依赖、秒级出结果；装了 c8 会自动多跑第 2 层行覆盖率
（`npm install --ignore-scripts -D c8`，报告落 `coverage/`）。
