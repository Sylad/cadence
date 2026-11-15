import type { Taille } from './banc.js';
import type { Mesure } from './bras.js';
import { avisLu, type Jugement, type Meca } from './juges.js';

/** L689 : mesure sans juge IA d'un bras (bancs micro et mécanique, sans-juge.ts). */
/** `rejoue` (L734) : la mesure rouge du premier passage, sous la charge des autres bancs ; les champs sont alors ceux du rejeu seul. */
export interface MesureSansJuge { suite_ok: boolean; caches_ok: boolean | null; rejoue?: { suite_ok: boolean; caches_ok: boolean | null } }
export interface ResultatBanc { banc: string; taille: Taille; visible: boolean; reponses: boolean; frais: boolean;
  mesures: Record<string, Mesure>; jugement: Jugement | null; fuites: Record<string, string[]>; fuites_a_verifier?: Record<string, string[]>;
  sans_juge?: Record<string, MesureSansJuge>;
  /** L733 : bras qui n'ont livré aucun fichier hors plan et doc, et la raison ; le banc n'est alors pas mesuré (sans juge seulement). */
  non_livre?: Record<string, string> }
/** `bruit` (L737) : banc de base -> plus grand écart de temps (rapport ≥ 1) mesuré entre deux bras identiques dans l'historique (`bruitParBanc`). */
export interface Barre { temps_max: number; temps_max_retouche: number; reference_absolue: { caches: number; mutations: number }; bruit?: Record<string, number> }
export interface Critere { nom: string; valeur: string; seuil: string; ok: boolean; bloquant: boolean }
/** `non_mesurable` (L733, ligne (d) des cinq règles de `verdictSansJuge`) : bancs dont un bras n'a pas livré le travail, posé seulement si aucun critère bloquant n'est rouge ; le passage n'est ni vert ni rouge, il est à rejouer. */
export interface Verdict { vert: boolean; criteres: Critere[]; non_mesurable?: string[] }
export const titreVerdict = (v: Verdict): string => (v.non_mesurable ? 'NON MESURABLE (à rejouer)' : v.vert ? 'VERT' : 'ROUGE');

export const BARRE_SPEC: Barre = { temps_max: 1.5, temps_max_retouche: 1.2, reference_absolue: { caches: 304, mutations: 0.79 } };
/** L689 (décision de Sylvain du 13-11) : la publication exige cadence run, le mode par défaut, contre Claude seul. */
export const PUBLIE = { candidat: 'cadence-run', reference: 'A' } as const;

const somme = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Banc de base d'un id de répétition `<banc>#k`. */
export const banBase = (id: string): string => (id.includes('#') ? id.slice(0, id.lastIndexOf('#')) : id);

/** Avis par banc de base : les répétitions comptent une fois, et seulement si toutes sont jugées et s'accordent ; sinon « egal ». « indécis » (R39) n'est pas une préférence. */
function avisParBanc(res: ResultatBanc[], champ: 'prefere' | 'ui'): { id: string; val: string; label: string }[] {
  const groupes = new Map<string, ResultatBanc[]>();
  res.forEach((r, i) => { const k = r.banc.includes('#') ? banBase(r.banc) : `\0${i}`; groupes.set(k, [...(groupes.get(k) ?? []), r]); });
  return [...groupes.values()].map((rs) => {
    const id = banBase(rs[0].banc); const a = rs.map((r) => r.jugement?.[champ]);
    if (a.some((x) => x === undefined)) return { id, val: 'egal', label: 'égal (non jugé)' };
    if (a.some((x) => x !== a[0])) return { id, val: 'egal', label: 'égal (désaccord)' };
    return { id, val: a[0]!, label: a[0] === 'egal' ? 'égal' : [...new Set(rs.map((r) => avisLu(r.jugement!, champ)))].join(' ; ') };
  });
}
const detail = (av: { id: string; label: string }[]) => av.map((x) => `${x.id} : ${x.label}`).join(' · ');

const c = (nom: string, valeur: string, seuil: string, ok: boolean, bloquant = true): Critere => ({ nom, valeur, seuil, ok, bloquant });
/** L737 : à partir de cet écart entre deux bras identiques, un banc ne départage plus un vrai × 2 : son temps devient indicatif. */
export const BRUIT_MAX = 2;
/**
 * L737 : passages déjà joués où les deux bras recevaient le même prompt au même modèle, prouvé sur les transcripts par l'étude L735
 * (docs/etudes/banc3-lenteur.md, § 4a : avant L736, `cadence-run` jouait le brief A au banc court). Le banc ne notait pas encore `empreinte_bras`.
 */
