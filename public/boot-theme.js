// public/boot-theme.js
// 首帧同步一次「已存的外观设置」：主题（light/dark）与圆角档位。
//
// 为什么单独一个文件而不是内联进 index.html：全站 CSP 是
// `script-src 'self'`（见 public/_headers），**没有** 'unsafe-inline' ——
// 内联的 <script> 会被拦掉，而且只在 Pages 部署下被拦（本地 dev 正常），
// 这种「本地好使、上线失效」的坑最难查。'self' 允许同源外链，所以放这里。
//
// 它为什么必须在 React 之前跑：启动骨架是纯 CSS 画的，只认 prefers-color-scheme，
// 不认用户在设置里存的 light/dark —— 深色用户每次刷新都先闪一屏浅色骨架；
// 圆角同理，骨架原来写死 12px、真实卡片是 --card-radius，React 一挂载整屏「圆角张开」。
//
// 体积刻意压到几百字节、不发任何请求，同步跑完就在首帧之前。
// React 挂载后会把 --card-radius 写到 .nav-root（比 <html> 更具体的元素），两边不打架。
(function () {
    try {
        // localStorage 在部分 WebView 里一访问就抛 SecurityError，所以整段包 try
        var theme = localStorage.getItem("theme");
        // "system" / 没存过 → 不写属性，继续走 index.html 里那条 @media
        if (theme === "light" || theme === "dark") {
            document.documentElement.dataset.bootTheme = theme;
        }
        var radius = localStorage.getItem("navihive:radius");
        document.documentElement.style.setProperty(
            "--card-radius",
            radius === "standard" ? "14px" : radius === "sharp" ? "6px" : "22px"
        );
    } catch (e) {
        // 读不到就保持默认（圆润 + 跟随系统），骨架照样画得出来
    }
})();
