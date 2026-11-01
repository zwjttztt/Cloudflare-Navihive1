import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

/**
 * react-hooks v7 的 recommended 里塞进了整套「面向 React Compiler」的规则
 * （set-state-in-effect / refs / immutability / globals /
 *  preserve-manual-memoization / use-memo …）。
 *
 * 这些规则查的是「这段代码编译器编译不过」，不是「这段代码现在跑错了」。
 * 本项目没有启用 React Compiler，全开会一次性冒出 60+ 条：
 * 大部分是「effect 里拉完数据 setState」「测试宿主组件往 ref 上挂探针」这类
 * 有意为之的写法，逐条改既动不到行为又牵扯面很大。
 *
 * 所以这里只保留升级前就在跑的两条（rules-of-hooks / exhaustive-deps），
 * 其余显式置为 off —— 等真要上 compiler 时再按这批报错逐项评估。
 * 写成「白名单以外的全关」而不是手写一份 off 列表，
 * 是为了将来插件再加新规则时默认不静默生效。
 */
const KEPT_REACT_HOOKS = new Set([
  'react-hooks/rules-of-hooks',
  'react-hooks/exhaustive-deps',
])
const reactHooksRules = Object.fromEntries(
  Object.entries(reactHooks.configs.recommended.rules).map(([name, value]) => [
    name,
    KEPT_REACT_HOOKS.has(name) ? value : 'off',
  ]),
)

export default tseslint.config(
  // dist 是构建产物；script/tmp-tests 与 .tmp-check 是单测/类型检查的临时产物
  // （单测在退出时清理，但沙箱等环境可能清理失败而留下，被误当成源码 lint 出一堆假错误）
  // dist-server 同理：自托管入口的 esbuild 产物，里面带着源码里的 eslint-disable
  // 注释，引用的规则没应用到 .mjs 上，报一堆 "Definition for rule ... was not found"
  { ignores: ['dist', 'dist-server', 'script/tmp-tests', '.tmp-check'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooksRules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // 下划线开头的变量/参数/捕获错误视为「有意保留」：
      // 回调签名里用不到的形参（如 (_, index) => ...）、catch 里故意忽略的错误。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // NavigationAPI 里用 `const self = this` 是为了在嵌套回调中保留实例引用
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['self'] }],
    },
  },
  {
    // 类型感知规则只对 src 开（tests/ / script/ / worker/ 暂不纳入，控制爆炸半径）。
    // 代码里大量手工 `void fn()` 说明团队一直在手工弥补浮 Promise，
    // 交给 no-floating-promises 统一盯。type-checked lint 需要类型信息，
    // 走 projectService 自动按最近 tsconfig 匹配（src 命中 tsconfig.app.json）。
    //
    // 为什么只开这一条、不整包上 recommendedTypeChecked（2026-11-01 评估）：
    // 预设全家桶在存量代码上一次性报 267 个 error，大头是
    // no-unnecessary-type-assertion(67) / no-misused-promises(58) / require-await(41)
    // / no-unsafe-*(60+)，且大半落在并行重构中的文件里 —— 直接开会把 CI 打红。
    // 这批余量另行排期，先落地收益最明确、存量最少（10 个）的 no-floating-promises。
    files: ['src/**/*.{ts,tsx}'],
    // src/API 与 src/hooks 正被并行重构（2026-11-01），暂缓接入避免修复冲突；
    // 并行改动合入后删掉这行 ignores 即可全量生效。
    ignores: ['src/API/**', 'src/hooks/**'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
)
