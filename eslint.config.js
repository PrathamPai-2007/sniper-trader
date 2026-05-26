'use strict';

// ESLint flat config for project-wide JS linting in CommonJS runtime.
const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**', 'logs/**', '.cursor/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
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
      },
    },
    rules: {
      strict: ['error', 'global'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': 'off',
      'no-useless-assignment': 'off',
      'no-unsafe-optional-chaining': 'off',
      'preserve-caught-error': 'off',
      'no-shadow': 'error',
      'no-new-wrappers': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      radix: 'error',
      'no-self-compare': 'error',
      'no-duplicate-imports': 'error',
      'no-template-curly-in-string': 'error',
      'array-callback-return': 'error',
      'no-sequences': 'error',
    },
  },
];
