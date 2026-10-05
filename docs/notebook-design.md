# 记事本设计方案（跟随账号导入导出）

> **状态：设计已定稿，待实现。** 三个待拍板问题已由用户拍板（见第三节），
> Markdown 那一问还牵出一个 CSP 冲突（见第五节），渲染层因此改了方案。

配合阅读：`docs/password-manager-plan-B.md`（同类设计文档的写法参考）。

## 零、先对齐「记事本」是什么

按**一个独立的、全局的笔记列表**（多条，可排序、可置顶、可选关联到某个站点）设计，
和现在每个卡片上的 `sites.notes`（单条、跟着站点走）是两回事。两者并存：

| | 站点备注（现有） | 记事本（本方案） |
|---|---|---|
| 粒度 | 每个站点一条 | 全局多条 |
| 生命周期 | 跟着卡片生灭 | 独立存在，卡片删了也在 |
| 典型用途 | 这个站怎么登录、注意事项 | 临时想法、待办、片段 |
| 格式 | 纯文本 | **Markdown**（已定） |
| 入口 | 卡片右键 / 网站设置 | 顶栏独立入口 |

---

## 一、数据模型

在 `src/API/methods/internals.ts` 的建表数组里加一条（那里已有 `recycle_bin` 等 10 张表）：

```sql
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 跟账号走：这是它能被「随账号导入导出」的前提。
    -- 未启用鉴权的单账号部署里为 NULL（和 user_configs 一样的处理）
    user_id INTEGER,
    -- 跨设备/跨导入识别同一条笔记。**合并导入要靠它去重**（见 3.3），
    -- 没有它就只能靠标题+内容硬比，那样改过一次的笔记会被当成两条。
    uuid TEXT,
    title TEXT NOT NULL DEFAULT '',
    -- Markdown 源码，不是 HTML
    content TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    order_num INTEGER NOT NULL DEFAULT 0,
    -- 可选：这条笔记是关于哪个站点的。**不建外键**：站点被删了，笔记不该跟着消失
    -- （这正是笔记独立于卡片的意义），所以它只是一个可空引用。
    site_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, pinned DESC, order_num);
```

**为什么 `user_id` 而不是 `owner_user_id`**：与 `sites` / `configs` / `user_configs` 一致，
可以直接复用现成的 `scopeSql`（它已处理 uid 为 NULL 的单账号部署场景）：

```ts
// 现有 sites 的写法，记事本照抄即可
SELECT ... FROM notes${this.scopeSql(true)}
```

**为什么不做成 `configs` 里的一条 JSON**：`configs` 的写入要过所有者门控（普通账号记不了
自己的东西），而且整体读改写——一条笔记就是整份 JSON 的一处改写，多几条就开始互相踩。

---

## 二、API

照 `DataApi` 的模式加一个 `notes` 分域（`src/API/methods/notes.ts`）：

```ts
export interface NotesApi {
    listNotes(): Promise<Note[]>;
    getNote(id: number): Promise<Note | null>;
    createNote(draft: Partial<Note>): Promise<Note>;
    updateNote(id: number, patch: Partial<Note>): Promise<Note | null>;
    deleteNote(id: number): Promise<{ success: boolean; recycleId?: number }>;
    updateNoteOrder(orders: { id: number; order_num: number }[]): Promise<boolean>;
    countNotes(): Promise<number>;
}
```

- 客户端：`src/API/methods/notes.ts`（Worker 侧）+ `src/API/client.ts` 加同名方法，
  **`mock.ts` 也要加**（`tests/apiContract.dom.test.tsx` 会检查前端调用的方法两边都有）。
- 路由：`worker/routes/data.ts` 加 `GET/POST /api/notes` 与 `PUT/DELETE /api/notes/:id`。
- **删除走回收站**：复用 `pushToRecycle`（`kind='note'`），误删能撤销。
- `createNote` 里生成 `uuid`（`crypto.randomUUID()`，浏览器原生，不引依赖）。

