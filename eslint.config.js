'use strict';

const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    ignores: ['node_modules/**', 'logs/**', '.cursor/**', 'dist/**', '.test-artifacts/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        global: 'readonly',
        URLSearchParams: 'readonly',
        BigInt: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-undef': 'off', // TypeScript handles this
      'no-unused-vars': 'off', // Use TS version
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': 'off',
      'no-shadow': 'off', // Use TS version
      '@typescript-eslint/no-shadow': 'error',
      'no-new-wrappers': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      radix: 'error',
      'no-self-compare': 'error',
      'no-duplicate-imports': 'error',
      'no-template-curly-in-string': 'error',
      'array-callback-return': 'error',
      'no-sequences': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off', // Enabled per-file below
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'script',
    },
    rules: {
      strict: ['error', 'global'],
    },
  },
];
