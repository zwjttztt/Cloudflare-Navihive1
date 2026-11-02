# 移动端触控目标测量 + 修复报告（390×844 与 375×844，2026-11-02）

> **这是「测量 + 修复」报告，不是纯测量。**
>
> 本文分两部分：**第一部分**是修复前的测量基线（390×844 下有多少可点元素、哪些不到 44px、
> 分别属于哪个组件、建议怎么修）；**第二部分**是 2026-11-02 收尾落地的修复与验证
> （6 处 CSS 容器已改、审计脚本从 report-only 翻成 fail-closed 硬判据、双视口 390×844 + 375×844
> 均 0 违规）。
>
> 判据口径：**有效热区 = max(边框盒, ::after 伪元素热区)**，再与逐层祖先求交
> （仅在祖先 `overflow ≠ visible` 时才裁切）。三档：critical 44 / deco 40 / accept 24。
> 改动留在工作区，**没有 `git commit` / `push`**。

---

## 一、为什么要这一段：现有审计面全是桌面视口

`script/a11y-audit.mjs` 到 2026-11-01 为止有五段扫描面（首页 → 记事本 → 设置中心 →
附件抽屉常态 → 抽屉空态/失败态），但它们**全部跑在同一个桌面视口**上：`auditEnv.mjs`
的 `openBrowser` 只给 Chrome 传了一个 `--window-size=1440,950`，没有
`Emulation.setDeviceMetricsOverride`、也没有触控仿真。

这漏掉的是**两件互不相同的事**：

1. **小屏 DOM 根本没被量过。** 390 / 375 宽下 `useMediaQuery` 走的是另一条分支：
   底栏 `MobileTabBar` 出现、顶栏的同名入口 `display: none`、弹窗从「居中卡片」
   变成贴底全宽面板（`src/index.css` 的 `max-width: 599.95px` 段）。桌面量到的
   DOM 形状与真机不是同一份 —— 「桌面全绿」推不出「手机上没问题」。

2. **触控守卫在桌面视口是关着的。** `src/index.css` 那套 44px 守卫挂在
   `@media (hover: none) and (pointer: coarse)` 上，`src/utils/device.ts` 还要
   `navigator.maxTouchPoints > 0` 才把 `nav-touch` 挂到 `<html>`（卡片浮层常显、
   设置/星标按钮常显都靠它）。桌面 headless 下这两条都不成立。
   也就是说：**桌面量到的 30px 图标按钮，真机上可能已经被守卫撑到 44，也可能没有**。
   不仿真就永远分不清这两种情况 —— 而这两种情况的修法完全相反。

顺带印证一件事：第一次测量就量出「守卫生效了」和「守卫漏了几处」的差别，
证明桌面视口下的读数是**不能**用来定判据的。

### 这一段现在是 fail-closed 硬判据（原 report-only 已翻闸）

| 决定 | 理由 |
| --- | --- |
| 仿真前提（viewport / matchMedia / maxTouchPoints / nav-touch）任意一条不成立 → 该视口直接判红 | 否则「仿真没生效」会永久静默，等于没测 |
| 四个面（A 首页 / B 设置中心 / C 底部面板弹窗 / D 批量操作条）任一打不开 → 那个面判红 | 漏测的面不能假装绿 |
| 量出来的**有效热区 < 该档阈值** → 判红，写明 w×h / className / surface / tier | 手机上触控目标够不够大第一次被 CI 真盯着 |
| **双视口 390×844 + 375×844，两档都过才放行** | 375 更窄，顶栏 / 底栏更容易挤 |

> 历史注：这一段最初是 report-only（只打印、不进 `failures`、不 fail-closed），
> 目的是先看真实分布再定判据，避免用没验过的尺子改代码。判据与修复都落地后，
> 在 2026-11-02 收尾翻成上面的 fail-closed 硬判据。详见第七节。

---

## 二、仿真参数与生效验证（双视口）

| 项 | 值 |
| --- | --- |
| `Emulation.setDeviceMetricsOverride` | `{ width: 390|375, height: 844, deviceScaleFactor: 3, mobile: true }`（两档各跑一遍） |
| `Emulation.setTouchEmulationEnabled` | `{ enabled: true, maxTouchPoints: 5 }` |
| 重载 | `location.href = <url>?t=<ts>` 后 `waitRendered(evaluate, { minButtons: 8 })`（不用固定 sleep） |
| 收尾 | `Emulation.clearDeviceMetricsOverride` + `setTouchEmulationEnabled({enabled:false})`（每个视口跑完都清，不污染后续段） |