---

## 三、导入导出（三个决策已定）

### 3.1 决策一：导出**默认含**笔记，另给独立开关

**不复用** `backup.includeCredentials`（那个默认是**不含**），新增一个独立配置：

```ts
// 默认 true —— 显式写成 "false" 才排除
const withNotes = configs[BACKUP_NOTES_CONFIG] !== "false";
```

与凭据开关**刻意分开**：凭据是「敏感数据，默认不带」，笔记是「主要内容，默认带」。
合成一个开关的话，用户为了拿笔记就得把密码也导出去。

- `ExportData` 加**可选**字段 `notes?: Note[]`。
- UI：`BackupTab` 里在「备份含登录凭据」旁边加一个独立开关「备份含记事本」（默认开）。
- 老备份没这个字段 → `normalizeImportData` 放行，**现有笔记保持原样**。

摘要校验**自动覆盖**：`stableStringify()` 对整个对象做稳定序列化后算 SHA-256，
`notes` 一进 `ExportData` 就被算进去了，不用额外改。

### 3.2 决策二：覆盖式导入**默认合并**，另给「完全覆盖」

```ts
export interface ImportOptions {
    onProgress?: (progress: ImportProgress) => void;
    /** 笔记怎么办。默认 merge（保留本地多余的），replace 则先清空再导入 */
    notesMode?: "merge" | "replace";
}
```

- **`merge`（默认）**：只插入文件里的笔记，**不清本地的**。
- **`replace`**：先清空本地笔记再插入（与卡片的行为一致）。
- UI：导入预览弹窗里加一个二选一，默认「合并」；选「完全覆盖」时按现有 destructive
  确认框的规矩提示「本地笔记会被清掉」。

### 3.3 合并怎么做才不产生一堆重复

这是「合并」真正的难点。判据：**按 `uuid` 去重**。

- 文件里这条 uuid 本地没有 → 插入
- 本地有同 uuid → **保留本地那份**（本地更新），文件那份跳过
  （也可以反过来取 updated_at 较新的，**建议取较新的**，语义更符合直觉）
- 本地多出来的 → 原样保留

没有 uuid 的话只能按「标题 + 内容」硬比，用户改过一次笔记就会多出一条重复。

### 3.4 导入其余三处易错点

1. **`queryExportBundle` 加进同一个 `db.batch`**（现在是 `transfer.ts:159` 一次取回
   groups/sites/configs），不增加 D1 往返。
2. **id 必须重分配**：备份里的 `notes.id` 是**导出方**的编号，导入到另一个账号时会撞号。
   照 sites 的现成做法：先 `nextIdBase` 拿起点、预分配新 id、建 `noteIdMap`。
3. **`user_id` 写当前登录者**，不是文件里那个值 —— 否则会把 A 账号的笔记导进 B 账号名下，
   而这个字段是**唯一的隔离依据**。

**关于事务边界（修正我第一版的说法）**：现有导入**不是**一个巨大的事务，而是
`COMMIT_CHUNK_STATEMENTS = 250` 语句一块、每块各是一个 `db.batch`（见 `transfer.ts:451`）。
它的取舍已经写在代码注释里：中途炸了要回滚**已提交的那几块**，
但「旧数据始终没被动过」，所以库里仍然是「一份完整可用版本」。

笔记**跟着这个分批走**就行，不要另起一套 —— 几百条笔记按 250 一块分，
和卡片是同一种节奏。第一版我写成「所有笔记插同一个 batch 事务」，那是错的：
D1 的 batch 有语句数上限，几百条笔记就会撞上。

### 3.5 导入结果要告诉用户「新增/更新/跳过」几条

现在的 `ImportResult` 只有 `success` / `message` / 两个 idMap（`types.ts:122`），
用户导入完只知道「成功」，不知道**笔记到底怎么处理了**。合并模式下这尤其要紧：

