// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      'docs-site/_site/**',
      'docs-site/content/css/**',
      '.agents/**',
      'ds-bundle/**',
      'ds-bundle-css/**',
      '.ds-sync/**',
      '.design-sync/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['docs-site/.eleventy.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
);