**为什么必须重载**：`useMediaQuery` 是「订阅 + 首帧取值」；只改设备度量不重载时，
MUI 那批 `useMediaQuery` 虽然会收到 matchMedia 变更并重渲染，但
`nav-touch`（启动时一次性判定的 `<html>` class）、懒加载过的 chunk 布局缓存、
`dvh` 相关的高度都不会跟着重算。重载一次最省事，也和真机「冷启动即该宽度」一致。

**生效验证（脚本每次都会打印，三条全中才算数）** —— 两视口都应满足：

```
390×844: {"innerWidth":390,"innerHeight":844,"dpr":3,"touchPoints":5,
          "qSmall":true,"qCoarse":true,"qHoverNone":true,"navTouch":true,"tabbar":1}
375×844: {"innerWidth":375,"innerHeight":844,"dpr":3,"touchPoints":5,
          "qSmall":true,"qCoarse":true,"qHoverNone":true,"navTouch":true,"tabbar":1}
```

即：布局视口 = 目标宽 ×844 @3x、`navigator.maxTouchPoints = 5`、
`matchMedia('(max-width:599.95px)') = true`（小屏档位切过去了）、
`(pointer: coarse) = true`（触控守卫打开）、`nav-touch = true`（卡片浮层常显规则生效）、
底栏 1 条。任一条不成立，脚本对该视口直接判红（`mobileFailures.push(...)`）。

---

## 三、测量口径（读表前必看）

1. **元素集与 `scanTouch` 逐字相同**：`button, a[href], [role="button"], [role="option"]`，
   跳过 `width/height === 0`、`pointer-events: none`、`visibility: hidden`。
   两把尺子量同一批元素，结论才能互相印证。
2. **亚像素容差 `EPS = 0.5`**，与 `scanTouch` 同一套（LayoutUnit 1/64 + DPR 贴齐）。
   实测就撞上了这个精度问题：同一批卡片图标在不同轮里报 **31.52 / 31.74 / 31.84 / 31.88**，
   差别来自卡片宽度随文案微调、进而带动 em 尺寸。**所以靠近阈值的数字只能当趋势看**，
   这也是 44 判据必须留容差的原因。
3. **两种口径，分开报**：
   - **边框盒**（`getBoundingClientRect`）：`scanTouch` 一直是这个口径，可对照；
   - **有效热区**：元素自身 30 多 px，但 CSS 用 `::after` 把可点范围补到了 44
     （`src/index.css` 的「卡片上那些小图标」「底部导航的自绘按钮」「分组工具条」等段）。
     边框盒看不到伪元素，所以要把「44 的有效热区」还原出来再与**祖先可见区求交**。
     **关键修正（修复阶段）**：求交时**只在祖先 `overflow ≠ visible` 时才裁切**。
     `overflow: visible`（默认）的祖先不会裁掉伪元素 —— 伪元素溢出后仍然参与命中测试，
     真机上手指能戳到那部分。若不论 overflow 一律求交，会把「分组工具条」那种
     36 高容器 + 44 高伪元素误判成只有 36 高热区（其实 44 高那圈溢出后仍可点）。
     这一点在反向验证里被实测确认（见第七节）。
4. **已知覆盖面缺口（别当成「量过了」）**：`[role="menuitem"]`（MUI `MenuItem` 是 `<li>`）
   不在元素集里，**菜单项本轮未测**；记事本、附件抽屉、命令面板在 375 / 390 下的形态**本轮未测**
   （四个面只覆盖首页 / 设置中心 / 一个底部面板弹窗 / 批量条）。
5. 「可点元素 N 个」有两个数：**实测 N** 与**选择器匹配 M**（含被跳过的隐藏节点），
   清单长度 = 实测 N。

---

## 四、四个面的实测清单（修复前基线，390×844）

> 下表是**修复前**的测量基线（也是判断「哪些要修」的依据）。修复后这些元素的
> 有效热区已全部补到 44，见第七节「修复后复核」。

### 面级汇总（修复前）

| 面 | 实测可点 | < 44 | 其中有效热区已够 44 | < 40 | < 24 |
| --- | --- | --- | --- | --- | --- |
| A 首页 | 32 | 29 | 12 | 23 | **0** |
| B 设置中心 | 11 | 1 | 0 | 1 | **0** |
| C 底部面板弹窗（新增站点） | 6 | 4 | 0 | 4 | **0** |
| D 批量操作条 | 7 | 1 | 0 | 1 | **0** |
| **合计** | **56** | **35** | **12** | **29** | **0** |

