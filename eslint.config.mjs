import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/*.zip', 'scripts/gen-icons.mjs'] },
  ...tseslint.configs.recommended,
);
