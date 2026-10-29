// public/boot-guard.js
// 首屏兜底：主脚本没跑起来时，把页面从「死骨架」里救回来。
//
// 为什么需要它（2026-10-29 线上实况）：
//   index.html 里有一套纯 CSS 骨架（#boot-skeleton），React 挂载后由 main.tsx 在
//   首帧的 rAF 里删掉。也就是说 —— 只要 `<script type="module" src="/assets/index-*.js">`
//   因为任何原因**没执行**（chunk 404、跨境线路抽风、SW 缓存里留了个引用已删 chunk 的
//   旧外壳），页面就会永久停在骨架：没有报错、没有按钮、刷新也不一定恢复。
//   而所有「版本漂移自救」代码都在那个跑不起来的 bundle 里，救不了自己。
//
// 所以这段必须是**外链的独立脚本**（CSP 是 script-src 'self'，内联会被拦），
// 且不依赖任何构建产物：它只看一件事 —— 到点了骨架还在不在。
//
// 动作只有三步，且**每个会话只做一次**（避免服务器真挂了时无限刷新）：
//   1) 删掉所有 Cache Storage（把 SW 里那份旧外壳/旧 chunk 清干净）；
//   2) 注销 Service Worker（下次导航直接回源）；
//   3) reload 一次。
// 主资源在 reload 时浏览器强制回源校验，所以「HTML 缓存 60 秒」也不会把旧外壳再喂回来。
(function () {
    "use strict";

    var SKELETON_ID = "boot-skeleton";
    var RETRY_KEY = "navihive:boot-guard";
    var TIMEOUT_MS = 15000;
    var CACHE_CLEAR_DEADLINE_MS = 3000;

    function hasRetried() {
        try {
            return sessionStorage.getItem(RETRY_KEY) === "1";
        } catch (e) {
            // 隐私模式 / 存储被禁：当作「没重试过」，但下面的 URL 参数还能兜一层
            return /(\?|&)boot-retry=1(&|$)/.test(location.search);
        }
    }

    function markRetried(flag) {
        try {
            if (flag) sessionStorage.setItem(RETRY_KEY, "1");
            else sessionStorage.removeItem(RETRY_KEY);
        } catch (e) {
            /* 存不了就算了，不因为记账失败把用户卡住 */
        }
    }

    /** 骨架还在 = React 没提交过首帧（mount 成功的路径一定会把它删掉） */
    function skeletonAlive() {
        try {
            return document.getElementById(SKELETON_ID) !== null;
        } catch (e) {
            return false;
        }
    }

    function dropCaches() {
        try {
            if (!window.caches || typeof window.caches.keys !== "function") return Promise.resolve();
            return window.caches.keys().then(function (keys) {
                return Promise.all(
                    keys.map(function (key) {
                        return window.caches.delete(key);
                    })
                );
            });
        } catch (e) {
            return Promise.resolve();
        }
    }

    function unregisterWorkers() {
        try {
            var sw = navigator.serviceWorker;
            if (!sw || typeof sw.getRegistrations !== "function") return Promise.resolve();
            return sw.getRegistrations().then(function (regs) {
                return Promise.all(
                    regs.map(function (reg) {
                        return reg.unregister();
                    })
                );
            });
        } catch (e) {
            return Promise.resolve();
        }
    }

    function reload() {
        try {
            location.reload();
        } catch (e) {
            /* 极少数环境禁止 reload：什么都做不了，保持原样即可 */
        }
    }

    function recover() {
        var finished = false;
        function finish() {
            if (finished) return;
            finished = true;
            reload();
        }
        // 清缓存 / 注销本身卡住也不能让用户干等：到点直接刷
        setTimeout(finish, CACHE_CLEAR_DEADLINE_MS);
        dropCaches()
            .then(unregisterWorkers, unregisterWorkers)
            .then(finish, finish);
    }

    function check() {
        if (!skeletonAlive()) {
            // 这次挂上了：把记号清掉，下次真出问题还能再救一次
            markRetried(false);
            return;
        }
        if (hasRetried()) return; // 已经救过一次还是不行：不刷了，避免无限循环
        markRetried(true);
        recover();
    }

    try {
        setTimeout(check, TIMEOUT_MS);
    } catch (e) {
        /* 连定时器都挂不上：保持原样 */
    }
})();
