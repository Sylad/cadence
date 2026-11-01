import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agreger, analyserSession, estSuiteComplete, lireJournal, lireVagues, posteDeLOutil, rendre, ventilerLot } from '../scripts/temps-d-un-lot.mjs';
import { cleanupTempDirs, tempDir } from './helpers.js';

afterAll(cleanupTempDirs);
const t = (s: number) => new Date(Date.UTC(2026, 10, 1, 12, 0, s)).toISOString();
const appel = (s: number, id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', timestamp: t(s), message: { id: `m${id}`, usage: { output_tokens: 10 }, content: [{ type: 'tool_use', id, name, input }] } });
const resultat = (s: number, id: string) => JSON.stringify({ type: 'user', timestamp: t(s), message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const debut = (s: number) => JSON.stringify({ type: 'user', timestamp: t(s), message: { content: 'brief' } });
const poste = (command: string) => posteDeLOutil('Bash', { command });

describe('L517 bords — classer des commandes réelles', () => {
  it('git commit avec message en heredoc reste « git »', () => {
    expect(poste("git commit -m \"$(cat <<'EOF'\nfeat: x\nEOF\n)\"")).toBe('git');
  });
  it('git commit dont le message cite « rm » ou « cp » reste « git »', () => {
    expect(poste('git commit -m "fix: rm le doublon"')).toBe('git');
  });
  it('grep qui cherche le mot vitest est une lecture, pas des tests', () => {
    expect(poste('grep -rn vitest package.json')).toBe('lectures');
  });
  it('cat d\'un fichier nommé pytest est une lecture', () => {
    expect(poste('cat docs/pytest.md')).toBe('lectures');
  });
  it('grep du mot tsc est une lecture, pas un build', () => {
    expect(poste('grep -n tsc package.json')).toBe('lectures');
  });
  it('grep -rn rm src est une lecture', () => {
    expect(poste('grep -rn rm src')).toBe('lectures');
  });
  it('nom d\'outil en minuscules bash est classé comme Bash', () => {
    expect(posteDeLOutil('bash', { command: 'ls' })).toBe('lectures');
  });
  it('entrée null ou commande non texte ne lève pas', () => {
    expect(posteDeLOutil('Bash', null as never)).toBe('autre outil');
    expect(posteDeLOutil('Bash', { command: 42 } as never)).toBe('autre outil');
    expect(posteDeLOutil('Edit', null as never)).toBe('écriture');
  });
  it('suite complète lancée depuis un dossier test/ via cd reste complète', () => {
    expect(estSuiteComplete('cd test/ && npx vitest run')).toBe(true);
  });
  it('une suite avec rapporteur et workers reste complète', () => {
    expect(estSuiteComplete('npx vitest run --minWorkers=1 --maxWorkers=10 --reporter=dot')).toBe(true);
  });
  it('un grep de vitest n\'est pas une suite complète', () => {
    expect(estSuiteComplete('grep vitest package.json')).toBe(false);
  });
});

describe('L517 bords — session', () => {
  it('un seul horodatage : durée 0, pas de NaN', () => {
    const r = analyserSession(debut(0));
    expect(r.dureeMs).toBe(0);
    expect(Object.values(r.postes).every((p) => Number.isFinite(p.ms))).toBe(true);
  });
  it('un résultat arrivé avant son appel (horloge désordonnée) ne donne aucun temps négatif', () => {
    const r = analyserSession([debut(10), appel(20, 'a', 'Read', {}), resultat(15, 'a')].join('\n'));
    for (const p of Object.values(r.postes)) expect(p.ms).toBeGreaterThanOrEqual(0);
  });
  it('un même tool_use_id deux fois : les appels ne sont pas comptés deux fois', () => {
    const r = analyserSession([debut(0), appel(5, 'a', 'Read', {}), appel(5, 'a', 'Read', {}), resultat(6, 'a')].join('\n'));
    expect(r.postes['lectures'].n).toBe(1);
  });
  it('la somme des postes égale la durée de la session', () => {
    const r = analyserSession([debut(0), appel(5, 'a', 'Read', {}), resultat(8, 'a'), appel(9, 'b', 'Bash', { command: 'npx vitest run' }), resultat(50, 'b')].join('\n'));
    const somme = Object.values(r.postes).reduce((x, p) => x + p.ms, 0);
    expect(somme).toBe(r.dureeMs);
  });
  it('content en chaîne (message user texte) ou null ne casse pas', () => {
    const l = JSON.stringify({ type: 'assistant', timestamp: t(1), message: { id: 'x', content: null } });
    expect(() => analyserSession([debut(0), l, 'null', '[]', '42'].join('\n'))).not.toThrow();
  });
  it('usage avec jetons en chaîne ne produit pas de concaténation', () => {
    const l = JSON.stringify({ type: 'assistant', timestamp: t(1), message: { id: 'x', usage: { output_tokens: '5', input_tokens: '7' }, content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] } });
    const r = analyserSession([debut(0), l, resultat(2, 'a')].join('\n'));
    expect(typeof r.postes['lectures'].sortie).toBe('number');
    expect(Number.isFinite(r.postes['lectures'].contexte)).toBe(true);
  });
  it('fins de ligne CRLF', () => {
    const r = analyserSession([debut(0), appel(5, 'a', 'Read', {}), resultat(8, 'a')].join('\r\n'));
    expect(r.postes['lectures'].n).toBe(1);
  });
});

describe('L517 bords — journal', () => {
  it('durée en heures lue', () => {
    const j = lireJournal("2026-11-01T17:01:35.689Z cadence:L1 · créneau de session obtenu après 1 h 2 min d'attente");
    expect(j.get('cadence:L1')?.attentes[0].ms).toBe(3_720_000);
  });
  it('durée illisible ne compte pas 0 en silence', () => {
    const j = lireJournal("2026-11-01T17:01:35.689Z cadence:L1 · créneau de session obtenu après quelque temps d'attente");
    expect(j.get('cadence:L1')?.attentes.length ?? 0).toBe(0);
  });
  it('journal vide, CRLF', () => {
    expect(lireJournal('').size).toBe(0);
    const j = lireJournal("2026-11-01T17:02:00.000Z cadence:L1 · créneau de session obtenu après 45 s d'attente\r\n2026-11-01T18:00:00.000Z cadence:L1 intégré : a..b\r\n");
    expect(j.get('cadence:L1')?.integre).toBe(Date.parse('2026-11-01T18:00:00.000Z'));
  });
  it('« intégré » écrit deux fois : la dernière date gagne', () => {
    const j = lireJournal('2026-11-01T18:00:00.000Z c:L1 intégré : a..b\n2026-11-01T19:00:00.000Z c:L1 intégré : b..c');
    expect(j.get('c:L1')?.integre).toBe(Date.parse('2026-11-01T19:00:00.000Z'));
  });
});

describe('L517 bords — lot', () => {
  const dir = tempDir();
  const pas = (kind: string, d0: string, d1: string, extra: object = {}) => ({ kind, status: 'ok', started: `2026-11-01T${d0}Z`, ended: `2026-11-01T${d1}Z`, tokens: { counted: 10 }, ...extra });
  it('une attente de créneau plus longue que le pas ne rend pas le mur négatif', () => {
    const l = ventilerLot({ project: 'p', lot: 'L', steps: [pas('implement', '10:00:00', '10:01:00')] }, { attentes: [{ t: Date.parse('2026-11-01T10:00:30Z'), ms: 600_000 }], integre: null }, dir);
    for (const v of Object.values(l.mur)) expect(v).toBeGreaterThanOrEqual(0);
  });
  it('pas dont la fin précède le début ne rend pas de mur négatif', () => {
    const l = ventilerLot({ project: 'p', lot: 'L', steps: [pas('implement', '10:10:00', '10:00:00')] }, undefined, dir);
    for (const v of Object.values(l.mur)) expect(v).toBeGreaterThanOrEqual(0);
  });
  it('estimate en chaîne ou jetons non numériques ne produisent pas de NaN', () => {
    const l = ventilerLot({ project: 'p', lot: 'L', estimate: '0.3', steps: [pas('implement', '10:00:00', '10:05:00', { tokens: { counted: '12' } })] }, undefined, dir);
    expect(Number.isFinite(l.jetons['implémentation'])).toBe(true);
  });
  it('sessionId avec ../ ne sort pas du dossier des transcripts', () => {
    const racine = tempDir();
    mkdirSync(join(racine, 'a'));
    const dehors = tempDir();
    writeFileSync(join(dehors, 'secret.jsonl'), [debut(0), appel(5, 'a', 'Read', {}), resultat(6, 'a')].join('\n'));
    const rel = `../../${dehors.split('/').slice(-1)[0]}/secret`;
    const l = ventilerLot({ project: 'p', lot: 'L', steps: [pas('implement', '10:00:00', '10:05:00', { sessionId: rel })] }, undefined, racine);
    expect(l.sessionsLues).toBe(0);
  });
  it('transcripts : un fichier au lieu d\'un dossier ne lève pas', () => {
    const racine = tempDir();
    writeFileSync(join(racine, 'x'), 'a');
    expect(() => ventilerLot({ project: 'p', lot: 'L', steps: [pas('implement', '10:00:00', '10:05:00', { sessionId: 'S' })] }, undefined, racine)).not.toThrow();
  });
  it('steps absent ou null', () => {
    expect(() => ventilerLot({ project: 'p', lot: 'L' }, undefined, dir)).not.toThrow();
    expect(() => ventilerLot({ project: 'p', lot: 'L', steps: null }, undefined, dir)).not.toThrow();
  });
  it('la somme des postes de session d\'un lot ne dépasse pas son mur d\'implémentation + correction', () => {
    const racine = tempDir();
    mkdirSync(join(racine, 'a'));
    writeFileSync(join(racine, 'a', 'S.jsonl'), [debut(0), appel(5, 'a', 'Read', {}), resultat(600, 'a')].join('\n'));
    const l = ventilerLot({ project: 'p', lot: 'L', steps: [pas('implement', '10:00:00', '10:01:00', { sessionId: 'S' })] }, undefined, racine);
    const s = Object.values(l.session).reduce((x: number, p: any) => x + p.ms, 0);
    expect(s).toBeLessThanOrEqual(l.mur['implémentation'] + 1000);
  });
});

describe('L517 bords — agrégat et vagues', () => {
  it('rendre : cause à 0 passes et byCause vide sans NaN', () => {
    expect(rendre(agreger([]), { byCause: {} })).not.toMatch(/NaN|Infinity/);
    expect(rendre(agreger([]), { byCause: { a: 0 } })).not.toMatch(/NaN|Infinity/);
  });
  it('lireVagues : since invalide ne masque pas silencieusement toutes les vagues', () => {
    const runs = join(tempDir(), 'runs');
    mkdirSync(join(runs, 'v'), { recursive: true });
    writeFileSync(join(runs, 'v', 'wave.json'), JSON.stringify({ created: '2026-10-30T10:00:00Z' }));
    writeFileSync(join(runs, 'v', 'p--L1.json'), JSON.stringify({ project: 'p', lot: 'L1', steps: [] }));
    expect(() => lireVagues(runs, 'pas-une-date')).toThrow();
  });
  it('lireVagues : un fichier à la racine de runs est ignoré', () => {
    const runs = join(tempDir(), 'runs');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, 'note.txt'), 'x');
    expect(lireVagues(runs)).toEqual([]);
  });
  it('lireVagues : état JSON valide mais null ne lève pas', () => {
    const runs = join(tempDir(), 'runs');
    mkdirSync(join(runs, 'v'), { recursive: true });
    writeFileSync(join(runs, 'v', 'wave.json'), JSON.stringify({ created: '2026-10-30T10:00:00Z' }));
    writeFileSync(join(runs, 'v', 'p--L1.json'), 'null');
    expect(() => lireVagues(runs)).not.toThrow();
  });
});
