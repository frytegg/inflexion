// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'out/**',
      'cache/**',
      'broadcast/**',
      '**/target/**',
      '.venv/**',
      'packages/contracts/lib/**',
      'packages/contracts/out/**',
      'packages/contracts/cache/**',
      'packages/contracts/broadcast/**',
      'apps/docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