- **24px 底线（WCAG 2.5.8）在移动端四个面上是 0 条** —— 现有判据没有回归。
  但要说清这个绿是怎么来的：弹窗操作区（`.MuiDialogActions-root`）、底栏
  （`.nav-mobile-tabbar`）、批量条（`.nav-bulk-bar`）那几处 44 高，是
  `src/index.css` 触控守卫撑出来的；守卫没覆盖到的地方就露出来了（见第五节）。
- 面 C 形态确认为**贴底全宽面板**：纸面 390×545.59、底边 844（视口 390×844）✓ ——
  这一面量的确实是「小屏底部面板」而不是桌面居中卡片。
- **设置中心左栏实测 10 条、行高一律 44**（脚本为这一条单独打印了实测行高）。
  任务书里写的「9 条」与实测不符：现在是 10 条（统计 / 数据与维护 / 数据安全 / 审计日志 /
  外观与搜索 / 密码保险库 / AI 设置 / 账号与安全 / 快捷键与操作帮助 / 退出登录）。
  44 这条与 `a11y-audit.mjs` 的注释一致，**没有需要修的地方**。

### A 首页（32 个可点元素，修复前）

| # | 尺寸 w×h | 有效热区 | 分档 | 元素（aria-label / 文本前 16 字） | className（前 40） | 父元素 className（前 30） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 31.52×31.52 | 44×44 | 装饰 | 网站设置 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 2 | 31.52×31.52 | 44×44 | 装饰 | 加星标 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 3 | 31.52×31.52 | — | 装饰 | 绑定笔记 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 4 | 31.52×31.52 | 44×44 | 装饰 | 网站设置 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 5 | 31.52×31.52 | 44×44 | 装饰 | 加星标 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 6 | 31.52×31.52 | — | 装饰 | 绑定笔记 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 7 | 31.52×31.52 | 44×44 | 装饰 | 网站设置 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 8 | 31.52×31.52 | 44×44 | 装饰 | 加星标 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 9 | 31.52×31.52 | — | 装饰 | 绑定笔记 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-card-in MuiBox-root css-8s` |
| 10 | 116×34 | — | 可接受 | 跳到网站列表 | `nav-skip-link MuiBox-root css-0` | `nav-root MuiBox-root css-1kwe9` |
| 11 | 36×44 | — | 关键 | 进入多选模式 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-display-pill MuiBox-root c` |
| 12 | 36×36 | — | 可接受 | 收起分组 | `MuiButtonBase-root MuiIconButton-root Mu` | `MuiBox-root css-1mzc55` |
| 13 | 36×36 | — | 装饰 | 编辑分组 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-group-tools MuiBox-root cs` |
| 14 | 36×36 | — | 装饰 | 分享分组 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-group-tools MuiBox-root cs` |
| 15 | 36×36 | — | 可接受 | 收起分组 | `MuiButtonBase-root MuiIconButton-root Mu` | `MuiBox-root css-1mzc55` |
| 16 | 36×36 | — | 装饰 | 编辑分组 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-group-tools MuiBox-root cs` |
| 17 | 36×36 | — | 装饰 | 分享分组 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-group-tools MuiBox-root cs` |
| 18 | 66×36 | — | 关键 | 显示设置，当前卡片视图 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-display-pill MuiBox-root c` |
| 19 | 74×36 | — | 装饰 | 排序 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-group-tools MuiBox-root cs` |
| 20 | 74×36 | — | 装饰 | 排序 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-group-tools MuiBox-root cs` |
| 21 | 86×36 | — | 关键 | 打开记事本 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-header-tools MuiBox-root c` |
| 22 | 96×36 | — | 装饰 | 添加卡片 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-group-tools MuiBox-root cs` |
| 23 | 96×36 | — | 装饰 | 添加卡片 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-group-tools MuiBox-root cs` |
| 24 | 55.33×43.19 | 55.33×44 | 关键 | 搜索 | `nav-tabbar-btn MuiBox-root css-ypz99u` | `MuiPaper-root MuiPaper-elevati` |
| 25 | 55.33×43.19 | 55.33×44 | 关键 | 新增 | `nav-tabbar-btn MuiBox-root css-ypz99u` | `MuiPaper-root MuiPaper-elevati` |
| 26 | 55.33×43.19 | 55.33×44 | 关键 | 星标 | `nav-tabbar-btn MuiBox-root css-ypz99u` | `MuiPaper-root MuiPaper-elevati` |
| 27 | 55.33×43.19 | 55.33×44 | 关键 | 设置 | `nav-tabbar-btn MuiBox-root css-ypz99u` | `MuiPaper-root MuiPaper-elevati` |
| 28 | 55.34×43.19 | 55.34×44 | 关键 | 分组 | `nav-tabbar-btn MuiBox-root css-ypz99u` | `MuiPaper-root MuiPaper-elevati` |
| 29 | 55.34×43.19 | 55.34×44 | 关键 | 笔记 | `nav-tabbar-btn MuiBox-root css-ypz99u` | `MuiPaper-root MuiPaper-elevati` |
| 30 | 144.79×83.88 | — | 可接受 | 示例一示例站点一 | `MuiButtonBase-root MuiCardActionArea-roo` | `MuiPaper-root MuiPaper-elevati` |
| 31 | 144.79×83.88 | — | 可接受 | 示例二示例站点二 | `MuiButtonBase-root MuiCardActionArea-roo` | `MuiPaper-root MuiPaper-elevati` |
| 32 | 144.79×83.88 | — | 可接受 | 示例三示例站点三 | `MuiButtonBase-root MuiCardActionArea-roo` | `MuiPaper-root MuiPaper-elevati` |

**读法（修复前）**：
- 第 1~9 行是卡片右下角那组浮层图标。触屏下它们**常显**（`html.nav-touch .nav-card-actions{opacity:1}`），
  所以是「真能点到」的次要操作，不是纯装饰。其中「网站设置 / 加星标」两枚被
  `::after` 撑到 44×44（有效热区列有值），**「绑定笔记」没有** ——
  守卫的伪元素名单是 `.nav-card-actions .MuiIconButton-root, .nav-settings-btn, .nav-star-btn`，
  **漏了 `.nav-note-btn`**（它有 `opacity:1` 的常显规则，却没进热区名单）。这是最明确的一处遗漏（已修复，见第七节）。
- 第 24~29 行底栏：边框盒 43.19 高（差 0.81px），`::after` 把热区补到 55.33×44 —— **真机上够**。
  但如果判据按边框盒写 44，这 6 条会全部假红（所以判据必须写有效热区口径）。
- 第 18/21 行是顶栏的两枚**文字按钮**（`MuiButton-root`）：高 36。
  触控守卫里有 `header .MuiIconButton-root { min-height: 44px }`，**只覆盖 IconButton，
  不覆盖 header 里的文字按钮** —— 这是第二处遗漏（已修复，见第七节）。
- 第 11 行「进入多选模式」是 `36×44`：高够了、**宽不够**（方形目标要求 44×44）。
- 第 13/14/16/17/19/20/22/23 行是分组工具条 `.nav-group-tools`：8 条全是 36 高、无伪元素热区（已修复，见第七节）。

### B 设置中心（11 个可点元素，修复前）

| # | 尺寸 w×h | 有效热区 | 分档 | 元素（aria-label / 文本前 16 字） | className（前 40） | 父元素 className（前 30） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 36×36 | — | 关键 | 关闭 | `MuiButtonBase-root MuiIconButton-root Mu` | `MuiBox-root css-avuaum` |
| 2 | 348×44 | — | 关键 | 统计 | `MuiBox-root css-lx55or` | `MuiBox-root css-3a3hw0` |
| 3 | 348×44 | — | 关键 | 数据与维护 | `MuiBox-root css-1i079a0` | `MuiBox-root css-3a3hw0` |
| 4 | 348×44 | — | 关键 | 数据安全 | `MuiBox-root css-1i079a0` | `MuiBox-root css-3a3hw0` |
| 5 | 348×44 | — | 关键 | 审计日志 | `MuiBox-root css-1i079a0` | `MuiBox-root css-3a3hw0` |
| 6 | 348×44 | — | 关键 | 外观与搜索 | `MuiBox-root css-1i079a0` | `MuiBox-root css-1ica3ez` |
| 7 | 348×44 | — | 关键 | 密码保险库 | `MuiBox-root css-1i079a0` | `MuiBox-root css-1ica3ez` |
| 8 | 348×44 | — | 关键 | AI 设置 | `MuiBox-root css-1i079a0` | `MuiBox-root css-1ica3ez` |
| 9 | 348×44 | — | 关键 | 账号与安全 | `MuiBox-root css-1i079a0` | `MuiBox-root css-1ica3ez` |
| 10 | 348×44 | — | 关键 | 快捷键与操作帮助 | `MuiBox-root css-1i079a0` | `MuiBox-root css-1ica3ez` |
| 11 | 348×44 | — | 关键 | 退出登录 | `MuiBox-root css-1gu597p` | `MuiBox-root css-11iq98b` |

**读法（修复前）**：左栏 10 条一律 348×44 ✓（与「窄屏 44」的注释一致）。
**唯一不达标的是右上角那枚 ×：「关闭」36×36** —— 而它恰恰是「关掉整屏」的唯一可点入口之一
（另一个是 Esc / 点遮罩）。`DialogCloseButton` 走的是 `IconButton size="small"`，
既不在 `.MuiDialogActions-root` 里，也不在 `header` 里，所以两条 44 守卫都管不到它（已修复，见第七节）。

### C 底部面板弹窗（新增站点）（6 个可点元素，修复前）

| # | 尺寸 w×h | 有效热区 | 分档 | 元素（aria-label / 文本前 16 字） | className（前 40） | 父元素 className（前 30） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 36×36 | — | 关键 | 关闭 | `MuiButtonBase-root MuiIconButton-root Mu` | `MuiBox-root css-avuaum` |
| 2 | 36×36 | — | 可接受 | 生成随机强密码 | `MuiButtonBase-root MuiIconButton-root Mu` | `MuiInputAdornment-root MuiInpu` |
| 3 | 36×36 | — | 可接受 | 显示密码 | `MuiButtonBase-root MuiIconButton-root Mu` | `MuiInputAdornment-root MuiInpu` |
| 4 | 38×38 | — | 可接受 | 修改图标 | `MuiButtonBase-root MuiIconButton-root Mu` | `MuiInputAdornment-root MuiInpu` |
| 5 | 52×44 | — | 关键 | 创建 | `MuiButtonBase-root MuiButton-root MuiBut` | `MuiDialogActions-root MuiDialo` |
| 6 | 54×44 | — | 关键 | 取消 | `MuiButtonBase-root MuiButton-root MuiBut` | `MuiDialogActions-root MuiDialo` |

**读法（修复前）**：底部那排「取消 / 创建」是 44 高 ✓（守卫里 `.MuiDialogActions-root .MuiButton-root{min-height:44px}`）。
和面 B 一样，**唯一的缺口就是右上角那枚 ×**（36×36）。输入框里的三枚 adornment 图标
（随机强密码 / 显示密码 / 修改图标）36~38，按 WCAG 24 已够，按 44 会红 —— 它们是「输入框内的辅助按钮」，
修复后维持 24（不进关键 / 装饰档）。

### D 批量操作条（7 个可点元素，修复前）

| # | 尺寸 w×h | 有效热区 | 分档 | 元素（aria-label / 文本前 16 字） | className（前 40） | 父元素 className（前 30） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 36×36 | — | 关键 | 退出多选模式 | `MuiButtonBase-root MuiIconButton-root Mu` | `nav-bulk-bar MuiBox-root css-1` |
| 2 | 74×44 | — | 关键 | 删除 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-bulk-bar MuiBox-root css-1` |
| 3 | 74×44 | — | 关键 | 完成 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-bulk-bar MuiBox-root css-1` |
| 4 | 87×44 | — | 关键 | 加星标 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-bulk-bar MuiBox-root css-1` |
| 5 | 87×44 | — | 关键 | 打标签 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-bulk-bar MuiBox-root css-1` |
| 6 | 100×44 | — | 关键 | 取消星标 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-bulk-bar MuiBox-root css-1` |
| 7 | 100×44 | — | 关键 | 移动分组 | `MuiButtonBase-root MuiButton-root MuiBut` | `nav-bulk-bar MuiBox-root css-1` |