```ts
export interface ImportResult {
    success: boolean;
    message?: string;
    groupIdMap: Record<string, number>;
    siteIdMap: Record<string, number>;
    /** 笔记三态统计（借鉴 inkstone 的 ImportResult 设计） */
    noteStats: {
        /** 文件里有、本地没有 → 新增 */
        created: number;
        /** 同 uuid，取了文件里较新的一份 → 覆盖 */
        updated: number;
        /** 同 uuid 但本地较新，或内容完全一样 → 保留本地不动 */
        skipped: number;
        /** 完全覆盖模式下被清掉的本地笔记数 */
        removed: number;
    };
}
```

`skipped` 这个状态很关键：合并模式下「本地较新就不动」是**正确行为**，
但如果不给用户一个数字，他会以为导入没生效。

（inkstone 的 `ImportResult` 是 `createdNotes / updatedNotes / skippedNotes` 三态，
外加 `createdFolders` / `createdAttachments` 和一个**最多 100 条**的 warnings 列表 ——
那个上限也值得抄，否则一次坏导入能刷屏。）

### 3.6 备份文件会长多大

一条笔记平均 500 字节（含 Markdown 源码，可能更大）：

| 笔记数 | 增量 |
|---|---|
| 50 | ~25 KB |
| 500 | ~250 KB |
| 5000 | ~2.5 MB |

明文 JSON 本来就是全量导出，不是增量，所以**几百条以内都不构成问题**。

---

## 四、Markdown：能存，但渲染层不能照搬 inkstone ⚠️

