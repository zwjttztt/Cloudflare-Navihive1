/// <reference types="vite/client" />

// 只用于**动态** import 的样式（目前只有公式的 katex.min.css）。
// 静态 import 的样式走 Vite 的内置处理，不需要声明；动态那一种 TS 认不了模块。
declare module "*.css" {
    const css: string;
    export default css;
}

// katex 的 package.json 用 exports 限死了子路径，`*.css` 的通配声明兜不住它，
// 所以这一条要走具体模块名（MathNode 里是故意动态引入的，别改成静态 import）。
declare module "katex/dist/katex.min.css";