**读法（修复前）**：破坏性操作「删除」74×44 ✓。**唯一缺口是左边那枚「退出多选模式」36×36** ——
它同样是 IconButton，落在 `.nav-bulk-bar .MuiButton-root` 这条守卫的作用范围之外（已修复，见第七节）。
这一面是**新纳入扫描面的**（桌面视口下它根本不渲染，历史上一次都没被量过）。

---

## 五、分类提案：三档 + 机器可判据（修复前）

### 三档的定义（即审计脚本里 `tierOf()` 的落地）

| 档 | 判据（目标尺寸） | 含义 | 本档元素数（修复前） | < 44 | 需修（边框盒与有效热区都不达标） |
| --- | --- | --- | --- | --- | --- |
| **关键操作** | **44×44 硬判（有效热区口径）** | 拇指区主入口 / 破坏性或批量写操作 / 关掉整屏 | 30 | 12 | **6** |
| **装饰性 / 次要** | **40×40（有效热区口径）** | 常显但不承担主流程的浮层图标、分组工具条 | 17 | 17 | **11** |
| **可接受** | **24×24（WCAG 2.5.8 现状）** | 列表行、chip、卡片主体、输入框内辅助键 | 9 | 6 | **6** |

「需修」= 按该档判据现在会红、且没有有效热区兜着的条数 —— 这也是**真正要动代码的数量**。
修复后这 17 条「需修」已全部被 CSS 守卫 / 伪元素兜住（见第七节）。

