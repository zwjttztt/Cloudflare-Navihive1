// shared/spaRoutes.ts
// 前端 SPA 的**唯一路由表**，以及「像不像静态资源」的判定。
//
// 为什么要有这个文件：同一个判定以前在三处各写一份 —— worker/index.ts 内联
// `/\.[a-z0-9]{1,8}$/i`、server/static.ts 的 ASSET_EXT_RE、src/main.tsx 内联
// 两个 `/^\/s\/([a-f0-9]{64})$/`。它们互相看不见，于是「前端加了路由、后端没跟」
// 只能是静默失效：路由 404 只有真访问才发现，而后端回退太宽（无扩展名一律回
// index.html）又会把 `/anything` 全变成 200。收敛成一份，加路由只改一处。
//
// 放在仓库根的 shared/ 而不是 src/：worker 的 tsconfig 只 include worker/，
// 但 import 的依赖会被跟随编译，所以 shared/ 两侧都能引（server/ 同理，
// 它由 script/build-server.mjs 用 esbuild 整体打包）。
// 刻意**零依赖**：这个文件会被打进 worker、首屏、自托管服务端三条产物链。
//
// 收紧后的语义（P2-8）：
//   · 带扩展名 → 静态资产，命中就吐、不命中 404（绝不拿整页 HTML 顶替脚本）
//   · 命中路由表 → SPA 回退 index.html
//   · 其余（无扩展名但不在表里）→ 404
// 第三条是这次的改动：以前 `/notes`、`/.git/config`、`/wp-login.php` 这类
// 无扩展名路径一律 200 回整页 HTML，扫描器拿到的是「本站什么都存在」，
// 而真实业务根本没有这些路由。
export const SHARE_TOKEN_PATTERN = "[a-f0-9]{64}";

/** 单条分享笔记：/s/<64 位小写 hex> */
export const PUBLIC_NOTE_PATH_RE = new RegExp(`^/s/(${SHARE_TOKEN_PATTERN})$`);
/** 单条分享分组：/sg/<64 位小写 hex> */
export const PUBLIC_GROUP_PATH_RE = new RegExp(`^/sg/(${SHARE_TOKEN_PATTERN})$`);

/** 与 server/static.ts 原 ASSET_EXT_RE 同义：最后一节带 .ext（1~8 位）就算静态资产 */
export const ASSET_EXT_RE = /\.[a-z0-9]{1,8}$/i;

export interface SpaRoute {
    name: string;
    match: RegExp;
}

/**
 * 前端事实路由表。前端**没有** react-router，业务内部全靠状态切换，
 * URL 上真实存在的只有这三条（见 src/main.tsx：publicGroupToken → 分组公开页，
 * publicToken → 笔记公开页，否则 → App）。新增 URL 路由必须同时加在这里，
 * 否则 Cloudflare 与自托管都会回 404。
 */
export const SPA_ROUTES: readonly SpaRoute[] = [
    { name: "home", match: /^\/$/ },
    { name: "public-note", match: PUBLIC_NOTE_PATH_RE },
    { name: "public-group", match: PUBLIC_GROUP_PATH_RE },
];

/** 归一：保证以 / 开头、去掉结尾多余斜杠（`/s/<token>/` 与 `/s/<token>` 同路由） */
export function normalizeSpaPath(pathname: string): string {
    let p = pathname.startsWith("/") ? pathname : `/${pathname}`;
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return p;
}

/** 未命中的路径是否「像静态资源」：最后一节带扩展名（.js / .css / .png / .woff2 …）就算 */
export function looksLikeAsset(pathname: string): boolean {
    const last = pathname.split("/").pop() ?? "";
    return ASSET_EXT_RE.test(last);
}

/** 是否是前端真实存在的路由（决定要不要回退 index.html） */
export function isSpaRoute(pathname: string): boolean {
    const p = normalizeSpaPath(pathname);
    return SPA_ROUTES.some(route => route.match.test(p));
}

/** /s/<token> 里的 token，不是这条路由返回 null */
export function publicNoteTokenFromPath(pathname: string): string | null {
    return PUBLIC_NOTE_PATH_RE.exec(normalizeSpaPath(pathname))?.[1] ?? null;
}

/** /sg/<token> 里的 token，不是这条路由返回 null */
export function publicGroupTokenFromPath(pathname: string): string | null {
    return PUBLIC_GROUP_PATH_RE.exec(normalizeSpaPath(pathname))?.[1] ?? null;
}
