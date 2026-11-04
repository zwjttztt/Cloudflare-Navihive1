// script/api-edge-probe-cases.mjs
// `api-edge-probe.mjs` 的 case 表（**纯数据**，没有任何副作用、不 import 任何东西）。
//
// 为什么单独一个文件：以前 case 表就写在探针脚本里，守卫测试想检查「每条 case 都
// 声明了期望状态」只能拿正则去扫源码 —— 改个引号、换个换行就假绿，等于没有守卫。
// 抽成纯数据之后，`tests/apiEdgeProbeSpec.test.ts` 直接 import 这份表逐条断言，
// 检查的是**真的结构**而不是文本。
//
// ---------------------------------------------------------------------------
// 判据（每条 case 必须显式声明 `expect`）
// ---------------------------------------------------------------------------
// 旧版判据只有一个：`status >= 500` 才算坏。于是 **401 / 404 全算「好」** ——
// 探针绿不绿跟「接口是否按预期工作」毫无关系：登录没成功（全 401）也是绿的，
// 路由写错成 404 也是绿的，`note-orders` 两条本该 2xx 的有效请求被挡成 400 还是绿的。
// 现在改成「每条 case 自己说清楚期望什么状态码」：
//
//   1. `status >= 500` **永远判失败**（与旧版一致；服务端崩了和「正确地拒绝」是两件事）；
//   2. 声明了 `expect` 的，实际状态必须在集合内；
//   3. 故意探测「未鉴权 / 不存在」的 case，把 `expect` 显式写成 `[401]` / `[404]`，
//      **不许用默认值蒙**（默认值就是这么把 401 放过去的）。
//
// ---------------------------------------------------------------------------
// 字段
// ---------------------------------------------------------------------------
//   method   HTTP 方法
//   path     `/api/` 之后的路径（含 query）
//   body     请求体；`undefined` = 不带体，`null` = 带 JSON `null`（两者必须能区分，
//            「null 体会不会让服务端 500」正是这个探针最老的一条命案）
//   expect   允许的状态码集合（**必填**，非空整数数组）
//   why      这条在探什么（必填；失败时打印出来，省得回头猜）
//   auth     "none" = 故意不带会话（探未鉴权）；缺省 = 带已登录会话
//   note     已知的可疑行为 / 依赖关系（可选，仅作文档，不参与判定）
//
// ⚠️ 顺序有意义：后面的 case 依赖前面 POST 出来的数据（比如 `/api/notes/1` 那条
// 依赖前面 `POST /api/notes` 已经建出了 id=1）。别随手调整顺序。

/** 10 万字符：远超任何字段的长度上限，用来试探「超长输入会不会把服务端搞崩」 */
export const LONG_INPUT = "x".repeat(100_000);

/** 失败时打印的响应体长度上限（旧版是 160，短到看不见错误原因） */
export const BODY_PREVIEW_CHARS = 800;

/** 守卫测试用的下限：抽出 case 表时一条都不许丢（原脚本是 59 条） */
export const MIN_CASES = 59;

/** 故意不带会话的标记 */
export const AUTH_NONE = "none";

/**
 * 造一张 case 表。
 *
 * 目前所有 case 都能由常量拼出来，所以 `buildCases()` 就是 `buildCases({})`。
 * 之所以留着工厂签名：有些探测天然依赖运行期值（「先建一条笔记拿到它真实的 id 再拿
 * 那个 id 去探边界」比写死 `1` 稳得多）。测试用一个桩 ctx 调它就能拿到全量 case，
 * 不需要起服务，也不需要知道哪些值是真跑时才算得出来。
 *
 * @param {{ longInput?: string, noteId?: number }} [ctx]
 * @returns {Array<{
 *   method: string,
 *   path: string,
 *   body?: unknown,
 *   expect: number[],
 *   why: string,
 *   auth?: "none",
 *   note?: string,
 * }>}
 */
