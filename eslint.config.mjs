// Garde-fous de qualité (L462) : l'équivalent de Checkstyle/PMD pour TypeScript. Les seuils sont ceux de départ ;
// l'existant qui les dépasse est figé dans qualite-baseline.json (cliquet, voir docs/qualite.md), pas dans ce fichier.
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'plugins/**', 'evals/**', 'tmp/**', '.cadence/**'] },
  {
    files: ['src/**/*.ts', 'bin/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: { parser: tseslint.parser },
    plugins: { sonarjs },
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 4],
      'max-params': ['error', 5],
      complexity: ['error', 15],
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
);
