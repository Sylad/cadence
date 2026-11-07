import type { Taille } from './banc.js';
import type { Mesure } from './bras.js';
import type { Jugement } from './juges.js';

export interface ResultatBanc { banc: string; taille: Taille; visible: boolean; reponses: boolean; frais: boolean;
  mesures: Record<string, Mesure>; jugement: Jugement | null; fuites: Record<string, string[]> }
export interface Barre { temps_max: number; temps_max_retouche: number; reference_absolue: { caches: number; mutations: number } }
export interface Critere { nom: string; valeur: string; seuil: string; ok: boolean; bloquant: boolean }
export interface Verdict { vert: boolean; criteres: Critere[] }

export const BARRE_SPEC: Barre = { temps_max: 1.5, temps_max_retouche: 1.2, reference_absolue: { caches: 304, mutations: 0.79 } };

const somme = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => `${Math.round(x * 100)} %`;

export function verdict(res: ResultatBanc[], ref: string, cand: string, barre: Barre): Verdict {
  const jug = res.filter((r) => r.jugement).map((r) => r.jugement!);
  const t = (rs: ResultatBanc[], b: string) => somme(rs.map((r) => r.mesures[b]?.duree_s ?? 0));
  const ret = res.filter((r) => r.taille === 'retouche');
  const caches = (b: string) => somme(jug.map((j) => j.meca[b].caches_passes));
  const mut = (b: string) => somme(jug.map((j) => j.meca[b].mutations_tuees)) / Math.max(1, somme(jug.map((j) => j.meca[b].mutations_total)));
  const def = (b: string) => somme(jug.map((j) => j.defauts[b].bloquants + j.defauts[b].majeurs));
  const prefCand = jug.filter((j) => j.prefere !== ref).length;
  const ui = (b: string) => jug.filter((j) => j.ui === b).length;
  const inutiles = somme(res.filter((r) => !r.reponses).map((r) => r.mesures[cand]?.questions ?? 0));
  const fuites = res.flatMap((r) => r.fuites[cand] ?? []);
  const echecs = res.flatMap((r) => [ref, cand].flatMap((b) => { const e = r.mesures[b]?.echec; return e ? [`${r.banc}/${b} : ${e}`] : []; }));
  const manquants = res.flatMap((r) => [ref, cand].filter((b) => !r.mesures[b]).map((b) => `${r.banc}/${b}`));
  const total = (b: string) => somme(jug.map((j) => j.meca[b].mutations_total));
  const sansMutation = jug.length > 0 && (total(ref) === 0 || total(cand) === 0);
  const c = (nom: string, valeur: string, seuil: string, ok: boolean, bloquant = true): Critere => ({ nom, valeur, seuil, ok, bloquant });
  const criteres: Critere[] = [
    c('au moins un banc', `${res.length}`, '≥ 1', res.length >= 1),
    c('mesures complètes', manquants.length ? manquants.join(' ; ') : 'toutes', 'toutes', manquants.length === 0),
    c('tous les bancs jugés', `${jug.length}/${res.length}`, 'tous', jug.length === res.length),
    c('aucune fuite', `${fuites.length}`, '0', fuites.length === 0),
    c('aucun bras en échec', echecs.length ? echecs.join(' ; ') : '0', '0', echecs.length === 0),
    c('relecture aveugle', `${prefCand}/${jug.length} sans préférence pour ${ref}`, '> la moitié', jug.length === 0 || prefCand * 2 > jug.length),
    c('tests cachés', `${caches(cand)} contre ${caches(ref)}`, `≥ ${ref}`, caches(cand) >= caches(ref)),
    c('mutations tuées', sansMutation ? 'aucune mutation jouée' : `${pct(mut(cand))} contre ${pct(mut(ref))}`, `≥ ${ref}`, !sansMutation && mut(cand) >= mut(ref)),
    c('défauts bloquants et majeurs', `${def(cand)} contre ${def(ref)}`, `≤ ${ref}`, def(cand) <= def(ref)),
    c('cohérence UI', `${ui(cand)} contre ${ui(ref)}`, `≥ ${ref}`, ui(cand) >= ui(ref)),
    c('temps total', `${t(res, cand)} s contre ${t(res, ref)} s`, `≤ ${barre.temps_max} × ${ref}`, t(res, cand) <= barre.temps_max * t(res, ref)),
    c('temps des retouches', ret.length ? `${t(ret, cand)} s contre ${t(ret, ref)} s` : 'aucun banc de retouche', `≤ ${barre.temps_max_retouche} × ${ref}`, !ret.length || t(ret, cand) <= barre.temps_max_retouche * t(ret, ref), ret.length > 0),
    c('questions inutiles', `${inutiles}`, '0', inutiles === 0),
    c(`tests cachés (07-11 : ${barre.reference_absolue.caches})`, `${caches(cand)}`, `≥ ${barre.reference_absolue.caches}`, caches(cand) >= barre.reference_absolue.caches, false),
    c(`mutations (07-11 : ${pct(barre.reference_absolue.mutations)})`, pct(mut(cand)), `≥ ${pct(barre.reference_absolue.mutations)}`, mut(cand) >= barre.reference_absolue.mutations, false),
  ];
  return { vert: criteres.every((x) => x.ok || !x.bloquant), criteres };
}