### 机器可判据（可用选择器 / MUI class / 所在容器稳定识别）

顺序敏感，先命中先归类（即 `tierOf()` 的实现）：

| 顺序 | 判据 | 归入 | 判定例子 |
| --- | --- | --- | --- |
| 1 | 在 `.nav-mobile-tabbar` 内 | 关键 | 底栏 6 颗（搜索 / 分组 / 新增 / 笔记 / 星标 / 设置） |
| 2 | 在 `header` 内 | 关键 | 顶栏「显示设置」「打开记事本」「进入多选模式」 |
| 3 | 在 `.MuiDialogActions-root` 内 | 关键 | 底部面板那排「取消 / 创建」 |
| 4 | 在 `.nav-bulk-bar` 内 | 关键 | 批量条全部 7 颗（含「删除」） |
| 5 | 在 `[data-workspace-nav]` 内 | 关键 | 设置中心左栏 10 条 |
| 6 | 在 `[data-dialog-close]` 内 / 自身带该属性 | 关键 | 所有弹窗右上角的 × |
| 7 | 在 `.nav-card-actions` 内 | 装饰 | 卡片浮层的「网站设置 / 加星标」 |
| 8 | 自身 `.nav-settings-btn` / `.nav-star-btn` / `.nav-note-btn` | 装饰 | 卡片上那三颗裸 IconButton（含「绑定笔记」） |
| 9 | 在 `.nav-group-tools` 内 | 装饰 | 分组工具条「编辑 / 分享 / 排序 / 添加卡片」 |
| 10 | 在 `[data-attachment-row]` 内且是 `button.MuiIconButton-root` | 装饰 | 附件卡片上的删除键（本轮未扫到，规则先留着） |
| — | 其余 | 可接受 | 卡片主体 `<a>`、skip link、adornment 图标键、列表行 |

