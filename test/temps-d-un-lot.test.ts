import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agreger, analyserSession, estSuiteComplete, lireJournal, lireVagues, main, posteDeLOutil, rendre, trancheEstimate, ventilerLot } from '../scripts/temps-d-un-lot.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);
const SCRIPT = fileURLToPath(new URL('../scripts/temps-d-un-lot.mjs', import.meta.url));

/** Une ligne de transcript : un appel d'outil (assistant) ou son résultat (user), à `t` secondes de 12:00. */
const t = (s: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, s)).toISOString();
const appel = (s: number, id: string, name: string, input: object, usage = { output_tokens: 10, cache_read_input_tokens: 1000 }) => JSON.stringify({ type: 'assistant', timestamp: t(s), message: { id: `m${id}`, usage, content: [{ type: 'tool_use', id, name, input }] } });
const resultat = (s: number, id: string) => JSON.stringify({ type: 'user', timestamp: t(s), message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const debut = (s: number) => JSON.stringify({ type: 'user', timestamp: t(s), message: { content: 'brief' } });

describe('L517 — classer un appel d\'outil', () => {
  it.each([
    ['Bash', { command: 'npx vitest run > $TMPDIR/s.txt' }, 'tests'],
    ['Bash', { command: 'cd /x && npx tsc --noEmit && node scripts/qualite.mjs --contre main' }, 'build'],
    ['Bash', { command: 'cd /x && sed -n 1,40p src/a.ts' }, 'lectures'],
    ['Bash', { command: 'W=/tmp/x; grep -rn foo src' }, 'lectures'],
    ['Bash', { command: "python3 - <<'E'\nopen('a','w').write('x')\nE" }, 'écriture'],
    ['Bash', { command: 'python3 -c "import json;print(1)"' }, 'lectures'],
    ['Bash', { command: 'sed -i s/a/b/ src/a.ts' }, 'écriture'],
    ['Bash', { command: 'cadence news new L1' }, 'Nouveautés'],
    ['Bash', { command: 'git add src/a.ts && git commit -m x' }, 'git'],
    ['Bash', { command: 'git diff HEAD~1' }, 'lectures'],
    ['Bash', { command: 'sleep 30' }, 'attente'],
    ['Read', { file_path: '/a' }, 'lectures'],
    ['Edit', { file_path: '/repo/src/a.ts' }, 'écriture'],
    ['Write', { file_path: '/repo/docs/nouveautes/a.md' }, 'Nouveautés'],
    ['mcp__playwright__browser_take_screenshot', {}, 'captures'],
    ['StructuredOutput', {}, 'modèle seul'],
    ['Skill', {}, 'autre outil'],
    ['Bash', {}, 'autre outil'],
  ])('%s %j → %s', (nom, entree, poste) => {
    expect(posteDeLOutil(nom, entree as Record<string, unknown>)).toBe(poste);
  });

  it('une suite complète ne nomme ni fichier ni filtre', () => {
    expect(estSuiteComplete('npx vitest run')).toBe(true);
    expect(estSuiteComplete('npx vitest run test/a.test.ts')).toBe(false);
    expect(estSuiteComplete('npx vitest run -t "R1"')).toBe(false);
    expect(estSuiteComplete('npx tsc --noEmit')).toBe(false);
  });
});

describe('L517 — ventiler une session', () => {
  it('démarrage, lectures, tests (suite et ciblés), rapport final', () => {
    const texte = [
      debut(0),
      appel(10, 'a', 'Read', { file_path: '/a' }),
      resultat(12, 'a'),
      appel(20, 'b', 'Bash', { command: 'npx vitest run' }),
      resultat(80, 'b'),
      appel(90, 'c', 'Bash', { command: 'npx vitest run test/x.test.ts' }),
      resultat(100, 'c'),
      appel(130, 'd', 'StructuredOutput', {}),
      resultat(131, 'd'),
    ].join('\n');
    const r = analyserSession(texte);
    expect(r.postes['démarrage'].ms).toBe(10_000);
    expect(r.postes['lectures'].ms).toBe(2_000);
    expect(r.postes['tests'].ms).toBe(8_000 + 60_000 + 10_000 + 10_000);
    expect(r.rejeuxTests).toBe(2);
    expect(r.rejeuxSuite).toBe(1);
    expect(r.suiteMs).toBe(68_000);
    expect(r.ciblesMs).toBe(20_000);
    expect(r.postes['modèle seul'].ms).toBe(30_000 + 1_000);
    expect(r.dureeMs).toBe(131_000);
    expect(r.postes['lectures'].sortie).toBe(10);
  });

  it('un message qui porte deux appels ne compte ses jetons qu\'une fois', () => {
    const deux = JSON.stringify({ type: 'assistant', timestamp: t(5), message: { id: 'mx', usage: { output_tokens: 50, cache_read_input_tokens: 0 }, content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }, { type: 'tool_use', id: 'b', name: 'Read', input: {} }] } });
    const r = analyserSession([debut(0), deux, resultat(6, 'a'), resultat(6, 'b')].join('\n'));
    expect(r.postes['lectures'].sortie).toBe(50);
    expect(r.postes['lectures'].n).toBe(2);
  });

  it('un transcript vide, une ligne illisible et un appel sans résultat ne cassent pas', () => {
    expect(analyserSession('').dureeMs).toBe(0);
    expect(analyserSession('pas du json\n').appels).toBe(0);
    const r = analyserSession([debut(0), appel(5, 'a', 'Read', {})].join('\n'));
    expect(r.postes['lectures'].ms).toBe(0);
    expect(r.postes['démarrage'].ms).toBe(5_000);
  });
});

