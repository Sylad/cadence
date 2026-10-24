import { docSyncSet } from './docsync.js';

/** Clé `orchestrate.testGate` de cadence.yaml (L287) : du code modifié sans test touché, avant la revue. */
export interface TestGateConfig {
  /** Motifs des fichiers de code (mêmes motifs que `docs.sync`, `!…` pour exclure). */
  code: string[];
  /** Motifs des fichiers de test : un seul touché par le lot lève la porte. */
  tests: string[];
  /** Fichiers de code dispensés de test (types, configuration, migrations…). */
  except: string[];
  /** Nombre de fichiers de code (hors exceptions) à partir duquel la porte joue. */
  threshold: number;
}

export const DEFAULT_TEST_PATTERNS = ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '**/__tests__/**'];

/**
 * Les fichiers de code que le lot a modifiés sans toucher le moindre fichier de test (triés), ou rien : un test touché, ou
 * moins de `threshold` fichiers de code. Un fichier de test n'est jamais du code, même quand il correspond à `code`.
 */
export function testGateMissing(gate: TestGateConfig, files: Set<string>): string[] {
  const isTest = docSyncSet(gate.tests);
  if ([...files].some(isTest)) return [];
  const isCode = docSyncSet(gate.code);
  const isException = gate.except.length ? docSyncSet(gate.except) : () => false;
  const code = [...files].filter((f) => isCode(f) && !isException(f)).sort();
  return code.length >= gate.threshold ? code : [];
}
