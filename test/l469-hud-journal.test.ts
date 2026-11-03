import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Le mod est hors du typecheck de cadence (tsconfig.json) : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { LAST_DELIVERIES } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { LAST_DELIVERIES: string };

it('R30 — le panneau des livraisons lit « jour sha bloc » comme « jour sha » : la dernière ligne verte est celle du bloc', () => {
  const root = mkdtempSync(join(tmpdir(), 'l469-hud-'));
  try {
    const dir = join(root, 'api', '.git', 'cadence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'deliveries.log'), '2026-10-27 aaa1111\n2026-10-29 bbb2222 api\n');
    const run = spawnSync('python3', ['-I', '-c', LAST_DELIVERIES, root], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([{ project: 'api', day: '2026-10-29', sha: 'bbb2222', status: 'verte', green: '2026-10-29' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