export const PAIRES_IDENTIQUES_L735 = ['2026-11-13-1717-af18c3783fa3', '2026-11-13-2047-2b220bd21ebf', '2026-11-14-0002-0118958c983c', '2026-11-14-1000-0118958c983c',
  '2026-11-14-1018-0118958c983c', '2026-11-14-1721-1085f4914df4', '2026-11-15-1540-f83140f3ab70', '2026-11-15-1604-f83140f3ab70', '2026-11-15-1749-edc99cb3f24c'];
/** Un passage relu dans `rapports/<run>.json`. */
export type PassageLu = { run: string; resultats: ResultatBanc[] };

/**
 * L737 : bruit de chaque banc de base, le plus grand rapport des temps (≥ 1) entre deux bras identiques de l'historique : même `empreinte_bras`
 * (brief, modèle, réglages et pièces), ou passage de PAIRES_IDENTIQUES_L735. Un banc non livré, un bras en échec ou un temps nul ne mesure rien.
 */
export function bruitParBanc(passages: PassageLu[]): Record<string, number> {
  const bruit: Record<string, number> = {};
  for (const p of passages) for (const r of p.resultats) {
    const m = Object.values(r.mesures ?? {});
    if (m.length !== 2 || (r.non_livre && Object.keys(r.non_livre).length) || m.some((x) => x.echec !== null || !(x.duree_s > 0))) continue;
    if (!(PAIRES_IDENTIQUES_L735.includes(p.run) || (m[0].empreinte_bras && m[0].empreinte_bras === m[1].empreinte_bras))) continue;
    const id = banBase(r.banc), e = Math.max(m[0].duree_s, m[1].duree_s) / Math.min(m[0].duree_s, m[1].duree_s);
    bruit[id] = Math.max(bruit[id] ?? 1, e);
  }
  return bruit;
}

const nb = (x: number) => String(Math.round(x * 100) / 100).replace('.', ',');
/**
 * L737 : critères de temps selon le bruit de chaque banc (tableau « Bruit du temps » dans docs/v2/banc.md). Seule fonction qui porte la règle.
 * Écart e d'un banc : `barre.bruit[banc de base]`. Sans paire identique connue ou e ≤ seuil de la barre : le seuil de la barre ; seuil < e < BRUIT_MAX : e ;
 * e ≥ BRUIT_MAX : banc bruité, son temps sort du temps total et des retouches et se lit dans « temps des bancs bruités », indicatif.
 * Un critère vaut « candidat ≤ Σ seuil du banc × référence » sur ses bancs : sans bruit, c'est la règle d'avant (1,5 × A, 1,2 × A). Les bancs non livrés
 * sont déjà sortis (L733, règle (a)) ; temps total et retouches restent bloquants sur les bancs non bruités (règle (b)).
 */
function criteresTemps(res: ResultatBanc[], ref: string, cand: string, barre: Barre): Critere[] {
  const t = (rs: ResultatBanc[], b: string) => somme(rs.map((r) => r.mesures[b]?.duree_s ?? 0));
  const e = (r: ResultatBanc) => barre.bruit?.[banBase(r.banc)] ?? 1;
  const bruites = res.filter((r) => e(r) >= BRUIT_MAX), fiables = res.filter((r) => !bruites.includes(r)), ret = fiables.filter((r) => r.taille === 'retouche');
  /** `vide` : la valeur d'un critère sans banc, alors indicatif. */
  const critere = (nom: string, rs: ResultatBanc[], seuil: number, vide?: string): Critere => {
    const s = (r: ResultatBanc) => Math.max(seuil, e(r)), limite = somme(rs.map((r) => s(r) * (r.mesures[ref]?.duree_s ?? 0)));
    const parBanc = rs.some((r) => s(r) !== seuil) ? ` (seuil par banc, bruit compris : ${[...new Set(rs.map((r) => `${banBase(r.banc)} ${nb(s(r))}`))].join(' ; ')})` : '';
    return c(nom, vide && !rs.length ? vide : `${t(rs, cand)} s contre ${t(rs, ref)} s`, parBanc ? `≤ ${Math.round(limite)} s${parBanc}` : `≤ ${seuil} × ${ref}`,
      t(rs, cand) <= limite, !(vide && !rs.length));
  };
  const idsBruites = [...new Set(bruites.map((r) => `${banBase(r.banc)} ${nb(e(r))}`))].join(' ; ');
  return [
    critere('temps total', fiables, barre.temps_max, bruites.length ? 'aucun banc au temps fiable' : undefined),
    critere('temps des retouches', ret, barre.temps_max_retouche, 'aucun banc de retouche'),
    ...(bruites.length ? [c('temps des bancs bruités', `${t(bruites, cand)} s contre ${t(bruites, ref)} s (${idsBruites})`,
      `≤ ${barre.temps_max} × ${ref}, indicatif : écart entre bras identiques ≥ ${BRUIT_MAX}`, t(bruites, cand) <= barre.temps_max * t(bruites, ref), false)] : []),
  ];
}