export function rapport(res: ResultatBanc[], ref: string, cand: string, v: Verdict, e: { date: string; empreinte: string }): string {
  const lignes = res.map((r) => {
    const j = r.jugement; const m = (b: string) => r.mesures[b];
    return `| ${r.banc} | ${m(ref)?.duree_s ?? '–'} s | ${m(cand)?.duree_s ?? '–'} s | ${m(ref)?.tokens ?? '–'} | ${m(cand)?.tokens ?? '–'} | ${j?.prefere ?? 'non jugé'} | ${j ? `${j.meca[ref].caches_passes} · ${j.meca[cand].caches_passes}` : '–'} | ${j ? `${j.meca[ref].mutations_tuees}/${j.meca[ref].mutations_total} · ${j.meca[cand].mutations_tuees}/${j.meca[cand].mutations_total}` : '–'} |`;
  });
  const questions = res.flatMap((r) => [ref, cand].flatMap((b) => (r.mesures[b]?.questions_texte ?? []).map((q) => `- ${r.banc}/${b} : ${q.trim().replace(/\s*\n\s*/g, ' ')}`)));
  return [`# Banc ${e.date} — ${cand} contre ${ref} — ${v.vert ? 'VERT' : 'ROUGE'}`, '', `Empreinte de v2 : ${e.empreinte}`, '',
    `| Banc | Temps ${ref} | Temps ${cand} | Tokens ${ref} | Tokens ${cand} | Préféré | Cachés ${ref} · ${cand} | Mutations ${ref} · ${cand} |`,
    '|---|---|---|---|---|---|---|---|', ...lignes, '', '| Critère | Valeur | Seuil | Résultat |', '|---|---|---|---|',
    ...v.criteres.map((c) => `| ${c.nom} | ${c.valeur} | ${c.seuil} | ${c.ok ? 'ok' : c.bloquant ? '**ROUGE**' : 'en dessous (indicatif)'} |`), '',
    ...(questions.length ? ['## Questions posées', '', ...questions, ''] : [])].join('\n');
}

export const ligneHistorique = (v: Verdict, e: { date: string; empreinte: string; candidat: string; bancs: string[]; hebdo: boolean; frais: number }) =>
  JSON.stringify({ ...e, vert: v.vert, rouges: v.criteres.filter((c) => c.bloquant && !c.ok).map((c) => c.nom) });

const PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
/** Jour civil (AAAA-MM-JJ) et jour de semaine (0 = dimanche) à Paris. */
function parisJour(d: Date): { jour: string; sem: number } {
  const p = Object.fromEntries(PARIS.formatToParts(d).map((x) => [x.type, x.value]));
  return { jour: `${p.year}-${p.month}-${p.day}`, sem: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Jour civil parisien du samedi de la semaine du banc : le samedi passé, ou aujourd'hui si on est samedi. */
function samediCourant(d: Date): string {
  const { jour, sem } = parisJour(d);
  const [y, m, j] = jour.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, j - ((sem + 1) % 7))).toISOString().slice(0, 10);
}

export function statut(historique: string[], maintenant: Date, empreinte: string) {
  const h = historique.filter(Boolean).map((l) => JSON.parse(l) as { date: string; empreinte: string; vert: boolean; hebdo: boolean; frais: number });
  const sam = samediCourant(maintenant);
  const enWeekend = [6, 0].includes(parisJour(maintenant).sem);
  const depuisSamedi = h.filter((x) => parisJour(new Date(x.date)).jour >= sam);
  const dernier = h.at(-1);
  return {
    dernier: dernier ? `${dernier.date} ${dernier.vert ? 'vert' : 'rouge'} (${dernier.empreinte})` : undefined,
    banc_du_weekend: enWeekend || depuisSamedi.some((x) => x.hebdo),
    publication_ok: h.some((x) => x.vert && x.empreinte === empreinte),
    frais_semaine: somme(depuisSamedi.map((x) => x.frais ?? 0)),
  };
}
