import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bench, commandeBanc } from '../src/bench/cli.js';
import { complet, sequencesDe } from '../src/bench/complet.js';
import { COMPLET_MAX_JOURS, PUBLIE, statut } from '../src/bench/verdict.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

// L730 (D-22, Sylvain du 14-11 : « banc court, environ 3 heures avec juges, c'est complètement dingue ») : garde proportionnée.
// Avant une publication, le banc mécanique suffit ; le banc complet (court avec juges puis séquence) passe le samedi ; rouge, il se signale
// et fait revenir la garde au banc complet jusqu'à un banc complet vert.
const now = new Date('2026-11-15T12:00:00Z');
const modeles = { 'cadence-run': 'opus', 'sequence-v2': 'opus', A: 'opus' };
const l = (o: Record<string, unknown> = {}) => JSON.stringify({ date: '2026-11-15T10:00:00Z', empreinte: 'e1', candidat: 'cadence-run', reference: 'A', modele_candidat: 'opus',
  bancs: ['1-a', '3-b', '6-c'], hebdo: false, frais: 0, vert: true, rouges: [], ...o });
const meca = (o: Record<string, unknown> = {}) => l({ niveau: 'mecanique', ...o });
const seq = (o: Record<string, unknown> = {}) => l({ type: 'sequence', sequence: 's', run: 'r1', repetition: 1, repetitions: 1, bancs: ['s'], ...o });
const st = (h: string[], emp = 'e1') => statut(h, now, emp, modeles, PUBLIE);
const ioMaintenant = (env: NodeJS.ProcessEnv) => ({ ...ioTest(env), now: () => now });

describe('garde proportionnée : le banc mécanique suffit avant une publication (L730)', () => {
  it('banc mécanique vert, cadence-run contre A, bancs 1, 3 et 6 : permise, sans juge ni séquence', () => {
    expect(st([meca()])).toMatchObject({ publication_ok: true, mode: 'mecanique', alerte: undefined });
  });
  it('refusée : mécanique rouge, sur une autre empreinte, sans le banc 6, autre candidat, autre modèle, empreinte inconnue', () => {
    expect(st([meca({ vert: false })]).publication_ok).toBe(false);
    expect(st([meca({ empreinte: 'e0' })]).publication_ok).toBe(false);
    expect(st([meca({ bancs: ['1-a', '3-b'] })]).publication_ok).toBe(false);
    expect(st([meca({ candidat: 'equipe-legere' })]).publication_ok).toBe(false);
    expect(st([meca({ modele_candidat: 'sonnet' })]).publication_ok).toBe(false);
    expect(st([meca({ empreinte: 'inconnue' })], 'inconnue').publication_ok).toBe(false);
  });
  it('un passage rouge de l\'empreinte après le mécanique vert (micro, mécanique, éclair) refuse ; un mécanique vert ensuite permet de nouveau', () => {
    expect(st([meca(), l({ niveau: 'micro', bancs: ['1-a'], vert: false })]).publication_ok).toBe(false);
    expect(st([meca(), l({ bancs: ['1-a'], eclair_ok: false })]).publication_ok).toBe(false);
    expect(st([meca(), meca({ vert: false })]).publication_ok).toBe(false);
    expect(st([meca({ vert: false }), meca()]).publication_ok).toBe(true);
  });
  it('le banc complet vert (court et séquence) permet toujours la publication', () => {
    expect(st([l(), seq()]).publication_ok).toBe(true);
  });
});