/** Critères sans juge, communs à tous les passages (L689) : mesures, fuites et échecs (`avant`), temps et questions (`apres`). */
function communs(res: ResultatBanc[], ref: string, cand: string, barre: Barre): { avant: Critere[]; apres: Critere[] } {
  const inutiles = somme(res.filter((r) => !r.reponses).map((r) => r.mesures[cand]?.questions ?? 0));
  const fuites = res.flatMap((r) => Object.entries(r.fuites).flatMap(([b, ps]) => ps.map((p) => `${r.banc}/${b} : ${p}`)));
  const echecs = res.flatMap((r) => [ref, cand].flatMap((b) => { const e = r.mesures[b]?.echec; return e ? [`${r.banc}/${b} : ${e}`] : []; }));
  const manquants = res.flatMap((r) => [ref, cand].filter((b) => !r.mesures[b]).map((b) => `${r.banc}/${b}`));
  const avant = [
    c('au moins un banc', `${res.length}`, '≥ 1', res.length >= 1),
    c('mesures complètes', manquants.length ? manquants.join(' ; ') : 'toutes', 'toutes', manquants.length === 0),
    c('aucune fuite', fuites.length ? fuites.join(' ; ') : '0', '0', fuites.length === 0),
    c('aucun bras en échec', echecs.length ? echecs.join(' ; ') : '0', '0', echecs.length === 0),
  ];
  const apres = [
    ...criteresTemps(res, ref, cand, barre),
    c('questions inutiles', `${inutiles}`, '0', inutiles === 0),
  ];
  return { avant, apres };
}

/**
 * L689 : verdict d'un banc micro ou mécanique, sans juge IA : suite du projet et tests d'origine verts sur au moins autant de bancs que la référence.
 * Banc non livré : cinq règles (L733, deux revues ; tableau « Banc non livré » dans docs/v2/banc.md). Seule fonction qui les porte :
 * (a) un banc non livré (`non_livre`, posé par `sansLivrable`) sort de TOUS les critères, temps total et retouches compris ;
 * (b) temps total (≤ 1,5 × ref) et temps des retouches (≤ 1,2 × ref) se calculent sur les bancs mesurés restants et RESTENT BLOQUANTS ;
 * (c) tout critère bloquant rouge sur un banc mesuré → ROUGE ; (d) aucun rouge et au moins un banc non livré → NON MESURABLE ; (e) sinon VERT.
 * Une suite rouge rejouée verte (L734) arrive ici déjà verte (`sans_juge.<bras>.suite_ok` est le rejeu) : ce n'est pas un rouge.
 * Seul « au moins un banc » cesse d'être bloquant quand un banc n'est pas livré : sans lui, un passage dont aucun banc n'est livré serait rouge, pas non mesurable.
 */
