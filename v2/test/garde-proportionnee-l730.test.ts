import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bench, commandeBanc, empreinte, REPO } from '../src/bench/cli.js';
import { complet, sequencesDe } from '../src/bench/complet.js';
import { COMPLET_MAX_JOURS, GARDE_DEPUIS, PUBLIE, statut } from '../src/bench/verdict.js';
import { ioTest } from './cli.test.js';
import { dossierTemp } from './temp.js';

// L730 (D-22, Sylvain du 14-11 : « banc court, environ 3 heures avec juges, c'est complètement dingue ») : garde proportionnée.
// Avant une publication, le banc mécanique suffit ; le banc complet (court avec juges puis séquence) passe le samedi ; rouge, il se signale
// et reste signalé jusqu'à ce que ce banc soit rejoué vert après lui, sur la version corrigée (garde en quatre règles, docs/v2/banc.md).
// L903 (D-39, Sylvain du 26-11 : « on fait rien sur cadence pendant que ça tourne ») : l'alerte ne bloque plus la publication, elle s'affiche.
const now = new Date('2026-11-15T12:00:00Z');
const modeles = { 'cadence-run': 'opus', 'sequence-v2': 'opus', A: 'opus' };
const l = (o: Record<string, unknown> = {}) => JSON.stringify({ date: '2026-11-15T10:00:00Z', empreinte: 'e1', candidat: 'cadence-run', reference: 'A', modele_candidat: 'opus',
  bancs: ['1-a', '3-b', '7-c'], hebdo: false, frais: 0, vert: true, rouges: [], ...o });
const meca = (o: Record<string, unknown> = {}) => l({ niveau: 'mecanique', ...o });
const seq = (o: Record<string, unknown> = {}) => l({ type: 'sequence', sequence: 's', run: 'r1', repetition: 1, repetitions: 1, bancs: ['s'], ...o });
const st = (h: string[], emp = 'e1') => statut(h, now, emp, modeles, PUBLIE);
const ioMaintenant = (env: NodeJS.ProcessEnv) => ({ ...ioTest(env), now: () => now });

