// shared/sessionCookie.ts
// 会话 cookie 的名字：**前端与服务端共用的唯一定义点**。
//
// 为什么单独成一个文件（A3）：以前 src/API/transport.ts（前端写登录标记）与
// worker/httpUtils.ts（服务端下发 / 清除令牌 cookie）各写一个 "navihive_session"
// 字符串。改一处忘一处就是全站静默掉线：登录接口 200、前端也写了标记，
// 但服务端那条令牌 cookie 的名字对不上 → 下一个请求 401 → 界面刚登录成功就闪回登录页。
//
// 为什么不直接让 worker 引 src/API/transport.ts（那边本来就是要引用的方向）：
// transport.ts 里有 document / location / localStorage 这些 DOM 全局，而
// worker 的 tsconfig 不带 DOM lib（Workers 运行时没有它们）——
// 引用会让 `tsc -b`（npm run typecheck）在那一侧直接编译不过。
// 放在 shared/ 就绕开了这个lib 差异：这个目录就是给两条产物链共用常量用的
// （见 shared/apiErrorCodes.ts 顶上那段说明），刻意**零依赖**。

/** httpOnly 之外那条、给前端判断「是否已登录」的标记 cookie 的名字 */
export const SESSION_COOKIE = "navihive_session";
