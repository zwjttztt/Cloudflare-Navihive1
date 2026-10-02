import { createRouter, createWebHistory } from "vue-router";
import HomeView from "@/views/HomeView.vue";

// 样板阶段只有一个页面：先把首页跑通，再逐步加设置/备份/回收站等路由。
export const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: "/", name: "home", component: HomeView }],
});