export function buildCases(ctx = {}) {
    const long = typeof ctx.longInput === "string" ? ctx.longInput : LONG_INPUT;
    // 默认 1：探针自己的流程序列里 `POST /api/notes` 先建出了 id=1，
    // 这三条 PUT 就打在它身上（顺序有意义，见文件头）。
    const noteId = Number.isInteger(ctx.noteId) ? /** @type {number} */ (ctx.noteId) : 1;

    return [
        // ---- 读：分页参数是「夹取」还是「拒绝」，两种都算对，但必须有一个确定行为 ----
        {
            method: "GET",
            path: "/api/notes?fields=list&limit=-1",
            body: undefined,
            expect: [200],
            why: "limit 为负：要么夹取成合法值、要么 400，绝不许 500",
            note: "实测被当成「没传」→ 全量返回（200）",
        },
        {
            method: "GET",
            path: "/api/notes?fields=list&limit=99999999",
            body: undefined,
            expect: [200],
            why: "limit 超大：必须夹到上限，不许直接拼进 SQL",
        },
        {
            method: "GET",
            path: "/api/notes?fields=list&limit=abc",
            body: undefined,
            expect: [200],
            why: "limit 非数字：NaN 进 SQL 会变成无 LIMIT 或 500，必须是确定行为",
        },
        {
            method: "GET",
            path: "/api/notes/-1",
            body: undefined,
            expect: [404],
            why: "负数 id：不存在就是 404，不许 500",
        },
        {
            method: "GET",
            path: "/api/notes/NaN",
            body: undefined,
            expect: [400],
            why: "id 是 NaN：入口必须拒（400），不能把 NaN 绑进 SQL",
        },
        {
            method: "GET",
            path: "/api/notes/1e999",
            body: undefined,
            expect: [404],
            why: "id 溢出成 Infinity：必须被挡成「不存在」，不许进 SQL 变 500",
        },
        {
            method: "GET",
            path: "/api/notes/99999999999999999999",
            body: undefined,
            expect: [404],
            why: "超出安全整数范围的 id：同上",
        },
        {
            method: "GET",
            path: "/api/notes/%20",
            body: undefined,
            expect: [400],
            why: "id 是空格：parseInt 得 NaN → 400",
        },
        {
            method: "GET",
            path: "/api/notes/..",
            body: undefined,
            expect: [404],
            why: "路径穿越：不许命中别的路由实现",
        },
        {
            method: "GET",
            path: "/api/notes/folders/../../etc",
            body: undefined,
            expect: [404],
            why: "路径穿越（多级）：不许被当成静态文件取走",
        },

        // ---- 读：搜索的畸形入参 ----
        {
            method: "POST",
            path: "/api/notes/search",
            body: { query: long, limit: 10 },
            expect: [200],
            why: "10 万字查询：FTS 解析不能崩（崩了就是 500）",
        },
        {
            method: "POST",
            path: "/api/notes/search",
            body: { query: "", limit: -5 },
            expect: [200],
            why: "空查询 + 负 limit：必须给空结果，不许 500",
        },
        {
            method: "POST",
            path: "/api/notes/search",
            body: { query: null, limit: "x" },
            expect: [200],
            why: "query 为 null、limit 是字符串：类型不符要能兜住",
        },
        {
            method: "POST",
            path: "/api/notes/search",
            body: null,
            expect: [200],
            why: "body 为 JSON null：搜索是只读接口，可以不 400，但绝不能 500",
        },

        // ---- 写：笔记 ----
        {
            method: "POST",
            path: "/api/notes",
            body: { title: long, content: "a" },
            expect: [200],
            why: "10 万字标题：不许把服务端搞崩",
            note: "实测 200 —— 目前**没有**标题长度上限，超长标题会被原样落库",
        },
        {
            method: "POST",
            path: "/api/notes",
            body: { title: "边界", content: long },
            expect: [200],
            why: "10 万字正文：同上",
            note: "实测 200 —— 同样没有正文长度上限",
        },
        {
            method: "POST",
            path: "/api/notes",
            body: { title: " 控制字符", content: "" },
            expect: [200],
            why: "标题带控制字符：要能存（前端会转义），不许 500",
        },
        {
            method: "POST",
            path: "/api/notes",
            body: { title: "emoji \u{1F600}\u{1F1FA}\u{1F1F8}", content: "" },
            expect: [200],
            why: "emoji / 区域旗：UTF-16 代理对不许把 SQL 参数搞坏",
        },
        {
            method: "POST",
            path: "/api/notes",
            body: { title: 12345, content: {} },
            expect: [200],
            why: "title/content 类型都不对：字段级白名单必须把它们降级成空串，不许进 SQL",
            note: "实测 200 且落库是空标题 —— 这是**已知的静默降级**（不是崩溃，故钉 200）",
        },
        {
            method: "POST",
            path: "/api/notes",
            body: "不是对象",
            expect: [400],
            why: "body 是字符串：旧版会静默建出一条全空笔记，现在必须 400",
        },
        {
            method: "POST",
            path: "/api/notes",
            body: null,
            expect: [400],
            why: "body 是 null：旧版 `null.title` 抛 TypeError → 500 的那条命案",
        },

        // ---- 写：分组 ----
        {
            method: "POST",
            path: "/api/groups",
            body: { name: long, order_num: 0 },
            expect: [200],
            why: "10 万字分组名：不许崩",
            note: "实测 200 —— 分组名也没有长度上限",
        },
        {
            method: "POST",
            path: "/api/groups",
            body: { name: "", order_num: 0 },
            expect: [400],
            why: "空分组名：业务上无意义，必须拒",
        },
        {
            method: "POST",
            path: "/api/groups",
            body: { name: "分组", order_num: "abc" },
            expect: [400],
            why: "order_num 是字符串：必须 400，不能靠 SQLite 报错变 500",
        },
        {
            method: "POST",
            path: "/api/groups",
            body: { name: "分组", order_num: 1e999 },
            expect: [400],
            why: "order_num 溢出成 Infinity：必须 400",
        },
        {
            method: "POST",
            path: "/api/groups",
            body: null,
            expect: [400],
            why: "body 为 null",
        },
        {
            method: "POST",
            path: "/api/groups",
            body: "字符串",
            expect: [400],
            why: "body 是字符串：旧版会静默建出空分组",
        },
        {
            method: "POST",
            path: "/api/groups",
            body: 12345,
            expect: [400],
            why: "body 是数字：同上",
        },
        {
            method: "POST",
            path: "/api/groups",
            body: [1, 2],
            expect: [400],
            why: "body 是数组：写接口不收顶层数组",
        },

        // ---- 写：站点 ----
        {
            method: "POST",
            path: "/api/sites",
            body: { group_id: 999999, name: "孤立", url: "https://e.com" },
            expect: [400],
            why: "group_id 不存在：必须 400，不能写出一条挂在幽灵分组上的站点",
            note: "实测 400，但报文是「排序号必须是数字」—— 校验顺序让它先被别的规则挡住，实际没探到 group_id",
        },
        {
            method: "POST",
            path: "/api/sites",
            body: { group_id: 1, name: "坏 URL", url: "javascript:alert(1)" },
            expect: [400],
            why: "javascript: 伪协议：安全边界，必须拒",
        },
        {
            method: "POST",
            path: "/api/sites",
            body: { group_id: 1, name: "坏 URL2", url: "not-a-url" },
            expect: [400],
            why: "不是 URL：必须拒",
        },
        {
            method: "POST",
            path: "/api/sites",
            body: { group_id: 1, name: "坏 URL3", url: "" },
            expect: [400],
            why: "空 URL：必须拒",
        },
        {
            method: "POST",
            path: "/api/sites",
            body: null,
            expect: [400],
            why: "body 为 null",
        },

        // ---- 写：标签 / 文件夹 ----
        {
            method: "POST",
            path: "/api/notes/tags",
            body: { name: long },
            expect: [200],
            why: "10 万字标签名：不许崩",
            note: "实测 200 —— 标签名没有长度上限",
        },
        {
            method: "POST",
            path: "/api/notes/tags",
            body: null,
            expect: [400],
            why: "body 为 null",
        },
        {
            method: "POST",
            path: "/api/notes/folders",
            body: { name: long, order_num: 0 },
            expect: [200],
            why: "10 万字文件夹名：不许崩",
            note: "实测 200 —— 文件夹名没有长度上限",
        },
        {
            method: "POST",
            path: "/api/notes/folders",
            body: null,
            expect: [400],
            why: "body 为 null",
        },

        // ---- 写：改笔记（乐观并发） ----
        {
            method: "PUT",
            path: `/api/notes/${noteId}`,
            body: { content: "x", rev: -1 },
            expect: [200],
            why: "rev 为负：不是合法版本号，应退化成「不做并发校验」而不是 500",
            note: "实测 200 —— 负 rev 被忽略，等于老客户端行为",
        },
        {
            method: "PUT",
            path: `/api/notes/${noteId}`,
            body: { content: "x", rev: 99999999 },
            expect: [409],
            why: "rev 对不上：必须 409 并带回当前内容，不许静默覆盖别人的改动",
        },
        {
            method: "PUT",
            path: `/api/notes/${noteId}`,
            body: { rev: "abc" },
            expect: [200],
            why: "rev 是字符串：类型不符要忽略它，不许拼进 SQL",
        },
        {
            method: "PUT",
            path: `/api/notes/${noteId}`,
            body: null,
            expect: [400],
            why: "body 为 null",
        },
        {
            method: "PUT",
            path: `/api/notes/${noteId}/tags`,
            body: null,
            expect: [400],
            why: "body 为 null",
        },
        {
            method: "PUT",
            path: "/api/notes/folders/1",
            body: { name: long },
            expect: [200],
            why: "10 万字文件夹名（改名）：不许崩",
        },

        // ---- 写：配置 ----
        {
            method: "PUT",
            path: "/api/configs/x",
            body: { value: long },
            expect: [200],
            why: "10 万字配置值：不许崩",
            note: "实测 200 —— 配置值没有长度上限",
        },
        {
            method: "PUT",
            path: "/api/configs/x",
            body: { value: null },
            expect: [400],
            why: "value 为 null：配置值只认字符串",
        },
        {
            method: "PUT",
            path: "/api/configs/x",
            body: null,
            expect: [400],
            why: "body 为 null",
        },

        // ---- 写：导入 ----
        {
            method: "POST",
            path: "/api/notes/import",
            body: { data: "not-json" },
            expect: [400],
            why: "data 不是合法 JSON：必须 400 而不是把服务端搞崩",
        },
        {
            method: "POST",
            path: "/api/notes/import",
            body: { data: "{}" },
            expect: [400],
            why: "合法 JSON 但没有笔记数据：必须 400 而不是静默导入 0 条",
        },
        {
            method: "POST",
            path: "/api/notes/import",
            body: null,
            expect: [400],
            why: "body 为 null",
        },

        // ---- 写：批量排序 ----
        {
            method: "PUT",
            path: "/api/note-orders",
            body: { orders: "not-an-array" },
            expect: [400],
            why: "orders 不是数组：必须 400（undefined 进 bind 会变 500）",
        },
        {
            method: "PUT",
            path: "/api/note-orders",
            body: { orders: [{ id: "x", order_num: 1 }] },
            expect: [400],
            why: "元素 id 不是数字：必须逐项校验后 400",
        },
        {
            method: "PUT",
            path: "/api/note-orders",
            body: null,
            expect: [400],
            why: "body 为 null",
        },
        // 反向：这个接口**两种形状都认**，探针也得钉住「有效的形状不能被挡掉」——
        // 只验「坏的被拒」会漏掉「好的也被拒」那一类回归（改错过一次）。
        // 这两条以前只被「非 5xx 就算过」放过去，等于没验。
        {
            method: "PUT",
            path: "/api/note-orders",
            body: [{ id: noteId, order_num: 0 }],
            expect: [200],
            why: "顶层数组形状：这是**有效**请求，必须 2xx，不许被入口挡成 400",
            note: "实测 200 `{success:true}`（route 用 Response.json 回，不是 201）",
        },
        {
            method: "PUT",
            path: "/api/note-orders",
            body: { orders: [{ id: noteId, order_num: 0 }] },
            expect: [200],
            why: "`{orders:[...]}` 形状：同样是有效请求，必须 2xx",
            note: "实测 200 `{success:true}`",
        },
        {
            method: "PUT",
            path: "/api/group-orders",
            body: null,
            expect: [400],
            why: "body 为 null（这个接口只收顶层数组）",
        },
        {
            method: "PUT",
            path: "/api/site-orders",
            body: null,
            expect: [400],
            why: "body 为 null（同上）",
        },

        // ---- 读：附件路径穿越 ----
        {
            method: "GET",
            path: "/api/notes/attachments/..%2F..%2Fetc%2Fpasswd",
            body: undefined,
            expect: [400],
            why: "附件 id 里塞逃逸序列：必须被挡（400），绝不能读到库外文件",
        },

        // ---- 登录在鉴权链之外，单独一条 ----
        {
            method: "POST",
            path: "/api/login",
            body: null,
            expect: [400],
            why: "登录体为 null：`null` 体曾让 validateLogin 去读 .username 抛 500",
        },

        // ---- 未鉴权：故意不带会话 ----
        // 这一组以前完全没有。旧判据把 401 当「好」，于是「鉴权整个失效、所有接口
        // 都能匿名访问」也能全绿 —— 正好是最不该绿的那种故障。
        {
            method: "GET",
            path: "/api/notes",
            body: undefined,
            expect: [401],
            why: "不带会话读笔记：必须 401（探到 200 说明鉴权漏了）",
            auth: AUTH_NONE,
        },
        {
            method: "PUT",
            path: "/api/note-orders",
            body: [{ id: noteId, order_num: 0 }],
            expect: [401],
            why: "不带会话写排序：**有效请求体**也必须先被鉴权挡住（401 优先于 200）",
            auth: AUTH_NONE,
        },
    ];
}
