import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // قواعد react-hooks الإصدار 7 صارمة مع نمط جلب البيانات التقليدي (fetch + setState داخل useEffect)
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      // الملفات تصدر مكونات وأدوات مساعدة معاً، وهذا مقبول عملياً
      'react-refresh/only-export-components': 'off',
    },
  },
])
