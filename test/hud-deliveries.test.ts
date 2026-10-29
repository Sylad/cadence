import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';


// Le mod est hors du typecheck de cadence (tsconfig.json) : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { DELIVERIES } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { DELIVERIES: string };

// L412 : le script Python du mod (livraisons en échec du panneau des lots) joué pour de vrai ; les tests du mod n'ont pas accès au système de fichiers.

it('R11 — le script DELIVERIES lit la dernière livraison en échec, effacée par une livraison verte écrite après', () => {
  const root = mkdtempSync(join(tmpdir(), 'deliveries-'))
  try {
    const repo = (name: string, failed: string | null, green: string | null, greenIsNewer = true) => {
      const dir = join(root, name, '.git', 'cadence')
      mkdirSync(dir, { recursive: true })
      if (failed !== null) writeFileSync(join(dir, 'deliveries-failed.log'), failed)
      if (green !== null) writeFileSync(join(dir, 'deliveries.log'), green)
      const old = new Date('2026-10-28T10:00:00Z')
      const recent = new Date('2026-10-29T10:00:00Z')
      if (failed !== null) utimesSync(join(dir, 'deliveries-failed.log'), old, greenIsNewer ? old : recent)
      if (green !== null) utimesSync(join(dir, 'deliveries.log'), recent, greenIsNewer ? recent : old)
    }
    repo('rouge', '2026-10-27 aaa1111 [ci] CI en échec ⏎ x\n2026-10-29 bbb2222 [deploiement] script en échec (code 1) ⏎ boum\n', null)
    repo('retabli', '2026-10-28 ccc3333 [ci] CI en échec\n', '2026-10-29 ddd4444\n')
    repo('apres', '2026-10-29 eee5555 [verification] vérification en échec\n', '2026-10-28 fff6666\n', false)
    repo('vide', '\n\n', null)
    repo('propre', null, '2026-10-29 ggg7777\n')
    mkdirSync(join(root, 'sans-git'))
    writeFileSync(join(root, 'cadence.yaml'), '')
    const run = spawnSync('python3', ['-I', '-c', DELIVERIES, root], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual([
      { project: 'apres', day: '2026-10-29', sha: 'eee5555', reason: 'vérification en échec' },
      { project: 'rouge', day: '2026-10-29', sha: 'bbb2222', reason: 'script en échec (code 1)' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