**为什么用 `[data-dialog-close]` 而不是 `.MuiDialogTitle-root`**：设置中心那套外壳
根本没有 `MuiDialogTitle`，按标题栏归类会让**同一颗 ×** 在面 B 落「可接受」、在面 C 落「关键」。

### 几个具体判定与理由

1. **底栏 6 颗 → 关键（44，有效热区口径）**。高频、第一触点。边框盒 43.19，差 0.81px，
   但 `::after` 已把热区补到 44。**真机达标，不改边框盒**（MobileTabBar 的 `py` 改动不做）。
2. **卡片里悬停浮出的小图标 → 装饰（40，有效热区口径）**。理由：① 触屏上常显、点得到；
   ② 都是对某卡片的一次性小动作（设置 / 加星 / 绑笔记），出错代价低、可撤销；
   ③ 卡片主体入口是 144×84 的 `MuiCardActionArea`，远大于 44。**「绑定笔记」原漏热区，已补。**
3. **设置中心左栏 10 条 → 关键（44）**，实测 44 ✓。
4. **输入框内的 adornment 图标键 → 可接受（24）**。紧贴输入框、撑到 44 会把输入框撑高一整行；
   24 已满足 WCAG 2.5.8（且有足够间距）。**维持现状**。
5. **「收起分组」36×36 → 可接受**。可逆的展示开关，且有整行标题可点作为替代路径。
6. **skip link 116×34 → 可接受**。只在键盘聚焦时出现，键盘用户不依赖 44px 热区。

---

## 六、修复前：如果把判据提到 44 / 40，会红多少

