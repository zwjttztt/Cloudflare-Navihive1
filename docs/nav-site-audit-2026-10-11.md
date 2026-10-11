# 导航站侧源码级自查报告（2026-10-11）

范围：导航站侧核心模块（卡片/分组体系、搜索、排序、链接巡检、图标代理、书签导入、分组分享、回收站、AI 向量、审计、监听器卫生）。方法：逐文件源码级核对，找「真问题」，不复述已知治理（mountQueue / 搜索上限 / iconCache / prefSync 等既往批次已钉住的不重复列）。随本轮同步复核了两个遗留项（大纲预览跳转、导出未保存草稿），结论见第四节。

## 一、P1：AI 向量删除无账号 scope（跨账号数据丢失，建议立即修）

**位置**：`src/API/methods/ai.ts:91`（`replaceEmbeddings`）

```sql
DELETE FROM site_embeddings WHERE model != ?   -- ❌ 没有任何账号条件
```

**链路**：`worker/routes/ai.ts:253` —— 任意登录用户 `POST /api/ai/embed`（「补向量」按钮）→ `replaceEmbeddings` → 上面这条 DELETE。

**影响**：多账号产品定位下的真数据丢失。用户 B 换了 embedModel 补一次向量，**全表**其它模型（包括用户 A 正在用的）的向量被静默删光——A 的语义搜索从此悄悄退化成关键词搜索（useSemanticSearch 有降级，不报错，没人发现）。同模型不删，所以单账号 + 不换模型时看不出问题，这大概就是它活到现在的原因。

**修法（一行 SQL + 一条真库用例）**：删除限定在本人站点内——

```sql
DELETE FROM site_embeddings
WHERE model != ? AND site_id IN (SELECT id FROM sites WHERE user_id IS ?)
```

配 `tests/` 真 SQLite 用例（两个用户各写一组向量，B 换模型补向量后断言 A 的行完好）。

## 二、P2：两处小缺陷（修复成本各 ≤ 半小时）

### 2.1 分组分享撤销用 `window.confirm`（违反站内弹窗统一）

`src/components/GroupShareDialog.tsx:104`：`if (!window.confirm("撤销后链接立即失效，确定撤销吗？")) return;`。项目约定是站内 ConfirmDialog（毛玻璃、data-confirm-action 定位），NotesPage/NamePromptDialog 都已迁移；原生框在 jsdom 里测不了、观感也断裂。改 ConfirmDialog + 确认后才调 revokeGroupShare。

### 2.2 书签导入同名文件夹会建出重复分组

`src/hooks/useBookmarkImport.ts:54`：同名复用查的是 `groups`（prop，不含本次新建）——书签文件里**两个同名文件夹**（如嵌套的「书签栏」）第二次会再建一个同名分组。修：循环内维护 `Map<name, GroupWithSites>`，新建的也登记进去，下一轮复用。

## 三、复核无问题清单（本轮逐文件核对过、值得记下来防止重复怀疑）

| 模块 | 结论 |
|---|---|
| `utils/linkHealth.ts` | 扎实：两次失败才标失效（suspect 窗口）、白名单纠偏、同域名只探代表、并发上限、云端合并取 max-ts 幂等、上限 2000 条裁剪 |
| `utils/bookmarks.ts` | 嵌套/并列两种 Netscape 结构都认；无效 scheme（javascript:/place:/chrome:）过滤；无效→已有→文件内重复的判定顺序合理 |
| `API/methods/recycle.ts` | 笔记还原带全字段（starred/folder_id/archived）+ 标签悬空守卫 + FTS 重建；列表/还原全程 owner scope |
| `API/methods/groupShares.ts` | 脱敏由 SELECT 列表保证（只出 name/url/description/icon）；token 格式校验、过期/作者状态判定、need-password 分支干净 |
| `components/PublicGroupPage.tsx` | GET/POST 双态正确，口令错统一 need-password，错误兜底 |
| `worker/icon.ts` | safeFetch（scheme/port/host 黑名单+重定向重验）、content-type 白名单（SVG 拒绝）、512KB 上限、限速、CSP sandbox——多层防御在位 |
| 监听器卫生 | useCollapseController/useGlobalShortcuts/useOfflineBannerVisible/usePanelBreakpoint 等抽查全部成对 remove |
| `ai.ts` 其余方法 | listEmbeddings/countEmbeddings 都有 JOIN sites + scopeSql |

## 四、遗留项复核结论（随本轮完成）

### 4.1 大纲预览跳转 —— 功能正常，无需改码

真机探针 `harness/outline-probe.mjs`（run-probe.sh + CDP，jsdom 量不了布局所以此前挂账）全绿：
- 40 条标题的大纲完整渲染（stub 长文笔记）；
- 预览态点中间条目：目标标题 gap=0px 贴到预览容器顶（scrollTop 0→3283）；
- scroll-spy：滚回顶高亮第 1 条、滚到底高亮进入后段（最后一条被滚动上限夹在视口下方、不越过 60px 阈值——标准 spy 语义，不是缺陷）；
- 编辑态点大纲项：CodeMirror 滚动到目标行（scrollTop→5571），选区跳转正常；
- 全程 0 异常。`jumpToOffset` 走 NoteEditorHandle（CM 兼容面），无需改。

### 4.2 导出未保存草稿 —— 确认为真实体验缺陷，已修

原行为：编辑器头部导出三格式全部导 `active`（库里已存版本）——3s 自动保存窗口内刚打的内容不在导出文件里，且无任何提示（用户拿到旧文件不知道）。原注释的「标题正文同源」顾虑成立，但解法过保守：**草稿的 title/content 本身就同源**，直接导草稿即可。

已改（`NotesPage.tsx`）：新增 `exportTarget()`——有未保存修改导草稿（所见即所得），否则导已存版本；头部菜单三格式与 ⌘K 两个导出入口全部走它，头部导出后顺手 `void save()` 让草稿收敛；列表行菜单导出的是**没打开**的笔记（无草稿概念），保持已存口径。真机验证：dirty 后点导出有回执、0 异常。

## 五、建议顺序

| 批次 | 内容 | 量级 |
|---|---|---|
| 本批 | P1 向量 scope 修复 + 真 SQLite 用例；2.1 ConfirmDialog；2.2 导入同名分组 | 合计 ~1 小时 |
| 择机 | group_share views 防刷（匿名可刷计数，仅写配额损耗，P3） | 1 小时 |
| 待定 | 导航站侧体验新功能——backlog 为空，等用户点题 | — |
