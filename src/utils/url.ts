// src/utils/url.ts
// 网址规范化：补协议、挡危险协议、抹掉无意义的格式差异。
//
// 为什么需要单独一层：
// 1) 用户手输网址时几乎不会写 https://，直接存进库会被当成相对路径（点开跳到自己站内的 /xxx）。
// 2) <input type="url"> 挡得住 baidu.com、却**放行 javascript:alert(1)**（实测 Chrome 行为），
//    而卡片是 `href={site.url}` 直出的，等于留了一个存储型 XSS 口子。
// 3) 导入备份这条路完全不走表单校验，必须在入库前自己过一遍。
// 所以统一在「保存」和「导入」两处调用 normalizeUrl()，别再只靠表单。

/** 只放行这两种协议；其它（javascript: / data: / file: / vbscript: …）一律拒绝 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** 默认端口，规范化时去掉（http://a.com:80/ 与 http://a.com/ 是同一个地址） */
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

export type NormalizeFailure =
    | "empty"
    | "bad-protocol"
    | "unparseable"
    | "no-host";

export interface NormalizeResult {
    ok: boolean;
    /** 规范化后的网址；失败时是去掉空白与危险协议的原样字符串（仅供展示，别拿去存） */
    url: string;
    /** 失败原因，用于给用户一句能看懂的提示 */
    reason?: NormalizeFailure;
}

const FAILURE_TEXT: Record<NormalizeFailure, string> = {
    empty: "网址不能为空",
    "bad-protocol": "只支持 http / https 开头的网址",
    unparseable: "网址格式不对，换个写法试试（例：https://example.com）",
    "no-host": "网址里缺少域名",
};

export const normalizeFailureText = (reason?: NormalizeFailure): string =>
    reason ? FAILURE_TEXT[reason] : "网址无法识别";

/**
 * 规范化用户输入的一个网址。
 *
 * 做的事：
 * - 去掉首尾空白、换行与控制字符（从 Excel / 浏览器地址栏粘贴时很常见）
 * - 没有协议头时补 `https://`（`//example.com` 也按 http(s) 处理，跟随页面协议不可靠，统一给 https）
 * - 协议不在白名单里就拒绝 —— 这一条是安全底线，`javascript:` 会在这里被拦下
 * - 去掉默认端口、域名转小写、根路径的尾斜杠去掉（`/` 保留）
 *
 * 不做的事：
 * - 不去掉 `www.`、不解析查询串 —— 那是查重的事，见 `duplicate.ts` 的 `urlKey()`
 */
export function normalizeUrl(input: string): NormalizeResult {
    // 控制字符（含 \t \n \r）在 URL 里没有意义，还会被用来绕过黑名单检查
    // eslint-disable-next-line no-control-regex -- 这里的控制字符就是要被清掉的目标，不是误写
    const raw = (input || "").replace(/[\u0000-\u0020\u007f]/g, "").trim();
    if (!raw) return { ok: false, url: "", reason: "empty" };

    // 显式写了 javascript: / data: / file: 之类 —— 一律拒绝，不给补 https:// 的机会
    // （没有 `//` 分隔的伪协议会命中这一条；`//evil.com` 是协议相对地址，合法）
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    const scheme = schemeMatch ? schemeMatch[1].toLowerCase() + ":" : "";
    if (scheme && !ALLOWED_PROTOCOLS.has(scheme)) {
        return { ok: false, url: raw, reason: "bad-protocol" };
    }

    let withScheme = raw;
    if (!scheme) withScheme = `https://${raw.replace(/^\/+/, "")}`;

    let parsed: URL;
    try {
        parsed = new URL(withScheme);
    } catch {
        return { ok: false, url: raw, reason: "unparseable" };
    }

    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return { ok: false, url: raw, reason: "bad-protocol" };
    }
    // 域名为空只剩 `https://` 或 `https:///path`
    if (!parsed.hostname) return { ok: false, url: raw, reason: "no-host" };

    if (parsed.port && parsed.port === DEFAULT_PORTS[parsed.protocol]) {
        parsed.port = "";
    }

    // 根路径的尾斜杠去掉（https://a.com/ -> https://a.com），但保留 `/` 之外的路径
    if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
        return { ok: true, url: `${parsed.protocol}//${parsed.host}` };
    }

    return { ok: true, url: parsed.href };
}

/**
 * 能不能安全地放进 href。渲染层兜底用：数据库里理论上都是规范化过的，
 * 但历史数据 / 手动改库可能混进奇怪的值，卡片出链接前先过一次，
 * 万一不匹配就把 href 去掉，避免点一下执行脚本。
 */
export function isSafeHttpUrl(url?: string | null): boolean {
    const value = (url || "").trim();
    if (!value) return false;
    try {
        return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
    } catch {
        return false;
    }
}

/** 从网址里取展示用的域名（图标/描述兜底标题会用） */
export const hostOfUrl = (url?: string | null): string => {
    try {
        return new URL(url || "").hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
};

/**
 * 网址身份键：抹掉「同一个地址的写法差异」，用来判断两张卡片是不是同一个站点。
 *
 * 去重（新增卡片时提示「链接已存在」）与增量导入（判断这条要不要新建）共用同一把尺子 ——
 * 两边判定不一致就会出现「前端说重复、导入还是又建一条」。
 *
 * ⚠️ 只抹「差异」，不能抹「分隔」：早先是先把非字母数字全换成空格、再把空格删掉，
 * 于是 a.com/a/b、a.com/ab、a.com/a-b 三个地址算出同一个 key，
 * 会被误判成同一张卡（duplicate.ts 的实测教训）。
 * 现在把连续的非字母数字压成一个 "/"，路径层级留住；"?" 和 "#" 保持原样，
 * 免得查询串 / 锚点和路径层级混在一起（p?x=1 与 p/x/1 因此仍然不同）。
 *
 * 放在 utils/url 而不是 utils/duplicate：导入那几条链路也要用它，
 * 而 duplicate.ts 依赖 SVG / 组件层的类型，绕过去会产生循环引用。
 */
export const urlIdentityKey = (url?: string | null): string => {
    const raw = (url || "").trim();
    if (!raw) return "";
    return raw
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/[^\p{L}\p{N}?#]+/gu, "/")
        .replace(/^\/+/, "")
        .replace(/[/?#]+$/, "");
};
