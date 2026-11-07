import type { Taille } from './banc.js';
import type { Mesure } from './bras.js';
import type { Jugement, Meca } from './juges.js';

export interface ResultatBanc { banc: string; taille: Taille; visible: boolean; reponses: boolean; frais: boolean;
  mesures: Record<string, Mesure>; jugement: Jugement | null; fuites: Record<string, string[]> }
export interface Barre { temps_max: number; temps_max_retouche: number; reference_absolue: { caches: number; mutations: number } }
export interface Critere { nom: string; valeur: string; seuil: string; ok: boolean; bloquant: boolean }
export interface Verdict { vert: boolean; criteres: Critere[] }

export const BARRE_SPEC: Barre = { temps_max: 1.5, temps_max_retouche: 1.2, reference_absolue: { caches: 304, mutations: 0.79 } };

const somme = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => `${Math.round(x * 100)} %`;

/** Banc de base d'un id de répétition `<banc>#k`. */
export const banBase = (id: string): string => (id.includes('#') ? id.slice(0, id.lastIndexOf('#')) : id);

/** Avis par banc de base : les répétitions comptent une fois, et seulement si toutes sont jugées et s'accordent ; sinon « egal ». */
function avisParBanc(res: ResultatBanc[], champ: 'prefere' | 'ui'): { id: string; val: string; label: string }[] {
  const groupes = new Map<string, ResultatBanc[]>();
  res.forEach((r, i) => { const k = r.banc.includes('#') ? banBase(r.banc) : `\0${i}`; groupes.set(k, [...(groupes.get(k) ?? []), r]); });
  return [...groupes.values()].map((rs) => {
    const id = banBase(rs[0].banc); const a = rs.map((r) => r.jugement?.[champ]);
    if (a.some((x) => x === undefined)) return { id, val: 'egal', label: 'égal (non jugé)' };
    if (a.some((x) => x !== a[0])) return { id, val: 'egal', label: 'égal (désaccord)' };
    return { id, val: a[0]!, label: a[0] === 'egal' ? 'égal' : a[0]! };
  });
}
const detail = (av: { id: string; label: string }[]) => av.map((x) => `${x.id} : ${x.label}`).join(' · ');