describe('L517 — journal de vague', () => {
  it('lit l\'attente de créneau et la ligne « intégré » (é en fin de mot)', () => {
    const j = lireJournal([
      '2026-11-01T17:01:35.689Z cadence:L498 · créneau de session obtenu après 3 min 21 s d\'attente',
      '2026-11-01T17:02:00.000Z cadence:L498 · créneau de session obtenu après 45 s d\'attente',
      '2026-11-01T18:36:37.138Z cadence:L498 intégré : d26a55c..b51bd9c',
      'ligne libre sans lot',
    ].join('\n'));
    const l = j.get('cadence:L498');
    expect(l?.attentes.map((a) => a.ms)).toEqual([201_000, 45_000]);
    expect(l?.integre).toBe(Date.parse('2026-11-01T18:36:37.138Z'));
  });
});

const pas = (n: number, kind: string, d0: string, d1: string, counted = 100, extra: object = {}) => ({ n, kind, status: 'ok', started: `2026-11-01T${d0}Z`, ended: `2026-11-01T${d1}Z`, tokens: { counted }, ...extra });

describe('L517 — ventiler un lot', () => {
  const dir = tempDir();
  const etat = (steps: object[], estimate?: number) => ({ project: 'p', lot: 'L1', visible: false, estimate, steps });

  it('retire l\'attente de créneau du mur du pas, compte la porte entre pas et l\'intégration', () => {
    const journal = { attentes: [{ t: Date.parse('2026-11-01T10:02:00Z'), ms: 120_000 }], integre: Date.parse('2026-11-01T10:30:00Z') };
    const l = ventilerLot(etat([pas(1, 'implement', '10:00:00', '10:10:00', 500, { sessionId: 'absent' }), pas(2, 'review', '10:15:00', '10:20:00', 300)]), journal, dir);
    expect(l.mur['attente de créneau']).toBe(120_000);
    expect(l.mur['implémentation']).toBe(480_000);
    expect(l.mur['porte et orchestration']).toBe(300_000);
    expect(l.mur['revue']).toBe(300_000);
    expect(l.mur['intégration']).toBe(600_000);
    expect(l.jetons['implémentation']).toBe(500);
    expect(l.sessionsEcriture).toBe(1);
    expect(l.sessionsLues).toBe(0);
  });

  it('un trou de plus de 30 min est une suspension, hors mur', () => {
    const l = ventilerLot(etat([pas(1, 'implement', '10:00:00', '10:10:00'), pas(2, 'review', '13:10:00', '13:15:00')]), undefined, dir);
    expect(l.mur['porte et orchestration']).toBe(0);
    expect(l.suspensionMs).toBe(3 * 3600_000);
  });

  it('une passe de correction coûte la correction, la porte et la revue qui la suit', () => {
    const l = ventilerLot(etat([pas(1, 'implement', '10:00:00', '10:10:00'), pas(2, 'fix', '10:10:00', '10:14:00', 200), pas(3, 'review-small', '10:16:00', '10:18:00', 50)]), undefined, dir);
    expect(l.passes).toBe(1);
    expect(l.coutPasses).toEqual({ n: 1, ms: 4 * 60_000 + 2 * 60_000 + 2 * 60_000, jetons: 250 });
  });

  it('lit le transcript d\'une session d\'écriture trouvé par son sessionId', () => {
    const racine = tempDir();
    mkdirSync(join(racine, '-wt-L1'));
    writeFileSync(join(racine, '-wt-L1', 'S1.jsonl'), [debut(0), appel(5, 'a', 'Bash', { command: 'npx vitest run' }), resultat(65, 'a')].join('\n'));
    const l = ventilerLot(etat([pas(1, 'implement', '10:00:00', '10:10:00', 1, { sessionId: 'S1' })]), undefined, racine);
    expect(l.sessionsLues).toBe(1);
    expect(l.rejeuxSuiteSession).toBe(1);
    expect(l.session['tests'].ms).toBe(60_000);
  });

  it('un pas sans date de fin lisible est ignoré', () => {
    const l = ventilerLot(etat([{ n: 1, kind: 'implement', status: 'ok', started: 'x', ended: 'y' }]), undefined, dir);
    expect(l.sessionsEcriture).toBe(0);
  });
});

