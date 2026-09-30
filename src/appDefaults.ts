// App 的默认值与配置键名集中放在这里。
//
// 为什么单独拆一个文件：App.tsx 里这些常量散在 160~230 行之间，跟组件代码混在一起，
// 改一个默认值要在四千行里翻；而它们其实跟任何组件状态都无关，纯常量。
// 拆出来之后 App.tsx 只管 import，SettingsDialog 之类的组件想复用也不用回头依赖 App。

import { DEFAULT_ICON_API } from "./utils/iconApi";
import type { WebDavConfig } from "./API/http";

/**
 * 站点默认配置。
 *
 * 数据库里还没存过对应键时用它兜底。注意 `site.title`：原来这里是脚手架的
 * "MyHomepage"，应用一挂载就会把 <title> 从 index.html 里的「Navihive 导航站」
 * 改成它 —— 用户没配过标题的话，看到的就是这个莫名其妙的名字，统一改成站点自己的名字。
 */
export const DEFAULT_CONFIGS = {
    "site.title": "Navihive 导航站",
    "site.name": "Navihive",
    "site.customCss": "",
    // 一键获取图标所用的 API 模板，{domain} 会被替换成站点域名
    "site.iconApi": DEFAULT_ICON_API,
    // 背景图片与蒙版透明度（0~1，越大背景图越清晰）
    "site.backgroundImage": "",
    "site.backgroundMaskOpacity": "0.15",
    // 站点缩略图 API 模板（{url} / {domain} / {origin} 会被替换），留空表示不启用缩略图。
    // 默认留空：缩略图会把每个可见站点的链接交给第三方截图，不该是开箱即用的默认行为。
    // 想用的人在设置里填（输入框的占位提示就是 DEFAULT_THUMB_API，可直接采用）。
    "site.thumbApi": "",
    // 自定义主色（#rrggbb），留空表示跟随默认主题色
    "site.primaryColor": "",
    // 毛玻璃模糊强度（px，0~24），留空表示用默认 14
    "site.glassBlur": "",
};

/** WebDAV 备份默认配置（保存在服务端 configs 表中，不会写入备份文件） */
export const DEFAULT_WEBDAV_CONFIG: WebDavConfig = {
    url: "",
    username: "",
    password: "",
    path: "navihive-backup",
    // 备份口令：空 = 不加密上传（明文 gzip）。设了之后上传/恢复都用这个口令，
    // 与 AUTH_SECRET 无关
    backupPassword: "",
    // 默认不允许内网地址：WebDAV 多半是公网网盘，挡内网是白赚的防护
    allowPrivateNetwork: false,
};

/** WebDAV 配置在 configs 表中的键名前缀 */
export const WEBDAV_CONFIG_PREFIX = "webdav.";

// ---- 可选的多端同步（都存服务端 configs，默认关）----

/** 失效检测结果：换设备不用重测一遍 */
export const LINK_HEALTH_CONFIG = "link.health";
export const LINK_HEALTH_SYNC_CONFIG = "link.healthSync";

/** 本机偏好（星标 / 标签）：清了缓存也不至于全丢 */
export const PREF_SYNC_CONFIG = "pref.sync";
export const PREF_STARRED_CONFIG = "pref.starred";
export const PREF_TAGS_CONFIG = "pref.tags";

/** 改动后多久推一次：拖星标、连续打标签时不该每个动作都发一个请求 */
export const SYNC_DEBOUNCE_MS = 1500;
