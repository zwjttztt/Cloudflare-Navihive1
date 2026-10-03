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
  { ignores: ['dist', 'script/tmp-tests', '.tmp-check'] },
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
)
