import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'experiments/**', 'apps/internal/**', '**/coverage/**', 'docs/design/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.mjs'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
);
