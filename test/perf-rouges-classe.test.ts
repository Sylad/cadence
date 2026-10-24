import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tempDir } from './helpers.js';
import { writeWave } from './perf-helpers.js';

const TODAY = '2026-10-16';
const CUR = '2026-10-12';
const PREV = '2026-10-05';

function project(root: string, name: string, failed: string): void {
  const dir = join(root, name);
  mkdirSync(join(dir, '.cadence'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.cadence', 'raf.yaml'), `version: 1\nproject: "${name}"\nprefix: L\nlots: []\n`);
  mkdirSync(join(dir, '.git', 'cadence'), { recursive: true });
  writeFileSync(join(dir, '.git', 'cadence', 'deliveries-failed.log'), failed);
}

function setup(): string {
  const root = tempDir();
  mkdirSync(join(root, '.cadence', 'runs'), { recursive: true });
  writeWave(join(root, '.cadence', 'runs'), 'w1', '2026-10-01T08:00:00');
  project(root, 'maritime', `${CUR} a [deploiement] script de livraison en échec (code 1) ⏎ x\n${CUR} b [deploiement] script de livraison en échec (code 1)\n${PREV} c [ci] CI en échec\n`);
  project(root, 'alpha', `${CUR} d [ci] CI en échec\n${CUR} e [verification] vérification en échec\n${CUR} f vieille ligne sans classe\n`);
  return root;
}

async function perf(root: string, ...args: string[]) {
  const out: string[] = [];
  const code = await run(['perf', ...args], { cwd: root, env: { RAF_TODAY: TODAY }, out: (l) => out.push(l), err: () => {}, now: () => new Date(`${TODAY}T10:00:00`) });
  return { code, text: out.join('\n'), out };
}

describe('cadence perf — livraisons rouges par classe et par projet (L282)', () => {
  it('R9 — --json : quality.reds ventile chaque fenêtre par classe (anciennes lignes : « inconnue ») et par projet', async () => {
    const r = JSON.parse((await perf(setup(), '--json')).text);
    expect(r.quality.reds.current).toEqual({
      count: 5,
      byClass: { refus: 0, ci: 1, deploiement: 2, verification: 1, inconnue: 1 },
      byProject: { maritime: { deploiement: 2 }, alpha: { ci: 1, verification: 1, inconnue: 1 } },
    });
    expect(r.quality.reds.previous.count).toBe(1);
    expect(r.quality.reds.previous.byClass.ci).toBe(1);
    expect(r.quality.redDeliveries.current).toBe(5);
  });

  it('R10 — texte : une ligne par classe et une par projet, la plus grosse d\'abord, avec les libellés français', async () => {
    const { out } = await perf(setup());
    const byClass = out.find((l) => l.includes('livraisons rouges par classe'))!;
    expect(byClass).toContain('déploiement 2 · CI 1 · vérification 1 · non classée 1');
    expect(byClass).not.toContain('refus');
    const byProject = out.find((l) => l.includes('livraisons rouges par projet'))!;
    expect(byProject).toContain('alpha 3 (CI 1, vérification 1, non classée 1) · maritime 2 (déploiement 2)');
  });

  it('R11 — aucune livraison rouge dans la fenêtre courante : aucune de ces lignes', async () => {
    const root = tempDir();
    mkdirSync(join(root, '.cadence', 'runs'), { recursive: true });
    writeWave(join(root, '.cadence', 'runs'), 'w1', '2026-10-01T08:00:00');
    project(root, 'alpha', `${PREV} d [ci] CI en échec\n`);
    const { text } = await perf(root);
    expect(text).not.toContain('livraisons rouges par classe');
    expect(text).not.toContain('livraisons rouges par projet');
  });
});