export function verdictSansJuge(tous: ResultatBanc[], ref: string, cand: string, barre: Barre): Verdict {
  const nonLivres = tous.filter((r) => r.non_livre && Object.keys(r.non_livre).length), res = tous.filter((r) => !nonLivres.includes(r)); // (a)
  const k = communs(res, ref, cand, barre); // (b) : les temps sont ceux de `res`, bloquants comme sans banc non livré
  if (nonLivres.length) for (const x of k.avant) if (x.nom === 'au moins un banc') x.bloquant = false;
  const mes = res.filter((r) => r.sans_juge?.[ref] && r.sans_juge?.[cand]);
  const avecCaches = mes.filter((r) => r.sans_juge![ref].caches_ok !== null).length;
  const n = (b: string, f: 'suite_ok' | 'caches_ok') => mes.filter((r) => r.sans_juge![b][f] === true).length;
  const ok = (f: 'suite_ok' | 'caches_ok') => n(cand, f) >= n(ref, f);
  const criteres = [...k.avant,
    c('bancs mesurés sans juge', `${mes.length}/${res.length}`, 'tous', mes.length === res.length),
    c('suite du projet verte', `${n(cand, 'suite_ok')} contre ${n(ref, 'suite_ok')} bancs`, `≥ ${ref}`, ok('suite_ok')),
    c('tests d\'origine verts', avecCaches ? `${n(cand, 'caches_ok')} contre ${n(ref, 'caches_ok')} bancs sur ${avecCaches}` : 'aucun banc avec tests d\'origine', `≥ ${ref}`, ok('caches_ok')),
    ...k.apres,
    ...(nonLivres.length ? [c('bras qui ont livré le travail', nonLivres.flatMap((r) => Object.entries(r.non_livre!).map(([b, x]) => `${r.banc}/${b} : ${x}`)).join(' ; '), 'tous', false, false)] : [])];
  const rouge = criteres.some((x) => x.bloquant && !x.ok); // (c)
  const nonMesurable = !rouge && nonLivres.length > 0; // (d)
  return { vert: !rouge && !nonMesurable, criteres, ...(nonMesurable && { non_mesurable: nonLivres.map((r) => r.banc) }) }; // (e)
}

export function verdict(res: ResultatBanc[], ref: string, cand: string, barre: Barre): Verdict {
  const jug = res.filter((r) => r.jugement).map((r) => r.jugement!);
  const k = communs(res, ref, cand, barre);
  const caches = (b: string) => somme(jug.map((j) => j.meca[b].caches_passes));
  const mut = (b: string) => somme(jug.map((j) => j.meca[b].mutations_tuees)) / Math.max(1, somme(jug.map((j) => j.meca[b].mutations_total)));
  const def = (b: string) => somme(jug.map((j) => j.defauts[b].bloquants + j.defauts[b].majeurs));
  const prefs = avisParBanc(res, 'prefere'); const uis = avisParBanc(res, 'ui');
  const prefCand = prefs.filter((p) => p.val !== ref).length;
  const ui = (b: string) => uis.filter((u) => u.val === b).length;
  const total = (b: string) => somme(jug.map((j) => j.meca[b].mutations_total));
  const sansMutation = jug.length > 0 && (total(ref) === 0 || total(cand) === 0);
  const criteres: Critere[] = [...k.avant,
    c('tous les bancs jugés', `${jug.length}/${res.length} répétitions`, 'tous', jug.length === res.length),
    c('relecture aveugle', `${prefCand}/${prefs.length} bancs de base sans préférence pour ${ref} (${detail(prefs)})`, '> la moitié', prefs.length === 0 || prefCand * 2 > prefs.length),
    c('tests cachés', `${caches(cand)} contre ${caches(ref)}`, `≥ ${ref}`, caches(cand) >= caches(ref)),
    c('mutations tuées', sansMutation ? 'aucune mutation jouée' : `${pct(mut(cand))} contre ${pct(mut(ref))}`, `≥ ${ref}`, !sansMutation && mut(cand) >= mut(ref)),
    c('défauts bloquants et majeurs', `${def(cand)} contre ${def(ref)}`, `≤ ${ref}`, def(cand) <= def(ref)),
    c('cohérence UI', `${ui(cand)} contre ${ui(ref)} (${detail(uis)})`, `≥ ${ref}`, ui(cand) >= ui(ref)),
    ...k.apres,
    c(`tests cachés (07-11 : ${barre.reference_absolue.caches})`, `${caches(cand)}`, `≥ ${barre.reference_absolue.caches}`, caches(cand) >= barre.reference_absolue.caches, false),
    c(`mutations (07-11 : ${pct(barre.reference_absolue.mutations)})`, pct(mut(cand)), `≥ ${pct(barre.reference_absolue.mutations)}`, mut(cand) >= barre.reference_absolue.mutations, false),
  ];
  return { vert: criteres.every((x) => x.ok || !x.bloquant), criteres };
}