参考项目 [inkstone](https://github.com/zwjttztt/inkstone)（同样是跑在 Workers 上的
自托管 Markdown 笔记本）的依赖栈：

```
markdown-it 14 + markdown-it-anchor / -footnote / -mark / -task-lists
dompurify · prismjs · katex · mermaid · @codemirror/*
```

### 4.1 冲突：照搬它会让界面直接白屏

inkstone 的渲染流程是：

```
Markdown → md.render() → HTML 字符串 → DOMPurify.sanitize() → template.innerHTML → dangerouslySetInnerHTML
```

而 Navihive 的 `public/_headers` 里有这一条：

```
require-trusted-types-for 'script'; trusted-types navihive-sw
```

- 它把 `innerHTML` / `dangerouslySetInnerHTML` / `eval` / `document.write`
  **全部封死**（赋值字符串直接抛异常）。
- 策略里**没有** `trusted-types` 指令，意味着连创建自己的策略都不允许。
- `_headers` 的注释里已经写明：「**本条是 enforce 生效：万一将来引入会碰 sink 的依赖，
  界面会直接白屏，上线前必须跑一遍全量冒烟**」。

**结论：直接照搬 inkstone 的 `md.render()` + `dangerouslySetInnerHTML`，记事本一打开就白屏。**
这不是配置能绕过的——要么改渲染方式，要么动 CSP（后者意味着全站 XSS 防线降级，**不推荐**）。

### 4.2 采用的方案：markdown-it 只当**解析器**，渲染层自己写

```
Markdown → md.parse() → tokens → 自己映射成 React 元素
```

全程不产生 HTML 字符串、不碰任何 sink —— 与现有「全仓 0 处 innerHTML」的状态一致。

| | inkstone 做法 | 本方案 |
|---|---|---|
| 解析 | markdown-it | markdown-it（**同一个**） |
| 渲染 | renderer → HTML → DOMPurify → innerHTML | token → React 元素 |
| DOMPurify | 需要 | **不需要**（没有字符串注入） |
| CSP 兼容 | ✗ 与 TT 冲突 | ✓ |

**代价要说清楚**：markdown-it 的插件大多注册的是 `renderer.rules.*`，在 token 流方案下
**大部分会失效**，需要自己实现对应的 React 渲染：

| 插件 | token 流下怎么办 |
|---|---|
| `markdown-it-anchor` | 自己按 token 生成 slug，渲染成 `<h2 id=…>` + 一个锚点按钮 |
| `markdown-it-task-lists` | 自己识别 `- [ ]` / `- [x]`，渲染成 MUI `Checkbox`（受控、可点） |
| `markdown-it-mark` | 自己处理 `==高亮==`，渲染成 `<mark>` |
| `markdown-it-footnote` | **本轮不做**（需要完整的引用/回引链路，收益低） |

要支持的语法清单（第一版）：标题、段落、有序/无序列表、任务列表、引用、代码块、
表格、分隔线、链接、图片、粗体/斜体/删除线、行内代码、`==高亮==`。

**明确不做的**（体积炸弹，Navihive 首屏预算不允许，见 4.4）：
- **KaTeX**（公式，~280 KB）—— 笔记里写公式的场景很少
- **Mermaid**（图表，~2 MB）—— 更没必要
- **原始 HTML**（`html: true`）—— 不开。开了就要消毒，等于把 4.1 的坑再踩一遍

### 4.3 编辑器：先用 textarea，CodeMirror 留到后面

inkstone 用 CodeMirror 6（`@codemirror/state|view|commands|lang-markdown|search|autocomplete`
共 6 个包），它带来语法高亮、快捷键、搜索。但：

- 体积大，且 CodeMirror 的模块化懒加载比组件 lazy 麻烦得多
- Navihive 已有 `TextField multiline` + 刚做完的大弹窗（`rows` 撑满那套），**够用**

**第一版用 textarea**，把 CodeMirror 列为「以后想加再加」。

### 4.4 体积预算（这一条是硬约束）

`tests/bundleBudget.test.ts` 现在盯的是**真实首屏总量 950 KB / gzip 305 KB**
（2026-10-05 改的判据）。所以：

- `markdown-it`（min + gzip 约 35 KB）**必须 lazy** —— `NotesPanel` 整体 lazy 引入，
  绝不进首屏 chunk。
- 编辑器、渲染层都在同一个 lazy chunk 里，用户打开记事本时才下载。
- **落地后必须跑一次 `npm test -- bundleBudget`**，确认首屏没变。这条不是可选项。

---

## 五、前端

### 5.1 入口

顶栏加一个按钮（`Header.tsx`），或 `MoreMenu.tsx` 里加一项。
**建议顶栏独立按钮** —— 笔记是高频入口，藏进二级菜单等于没有。

### 5.2 面板

新建 `src/components/NotesPanel.tsx`（**lazy**），从右侧滑出：

- 列表：置顶在上，其余按 `order_num`；每行显示标题 + 内容摘要
- 排序：拖拽改 `order_num`（照 `groups` 的现成逻辑）
- 关键字过滤：**纯客户端**（笔记已在内存里，服务端不存全文索引）
- 编辑态：左源码 / 右预览，或上下切换

### 5.3 编辑弹窗照抄备注那套

内容可能很长，**沿用刚给站点备注做的大弹窗**：`notesPaper` 高度下限 + `rows` 撑大
+ **不硬拉 `height:100%`**（那是「光标落在框中间」的来源）。
连那两条防回退的判据一起抄。

但 textarea 要换成「Markdown 源码 + 预览」的双区布局，编辑区不能像纯文本那样铺满——
所以 `rows` 的值要重新定，且**别再对 textarea 设 height:100%**。

### 5.4 离线

走现成离线队列（`useOfflineQueue`）：断网时负数 id 占位、重放时 `translateTempIds` 回填。
**重放期间必须关入队入口**（`replaying`），否则会做两遍 —— 这是现成的坑，照 `sites` 抄。

---

## 六、工作量拆分

| # | 事项 | 量级 | 备注 |
|---|---|---|---|
| 1 | 建表 + 索引（含 `uuid`） | 小 | `internals.ts` 加一条 SQL |
| 2 | Worker 侧 CRUD + 回收站 | 中 | 照 `recycle.ts` 抄 |
| 3 | 客户端方法 + mock | 中 | 别漏 mock，`apiContract` 守卫会抓 |
| 4 | 导出（独立开关 + `ExportData.notes`） | 小 | 摘要自动覆盖 |
| 5 | **导入（mode + uuid 去重 + 三态统计）** | 中 | **最容易出错**，见 3.2–3.4 |
| 6 | **Markdown 渲染层（token → React）** | **中偏大** | 见 4.2；这是本轮新的主要工作量 |
| 7 | 面板 + 列表 + 编辑双区 | 中 | 大弹窗照抄备注那套 |
| 8 | 拖拽排序 | 小 | 照 groups |
| 9 | 离线队列接入 | 中 | 有现成的坑位 |
| 10 | 测试 | 中 | 见下 |

**测试要钉住的**（都是「写错了不报错、只是数据悄悄不对」那类）：

- 老备份（无 `notes` 字段）导入 → **现有笔记保持不变**
- 跨账号导入 → 笔记归**导入者**名下，不是文件里那个 `user_id`
- 合并模式 + 同 uuid → **不产生重复**，且保留 updated_at 较新的一份
- 覆盖模式 → 旧笔记被清掉
- 导入中途失败 → 卡片与笔记**同生共死**
- 摘要校验：手动删掉一条 `notes` 再导入 → 报「文件损坏」
- **Markdown 渲染**：`<script>` / `javascript:` 链接 / `<img onerror>` 一律变成纯文本
  （token 流方案的天然收益，但要有用例钉住）
- 首屏预算：加了 markdown-it 之后 `bundleBudget` 仍要绿

---

## 七、实施顺序

1. **第 1、2、3 项**（表 + 服务端 + 客户端）—— 纯数据通路
2. **第 4、5 项**（导出/导入）—— 这轮的真正目的，**测试先写**
3. **第 6 项**（Markdown 渲染层）—— 建议单独一轮，它有明确的验收标准：
   给一串 Markdown 源码，断言输出的是 React 元素且**源码里搜不到 innerHTML**
4. **第 7、8 项**（面板 + 排序）
5. **第 9 项**（离线）
6. 测试与文案补齐

第 6 项做完要立刻跑 `npm test -- bundleBudget` —— 那是这次唯一会碰到首屏体积的地方。

---

## 附二：inkstone 里还有哪些思路值得借鉴（分三档）

看完 inkstone 之后我把它的设计过了一遍，按「什么时候用得上」分三档。
**只有第一档进了上面的方案**，后两档是记事本上线之后的事 ——
现在写进去只会让方案失焦。

### 第一档：本轮就该抄（已并入上文）

| 思路 | 出处 | 价值 |
|---|---|---|
| 导入结果三态统计 | `backup-import.ts` 的 `ImportResult` | 正好撑起 merge/replace 的用户反馈，见 3.5 |
| warnings 数量上限 | 同上（`target.warnings.length >= 100` 就停） | 一次坏导入不该刷屏 |
| 重依赖用「转发模块」隔离 | `katex-loader.ts`（整个文件 3 行） | 见下 |

**转发模块**这个技巧值得单独说：它就是

```ts
import katex from 'katex'
import 'katex/dist/katex.min.css'
export default katex
```

看起来什么都没做，价值在于**给打包器一个干净的 chunk 入口** ——
`lazy(() => import('@/lib/katex-loader'))` 会让 katex 单独成一个 chunk，
而不是被并进调用方。Navihive 将来若真要加 katex/mermaid，用这个写法最省事。
（`katex/dist/katex.min.css` 放在转发模块里还有个副作用：CSS 会跟着 chunk 一起懒加载，
不会拖累首屏。）

### 第二档：记事本上线后可以考虑

| 思路 | inkstone 怎么做的 | 对 Navihive 的价值 |
|---|---|---|
| **增量同步（cursor）** | `useNotes.getState().cursor`；服务端只回 `cursor` 之后的变更；消息里还校验 `Number.isSafeInteger` | **最有价值的一条**。Navihive 现在多设备只能全量 `bootstrap`。笔记一多，全量拉既慢又费流量。`cursor` 可以就用 `updated_at` 的最大值，或一个全局递增版本号 |
| **多标签页选主（Leader election）** | `claimLeadership()`：用 BroadcastChannel 广播 claim，比较 `(at, clientId)`，**时间戳早的赢**，等 260ms 定胜负 | Navihive 是多标签页应用。同一个用户开两个标签页，现在会各轮询、各发请求，**浪费一半**。而且 D1 有六类限速，开销是实打实的 |
| **跨标签页广播** | `createBroadcast` + `local-write` / `pulled` / `outbox-result` 消息 | 一个标签页改了，另一个立刻知道，不用等轮询。Navihive 现在只用了 localStorage 分桶（`scopedKey`），没用 BroadcastChannel |
| **实时 + 轮询兜底** | WS 心跳 25s，超过 3 倍没 pong 就断开重连；即使 WS 健康也每 5 分钟兜底拉一次 | Navihive 现在只有轮询。加实时之前先把「兜底 + 心跳超时」这套做对，比先上 WS 重要 |
| **退避封顶** | `min(30s, 800 * 2^n)`，指数封顶 16 | 与 Navihive 离线队列的 1s→60s 思路一致，可以对齐 |
| **改设置不重建引擎** | `updateConfig()` 改 WebSocket/轮询，而不是 dispose 再 new | 小但实用：避免「改个设置断一次连接」 |

### 第三档：特定场景才需要

| 思路 | 为什么现在不需要 |
|---|---|
| **manifest + complete 双阶段提交**（先写 manifest 列出所有文件+sha256，最后写一个 `complete` 标记存 manifest 的 hash；导入时先验 hash 对不对，不对就认定这次快照不完整） | 这是给**多文件备份**解决「网盘同步到一半」的。Navihive 是单文件，已有整体摘要就够。但**如果将来记事本支持图片附件、备份变多文件，这套立刻变成必需** |
| **分批的双重上限**（`8MB` 且 `50 个文件`） | Navihive 单文件用不上。但它那条「按字节 + 按条数双限制」比只按条数更稳，可以留给将来 |
| **依赖顺序（附件先、笔记后）** | 同上，附件场景才需要。笔记的 `site_id` 不构成这种依赖（站点没了笔记还在） |
| **front matter / wiki 链接 / Obsidian callout** | 生态向的功能，做了会让人以为这是 Obsidian 兼容产品。范围要收住 |

---

## 附：从 inkstone 借什么、不借什么

**借**：
- 依赖选型（markdown-it 14 + 那几个插件，作为**解析器**用）
- 插件的行为约定（`markdown-it-task-lists` 的 `enabled/label` 选项、
  `markdown-it-anchor` 的 `permalink.linkInsideHeader` 形态）——照它配，未来对齐行为一致
- 分块渲染的思路（`renderMarkdownBlocks`：先完整解析一遍收集标题，再按顶层 token 切块渲染）

**不借**：
- `md.render()` → HTML → DOMPurify → `innerHTML` 这条链（与本项目 CSP 冲突）
- KaTeX / Mermaid / CodeMirror（体积）
- 原始 HTML 开关

**建议单独记一笔**：inkstone 的 `renderer.ts` 里有个 `escapeHtml()` 辅助函数
看起来是 `.replace(/</g, '<')` 这种「替换成自己」的形式（等于没转义）。
如果确实如此，它的安全性其实全靠后面的 `DOMPurify.sanitize()` 兜着。
借代码时**不要把这个函数一起抄过来**。
