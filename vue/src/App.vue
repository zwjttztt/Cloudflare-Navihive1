<script setup lang="ts">
// 外壳：只负责把 naive-ui 的 Provider 挂上。
// Locale 用 zhCN：日期选择器、分页等组件的中文文案靠它。
import { NConfigProvider, NDialogProvider, NMessageProvider, dateZhCN, zhCN } from "naive-ui";
</script>

<template>
    <n-config-provider :locale="zhCN" :date-locale="dateZhCN">
        <n-message-provider>
            <n-dialog-provider>
                <router-view />
            </n-dialog-provider>
        </n-message-provider>
    </n-config-provider>
</template>

<style>
* {
    box-sizing: border-box;
}
body {
    margin: 0;
    font-family:
        -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f5f6f8;
    color: #1f2328;
}
</style>
