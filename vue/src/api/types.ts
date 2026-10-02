// Vue 侧的 API 契约：直接再导出 React 版那份纯 TS 类型，不复制。
// types.ts 里只有数据形状（Group / Site / Config / BootstrapData …）和纯函数，
// 没有一行 React，所以可以被 Vue 安全地复用 —— 迁移期两边数据形状不会跑偏。
export type {
    Group,
    Site,
    SiteMeta,
    BootstrapData,
    Config,
} from "@shared/API/types";
