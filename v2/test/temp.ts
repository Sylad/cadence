import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// Dossiers temporaires des tests v2, supprimés à la fin du fichier de test (droits rendus : réglages des bras en lecture seule).
// La suite de cadence échoue sur tout dossier laissé dans sa racine temporaire (test/global-setup.ts).
const crees: string[] = [];
afterAll(() => {
  for (const d of crees.splice(0)) { try { execFileSync('chmod', ['-R', 'u+rwx', d]); } catch { /* déjà parti */ } rmSync(d, { recursive: true, force: true }); }
});
export function dossierTemp(prefixe: string): string {
  const d = mkdtempSync(join(tmpdir(), prefixe));
  crees.push(d);
  return d;
}
