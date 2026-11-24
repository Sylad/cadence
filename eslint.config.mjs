// Garde-fous de qualité (L462) : l'équivalent de Checkstyle/PMD pour TypeScript. Les seuils sont ceux de départ ;
// l'existant qui les dépasse est figé dans qualite-baseline.json (cliquet, voir docs/qualite.md), pas dans ce fichier.
// L823 : le périmètre couvre aussi cadence 2 (v2/src) et les hooks du plugin ; sonarjs recommended (l'équivalent de PMD),
// typescript-eslint recommended et le nommage (l'équivalent de Checkstyle) entrent sous le même cliquet.
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

const FICHIERS = ['src/**/*.ts', 'bin/**/*.js', 'scripts/**/*.mjs', 'v2/src/**/*.ts', 'plugins/*/hooks/**/*.{ts,tsx}'];
const pourFichiers = (configs) => configs.map((c) => ({ ...c, files: FICHIERS }));

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'plugins/*/node_modules/**', 'plugins/*/types/**', 'v2/node_modules/**', 'evals/**', 'tmp/**', '.cadence/**'],
  },
  ...pourFichiers(tseslint.configs.recommended),
  ...pourFichiers([sonarjs.configs.recommended]),
  {
    files: FICHIERS,
    // un eslint-disable ne fait pas disparaître un dépassement : le cliquet le compte quand même (qualite.mjs)
    linterOptions: { noInlineConfig: true },
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 4],
      'max-params': ['error', 5],
      complexity: ['error', 15],
      'sonarjs/cognitive-complexity': ['error', 15],
      // le nommage (Checkstyle) : variables, fonctions et types seulement ; les propriétés suivent les formats externes (YAML, JSON, API)
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'], leadingUnderscore: 'allow' },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
      ],
      // hors cliquet (décision du lead, L823) : trop nombreuses pour être figées utilement, ou fausses alertes pour une CLI
      'sonarjs/no-nested-template-literals': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/no-os-command-from-path': 'off',
      'sonarjs/todo-tag': 'off',
    },
  },
);