| 判据口径 | 会红的条数 | 说明 |
| --- | --- | --- |
| **44 硬判（边框盒）** | **35 / 56** | 首屏一面就占 29 条 |
| 44 硬判（有效热区口径） | **23 / 56** | 12 条（底栏 6 + 卡片设置/加星 6）已有 44 热区，不该红 |
| **两档：关键 44 + 装饰 40** | **17** | 关键 6 + 装饰 11，不含可接受档 |
| 24（现状） | **0** | 四个面全绿 |

**集中在哪几个组件**（按 44 有效热区口径的 23 条聚类）：

| 容器 | 条数 | 元素 |
| --- | --- | --- |
| `.nav-group-tools`（分组工具条） | 8 | 编辑 / 分享 / 排序 / 添加卡片 ×2 组 |
| 卡片浮层 `.nav-note-btn` | 3 | 「绑定笔记」（**唯一漏进伪元素名单的那颗**） |
| `header` 内按钮 | 3 | `.nav-display-pill` 2（显示设置 / 进入多选模式）+ `.nav-header-tools` 1（打开记事本） |
| 弹窗关闭键 `[data-dialog-close]` | 2 | 设置中心 ×、底部面板 × |
| 「收起分组」 | 2 | 两个分组的标题行图标钮（36×36，可接受档） |
| `.nav-bulk-bar` | 1 | 「退出多选模式」36×36 |
| `MuiInputAdornment` | 3 | 随机强密码 / 显示密码 / 修改图标（24 够，不必动） |
| skip link | 1 | 跳到网站列表（24 够，不必动） |

**一句话结论（修复前）**：44 档的 23 条里，**真正要动代码的只有 6 个容器、19 条**，
且**没有一条在 24px 以下** —— 即 44 这一档完全是「体验升级」，与「按 WCAG 2.5.8 判移动端是 0 违规」不矛盾。

---

## 七、修复落地 + 验证（2026-11-02 收尾）

### 7.1 已落地的 6 处 CSS 修复（`src/index.css`，触屏守卫段）

> 顺序：**先修容器，再翻判据闸** —— 否则闸一开，未修的元素会立刻把 CI 打红。

| # | 文件 | 改什么 | 覆盖条数 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `src/index.css` | 触控守卫里把 `header .MuiIconButton-root` 扩成 `header .MuiButtonBase-root`（文字按钮也吃到 44 高） | 3（显示设置 / 打开记事本 / 进入多选模式的高） | ✅ |
| 2 | `src/index.css` | 伪元素热区名单补 `.nav-note-btn::after`（与 `.nav-settings-btn / .nav-star-btn` 同一套 44×44） | 3 | ✅ |
| 3 | `src/index.css` | `.nav-group-tools .MuiButtonBase-root::after` 加 44 热区（**不**直接撑高，工具条会把分组标题挤变形） | 8 | ✅ |
| 4 | `src/index.css` | 弹窗关闭键：`.MuiDialog-root [data-dialog-close] { min-width/min-height: 44px }` | 2 | ✅ |
| 5 | `src/index.css` | `.nav-bulk-bar .MuiIconButton-root { min-width/min-height: 44px }`（「退出多选模式」） | 1 | ✅ |
| 6 | （**不做**）`src/components/MobileTabBar.tsx` | 底栏 43.19 → 44 的 `py: 0.5 → 0.6` | 6（仅几何） | ⏸ 有效热区口径下 43.19 已被 44 伪元素兜住，不必动 |

> 第 3 条的实现要点：`.nav-group-tools` 容器本身只有 36px 高、且 `overflow: visible`，
> 所以不能给按钮 `min-height: 44`（会顶高整条），只能靠 `::after` 把可点范围补到 44×44。
> 测量时若对 `overflow: visible` 的祖先也求交，会把这 44 高伪元素误裁成 36 ——
> 因此测量端同步改成「仅在祖先 `overflow ≠ visible` 时才裁切」（见第三节第 3 点）。

### 7.2 审计脚本：`script/a11y-audit.mjs` 从 report-only 翻成 fail-closed

- 移除 report-only 的 `mobileSurfaces / mobileMissing / collectMobile`，改为
  `runMobileAudit(vp)` 函数 + `mobileFailures` 累积数组 + `summarizeMobile()`；
- **双视口**：`MOBILE_VIEWPORTS = [390×844, 375×844]`，两档都跑，循环 `for (const vp of MOBILE_VIEWPORTS) await runMobileAudit(vp);`；
- **fail-closed**：仿真前提任一不成立 → 该视口判红；四个面任一打不开 → 该面判红；
  有效热区 < 该档阈值 → 判红，写明 w×h / className / surface / tier；
