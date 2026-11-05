// script/auditEnv.d.mts
// auditEnv.mjs 的**最小**类型声明。
//
// 为什么需要它：`tests/copyBlockTokens.test.ts` 要 import `CONTRAST_CORE`，把
// `audit:contrast` 页面上跑的那份亮度/对比度数学原样放进单测里跑。判据本体是 .mjs
// （node 直接跑，里面不能写 TS 标注），strict 模式下没有这份声明会报 TS7016。
// ⚠️ 这里只声明测试**真正用到**的那一个导出，不是给整个审计环境写完整签名 ——
//    logic 与注释永远以 auditEnv.mjs 为准，多写一份形状就多一处会漂的副本。

/** 注入浏览器的对比度核心（模板字符串，定义时不碰 DOM） */
export declare const CONTRAST_CORE: string;
