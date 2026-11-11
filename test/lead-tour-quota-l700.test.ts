import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../src/cli.js';
import { QUOTA_FILE, tourQuotaLine, tourQuotaRunLines } from '../src/quota-tour.js';
import { tempDir } from './helpers.js';

// L700 (D-15) : la jauge hebdo que publie la bande cadence-hud (rate_limits.seven_day) et les runs en quota, lus par lead tour.
const NOW = Date.parse('2026-11-11T16:00:00Z');
const MIN = 60_000;
function home(body?: object): NodeJS.ProcessEnv {
  const h = tempDir();
  if (body) writeFileSync(join(h, QUOTA_FILE), JSON.stringify(body));
  return { CADENCE_HOME: h };
}

describe('lead tour — jauge hebdo (L700)', () => {
  it('sous 80 % : une ligne, sans ⚠, avec le temps avant la remise à zéro', () => {
    expect(tourQuotaLine(home({ percent: 45, resetsAt: '2026-11-13T08:00:00Z', at: NOW - MIN }), NOW)).toBe('quota hebdo : 45 % · remise à zéro dans 1 j 16 h');
  });
  it('80 % pile : pas de ⚠ (« au-delà de 80 % »)', () => {
    expect(tourQuotaLine(home({ percent: 80, resetsAt: '2026-11-13T08:00:00Z', at: NOW }), NOW)).not.toContain('⚠');
  });
  it('au-delà de 80 % : ⚠ en tête, le seuil dit', () => {
    expect(tourQuotaLine(home({ percent: 86.4, resetsAt: '2026-11-11T19:30:00Z', at: NOW }), NOW)).toBe('⚠ quota hebdo : 86 % (au-delà de 80 %) · remise à zéro dans 3 h 30');
  });
  it('relevé de plus de 15 min : son âge est dit (pas une vieille donnée présentée comme actuelle)', () => {
    expect(tourQuotaLine(home({ percent: 45, resetsAt: '2026-11-13T08:00:00Z', at: NOW - 2 * 60 * MIN }), NOW)).toBe('quota hebdo : 45 % · remise à zéro dans 1 j 16 h · relevé il y a 2 h 00');
  });
  it('remise à zéro passée depuis le relevé : la valeur est périmée, elle n\'est pas affichée', () => {
    expect(tourQuotaLine(home({ percent: 97, resetsAt: '2026-11-11T15:00:00Z', at: NOW - 2 * 60 * MIN }), NOW)).toBe('quota hebdo : relevé périmé (remise à zéro passée depuis), la bande cadence-hud ne l\'a pas encore republié');
  });
  it('pas de fichier, ou illisible : la ligne le dit', () => {
    expect(tourQuotaLine(home(), NOW)).toBe('quota hebdo : inconnu (la bande cadence-hud ne l\'a pas publié)');
    const env = home();
    writeFileSync(join(env.CADENCE_HOME!, QUOTA_FILE), '{');
    expect(tourQuotaLine(env, NOW)).toBe('quota hebdo : inconnu (la bande cadence-hud ne l\'a pas publié)');
  });
});

describe('lead tour — runs en quota (L700)', () => {
  function runs(...etats: object[]): { parent: string; repo: string } {
    const parent = tempDir(), repo = join(parent, 'cadence'), d = join(parent, '.cadence-run');
    mkdirSync(repo); mkdirSync(d);
    etats.forEach((e, i) => writeFileSync(join(d, `cadence-${i}.json`), JSON.stringify({ repo, ...e })));
    return { parent, repo };
  }
  it('un run en quota : projet, id, limite, heure de reprise et geste pour reprendre avant ; les autres états sont passés', () => {
    const { repo } = runs({ id: 'r1', etat: 'quota', quota: { limite: 'hebdo', reprise: '2026-11-12T08:00:00.000Z' } }, { id: 'r2', etat: 'integre' }, { id: 'r3', etat: 'quota', quota: { limite: 'opus', reprise: null } });
    const lines = tourQuotaRunLines([repo]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^run en quota : cadence r1 · limite hebdo · reprise seule après \d{4}-11-12 \d\d:\d\d · avant : cadence run --reponse r1 "reprends"$/);
    expect(lines[1]).toBe('run en quota : cadence r3 · limite Opus · heure de reprise illisible · reprendre : cadence run --reponse r3 "reprends"');
  });
  it('un run d\'un autre dépôt du même dossier n\'est pas compté deux fois ; pas de .cadence-run : rien', () => {
    const { repo, parent } = runs({ id: 'r1', etat: 'quota', quota: { limite: 'hebdo', reprise: null } });
    expect(tourQuotaRunLines([repo, join(parent, 'autre')])).toHaveLength(1);
    expect(tourQuotaRunLines([join(tempDir(), 'x')])).toEqual([]);
  });
  it('cadence lead tour imprime la ligne de la jauge et celle des runs en quota', async () => {
    const { parent, repo } = runs({ id: 'r1', etat: 'quota', quota: { limite: 'hebdo', reprise: '2026-11-12T08:00:00.000Z' } });
    mkdirSync(join(repo, '.cadence'));
    writeFileSync(join(repo, '.cadence', 'raf.yaml'), 'project: cadence\nlots: []\n');
    const env = home({ percent: 91, resetsAt: '2026-11-13T08:00:00Z', at: NOW });
    const out: string[] = [];
    await run(['lead', 'tour', dirname(repo)], { cwd: parent, env: { RAF_TODAY: '2026-11-11', ...env }, out: (l) => out.push(l), err: (l) => out.push(l), now: () => new Date(NOW) });
    expect(out).toContain('⚠ quota hebdo : 91 % (au-delà de 80 %) · remise à zéro dans 1 j 16 h');
    expect(out.some((l) => l.startsWith('run en quota : cadence r1 · limite hebdo'))).toBe(true);
  });
});
