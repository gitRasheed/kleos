import js from '@eslint/js';
import tseslint from 'typescript-eslint';

function boundary(files, forbidden) {
  return {
    files,
    rules: { 'no-restricted-imports': ['error', { patterns: [{
      regex: '^(?:kleos(?:/|$)|(?:\\.\\./)+index\\.js$)|(?:^|/)(?:' + forbidden + ')(?:/|\\.js$)',
      message: 'Keep this dependency in its owning module (see AGENTS.md).',
    }] }] },
  };
}

export default tseslint.config(
  { ignores: ['dist/**', 'dist-test/**'] },
  js.configs.recommended,
  { files: ['**/*.ts'], extends: tseslint.configs.strict, rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  boundary(['src/theory/**/*.ts'], 'recipe|score|notation|ears|io|cli|tools|mcp'),
  boundary(['src/recipe/**/*.ts'], 'score|notation|theory|io|cli|tools|mcp|ears/(?!loudness\\.js$)[^/]+'),
  boundary(['src/ears/**/*.ts'], 'recipe|score|notation|theory|cli|tools|mcp'),
  boundary(['src/io/**/*.ts'], 'recipe|score|notation|theory|cli|tools|mcp|ears/(?!fft\\.js$)[^/]+'),
  boundary(['src/score/**/*.ts'], 'recipe|cli|mcp|tools'),
  boundary(['src/score/commands.ts'], 'recipe|cli|mcp'),
  boundary(['src/score/{render,master,dsp,fx,mixGraph,eqParametric}.ts', 'src/score/instruments/**/*.ts'], 'recipe|cli|mcp|tools|ears/(?!loudness\\.js$)[^/]+'),
  boundary(['src/notation/**/*.ts'], 'recipe|ears|cli|mcp|tools'),
  boundary(['src/tools.ts'], 'cli|mcp|score/commands'),
  boundary(['src/mcp.ts'], 'recipe|score|notation|theory|ears|io|cli'),
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
);