describe('L517 — agréger et rendre', () => {
  const dir = tempDir();
  const lot = (steps: object[], estimate?: number) => ventilerLot({ project: 'p', lot: 'L', steps, estimate }, undefined, dir);

  it('écarte un lot sans session d\'écriture et classe par tranche d\'estimate', () => {
    const a = agreger([lot([pas(1, 'implement', '10:00:00', '10:06:00')], 0.05), lot([pas(1, 'spec', '10:00:00', '10:06:00')], 0.05), lot([pas(1, 'implement', '10:00:00', '10:06:00'), pas(2, 'fix', '10:06:00', '10:08:00'), pas(3, 'fix', '10:08:00', '10:09:00')], 0.3)]);
    expect(a.lots).toBe(2);
    expect(a.passes).toEqual({ moins1: 1, un: 0, deuxOuPlus: 1 });
    expect(a.parTranche['≤ 0,1 j'].lots).toBe(1);
    expect(a.parTranche['0,1–0,5 j'].passesMoyennes).toBe(2);
    expect(trancheEstimate(null)).toBe('sans estimate');
  });

  it('rend les tableaux, sans NaN sur un jeu vide', () => {
    const md = rendre(agreger([]), { byCause: { 'bug-code': 3, 'spec-floue': 1 } });
    expect(md).not.toMatch(/NaN|Infinity/);
    expect(md).toMatch(/\| bug-code \| 3 \| 75 % \|/);
    expect(md).toMatch(/0 lots avec une session/);
  });
});

describe('L517 — lire les vagues et la ligne de commande', () => {
  const racine = tempDir();
  const runs = join(racine, 'runs');
  const vague = (nom: string, created: string, etat: object | string) => {
    mkdirSync(join(runs, nom), { recursive: true });
    writeFileSync(join(runs, nom, 'wave.json'), JSON.stringify({ created }));
    writeFileSync(join(runs, nom, 'p--L1.json'), typeof etat === 'string' ? etat : JSON.stringify(etat));
  };
  vague('v-ancienne', '2026-10-01T10:00:00Z', { project: 'p', lot: 'L1', steps: [] });
  vague('v-recente', '2026-10-30T10:00:00Z', { project: 'p', lot: 'L1', steps: [pas(1, 'implement', '10:00:00', '10:05:00')] });
  vague('v-cassee', '2026-10-31T10:00:00Z', '{pas du json');
  mkdirSync(join(runs, 'sans-wave'));

  it('ne garde que les vagues créées après `since`, ignore un état illisible et un dossier sans wave.json', () => {
    expect(lireVagues(runs, '2026-10-17T00:00Z').map((v) => v.vague)).toEqual(['v-recente']);
    expect(lireVagues(runs, undefined, '2026-10-02T00:00Z').map((v) => v.vague)).toEqual(['v-ancienne']);
  });

  it('la commande rend le tableau, --json les lots, et refuse une option inconnue ou un dossier absent', () => {
    expect(main(['--runs', runs, '--since', '2026-10-17T00:00Z', '--transcripts', racine])).toMatch(/1 lots avec une session d'écriture/);
    expect(JSON.parse(main(['--runs', runs, '--json', '--transcripts', racine])).lotsDetail).toHaveLength(2);
    const mauvais = spawnSync('node', [SCRIPT, '--nimporte'], { encoding: 'utf8' });
    expect(mauvais.status).toBe(1);
    expect(mauvais.stderr).toMatch(/option inconnue/);
    const absent = spawnSync('node', [SCRIPT, '--runs', join(racine, 'rien')], { encoding: 'utf8' });
    expect(absent.status).toBe(1);
    expect(absent.stderr).toMatch(/introuvable/);
    expect(spawnSync('node', [SCRIPT, '--since'], { encoding: 'utf8' }).stderr).toMatch(/demande une valeur/);
  });
});