describe('un banc complet rouge se signale et fait revenir la garde au banc complet (L730)', () => {
  it('banc court rouge du samedi : alerte, mode complet, le mécanique vert ne suffit plus', () => {
    const s = st([l({ date: '2026-11-14T09:00:00Z', vert: false, rouges: ['temps total'] }), meca()]);
    expect(s.mode).toBe('complet');
    expect(s.alerte).toBe('banc complet rouge le 2026-11-14 sur l\'empreinte e1 (banc court : temps total)');
    expect(s.publication_ok).toBe(false);
  });
  it('séquence rouge : alerte, même sur une autre empreinte que celle à publier', () => {
    const s = st([seq({ empreinte: 'e0', sequence: 'aether-b68', vert: false }), meca()]);
    expect(s.alerte).toMatch(/sur l'empreinte e0 \(séquence aether-b68\)/);
    expect(s.publication_ok).toBe(false);
  });
  it('levée par un banc complet vert ensuite (court et séquence de la même empreinte) ; un court vert seul ne la lève pas', () => {
    const rouge = l({ date: '2026-11-14T09:00:00Z', empreinte: 'e0', vert: false });
    expect(st([rouge, l(), meca()]).alerte).toBeDefined();
    expect(st([rouge, l(), meca()]).publication_ok).toBe(false);
    const s = st([rouge, l({ empreinte: 'e2' }), seq({ empreinte: 'e2' }), meca()]);
    expect(s).toMatchObject({ alerte: undefined, mode: 'mecanique', publication_ok: true });
  });
  it('revue L730 : un banc complet vert qui ne rejoue pas la séquence rouge ne lève pas l\'alerte (court + séquence X vertes contre séquence Y rouge)', () => {
    const y = seq({ date: '2026-11-14T09:00:00Z', empreinte: 'e0', sequence: 'Y', vert: false });
    const autre = st([l({ empreinte: 'e0', date: '2026-11-14T08:00:00Z' }), y, l({ empreinte: 'e2' }), seq({ empreinte: 'e2', sequence: 'X' }), meca()]);
    expect(autre).toMatchObject({ mode: 'complet', publication_ok: false });
    expect(autre.alerte).toMatch(/séquence Y/);
    const meme = st([l({ date: '2026-11-14T08:00:00Z' }), y, l(), seq({ sequence: 'X' }), meca()]);
    expect(meme).toMatchObject({ mode: 'complet', publication_ok: false });
    // rejouer Y vert (court et séquence Y de la même empreinte) lève l'alerte
    expect(st([y, l({ empreinte: 'e2' }), seq({ empreinte: 'e2', sequence: 'Y' }), meca()])).toMatchObject({ alerte: undefined, mode: 'mecanique', publication_ok: true });
    // Y rejouée sur une autre empreinte que le court vert : pas un banc complet, l'alerte tient
    expect(st([y, l({ empreinte: 'e2' }), seq({ empreinte: 'e3', sequence: 'Y' }), meca()]).alerte).toBeDefined();
  });
  it('revue L730 : deux rouges en attente (séquences Y puis Z) ; rejouer Z seule ne lève pas l\'alerte de Y', () => {
    const h = [seq({ date: '2026-11-14T09:00:00Z', empreinte: 'e0', sequence: 'Y', vert: false }), seq({ date: '2026-11-14T10:00:00Z', empreinte: 'e0', sequence: 'Z', vert: false }),
      l({ empreinte: 'e2' }), seq({ empreinte: 'e2', sequence: 'Z' })];
    expect(st([...h, meca()]).alerte).toMatch(/séquence Z.*aussi rouge depuis : séquence Y/);
    expect(st([...h, seq({ empreinte: 'e2', sequence: 'Y' }), meca()])).toMatchObject({ alerte: undefined, publication_ok: true });
  });
  it('revue L730 : pendant une alerte, un banc complet vert de l\'empreinte antérieur au rouge n\'autorise plus la publication', () => {
    const s = st([l({ date: '2026-11-14T08:00:00Z' }), seq({ date: '2026-11-14T08:30:00Z' }), l({ date: '2026-11-14T09:00:00Z', empreinte: 'e0', vert: false })]);
    expect(s).toMatchObject({ mode: 'complet', publication_ok: false });
    expect(s.alerte).toBeDefined();
  });
  it('une répétition rouge dans le dernier run de séquence garde l\'alerte, même suivie d\'une verte', () => {
    const h = [l(), seq({ run: 'r2', repetitions: 2, repetition: 1, vert: false }), seq({ run: 'r2', repetitions: 2, repetition: 2 }), meca()];
    expect(st(h).alerte).toBeDefined();
    expect(st(h).publication_ok).toBe(false);
  });
  it('ne lèvent pas d\'alerte : un banc d\'un autre candidat (sequence-v2), un micro, un mécanique ou un éclair rouges', () => {
    expect(st([seq({ candidat: 'sequence-v2', vert: false }), meca()]).alerte).toBeUndefined();
    expect(st([l({ niveau: 'micro', bancs: ['1-a'], vert: false, empreinte: 'e0' }), meca()]).alerte).toBeUndefined();
    expect(st([meca({ vert: false, empreinte: 'e0' }), meca()]).alerte).toBeUndefined();
    expect(st([l({ bancs: ['1-a'], eclair_ok: false, vert: false, empreinte: 'e0' }), meca()]).alerte).toBeUndefined();
  });
  it('jours depuis le dernier banc complet : null s\'il n\'a jamais tourné', () => {
    expect(st([meca()]).jours_depuis_complet).toBeNull();
    expect(st([l({ date: '2026-11-05T09:00:00Z' })]).jours_depuis_complet).toBe(10);
    expect(COMPLET_MAX_JOURS).toBe(8);
  });
});

describe('cadence2 bench statut et verifier-publication (L730)', () => {
  const racine = (h: string[]) => {
    const r = dossierTemp('garde-l730-');
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: b\ncadence-run:\n  modele: opus\n  brief: b\n`);
    writeFileSync(join(r, 'historique.jsonl'), `${h.join('\n')}\n`);
    return r;
  };
  it('statut : l\'alerte en ⚠ (reprise par le hook de démarrage et le tour), et la commande du banc complet', async () => {
    const r = racine([l({ empreinte: 'inconnue', date: '2026-11-14T09:00:00Z', vert: false })]), io = ioMaintenant({ BENCH_ROOT: r, HOME: r });
    expect(await bench(['statut'], io, '/depot/a-publier')).toBe(0);
    const t = io.sortie.join('\n');
    expect(t).toMatch(/garde : banc complet ; publication refusée/);
    expect(t).toContain(`« ${commandeBanc('/depot/a-publier', 'court')} » puis « ${commandeBanc('/depot/a-publier', 'sequence <id> --repetitions 2 --candidat cadence-run --reference A')} »`);
    expect(io.sortie.filter((x) => x.startsWith('⚠'))).toContainEqual(expect.stringMatching(/^⚠ banc complet rouge le 2026-11-14 .* exige de nouveau le banc complet/));
  });
  it('statut : un banc complet jamais joué, ou trop ancien, se signale', async () => {
    const jamais = ioMaintenant({ BENCH_ROOT: racine([meca()]), HOME: '/x' });
    await bench(['statut'], jamais, '/d');
    expect(jamais.sortie).toContainEqual(expect.stringMatching(/^⚠ aucun banc complet dans l'historique/));
    const vieux = ioMaintenant({ BENCH_ROOT: racine([l({ date: '2026-11-01T09:00:00Z' }), seq({ date: '2026-11-01T10:00:00Z' })]), HOME: '/x' }, now);
    await bench(['statut'], vieux, '/d');
    expect(vieux.sortie).toContainEqual(expect.stringMatching(/^⚠ dernier banc complet il y a 14 jours/));
    const frais = ioMaintenant({ BENCH_ROOT: racine([l(), seq()]), HOME: '/x' });
    await bench(['statut'], frais, '/d');
    expect(frais.sortie.filter((x) => /banc complet/.test(x) && x.startsWith('⚠'))).toEqual([]);
  });
  it('verifier-publication : refus en mode mécanique (commande du mécanique), en mode complet (alerte et commandes du banc complet)', async () => {
    const io = ioMaintenant({ BENCH_ROOT: racine([]), HOME: '/x' });
    expect(await bench(['verifier-publication'], io, '/d')).toBe(1);
    expect(io.sortie.join('\n')).toContain(`« ${commandeBanc('/d', 'mecanique')} »`);
    const alerte = ioMaintenant({ BENCH_ROOT: racine([l({ empreinte: 'e0', vert: false })]), HOME: '/x' });
    expect(await bench(['verifier-publication'], alerte, '/d')).toBe(1);
    expect(alerte.sortie.join('\n')).toMatch(/banc complet rouge .* la garde exige de nouveau le dernier banc court ET la dernière séquence verts/);
    expect(alerte.sortie.join('\n')).toContain(`« ${commandeBanc('/d', 'court')} »`);
  });
});

describe('cadence2 bench complet : le banc du samedi (L730)', () => {
  const faux = (codes: { court?: number; seq?: number } = {}) => {
    const appels: string[][] = [];
    return { appels, d: {
      bench: async (a: string[]) => { appels.push(['bench', ...a]); return a[0] === 'court' ? codes.court ?? 0 : 0; },
      sequence: async (a: string[]) => { appels.push(['sequence', ...a]); return codes.seq ?? 0; },
    } };
  };
  const avecSequences = (...ids: string[]) => { const r = dossierTemp('complet-l730-'); for (const id of ids) mkdirSync(join(r, 'sequences', id), { recursive: true }); mkdirSync(join(r, 'sequences'), { recursive: true }); writeFileSync(join(r, 'sequences', 'fichier.txt'), ''); return r; };
  it('court, puis chaque séquence en deux répétitions, cadence-run contre A, puis statut ; 0 si tout est vert', async () => {
    const r = avecSequences('s2', 's1'), { appels, d } = faux();
    expect(sequencesDe(r)).toEqual(['s1', 's2']);
    expect(await complet([], ioTest({ BENCH_ROOT: r, HOME: r }), d)).toBe(0);
    const bras = ['--candidat', 'cadence-run', '--reference', 'A'];
    expect(appels).toEqual([['bench', 'court', ...bras], ['sequence', 's1', '--repetitions', '2', ...bras], ['sequence', 's2', '--repetitions', '2', ...bras], ['bench', 'statut']]);
  });
  it('--sequences choisit les séquences, --juge passe au court et aux séquences', async () => {
    const { appels, d } = faux();
    expect(await complet(['--sequences', 'x', '--juge', 'sonnet'], ioTest({ BENCH_ROOT: avecSequences(), HOME: '/x' }), d)).toBe(0);
    expect(appels.slice(0, 2).map((a) => a.slice(0, 2))).toEqual([['bench', 'court'], ['sequence', 'x']]);
    expect(appels[1]).toEqual(expect.arrayContaining(['--juge', 'sonnet']));
  });
  it('un court rouge n\'arrête pas les séquences (code 1) ; un court refusé arrête tout (code 2) ; sans séquence ou option sans valeur : code 2', async () => {
    const rouge = faux({ court: 1 });
    expect(await complet([], ioTest({ BENCH_ROOT: avecSequences('s1'), HOME: '/x' }), rouge.d)).toBe(1);
    expect(rouge.appels.map((a) => a[0])).toEqual(['bench', 'sequence', 'bench']);
    const refus = faux({ court: 2 });
    expect(await complet([], ioTest({ BENCH_ROOT: avecSequences('s1'), HOME: '/x' }), refus.d)).toBe(2);
    expect(refus.appels).toHaveLength(1);
    expect(await complet([], ioTest({ BENCH_ROOT: avecSequences(), HOME: '/x' }), faux().d)).toBe(2);
    expect(await complet(['--sequences'], ioTest({ BENCH_ROOT: avecSequences('s1'), HOME: '/x' }), faux().d)).toBe(2);
    expect(await complet([], ioTest({ BENCH_ROOT: avecSequences('s1'), HOME: '/x' }), faux({ seq: 1 }).d)).toBe(1);
  });
});
