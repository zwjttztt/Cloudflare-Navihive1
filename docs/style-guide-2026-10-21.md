# 样式该写哪儿（2026-10-21）

> 承接质量评估 1.3：「新增组件时『该写哪儿』没有唯一答案」。
> 现状是四处在定义视觉：`index.css`（1288 行、39 处 `!important`）、
> 1225 处 `sx={}`、MUI theme 的 `styleOverrides`、以及 `App.css`。
> 这一页给一条能直接照做的判断顺序，不是审美规范。

## 一、四层各自管什么（从上到下，越靠上越优先改）

| 层 | 文件 | 管什么 | 什么时候改它 |
| --- | --- | --- | --- |
| **主题令牌** | `hooks/useThemeController.ts` | 颜色 / 字阶 / MUI 组件的默认外观（`styleOverrides`） | 「所有 Button 都该更圆一点」这类**全局一致**的诉求 |
| **CSS 变量** | `index.css` 的 `:root` / `html.dark` | 亮暗两态的自定义变量：`--accent`、`--radius-*`、`--dur-*`、`--glass-*`、编辑器相关 | 需要**跟随亮暗切换**、且 MUI 主题里没有对应概念的东西 |
| **语义类** | `index.css` 的 `.nav-*` / `.cm-*` / `.note-*` | 第三方库内部结构（CodeMirror、dnd-kit）、以及被多处复用的复合块 | `sx` 打不进去的地方（库自己生成的 DOM） |
| **单点样式** | 组件里的 `sx={}` | 这一个组件的布局、间距、响应式断点 | 默认选择。90% 的改动应该停在这一层 |

判断顺序（照着问）：

```
这个样式会影响「所有同类组件」吗？
  是 → 主题令牌（styleOverrides）
  否 ↓
它需要跟随亮/暗两态，或者要给 JS 之外的 CSS 读（变量/动画/媒体查询）吗？
  是 → index.css 的 CSS 变量
  否 ↓
目标 DOM 是第三方库生成的（我拿不到它的 JSX）吗？
  是 → index.css 的语义类（带库前缀）
  否 → sx（单点样式）
```

## 二、几条硬规矩

1. **颜色只从变量或主题拿，不写死。** 写死 `#fff` 在暗色下必然出问题；
   需要「跟文字同色」时用 `currentColor`，需要「跟主色」时用 `var(--accent)`。
2. **`!important` 只用在「压过第三方注入样式」这一种情况**，并且必须在注释里写清压的是谁。
   目前 39 处，新增一处就要能说出理由。
   反面教材（2026-10-21 真踩过）：光标的 `caret-color` 用 `!important` 压 CodeMirror 注入的
   `.ͼ1 .cm-content` 规则 —— 理由正当，因为那不是我们的类名、特异性又比我们高。
3. **不要用 `sx` 去改第三方库的内部类**（`.cm-*`、`.MuiPickers-*`）。
   `sx` 生成的是我们的类名，特异性打不过库自己的规则，最后只能加 `!important` ——
   那就该改到 `index.css` 里写成显式选择器。
4. **同一件事只在一层定义。** 比如圆角：变量是 `--radius-*`，组件里一律
   `borderRadius: "var(--radius-md)"`，不要在 `sx` 里再写 `2`。
5. **多档位的数值不要写成三元链。** 「紧凑 / 舒适 / 超紧凑」这类，集中到一张表
   （范例：`utils/densityMetrics.ts`）。`a ? x : b ? y : z` 一旦有三档就会在某处漏改，
   而且漏改的地方看起来完全合法 —— 这是 `tests/densityMetrics.test.ts` 那条静态守卫存在的原因。

## 三、亮暗两态怎么写

- **MUI 主题内**：走 `theme.palette.mode`，`styleOverrides` 里可以直接读。
- **`index.css` 里**：用 `html.dark` 前缀。深色标记由 `hooks/useDocumentEffects.ts` 打在
  `<html>` 上（`classList.toggle("dark")`），**不是** `prefers-color-scheme` ——
  用户可以手动选浅色，媒体查询会跟他的选择打架。
- **两态都要能读**：改完跑 `npm run audit:contrast`（亮/暗各一遍，0 处不合格才算过）。

## 四、动效

- 时长与曲线用变量：`--dur-base` / `--ease-out`，不要在 `sx` 里写 `0.2s ease`。
- **只动 `transform` / `opacity`**：改 `width/height/top/left` 会触发布局，长列表上肉眼可见地掉帧。
- 必须尊重 `prefers-reduced-motion`（`index.css` 里已有全局兜底，新写的关键帧动画要自己加一条）。

## 五、改完之后的自检清单

```bash
npm run lint                  # 0 error
npm run audit:contrast        # 亮/暗各 0 处不合格
npm run audit:a11y            # 焦点环 / 可访问名，0 项不合格
npm run build && npm run check:budget   # 体积预算（首屏 900KB raw / 300KB gzip）
```

前三项是最容易「改一处崩一处」的地方：新加一个浅色文字、或把 `outline: none` 抄进新组件，
都会在审计里直接红出来。**没跑过不要说通过。**

## 六、已知的遗留问题（别以为是自己写错了）

- `App.css` 与 `index.css` 有少量历史重复定义（早期拆分留下的）。新增样式别往 `App.css` 放。
- `index.css` 里有一部分 `.nav-*` 类其实已经被 `sx` 取代、但还没删。
  确认无人引用后再删（`grep -rn "nav-xxx" src/`）。
- 记事本的编辑器样式（`.cm-*`）刻意**不用** MUI 主题：CodeMirror 不在 MUI 树里，
  拿不到 `darkMode`，所以它全靠 `currentColor` + `var(--*)` 自适应。