const okRouge = (x: boolean | null | undefined) => (x === null || x === undefined ? '–' : x ? 'ok' : 'ROUGE');

/** `niveau` (L689) : micro ou mécanique ; `depot` : le dépôt dont le banc a lancé le code ; `duree_s` : durée du passage entier. */
export function rapport(res: ResultatBanc[], ref: string, cand: string, v: Verdict, e: { date: string; empreinte: string; repetitions?: number; eclair?: string[]; niveau?: string; depot?: string; duree_s?: number }): string {
  const lignes = res.map((r) => {
    const j = r.jugement; const sj = r.sans_juge; const m = (b: string) => r.mesures[b]; const deux = (f: (x: Meca) => string) => (j ? `${f(j.meca[ref])} · ${f(j.meca[cand])}` : '–');
    const sans = (f: 'suite_ok' | 'caches_ok') => (sj ? [ref, cand].map((b) => `${okRouge(sj[b]?.[f])}${sj[b]?.rejoue && sj[b].rejoue![f] === false ? ' (rejoué)' : ''}`).join(' · ') : '–');
    const prefere = j ? avisLu(j, 'prefere') : r.non_livre ? 'non mesurable' : sj ? 'sans juge' : 'non jugé';
    const caches = j ? `${j.meca[ref].caches_passes} · ${j.meca[cand].caches_passes}` : sans('caches_ok');
    const suite = j ? deux((x) => (x.suite_ok ? 'ok' : 'ROUGE')) : sans('suite_ok');
    return `| ${r.banc} | ${m(ref)?.duree_s ?? '–'} s | ${m(cand)?.duree_s ?? '–'} s | ${m(ref)?.tokens ?? '–'} | ${m(cand)?.tokens ?? '–'} | ${prefere} | ${caches} | ${j ? `${j.meca[ref].mutations_tuees}/${j.meca[ref].mutations_total} · ${j.meca[cand].mutations_tuees}/${j.meca[cand].mutations_total}` : '–'} | ${suite} | ${deux((x) => x.attendu)} | ${m(ref)?.taille_declaree ?? '–'} · ${m(cand)?.taille_declaree ?? '–'} |`;
  });
  const questions = res.flatMap((r) => [ref, cand].flatMap((b) => (r.mesures[b]?.questions_texte ?? []).map((q) => `- ${r.banc}/${b} : ${q.trim().replace(/\s*\n\s*/g, ' ')}`)));
  const lectures = res.flatMap((r) => Object.entries(r.fuites_a_verifier ?? {}).flatMap(([b, ps]) => ps.map((p) => `- ${r.banc}/${b} : ${p}`)));
  const nonLivres = res.flatMap((r) => Object.entries(r.non_livre ?? {}).map(([b, x]) => `- ${r.banc}/${b} : ${x}`));
  const rejoues = res.flatMap((r) => Object.entries(r.sans_juge ?? {}).flatMap(([b, x]) => (x.rejoue ? [`- ${r.banc}/${b} : ${x.suite_ok && x.caches_ok !== false ? 'vert' : 'ROUGE'} au rejeu seul (sous charge : suite ${okRouge(x.rejoue.suite_ok)}, tests d'origine ${okRouge(x.rejoue.caches_ok)})`] : [])));
  return [`# Banc ${e.date} — ${cand} contre ${ref} — ${titreVerdict(v)}`, '', `Empreinte de v2 : ${e.empreinte}`, `Répétitions : ${e.repetitions ?? 1}`,
    ...(e.niveau ? [`Niveau : ${e.niveau}, sans juge IA (n'autorise pas la publication)`] : []),
    ...(e.depot ? [`Dépôt mesuré : ${e.depot}`] : []),
    ...(e.duree_s !== undefined ? [`Durée du passage : ${e.duree_s} s`] : []), '',
    `| Banc | Temps ${ref} | Temps ${cand} | Tokens ${ref} | Tokens ${cand} | Préféré | Cachés ${ref} · ${cand} | Mutations ${ref} · ${cand} | Suite ${ref} · ${cand} | Attendu ${ref} · ${cand} | Taille déclarée ${ref} · ${cand} |`,
    '|---|---|---|---|---|---|---|---|---|---|---|', ...lignes, '', '| Critère | Valeur | Seuil | Résultat |', '|---|---|---|---|',
    ...v.criteres.map((c) => `| ${c.nom} | ${c.valeur} | ${c.seuil} | ${c.ok ? 'ok' : c.bloquant ? '**ROUGE**' : c.nom === 'bras qui ont livré le travail' ? '**non livré**' : 'en dessous (indicatif)'} |`), '',
    ...(rejoues.length ? ['## Suites rejouées', '', 'Rouge pendant que les autres bancs tournaient, rejouée seule après eux : le rejeu compte (L734).', '', ...rejoues, ''] : []),
    ...(nonLivres.length ? ['## Bancs non mesurables', '', 'Un bras n\'a livré aucun fichier hors plan et doc : son temps ne compte pas, ni en victoire ni en défaite. Rejouer le passage.', '', ...nonLivres, ''] : []),
    ...(e.eclair ? ['## Contrôles éclair', '', ...e.eclair.map((l) => `- ${l}`), ''] : []),
    ...[['Lectures à vérifier', lectures], ['Questions posées', questions]].flatMap(([t, l]) => (l.length ? [`## ${t}`, '', ...l, ''] : []))].join('\n');
}