export function verdict(res: ResultatBanc[], ref: string, cand: string, barre: Barre): Verdict {
  const jug = res.filter((r) => r.jugement).map((r) => r.jugement!);
  const t = (rs: ResultatBanc[], b: string) => somme(rs.map((r) => r.mesures[b]?.duree_s ?? 0));
  const ret = res.filter((r) => r.taille === 'retouche');
  const caches = (b: string) => somme(jug.map((j) => j.meca[b].caches_passes));
  const mut = (b: string) => somme(jug.map((j) => j.meca[b].mutations_tuees)) / Math.max(1, somme(jug.map((j) => j.meca[b].mutations_total)));
  const def = (b: string) => somme(jug.map((j) => j.defauts[b].bloquants + j.defauts[b].majeurs));
  const prefs = avisParBanc(res, 'prefere'); const uis = avisParBanc(res, 'ui');
  const prefCand = prefs.filter((p) => p.val !== ref).length;
  const ui = (b: string) => uis.filter((u) => u.val === b).length;
  const inutiles = somme(res.filter((r) => !r.reponses).map((r) => r.mesures[cand]?.questions ?? 0));
  const fuites = res.flatMap((r) => Object.entries(r.fuites).flatMap(([b, ps]) => ps.map((p) => `${r.banc}/${b} : ${p}`)));
  const echecs = res.flatMap((r) => [ref, cand].flatMap((b) => { const e = r.mesures[b]?.echec; return e ? [`${r.banc}/${b} : ${e}`] : []; }));
  const manquants = res.flatMap((r) => [ref, cand].filter((b) => !r.mesures[b]).map((b) => `${r.banc}/${b}`));
  const total = (b: string) => somme(jug.map((j) => j.meca[b].mutations_total));
  const sansMutation = jug.length > 0 && (total(ref) === 0 || total(cand) === 0);
  const c = (nom: string, valeur: string, seuil: string, ok: boolean, bloquant = true): Critere => ({ nom, valeur, seuil, ok, bloquant });
  const criteres: Critere[] = [
    c('au moins un banc', `${res.length}`, '≥ 1', res.length >= 1),
    c('mesures complètes', manquants.length ? manquants.join(' ; ') : 'toutes', 'toutes', manquants.length === 0),
    c('tous les bancs jugés', `${jug.length}/${res.length} répétitions`, 'tous', jug.length === res.length),
    c('aucune fuite', fuites.length ? fuites.join(' ; ') : '0', '0', fuites.length === 0),
    c('aucun bras en échec', echecs.length ? echecs.join(' ; ') : '0', '0', echecs.length === 0),
    c('relecture aveugle', `${prefCand}/${prefs.length} bancs de base sans préférence pour ${ref} (${detail(prefs)})`, '> la moitié', prefs.length === 0 || prefCand * 2 > prefs.length),
    c('tests cachés', `${caches(cand)} contre ${caches(ref)}`, `≥ ${ref}`, caches(cand) >= caches(ref)),
    c('mutations tuées', sansMutation ? 'aucune mutation jouée' : `${pct(mut(cand))} contre ${pct(mut(ref))}`, `≥ ${ref}`, !sansMutation && mut(cand) >= mut(ref)),
    c('défauts bloquants et majeurs', `${def(cand)} contre ${def(ref)}`, `≤ ${ref}`, def(cand) <= def(ref)),
    c('cohérence UI', `${ui(cand)} contre ${ui(ref)} (${detail(uis)})`, `≥ ${ref}`, ui(cand) >= ui(ref)),
    c('temps total', `${t(res, cand)} s contre ${t(res, ref)} s`, `≤ ${barre.temps_max} × ${ref}`, t(res, cand) <= barre.temps_max * t(res, ref)),
    c('temps des retouches', ret.length ? `${t(ret, cand)} s contre ${t(ret, ref)} s` : 'aucun banc de retouche', `≤ ${barre.temps_max_retouche} × ${ref}`, !ret.length || t(ret, cand) <= barre.temps_max_retouche * t(ret, ref), ret.length > 0),
    c('questions inutiles', `${inutiles}`, '0', inutiles === 0),
    c(`tests cachés (07-11 : ${barre.reference_absolue.caches})`, `${caches(cand)}`, `≥ ${barre.reference_absolue.caches}`, caches(cand) >= barre.reference_absolue.caches, false),
    c(`mutations (07-11 : ${pct(barre.reference_absolue.mutations)})`, pct(mut(cand)), `≥ ${pct(barre.reference_absolue.mutations)}`, mut(cand) >= barre.reference_absolue.mutations, false),
  ];
  return { vert: criteres.every((x) => x.ok || !x.bloquant), criteres };
}