- 末尾把 `mobileFailures` 并入全局 `failures`，与原有五段共用同一条 `可访问性审计通过/失败` 出口；
- 三档阈值写死：`TIER_THRESHOLD = { critical: 44, deco: 40, accept: 24 }`。

### 7.3 验证结果（全过才算完）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `npm run build`（`tsc -b && vite build`） | ✅ 通过（仅有 chunk 体积提示，非错误） |
| 审计·双视口 | `CHROME_PATH=... npm run audit:a11y` | ✅ **390×844 与 375×844 均 `可访问性审计通过（0 项不合格）`**，`mobileFailures` 两视口各累计 0 条 |
| 静态检查 | `npx eslint script/a11y-audit.mjs` | ✅ 0 问题 |
| 反向验证 | 临时把 `.nav-group-tools .MuiButtonBase-root::after` 的 `height` 从 `var(--touch-min)` 改成 `20px` 后重跑 | ✅ 触发 **8 条精确失败**：`移动端390×844/375×844 A 首页：控件 …「编辑分组/分享分组/排序/添加卡片」（装饰档，要求≥40） 有效热区 44×36 < 40`，并 `可访问性审计失败` |
| 反向验证·恢复 | 改回 `height: var(--touch-min)` 并重跑 | ✅ 回归 `0 项不合格`；`grep TEMP-BREAK src/index.css` 确认无残留 |

**双视口 0 违规结论**：在 390×844 与 375×844 两档下，四个面（首页 / 设置中心 /
底部面板弹窗 / 批量操作条）共 56 个可点元素，按「有效热区 = max(边框盒, ::after)」口径、
critical 44 / deco 40 / accept 24 三档判定，**违反项为 0**。其中关键档 30 个、装饰档 17 个、
可接受档 9 个，全部满足本档阈值（主要靠 CSS 守卫把边框盒撑到 44，或 `::after` 把溢出热区补到 44，
而伪元素溢出部分因祖先 `overflow: visible` 仍真实可点）。

**原有五段没被弄坏**：改动前（`git show HEAD:script/a11y-audit.mjs`）与改动后各跑一遍，
均为 `0 项不合格`、exit 0，且原有各段计数逐项一致（差异只有端口号、焦点环亚像素颜色，
以及一处预存抖动 —— 见第八节）。

---

## 八、复现方式与附注

```bash
npm run build                                        # 需要 dist/client
CHROME_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" npm run audit:a11y
```

输出里从 `=== 移动端 390×844 仿真：参数确认 ===` / `=== 移动端 375×844 仿真：参数确认 ===`
起是这一段；每个视口末尾有 `=== 移动端<视口> 触控：四面汇总（fail-closed）===`，
最后由全局 `可访问性审计通过（0 项不合格）` 收口。

**一处预存抖动（与本改动无关，已用「基线跑两遍」验证）**：`首页 buttons` 有时 31 有时 28、
`记事本：触控目标 可点元素` 有时 14 有时 11 —— 把**未改动的基线脚本连跑两遍**也会出现同样的差异，
是桩数据 / 懒渲染时序造成的，不是本段引入的。比较两轮输出时请只看结论行与各段计数，
别拿字节级 diff 当回归判据。

---

## 九、本轮做了什么 / 没做什么

**做了**
- `script/a11y-audit.mjs` 新增第 6 段：390×844 + 375×844 双视口设备度量 + 触控仿真 + 重新加载 +
  四个面测量（首页 / 设置中心 / 底部面板弹窗 / 批量操作条）；
- 把该段从 report-only **翻成 fail-closed 硬判据**（仿真失效 / 面缺失 / 有效热区不达标均判红，并入全局 `failures`）；
- `src/index.css` 落地 6 处触屏触控目标修复（第 6 条 MobileTabBar `py` 改动按约定不做）；
- 测量端 `effective()` 改为「仅在祖先 `overflow ≠ visible` 时裁切」的有效热区口径；
- 本文档（测量 + 修复报告）。

**没做**
- **没有 `git commit` / `push`**（改动留在工作区，由版本 bump 环节处理）；
- 没有放宽或删除任何现有 24px 判据；
- 没有动 MobileTabBar 的 `py`（有效热区口径下 43.19 已被 44 伪元素兜住，判定为不必动）；
- 没有补记事本 / 附件抽屉 / 命令面板在 375 / 390 下的扫描面（四面以外仍属「未测到的绿」，
  如需扩展到 100% 覆盖，按第四节的缺口补面即可）。
