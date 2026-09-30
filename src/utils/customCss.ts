// 「网站设置」里那段自定义 CSS 的清洗。
//
// 从 App.tsx 搬过来。它是纯字符串变换，放在组件里既没法单测、又容易被人误改。
// 注意这一层只是**兜底**：CSS 是管理员自己填的，真正的安全底线是不让非 owner 写
// 全站配置（`canManageSharedConfigs`）—— 清洗只在「管理员手滑贴了一段带 url(javascript:)
// 的样式」这种场景救场，别指望它挡住蓄意的攻击者。

/**
 * 去掉 CSS 里能直接执行脚本的那几种写法。
 *
 * - `url(javascript:...)`：改写 url() 的伪协议（保留外层括号，避免整条样式被浏览器丢弃时连带丢掉其它声明）
 * - `expression(...)`：老 IE 的脚本执行入口
 * - `@import`：可以把外部样式表带进来（绕过本文件的清洗）
 * - `behavior:`：老 IE 的 HTC 行为，等同引入脚本
 * - `content:` 里嵌 url(javascript:)：伪元素 content 也能触发
 */
export function sanitizeCustomCss(css: string): string {
    if (!css) return "";

    return (
        css
            // 移除包含javascript:的URL
            .replace(/url\s*\(\s*(['"]?)javascript:/gi, "url($1invalid:")
            // 移除expression
            .replace(/expression\s*\(/gi, "invalid(")
            // 移除import
            .replace(/@import/gi, "/* @import */")
            // 移除behavior
            .replace(/behavior\s*:/gi, "/* behavior: */")
            // 过滤content属性中的不安全内容
            .replace(/content\s*:\s*(['"]?).*?url\s*\(\s*(['"]?)javascript:/gi, "content: $1")
    );
}