export function rapport(res: ResultatBanc[], ref: string, cand: string, v: Verdict, e: { date: string; empreinte: string; repetitions?: number; eclair?: string[] }): string {
  const lignes = res.map((r) => {
    const j = r.jugement; const m = (b: string) => r.mesures[b]; const deux = (f: (x: Meca) => string) => (j ? `${f(j.meca[ref])} · ${f(j.meca[cand])}` : '–');
    return `| ${r.banc} | ${m(ref)?.duree_s ?? '–'} s | ${m(cand)?.duree_s ?? '–'} s | ${m(ref)?.tokens ?? '–'} | ${m(cand)?.tokens ?? '–'} | ${j?.prefere ?? 'non jugé'} | ${j ? `${j.meca[ref].caches_passes} · ${j.meca[cand].caches_passes}` : '–'} | ${j ? `${j.meca[ref].mutations_tuees}/${j.meca[ref].mutations_total} · ${j.meca[cand].mutations_tuees}/${j.meca[cand].mutations_total}` : '–'} | ${deux((x) => (x.suite_ok ? 'ok' : 'ROUGE'))} | ${deux((x) => x.attendu)} |`;
  });
  const questions = res.flatMap((r) => [ref, cand].flatMap((b) => (r.mesures[b]?.questions_texte ?? []).map((q) => `- ${r.banc}/${b} : ${q.trim().replace(/\s*\n\s*/g, ' ')}`)));
  return [`# Banc ${e.date} — ${cand} contre ${ref} — ${v.vert ? 'VERT' : 'ROUGE'}`, '', `Empreinte de v2 : ${e.empreinte}`, `Répétitions : ${e.repetitions ?? 1}`, '',
    `| Banc | Temps ${ref} | Temps ${cand} | Tokens ${ref} | Tokens ${cand} | Préféré | Cachés ${ref} · ${cand} | Mutations ${ref} · ${cand} | Suite ${ref} · ${cand} | Attendu ${ref} · ${cand} |`,
    '|---|---|---|---|---|---|---|---|---|---|', ...lignes, '', '| Critère | Valeur | Seuil | Résultat |', '|---|---|---|---|',
    ...v.criteres.map((c) => `| ${c.nom} | ${c.valeur} | ${c.seuil} | ${c.ok ? 'ok' : c.bloquant ? '**ROUGE**' : 'en dessous (indicatif)'} |`), '',
    ...(e.eclair ? ['## Contrôles éclair', '', ...e.eclair.map((l) => `- ${l}`), ''] : []),
    ...(questions.length ? ['## Questions posées', '', ...questions, ''] : [])].join('\n');
}

export const ligneHistorique = (v: Verdict, e: { date: string; empreinte: string; candidat: string; reference: string; modele_candidat: string; bancs: string[]; hebdo: boolean; frais: number; eclair_ok?: boolean }) =>
  JSON.stringify({ ...e, vert: v.vert, rouges: v.criteres.filter((c) => c.bloquant && !c.ok).map((c) => c.nom) });

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

type Ligne = { date: string; empreinte: string; vert: boolean; hebdo: boolean; frais: number; bancs?: string[]; candidat?: string; reference?: string; modele_candidat?: string; eclair_ok?: boolean };

/** `modeles` : nom du bras -> modèle, lus dans le bras.yaml courant (le modèle n'est pas dans l'empreinte). */
export function statut(historique: string[], maintenant: Date, empreinte: string, modeles: Record<string, string> = {}) {
  const h = historique.filter(Boolean).map((l) => JSON.parse(l) as Ligne);
  const sam = samediCourant(maintenant);
  const enWeekend = [6, 0].includes(parisJour(maintenant).sem);
  const depuisSamedi = h.filter((x) => parisJour(new Date(x.date)).jour >= sam);
  const dernier = h.at(-1);
  // Publication : le DERNIER passage de l'empreinte couvrant 1, 3 et 6 est vert, mesure un vrai candidat avec le modèle du bras.yaml
  // courant, et aucun passage rouge de cette empreinte (éclair compris) ne le suit.
  const miennes = h.filter((x) => x.empreinte === empreinte);
  const i = miennes.map((x) => ['1', '3', '6'].every((n) => (x.bancs ?? []).some((id) => banBase(id).split('-')[0] === n))).lastIndexOf(true);
  const m = miennes[i];
  return {
    dernier: dernier ? `${dernier.date} ${dernier.vert ? 'vert' : 'rouge'} (${dernier.empreinte})` : undefined,
    banc_du_weekend: enWeekend || depuisSamedi.some((x) => x.hebdo),
    publication_ok: empreinte !== 'inconnue' && m !== undefined && typeof m.reference === 'string' && m.candidat !== m.reference
      && typeof m.modele_candidat === 'string' && modeles[m.candidat ?? ''] === m.modele_candidat
      && !miennes.slice(i).some((x) => !x.vert || x.eclair_ok === false),
    frais_semaine: somme(depuisSamedi.map((x) => x.frais ?? 0)),
  };
}
