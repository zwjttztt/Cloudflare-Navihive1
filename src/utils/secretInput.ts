// src/utils/secretInput.ts
//
// 卡片上的「登录凭据」是**站点自己的账号密码**，不是导航站的登录密码。
// 浏览器看不出这层区别：只要页面上同时出现「一个文本输入框 + 一个 type=password
// 输入框」，它就会当成登录表单，保存卡片时弹「要不要保存密码」，还会拿导航站
// 自己的登录账号去自动填充卡片字段。
//
// 试过并验证无效的做法（别再走一遍）：
// - autocomplete="off" —— Chrome / Edge 从很早的版本起就**故意忽略**密码字段上的 off，
//   理由是「用户想存密码你拦不住」。
// - autocomplete="new-password" —— 更糟，语义上等于邀请浏览器「这里有个新密码，存吗？」，
//   老代码里就是这么写的，提示就是它招来的。
// - 去掉 <form>、按钮改 type="button" —— 能挡掉「表单提交」触发的那一次，但 Chrome 有
//   formless 检测（页面上 password 字段的值变了、随后字段随弹窗一起消失），照样会提示。
//
// 真正有效的只有这一条：让浏览器**根本认不出这是密码字段**。
// 即 type="text" + CSS `-webkit-text-security: disc` 做视觉遮蔽 —— 用户看到的还是圆点，
// 但浏览器眼里它就是个普通文本框，既不保存也不自动填充。
// Firefox 至今没实现这个属性，那里回退成 type="password"（Firefox 不搞 formless 检测，
// 没有 form 时它本来就不会提示，所以回退是安全的）。

let supportedCache: boolean | null = null;

/** 当前浏览器支不支持用 CSS 遮蔽文本（Chromium / WebKit 支持，Gecko 不支持） */
export function textSecuritySupported(): boolean {
    if (supportedCache !== null) return supportedCache;
    if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
        supportedCache = false;
        return false;
    }
    try {
        supportedCache = CSS.supports("-webkit-text-security", "disc");
    } catch {
        supportedCache = false;
    }
    return supportedCache;
}

/** 密码框该用什么 type：能遮蔽就用 text（不被识别为密码），否则退回 password */
export function secretInputType(visible: boolean): "text" | "password" {
    return visible || textSecuritySupported() ? "text" : "password";
}

/**
 * 配套样式：type 被换成 text 时靠它把内容遮成圆点。
 * 点了「显示密码」就撤掉遮蔽，露出明文。
 */
export function secretInputSx(visible: boolean): Record<string, unknown> {
    if (!textSecuritySupported()) return {};
    return {
        "& input": {
            WebkitTextSecurity: visible ? "none" : "disc",
        },
    };
}

/**
 * 输入框 name → 数据字段名的映射。
 *
 * name 不能叫 username / password（浏览器靠「名字 + 类型」猜这是登录表单），
 * 但表单状态里的键还得是 username / password，所以读写时过一遍这个表。
 * 忘了过 = 输入框打字没反应（值被写到 formData["site-account"] 里去了）。
 */
const FIELD_ALIASES: Record<string, string> = {
    "site-account": "username",
    "site-secret": "password",
};

export function formDataKey(name: string): string {
    return FIELD_ALIASES[name] ?? name;
}

/** 挂到密码框上的「请别管我」标记，挡掉第三方密码管理器扩展的图标与保存提示 */
export const SECRET_IGNORE_ATTRS = {
    "data-lpignore": "true",
    "data-1p-ignore": "true",
    "data-bwignore": "true",
    "data-protonpass-ignore": "true",
} as const;