export const ligneHistorique = (v: Verdict, e: { type?: 'sequence'; sequence?: string; run?: string; repetition?: number; repetitions?: number; date: string; empreinte: string; candidat: string; reference: string; modele_candidat: string; bancs: string[]; hebdo: boolean; frais: number; eclair_ok?: boolean;
  niveau?: string; duree_s?: number }) =>
  JSON.stringify({ ...e, vert: v.vert, rouges: v.criteres.filter((c) => c.bloquant && !c.ok).map((c) => c.nom), ...(v.non_mesurable && { non_mesurable: v.non_mesurable }) });

const PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Jour civil (AAAA-MM-JJ), heure (HHMM) et jour de semaine (0 = dimanche) à Paris. */
export function parisJour(d: Date): { jour: string; hhmm: string; sem: number } {
  const p = Object.fromEntries(PARIS.formatToParts(d).map((x) => [x.type, x.value]));
  return { jour: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}${p.minute}`, sem: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Jour civil parisien du samedi de la semaine du banc : le samedi passé, ou aujourd'hui si on est samedi. */
function samediCourant(d: Date): string {
  const { jour, sem } = parisJour(d);
  const [y, m, j] = jour.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, j - ((sem + 1) % 7))).toISOString().slice(0, 10);
}

type Ligne = { type?: string; sequence?: string; run?: string; repetition?: number; repetitions?: number; date: string; empreinte: string; vert: boolean; hebdo: boolean; frais: number; bancs?: string[]; candidat?: string; reference?: string; modele_candidat?: string; eclair_ok?: boolean;
  niveau?: string; rouges?: string[]; non_mesurable?: string[] };

/** Au moins une séquence ; pour chaque id, de la première ligne de son dernier run à la fin, toutes les lignes passent `ok` et le run compte exactement `repetitions` lignes (répétition 1..N). */
function seqOk(seqs: Ligne[], ok: (s: Ligne) => boolean): boolean {
  const ids = [...new Set(seqs.map((x) => x.sequence ?? ''))];
  return ids.length > 0 && ids.every((id) => {
    const l = seqs.filter((x) => (x.sequence ?? '') === id);
    const run = l.at(-1)!.run, n = l.at(-1)!.repetitions, d = l.filter((x) => x.run === run); // exactement N lignes, répétitions 1..N : une répétition tuée n'écrit rien
    return run !== undefined && l.slice(l.findIndex((x) => x.run === run)).every(ok) && Number.isInteger(n) && n! >= 1 && d.length === n && d.every((x) => x.repetitions === n && x.repetition! >= 1 && x.repetition! <= n) && new Set(d.map((x) => x.repetition)).size === n;
  });
}

const couvreCourt = (x: Ligne) => ['1', '3', '6'].every((n) => (x.bancs ?? []).some((id) => banBase(id).split('-')[0] === n));
/** Un passage du banc complet (L730) : banc avec juges couvrant 1, 3 et 6, ou ligne de séquence ; ni micro, ni mécanique, ni éclair. */
const duComplet = (x: Ligne) => x.type === 'sequence' || (!x.niveau && x.eclair_ok === undefined && couvreCourt(x));
/** Au-delà, le banc complet du samedi n'a pas tourné : la garde proportionnée n'a plus de filet (L730). */
export const COMPLET_MAX_JOURS = 8;
/** Mise en service de la garde proportionnée (L730, décision de Sylvain du 15-11) : le 15-11 à 00:00, heure de Paris. Les rouges d'avant ont déjà
 * été arbitrés (2.0.3 à 2.0.8 publiées sur dossier) : la règle 1 ne les compte pas. Une constante, pas un réglage. */
export const GARDE_DEPUIS = '2026-11-15T00:00:00+01:00';

/**
 * Garde de publication en quatre règles (L730, D-22 ; tableau dans docs/v2/banc.md, « Garde en quatre règles », section « Garde proportionnée »). Seule fonction qui porte ces règles :
 * (1) une alerte naît de chaque passage rouge du banc complet, cadence-run contre A : le banc court, ou une séquence identifiée par son id ;
 *     seulement à partir de GARDE_DEPUIS (les rouges d'avant sont déjà arbitrés) ;
 * (2) elle tombe lorsque CE banc (le court, ou CETTE séquence) est rejoué vert après elle (ordre de l'historique), sur la version corrigée ou une
 *     suivante ; levée, elle le reste pour toutes les empreintes suivantes (revue 3 : sinon chaque publication après un rouge redemanderait le complet) ;
 * (3) tant qu'une alerte tient, la publication est refusée, quel que soit le reste (mécanique vert, banc complet vert sans le banc rouge) ;
 * (4) hors alerte, le banc mécanique vert de l'empreinte suffit, et un banc complet vert aussi.
 */
function gardeEnQuatreRegles(h: Ligne[], empreinte: string, reel: (m: Ligne | undefined) => m is Ligne, publie?: { candidat: string; reference: string }) {
  const miennes = h.filter((x) => x.empreinte === empreinte);
  // Banc complet (C-1 pour chacun) : le DERNIER passage court de l'empreinte couvrant 1, 3 et 6 est vert, mesure un vrai candidat avec le modèle
  // du bras.yaml courant, et aucun passage court rouge de cette empreinte (éclair compris) ne le suit ; pour CHAQUE id de séquence de l'empreinte
  // (R30), toutes les lignes de son dernier run (répétitions) et toutes celles qui suivent sont vertes et réelles, même candidat et modèle.
  const courts = miennes.filter((x) => x.type !== 'sequence' && !x.niveau); // un banc micro ou mécanique ne compte pas ici
  const i = courts.map(couvreCourt).lastIndexOf(true);
  const m = courts[i], seqs = miennes.filter((x) => x.type === 'sequence');
  const completOk = reel(m) && !courts.slice(i).some((x) => !x.vert || x.eclair_ok === false)
    && seqOk(seqs, (s) => reel(s) && s.vert && s.candidat === m.candidat && s.modele_candidat === m.modele_candidat);
  // Banc mécanique : le DERNIER passage mécanique de l'empreinte couvrant 1, 3 et 6 est vert et réel, et aucun passage rouge de cette
  // empreinte, quel qu'il soit (micro, mécanique, court, éclair, séquence), ne le suit.
  const j = miennes.map((x) => x.niveau === 'mecanique' && couvreCourt(x)).lastIndexOf(true);
  const mecaOk = reel(miennes[j]) && !miennes.slice(j).some((x) => !x.vert || x.eclair_ok === false);
  // (1) chaque rouge du banc complet ; (2) rejoué : un court vert et réel écrit après lui, ou un run complet et vert de la MÊME séquence écrit après
  // lui, sur n'importe quelle empreinte ; un vert d'avant le rouge ne compte pas, ni un court et une séquence X verts pour une séquence Y (revues L730).
  const rouges = h.filter((x) => duComplet(x) && !x.vert && Date.parse(x.date) >= Date.parse(GARDE_DEPUIS) && (!publie || (x.candidat === publie.candidat && x.reference === publie.reference)));
  const rejoue = (rg: Ligne): boolean => {
    const apres = h.slice(h.indexOf(rg) + 1).filter(duComplet);
    return rg.type === 'sequence'
      ? seqOk(apres.filter((y) => y.type === 'sequence' && (y.sequence ?? '') === (rg.sequence ?? '')), (s) => reel(s) && s.vert)
      : apres.some((y) => y.type !== 'sequence' && reel(y) && y.vert);
  };
  const enAttente = rouges.filter((rg) => !rejoue(rg));
  // (3) et (4)
  return { enAttente, publication_ok: empreinte !== 'inconnue' && enAttente.length === 0 && (mecaOk || completOk) };
}

/** Ce qu'une alerte demande de rejouer : « court », ou « sequence <id> ». */
const quoi = (x: Ligne) => (x.type === 'sequence' ? `séquence ${x.sequence ?? '?'}` : 'banc court');

/**
 * Garde de publication. `modeles` : nom du bras -> modèle, lus dans le bras.yaml courant (le modèle n'est pas dans l'empreinte). `publie` (L689) :
 * candidat et référence exigés (la CLI passe PUBLIE) ; sans lui, tout candidat distinct de sa référence.
 * L730 (D-22, Sylvain du 14-11 : 3 h de banc avant chaque publication, « complètement dingue ») : la garde est proportionnée, selon `gardeEnQuatreRegles`.
 * `alerte` (signalée par `statut` et le tour) nomme le dernier rouge en attente et les autres ; `a_rejouer` dit quoi rejouer (sur la version corrigée) ;
 * `mode` vaut `complet` tant qu'une alerte tient.
 */
export function statut(historique: string[], maintenant: Date, empreinte: string, modeles: Record<string, string> = {}, publie?: { candidat: string; reference: string }) {
  const lues = historique.flatMap((l) => { // une ligne illisible ou sans date valide est sautée, jamais levée
    try { const x = JSON.parse(l) as Ligne; return typeof x?.date === 'string' && !Number.isNaN(Date.parse(x.date)) ? [x] : []; } catch { return []; }
  });
  const h = lues.filter((x) => !x.non_mesurable?.length); // L733 : un passage non mesurable n'est ni vert ni rouge pour la garde
  const sam = samediCourant(maintenant);
  const depuisSamedi = h.filter((x) => parisJour(new Date(x.date)).jour >= sam);
  const dernier = lues.at(-1);
  const reel = (m: Ligne | undefined): m is Ligne => m !== undefined && typeof m.reference === 'string' && m.candidat !== m.reference
    && typeof m.modele_candidat === 'string' && modeles[m.candidat ?? ''] === m.modele_candidat
    && (!publie || (m.candidat === publie.candidat && m.reference === publie.reference));
  const { enAttente, publication_ok } = gardeEnQuatreRegles(h, empreinte, reel, publie);
  const rouge = enAttente.at(-1);
  const autres = [...new Set(enAttente.slice(0, -1).map(quoi))].filter((q) => !rouge || q !== quoi(rouge));
  const alerte = rouge ? `banc complet rouge le ${parisJour(new Date(rouge.date)).jour} sur l'empreinte ${rouge.empreinte} (${quoi(rouge)}${rouge.rouges?.length ? ` : ${rouge.rouges.join(', ')}` : ''})${autres.length ? ` ; aussi rouge depuis : ${autres.join(', ')}` : ''}` : undefined;
  const dernierComplet = h.filter((x) => duComplet(x) && (!publie || (x.candidat === publie.candidat && x.reference === publie.reference))).at(-1);
  return {
    dernier: dernier ? `${dernier.date} ${dernier.type === 'sequence' ? 'séquence ' : ''}${dernier.niveau ? `${dernier.niveau} ` : ''}${dernier.non_mesurable?.length ? 'non mesurable' : dernier.vert ? 'vert' : 'rouge'} (${dernier.empreinte})` : undefined,
    mode: (alerte ? 'complet' : 'mecanique') as 'complet' | 'mecanique',
    alerte,
    /** Bancs à rejouer verts, après le rouge (version corrigée ou suivante), pour lever l'alerte : `court`, ou `sequence <id>`, dans l'ordre des rouges. */
    a_rejouer: [...new Set(enAttente.map((x) => (x.type === 'sequence' ? `sequence ${x.sequence ?? ''}` : 'court')))],
    /** Jours depuis le dernier passage du banc complet, null s'il n'a jamais tourné (le minuteur du samedi a pu être manqué). */
    jours_depuis_complet: dernierComplet ? Math.floor((maintenant.getTime() - Date.parse(dernierComplet.date)) / 86_400_000) : null,
    publication_ok,
    frais_semaine: somme(depuisSamedi.map((x) => x.frais ?? 0)),
  };
}
