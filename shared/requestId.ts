// shared/requestId.ts
// 请求 ID 的头名与长度 —— **浏览器 / Worker / 自托管入口共用一份**。
//
// 为什么单独放一个文件：三处都要用同一个字面量 ——
//   · server/entry.ts 在入口生成并注入请求头（结构化访问日志也用它）；
//   · worker/index.ts 读出它（没有就自生成）并回写响应头、写进服务端错误审计；
//   · src/API/client.ts 从响应头读出来挂到 ApiError 上，再由 errorReporter 上报。
// 三份手写迟早漂移，而漂移的表现是「日志里查不到对应那一行」——
// 只在真出故障的那天才发现的静默失效。
//
// ⚠️ 零依赖（与 shared/apiErrorCodes.ts 同理）：worker 与首屏两条产物链都会打进去。
// ⚠️ 取值纪律：这个头是**客户端也能写**的，读进来必须过白名单字符与长度，
//    否则换行符能把伪造的一整条日志塞进日志文件（日志注入）。
export const REQUEST_ID_HEADER = "x-request-id";

/** rid 长度：8 位足够在同一秒的几千条请求里区分开，又不至于把每行日志都撑长 */
export const REQUEST_ID_LEN = 8;

/** rid 的合法形态（入口生成的值天然符合；只有外部传进来的才需要校验） */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