describe('garde proportionnée : le banc mécanique suffit avant une publication (L730)', () => {
  it('banc mécanique vert, cadence-run contre A, bancs 1, 3 et 7 (L739) : permise, sans juge ni séquence', () => {
    expect(st([meca()])).toMatchObject({ publication_ok: true, alerte: undefined });
  });
  it('refusée : mécanique rouge, sur une autre empreinte, sans le banc 7, autre candidat, autre modèle, empreinte inconnue', () => {
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

describe('un banc complet rouge se signale, sans bloquer la publication (L730, L903)', () => {
  it('banc court rouge du samedi : alerte ; le mécanique vert permet la publication (L903)', () => {
    const s = st([l({ date: '2026-11-15T09:00:00Z', vert: false, rouges: ['temps total'] }), meca()]);
    expect(s.alerte).toBe('banc complet rouge le 2026-11-15 sur l\'empreinte e1 (banc court : temps total)');
    expect(s.a_rejouer).toEqual(['court']);
    expect(s.publication_ok).toBe(true);
  });
  it('séquence rouge : alerte, même sur une autre empreinte que celle à publier ; publication permise par le mécanique vert', () => {
    const s = st([seq({ empreinte: 'e0', sequence: 'aether-b68', vert: false }), meca()]);
    expect(s.alerte).toMatch(/sur l'empreinte e0 \(séquence aether-b68\)/);
    expect(s.publication_ok).toBe(true);
  });
  it('un court rouge d\'une autre empreinte tient tant que le court n\'est pas rejoué vert après lui ; rejoué vert sur la version corrigée, il tombe, pour elle et les suivantes', () => {
    const rouge = l({ date: '2026-11-15T09:00:00Z', empreinte: 'e0', vert: false });
    expect(st([rouge, seq({ empreinte: 'e2' }), meca()])).toMatchObject({ publication_ok: true, a_rejouer: ['court'] });
    expect(st([rouge, l(), meca()])).toMatchObject({ alerte: undefined, a_rejouer: [], publication_ok: true });
    expect(st([rouge, l({ empreinte: 'e2' }), meca()])).toMatchObject({ alerte: undefined, a_rejouer: [], publication_ok: true });
  });
  it('une répétition rouge dans le dernier run de séquence garde l\'alerte, même suivie d\'une verte', () => {
    const h = [l(), seq({ run: 'r2', repetitions: 2, repetition: 1, vert: false }), seq({ run: 'r2', repetitions: 2, repetition: 2 })];
    expect(st(h).alerte).toBeDefined();
    expect(st(h).publication_ok).toBe(false); // sans mécanique, le banc complet de l'empreinte n'est pas vert
    expect(st([...h, meca()]).publication_ok).toBe(true); // L903
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

// Garde en quatre règles (contrat décidé par le lead le 15-11, docs/v2/banc.md) : un test par ligne du tableau, puis les cas inverses vus aux revues.
describe('garde en quatre règles (contrat, L730)', () => {
  const y = (o: Record<string, unknown> = {}) => seq({ date: '2026-11-15T09:00:00Z', empreinte: 'e0', sequence: 'Y', vert: false, ...o });
  it('règle 1 : une alerte naît de chaque rouge du banc complet, court ou séquence (par son id), sur toute empreinte', () => {
    const s = st([l({ date: '2026-11-15T08:00:00Z', empreinte: 'e0', vert: false }), y(), meca()]);
    expect(s.alerte).toMatch(/\(séquence Y\) ; aussi rouge depuis : banc court$/);
    expect(s.a_rejouer).toEqual(['court', 'sequence Y']);
  });
  it('règle 2 : l\'alerte tombe quand CE banc est rejoué vert après elle, sur une empreinte postérieure (la version corrigée)', () => {
    expect(st([y(), seq({ sequence: 'Y' }), meca()])).toMatchObject({ alerte: undefined, a_rejouer: [], publication_ok: true });
    expect(st([seq({ sequence: 'Y' }), y({ empreinte: 'e1' }), meca()]).a_rejouer).toEqual(['sequence Y']); // un vert d'avant le rouge ne le rejoue pas
    expect(st([seq({ sequence: 'Y', empreinte: 'e0' }), y(), meca()]).a_rejouer).toEqual(['sequence Y']); // ni un vert d'avant sur l'empreinte du rouge
    // un run de Y incomplet (une répétition sur deux) ne rejoue pas Y
    expect(st([y(), seq({ sequence: 'Y', run: 'r2', repetitions: 2 }), meca()]).a_rejouer).toEqual(['sequence Y']);
  });
  it('règle 2 (revue 3) : rouge sur e0, rejoué vert sur e1 : levée pour de bon, la publication de e2 est permise sur un mécanique vert', () => {
    const h = [y(), seq({ sequence: 'Y' }), meca({ empreinte: 'e2' })];
    expect(st(h, 'e2')).toMatchObject({ alerte: undefined, a_rejouer: [], publication_ok: true });
    expect(st([y(), seq({ sequence: 'Y', empreinte: 'e2' }), meca()])).toMatchObject({ alerte: undefined, publication_ok: true }); // vert sur e2, publication de e1
    const court = l({ date: '2026-11-15T08:00:00Z', empreinte: 'e0', vert: false });
    expect(st([court, l(), meca({ empreinte: 'e2' })], 'e2')).toMatchObject({ alerte: undefined, publication_ok: true });
    expect(st([court, l(), meca({ empreinte: 'e2' })], 'e3').publication_ok).toBe(false); // e3 n'a pas de mécanique : règle 4, pas la règle 2
    // la même séquence rouge de nouveau sur e2 : une alerte neuve, Y est de nouveau à rejouer
    expect(st([...h, seq({ sequence: 'Y', empreinte: 'e2', vert: false }), meca({ empreinte: 'e3' })], 'e3')).toMatchObject({ a_rejouer: ['sequence Y'], publication_ok: true });
  });
  it('règle 2 (revue 3) : le rejeu ne compte que par le vrai bras, cadence-run contre A avec le modèle courant', () => {
    expect(st([y(), seq({ sequence: 'Y', candidat: 'sequence-v2' }), meca()]).a_rejouer).toEqual(['sequence Y']);
    expect(st([y(), seq({ sequence: 'Y', modele_candidat: 'sonnet' }), meca()]).a_rejouer).toEqual(['sequence Y']);
    expect(st([y(), seq({ sequence: 'Y', candidat: 'A' }), meca()]).a_rejouer).toEqual(['sequence Y']); // A contre A
    const court = l({ date: '2026-11-15T08:00:00Z', empreinte: 'e0', vert: false });
    expect(st([court, l({ candidat: 'sequence-v2' }), meca()]).a_rejouer).toEqual(['court']);
    expect(st([court, l({ modele_candidat: 'sonnet' }), meca()]).a_rejouer).toEqual(['court']);
    expect(st([court, l({ candidat: 'A' }), meca()]).a_rejouer).toEqual(['court']);
  });
  // L903 (D-39, Sylvain du 26-11) : la règle 3 ne bloque plus ; avant, Y rouge refusait toute publication jusqu'au rejeu (2.0.19 bloquée, 5 à 6 h).
  it('règle 3 (L903) : alerte en cours + mécanique vert de l\'empreinte : publication permise, l\'alerte reste affichée', () => {
    expect(st([y(), meca()])).toMatchObject({ publication_ok: true, a_rejouer: ['sequence Y'], alerte: expect.stringMatching(/séquence Y/) });
    expect(st([y(), l(), seq({ sequence: 'X' }), meca()])).toMatchObject({ publication_ok: true, a_rejouer: ['sequence Y'] });
    // le rouge du complet sur l'empreinte à publier, APRÈS le mécanique vert, ne le retire pas : c'est l'alerte, qui ne bloque plus
    expect(st([meca(), y({ empreinte: 'e1' })])).toMatchObject({ publication_ok: true, a_rejouer: ['sequence Y'] });
    expect(st([meca(), l({ date: '2026-11-15T11:00:00Z', vert: false })])).toMatchObject({ publication_ok: true, a_rejouer: ['court'] });
  });
  it('règle 3 (L903) : alerte en cours sans mécanique vert de l\'empreinte : refusée', () => {
    expect(st([y()]).publication_ok).toBe(false);
    expect(st([y(), meca({ empreinte: 'e0' })]).publication_ok).toBe(false); // mécanique d'une autre empreinte
    expect(st([y(), meca({ vert: false })]).publication_ok).toBe(false);
  });
  it('règle 3 (L903) : un mécanique, un micro ou un éclair rouges après le mécanique vert refusent toujours, alerte ou pas', () => {
    expect(st([y(), meca(), meca({ vert: false })]).publication_ok).toBe(false);
    expect(st([y(), meca(), l({ niveau: 'micro', bancs: ['1-a'], vert: false })]).publication_ok).toBe(false);
    expect(st([y(), meca(), l({ bancs: ['1-a'], eclair_ok: false, vert: false })]).publication_ok).toBe(false);
  });
  it('règle 4 : le mécanique vert suffit, et un banc complet vert aussi', () => {
    expect(st([meca()]).publication_ok).toBe(true);
    expect(st([l(), seq()]).publication_ok).toBe(true);
    expect(st([y(), seq({ sequence: 'Y' }), l(), seq({ sequence: 'X' })]).publication_ok).toBe(true);
  });
  it('revue 1 : un court et une séquence X verts ne lèvent pas Y, ni sur une autre empreinte, ni sur celle à publier', () => {
    expect(st([y(), l({ empreinte: 'e2' }), seq({ empreinte: 'e2', sequence: 'X' }), meca()]).alerte).toMatch(/séquence Y/);
    expect(st([y({ empreinte: 'e1' }), l(), seq({ sequence: 'X' }), meca()])).toMatchObject({ a_rejouer: ['sequence Y'] });
  });
  it('revue 1 : Y et Z rouges, Z seule rejouée ne lève pas Y ; Y rejouée ensuite, l\'alerte tombe', () => {
    const h = [y(), y({ date: '2026-11-15T10:00:00Z', sequence: 'Z' }), seq({ sequence: 'Z' })];
    expect(st([...h, meca()]).a_rejouer).toEqual(['sequence Y']);
    expect(st([...h, meca()]).alerte).toMatch(/séquence Y/);
    expect(st([...h, seq({ sequence: 'Y' }), meca()])).toMatchObject({ alerte: undefined, publication_ok: true });
  });
  it('revue 2 : un banc complet vert de l\'empreinte sans Y (court + séquence X) ne lève pas l\'alerte de Y ; il publie (L903)', () => {
    const s = st([l({ empreinte: 'e0', date: '2026-11-15T08:00:00Z' }), y(), l(), seq({ sequence: 'X' })]);
    expect(s).toMatchObject({ publication_ok: true, a_rejouer: ['sequence Y'] });
    expect(st([l(), seq(), y()]).a_rejouer).toEqual(['sequence Y']); // revue 1, constat mineur : un banc complet vert d'avant le rouge ne le rejoue pas
  });  // Décision de Sylvain du 15-11 : les rouges d'avant la mise en service (15-11, 00:00 à Paris) sont déjà arbitrés (2.0.3 à 2.0.8 publiées sur dossier).
  it('règle 1 (GARDE_DEPUIS) : un rouge du 12-11 ne lève pas d\'alerte ; un rouge du 15-11 ou après en lève une', () => {
    expect(GARDE_DEPUIS).toBe('2026-11-15T00:00:00+01:00');
    const avant = [seq({ date: '2026-11-12T20:00:00Z', empreinte: 'e0', sequence: 'aether-b68-court', vert: false }), l({ date: '2026-11-12T08:00:00Z', empreinte: 'e0', vert: false })];
    expect(st([...avant, meca()])).toMatchObject({ alerte: undefined, a_rejouer: [], publication_ok: true });
    expect(st([l({ date: '2026-11-14T22:59:59Z', vert: false }), meca()]).alerte).toBeUndefined(); // 14-11, 23:59:59 à Paris
    for (const date of ['2026-11-14T23:00:00Z', '2026-11-15T09:00:00Z', '2026-11-21T09:00:00Z']) { // 15-11 00:00 à Paris, puis après
      expect(st([l({ date, vert: false }), meca()])).toMatchObject({ a_rejouer: ['court'], publication_ok: true });
      expect(st([seq({ date, empreinte: 'e0', sequence: 'Y', vert: false }), meca()]).a_rejouer).toEqual(['sequence Y']);
    }
    expect(st([...avant, y(), meca()]).alerte).toMatch(/^banc complet rouge le 2026-11-15 .*\(séquence Y\)$/); // le rouge d'avant n'est pas cité
  });
});

describe('cadence2 bench statut et verifier-publication (L730)', () => {
  const racine = (h: string[]) => {
    const r = dossierTemp('garde-l730-');
    writeFileSync(join(r, 'bras.yaml'), `A:\n  modele: opus\n  brief: b\ncadence-run:\n  modele: opus\n  brief: b\n`);
    writeFileSync(join(r, 'historique.jsonl'), `${h.join('\n')}\n`);
    return r;
  };
  it('statut : l\'alerte en ⚠ (reprise par le hook de démarrage et le tour), qui ne bloque pas, avec les bancs à rejouer au banc complet du week-end', async () => {
    const r = racine([l({ empreinte: 'inconnue', date: '2026-11-15T09:00:00Z', vert: false })]), io = ioMaintenant({ BENCH_ROOT: r, HOME: r });
    expect(await bench(['statut'], io, '/depot/a-publier')).toBe(0);
    const t = io.sortie.join('\n');
    expect(t).toMatch(/garde : banc mécanique ; publication refusée/); // empreinte inconnue, pas de mécanique : refus de la règle 4, pas de l'alerte
    expect(t).toContain(`lancer, depuis la version à publier : « ${commandeBanc('/depot/a-publier', 'mecanique')} »`);
    expect(io.sortie.filter((x) => x.startsWith('⚠'))).toContainEqual(`⚠ banc complet rouge le 2026-11-15 sur l'empreinte inconnue (banc court) : ne bloque pas la publication (L903) ; à rejouer vert au banc complet du week-end, sur la version corrigée ou une suivante : court (« ${commandeBanc('/depot/a-publier', 'court')} ») ; corriger le défaut, et revenir sur une version publiée depuis qu'il est apparu`);
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
  it('verifier-publication : sans mécanique vert, refus avec la commande du mécanique ; l\'alerte suit en ⚠ (L903)', async () => {
    const io = ioMaintenant({ BENCH_ROOT: racine([]), HOME: '/x' });
    expect(await bench(['verifier-publication'], io, '/d')).toBe(1);
    expect(io.sortie.join('\n')).toContain(`« ${commandeBanc('/d', 'mecanique')} »`);
    const alerte = ioMaintenant({ BENCH_ROOT: racine([l({ empreinte: 'e0', vert: false }), seq({ empreinte: 'e0', sequence: 'Y', vert: false })]), HOME: '/x' });
    expect(await bench(['verifier-publication'], alerte, '/d')).toBe(1);
    expect(alerte.sortie[0]).toMatch(/^publication refusée sur l'empreinte inconnue : il faut le dernier banc mécanique/);
    expect(alerte.sortie[1]).toMatch(/^⚠ banc complet rouge .* ne bloque pas la publication \(L903\) ; à rejouer vert au banc complet du week-end, sur la version corrigée ou une suivante : court, sequence Y/);
    expect(alerte.sortie[1]).toContain(`« ${commandeBanc('/d', 'court')} », « ${commandeBanc('/d', 'sequence Y --repetitions 2 --candidat cadence-run --reference A')} »`);
  });
  it('verifier-publication (L903) : alerte en cours + mécanique vert de l\'empreinte du dépôt : code 0, et la ligne ⚠ de l\'alerte', async () => {
    const e = empreinte(REPO);
    expect(e).not.toBe('inconnue');
    const io = ioMaintenant({ BENCH_ROOT: racine([seq({ empreinte: 'e0', sequence: 'Y', vert: false }), meca({ empreinte: e })]), HOME: '/x' });
    expect(await bench(['verifier-publication'], io, REPO)).toBe(0);
    expect(io.sortie[0]).toBe(`banc mécanique ou complet vert sur l'empreinte ${e}`);
    expect(io.sortie.slice(1)).toEqual([expect.stringMatching(/^⚠ banc complet rouge le 2026-11-15 sur l'empreinte e0 \(séquence Y\) : ne bloque pas la publication/)]);
    // un mécanique rouge après le vert : refusée (inchangé)
    const rouge = ioMaintenant({ BENCH_ROOT: racine([seq({ empreinte: 'e0', sequence: 'Y', vert: false }), meca({ empreinte: e }), meca({ empreinte: e, vert: false })]), HOME: '/x' });
    expect(await bench(['verifier-publication'], rouge, REPO)).toBe(1);
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
