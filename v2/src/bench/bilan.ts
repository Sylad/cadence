// L912 (D-40) : à quoi sert le banc. Chaque rouge d'un passage est classé « régression réelle » (corrigée ensuite par un commit de v2/ hors de
// l'instrument de mesure) ou « bruit » (charge, réseau ou amont, rejoué vert sans changement, banc lui-même corrigé) ; `bench bilan` en fait le compte
// sur 4 semaines. Vécu du 27-11 : 2 rouges sur 3 bancs mécaniques dus à la charge (247 s contre 188), aucune régression.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../cli.js';
import { chargeHaute, type Charge } from './charge.js';
import { empreinteArbres } from './cli.js'; // appelé à l'exécution seulement : le cycle cli.ts ↔ bilan.ts est sans effet au chargement
import { datePassage, parisJour, type ResultatBanc, type Verdict } from './verdict.js';

/** « régression présumée » (revue L912) : le vert qui clôt le rouge suit trop de commits du noyau, ou arrive trop tard, pour en nommer la correction ; comptée à part, jamais avec les réelles. */
export type Classe = 'régression réelle' | 'régression présumée' | 'bruit' | 'non tranché';
/** `commits` : pour une régression (réelle ou présumée), les commits de v2/ hors du banc entre le rouge et le vert (sha court et sujet). */
/** `vert` : le rapport du vert qui clôt une régression, pour la compter une fois par vert. */
export interface Classement { classe: Classe; cause: string; commits?: string[]; vert?: string }

/** Les critères de temps : sous la charge, ils ne mesurent rien (L911). */
export const CRITERES_TEMPS = ['temps total', 'temps des retouches'];
/** L'instrument de mesure (banc, banc séquence, aide et aiguillage de cadence2) : un rouge corrigé par ces seuls fichiers était un défaut du banc, pas de cadence. */
export const INSTRUMENT = ['v2/src/bench/', 'v2/src/sequence/', 'v2/src/cli.ts'];
const instrument = (f: string) => INSTRUMENT.some((x) => f.startsWith(x));
/** Au-delà de ces commits du noyau, ou de ce délai entre le rouge et le vert, la correction n'est qu'une présomption (revue L912 : 22 rouges « réels » sur 4 à 48 commits, du 07-11 au 14-11). */
export const MAX_COMMITS_REELLE = 3;
export const MAX_HEURES_REELLE = 24;
/** Échec d'un bras dû au réseau ou à l'amont (API, quota), pas au code mesuré. */
const RESEAU = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|overloaded|rate.?limit|API Error|\b(429|529)\b|réseau|network/i;
const A_TRANCHER = 'à trancher par « cadence2 bench bilan » : régression réelle si un commit de v2/ hors du banc le corrige, bruit s\'il repasse vert sans changement';

/** Le premier échec de bras dû au réseau ou à l'amont, ou null. */
export function echecReseau(res: ResultatBanc[]): string | null {
  for (const r of res) for (const m of Object.values(r.mesures ?? {})) if (m.echec && RESEAU.test(m.echec)) return `${r.banc}/${m.bras} : ${m.echec.slice(0, 120)}`;
  return null;
}

/** Au passage : ce qu'on sait déjà de chaque rouge (charge, réseau) ; le reste attend la suite de l'historique. */
export function classerAuPassage(v: Verdict, res: ResultatBanc[]): Record<string, Classement> {
  const reseau = echecReseau(res), cl: Record<string, Classement> = {};
  for (const c of v.criteres) {
    if (c.non_mesurable && !c.ok) cl[c.nom] = { classe: 'bruit', cause: `non mesurable (${c.non_mesurable})` };
    else if (c.bloquant && !c.ok) cl[c.nom] = reseau ? { classe: 'bruit', cause: `réseau ou amont (${reseau})` } : { classe: 'non tranché', cause: A_TRANCHER };
  }
  return cl;
}

/** La section du rapport d'un passage (vide sans rouge ni temps non mesurable). */
export const lignesClassement = (cl: Record<string, Classement>): string[] => (Object.keys(cl).length
  ? ['## Classement des rouges (L912)', '', ...Object.entries(cl).map(([n, k]) => `- ${n} : ${k.classe} — ${k.cause}`), ''] : []);

/** Une ligne de `historique.jsonl`, ce que le bilan en lit. */
export interface Passage { type?: string; sequence?: string; run?: string; repetition?: number; niveau?: string; hebdo?: boolean; date: string; empreinte: string;
  duree_s?: number; vert: boolean; rouges?: string[]; non_mesurable?: string[]; charge_haute?: string }
/** Ce que le bilan lit du dépôt : le commit qui a fait une empreinte, et les commits de v2/ entre deux commits (fichiers touchés compris) ; null quand b ne descend pas de a. */
export interface Depot { commitDe(empreinte: string): string | undefined; commitsEntre(a: string, b: string): { commit: string; fichiers: string[] }[] | null }
/** Ce que le bilan lit d'un passage dans `rapports/` : la charge et les échecs de bras. */
export type LireRapport = (p: Passage) => { charge?: Charge; resultats?: ResultatBanc[] } | null;

/** La famille d'un passage : on ne compare un rouge qu'au vert suivant de même nature. */
export const famille = (p: Passage): string => (p.type === 'sequence' ? `séquence ${p.sequence ?? '?'}` : p.niveau ?? (p.hebdo ? 'hebdo' : 'avec juges'));

/** Le nom du rapport d'un passage (`rapports/<nom>.json`) : départ à l'heure de Paris pour un banc, run et répétition pour une séquence. */
export function nomRapport(p: Passage): string {
  if (p.type === 'sequence') return `${p.run}-${p.sequence}-r${p.repetition ?? 1}`;
  const { jour, hhmm } = parisJour(new Date(p.date));
  return `${jour}-${hhmm}-${p.empreinte}`;
}

/** Après coup : le vert suivant de la même famille et les commits entre les deux disent si le rouge était une régression ou du bruit. */
function classerParLaSuite(p: Passage, vertSuivant: Passage | undefined, depot: Depot): Classement {
  if (!vertSuivant) return { classe: 'non tranché', cause: `aucun passage vert depuis (${famille(p)})` };
  const quand = `${nomRapport(vertSuivant).slice(0, 15)}`;
  if (vertSuivant.empreinte === p.empreinte) return { classe: 'bruit', cause: `rejoué vert sans changement (${quand})` };
  const [a, b] = [depot.commitDe(p.empreinte), depot.commitDe(vertSuivant.empreinte)];
  if (!a || !b) return { classe: 'non tranché', cause: `empreinte absente de l'historique de main (${a ? vertSuivant.empreinte : p.empreinte})` };
  const commits = depot.commitsEntre(a, b);
  if (!commits) return { classe: 'non tranché', cause: `vert du ${quand} sur un commit antérieur au rouge` };
  const mesure = commits.filter((c) => c.fichiers.some((f) => !instrument(f)));
  if (!mesure.length) return { classe: 'bruit', cause: `banc corrigé : vert le ${quand} après ${commits.length} commit(s) du banc seulement (${INSTRUMENT.join(', ')})` };
  const heures = (Date.parse(vertSuivant.date) - Date.parse(p.date)) / 3_600_000;
  if (mesure.length > MAX_COMMITS_REELLE || heures > MAX_HEURES_REELLE) {
    return { classe: 'régression présumée', cause: `vert du ${quand} après ${mesure.length} commit(s) de v2/ hors du banc et ${Math.round(heures)} h : correction non nommée, à trancher dans classements.json`, commits: mesure.map((c) => c.commit), vert: nomRapport(vertSuivant) };
  }
  return { classe: 'régression réelle', cause: `corrigée avant le vert du ${quand} (${mesure.length} commit(s) de v2/ hors du banc, ${Math.round(heures)} h)`, commits: mesure.map((c) => c.commit), vert: nomRapport(vertSuivant) };
}

/** Chaque rouge d'un passage : la charge et le réseau d'abord (lus au rapport), puis la suite de l'historique. */
export function classerPassage(p: Passage, apres: Passage[], depot: Depot, lire: LireRapport): Record<string, Classement> {
  const r = lire(p);
  const charge = p.charge_haute ?? (r?.charge ? chargeHaute(r.charge) : null), reseau = r?.resultats ? echecReseau(r.resultats) : null;
  let suite: Classement | undefined;
  const parLaSuite = () => (suite ??= classerParLaSuite(p, apres.find((x) => x.vert && famille(x) === famille(p)), depot));
  return Object.fromEntries((p.rouges ?? []).map((c) => [c,
    CRITERES_TEMPS.includes(c) && charge ? { classe: 'bruit', cause: `non mesurable (${charge})` } as Classement
      : reseau ? { classe: 'bruit', cause: `réseau ou amont (${reseau})` } as Classement : parLaSuite()]));
}

/** Les rouges tranchés à la main (`classements.json` de la racine) : { "<nom du rapport>": { "<critère>" ou "*": "<classe> : <cause>" } }. */
export type Tranches = Record<string, Record<string, string>>;
const CLASSES: Classe[] = ['régression réelle', 'régression présumée', 'bruit', 'non tranché'];
/** Le classement tranché à la main d'un rouge, s'il y en a un valide ; il passe avant la règle automatique. */
export function tranche(t: Tranches | undefined, p: Passage, critere: string): Classement | undefined {
  const x = t?.[nomRapport(p)]?.[critere] ?? t?.[nomRapport(p)]?.['*'];
  const classe = CLASSES.find((c) => x?.startsWith(`${c} :`));
  return classe ? { classe, cause: `tranché à la main : ${x!.slice(classe.length + 2).trim()}` } : undefined;
}

/** Durée d'un passage : notée, ou (séquence) de son départ, lu dans le nom du run, à sa fin. */
const duree = (p: Passage): number => {
  if (p.duree_s !== undefined) return p.duree_s;
  const debut = p.run ? datePassage(p.run) : null;
  return debut ? Math.max(0, Math.round((Date.parse(p.date) - debut.getTime()) / 1000)) : 0;
};

/** Un passage A contre A (`bench bruit`) : rapport seul, hors de l'historique. */
export type PassageBruit = { run: string; duree_s: number };
export type RougeClasse = { passage: Passage; critere: string } & Classement;
export interface Bilan { depuis: Date; jusqua: Date; joues: Record<string, number>; heures: number; rouges: RougeClasse[]; nonMesurables: Passage[];
  criteres: string[] }

/** Le bilan de la fenêtre [maintenant − semaines, maintenant] ; `tous` : tout l'historique, pour trouver le vert qui suit un rouge de la fin de la fenêtre. */
export function bilan(tous: Passage[], bruits: PassageBruit[], o: { maintenant: Date; semaines: number; depot: Depot; lire: LireRapport; criteres?: string[]; tranches?: Tranches }): Bilan {
  const depuis = new Date(o.maintenant.getTime() - o.semaines * 7 * 86_400_000);
  const dans = (d: Date | null) => d !== null && d >= depuis && d <= o.maintenant;
  const fenetre = tous.filter((p) => dans(new Date(p.date)));
  const bruitsFenetre = bruits.filter((b) => dans(datePassage(b.run)));
  const joues: Record<string, number> = {};
  for (const p of fenetre) joues[famille(p)] = (joues[famille(p)] ?? 0) + 1;
  if (bruitsFenetre.length) joues['bruit (A contre A)'] = bruitsFenetre.length;
  const heures = (fenetre.reduce((s, p) => s + duree(p), 0) + bruitsFenetre.reduce((s, b) => s + b.duree_s, 0)) / 3600;
  const rouges = fenetre.flatMap((p) => Object.entries(classerPassage(p, tous.slice(tous.indexOf(p) + 1), o.depot, o.lire))
    .map(([critere, k]) => ({ passage: p, critere, ...(tranche(o.tranches, p, critere) ?? k) })));
  const criteres = [...new Set([...(o.criteres ?? []), ...rouges.map((r) => r.critere)])].sort((a, b) => a.localeCompare(b));
  return { depuis, jusqua: o.maintenant, joues, heures, rouges, nonMesurables: fenetre.filter((p) => !p.vert && !p.rouges?.length && p.non_mesurable?.length), criteres };
}

/** Les 3 premiers commits d'une correction, et combien d'autres : un vert lointain en suit des dizaines. */
const extrait = (c: string[]) => `${c.slice(0, 3).join(' ; ')}${c.length > 3 ? ` ; … et ${c.length - 3} autre(s) commit(s) de v2/` : ''}`;
const fr1 = (x: number) => x.toFixed(1).replace('.', ',');
const quand = (p: Passage) => { const { jour, hhmm } = parisJour(new Date(p.date)); return `${jour} ${hhmm.slice(0, 2)}:${hhmm.slice(2)}`; };
const compter = (l: string[]) => Object.entries(l.reduce<Record<string, number>>((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ');
const genre = (r: RougeClasse) => r.cause.replace(/ \(.*$/, '').replace(/ :.*$/, '').replace(/ le .*$/, ''); // « rejoué vert sans changement », « tranché à la main »…

/** Le bilan lisible : comptes, ce que la suite de tests seule aurait laissé passer, critères qui n'attrapent rien, puis le détail des rouges. */
export function lignesBilan(b: Bilan): string[] {
  const reels = b.rouges.filter((r) => r.classe === 'régression réelle'), bruit = b.rouges.filter((r) => r.classe === 'bruit');
  const nt = b.rouges.filter((r) => r.classe === 'non tranché'), presumees = b.rouges.filter((r) => r.classe === 'régression présumée');
  const parVert = (l: RougeClasse[]) => new Set(l.map((r) => `${famille(r.passage)} ${r.vert ?? r.cause}`)).size; // une régression par vert qui clôt ses rouges
  const par = (c: string, k: Classe) => b.rouges.filter((r) => r.critere === c && r.classe === k).length;
  const sansReelle = b.criteres.filter((c) => par(c, 'régression réelle') === 0);
  const aTrancher = sansReelle.filter((c) => par(c, 'non tranché') + par(c, 'régression présumée') > 0);
  const muets = sansReelle.filter((c) => !aTrancher.includes(c)); // jamais rouges, ou rouges tous du bruit
  return [`Bilan du banc du ${parisJour(b.depuis).jour} au ${parisJour(b.jusqua).jour} (L912, D-40)`,
    `- bancs joués : ${Object.values(b.joues).reduce((a, n) => a + n, 0)} passages (${Object.entries(b.joues).map(([f, n]) => `${f} ${n}`).join(', ') || 'aucun'})`,
    `- heures de machine : ${fr1(b.heures)} h`,
    `- régressions réelles attrapées : ${parVert(reels)} (${reels.length} rouge(s) de critère, clos par un vert après au plus ${MAX_COMMITS_REELLE} commit(s) de v2/ hors du banc et ${MAX_HEURES_REELLE} h ; une par vert qui les clôt)`,
    `- régressions présumées, à trancher dans classements.json : ${parVert(presumees)} (${presumees.length} rouge(s) de critère, clos par un vert plus lointain ; jamais comptées avec les réelles)`,
    `- faux rouges (bruit) : ${bruit.length}${bruit.length ? ` (${compter(bruit.map(genre))})` : ''}`,
    `- non tranchés : ${nt.length}${nt.length ? ` (${compter(nt.map(genre))})` : ''} ; passages non mesurables (charge) : ${b.nonMesurables.length}`,
    `- ce qu'aurait laissé passer la suite de tests seule : présomption, non mesurée — au plus ${parVert(reels)} régression(s) réelle(s), chacune sur un commit de main intégré après la porte`,
    '', '| Critère | Rouges | Régressions réelles | Présumées | Bruit | Non tranchés |', '|---|---|---|---|---|---|',
    ...b.criteres.map((c) => `| ${c} | ${b.rouges.filter((r) => r.critere === c).length} | ${par(c, 'régression réelle')} | ${par(c, 'régression présumée')} | ${par(c, 'bruit')} | ${par(c, 'non tranché')} |`), '',
    `Critères jamais rouges ou seulement en bruit sur la fenêtre (à retirer ou fondre dans la porte s'ils n'attrapent rien en 4 semaines) : ${muets.join(', ') || 'aucun'}`,
    `Critères sans régression réelle mais avec des rouges non tranchés ou présumés (utilité non mesurée, à trancher avant tout retrait) : ${aTrancher.join(', ') || 'aucun'}`,
    ...(b.rouges.length ? ['', 'Détail des rouges :', ...b.rouges.map((r) => `- ${quand(r.passage)} ${famille(r.passage)} ${r.passage.empreinte} — ${r.critere} : ${r.classe}, ${r.cause}${r.commits ? ` : ${extrait(r.commits)}` : ''}`)] : [])];
}

/** Sortie de git, vide hors d'un dépôt (le bilan dit alors « non tranché » plutôt que d'échouer). */
const git = (repo: string, args: string[]): string => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const MESURE = ['v2/src', 'v2/briefs', 'v2/hooks'];
/** a est-il un ancêtre de b (ou b lui-même) ? Un vert sur un commit plus ancien que le rouge ne tranche rien (revue L912). */
const estAncetre = (repo: string, a: string, b: string): boolean => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo, stdio: 'ignore' }); return true; } catch { return false; }
};

/** Le dépôt réel : l'empreinte de chaque commit de main qui touche v2/ (même calcul que `empreinte` de cli.ts, lu dans `git ls-tree`). */
export function depotGit(repo: string): Depot {
  const parEmpreinte = new Map<string, string>();
  for (const sha of git(repo, ['log', '--format=%H', '--', ...MESURE]).split('\n').filter(Boolean)) { // du plus récent au plus ancien : le plus ancien reste
    const l = git(repo, ['ls-tree', sha, 'v2/']).split('\n'), arbre = (p: string) => l.find((x) => x.endsWith(`\t${p}`));
    const [src, briefs, hooks] = MESURE.map(arbre);
    if (!src || !briefs) continue;
    parEmpreinte.set(empreinteArbres([src, briefs].map((x) => x.split(/\s+/)[2]), hooks), sha);
  }
  return {
    commitDe: (e) => parEmpreinte.get(e),
    commitsEntre: (a, b) => (!estAncetre(repo, a, b) ? null : git(repo, ['log', '--format=@%h %s', '--name-only', `${a}..${b}`, '--', ...MESURE]).split('\n@').map((x) => x.replace(/^@/, '').trim()).filter(Boolean)
      .map((x) => { const [commit, ...fichiers] = x.split('\n').filter(Boolean); return { commit, fichiers }; })),
  };
}

/** `historique.jsonl`, `rapports/*-bruit*.md` et la lecture d'un rapport, sous la racine du banc. */
export function lireRacine(racine: string): { passages: Passage[]; bruits: PassageBruit[]; lire: LireRapport; criteres: (depuis: Date) => string[]; tranches?: Tranches } {
  const h = join(racine, 'historique.jsonl'), d = join(racine, 'rapports');
  const passages = existsSync(h) ? readFileSync(h, 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as Passage] : []; } catch { return []; } }) : [];
  const fichiers = existsSync(d) ? readdirSync(d) : [];
  const bruits = fichiers.filter((f) => /-bruit(-main)?\.md$/.test(f)).map((f) => ({ run: f.slice(0, -3), duree_s: Number(/Durée du passage : (\d+) s/.exec(readFileSync(join(d, f), 'utf8'))?.[1] ?? 0) }));
  const json = (n: string) => { try { return JSON.parse(readFileSync(join(d, `${n}.json`), 'utf8')) as { charge?: Charge; resultats?: ResultatBanc[]; verdict?: Verdict }; } catch { return null; } };
  const criteres = (depuis: Date) => [...new Set(fichiers.filter((f) => f.endsWith('.json') && (datePassage(f) ?? 0) >= depuis)
    .flatMap((f) => (json(f.slice(0, -5))?.verdict?.criteres ?? []).filter((c) => c.bloquant).map((c) => c.nom)))];
  let tranches: Tranches | undefined;
  try { tranches = JSON.parse(readFileSync(join(racine, 'classements.json'), 'utf8')) as Tranches; } catch { /* aucun rouge tranché à la main */ }
  return { passages, bruits, lire: (p) => json(nomRapport(p)), criteres, tranches };
}

/** `cadence2 bench bilan [--semaines N]` (aussi `bench --bilan`) : le bilan des N dernières semaines (4 par défaut). 0, ou 2 sur un usage faux. */
export function commandeBilan(racine: string, reste: string[], io: Io, repo: string): number {
  const i = reste.indexOf('--semaines'), semaines = i < 0 ? 4 : Number(reste[i + 1]);
  if (!Number.isInteger(semaines) || semaines < 1) { io.err('usage : cadence2 bench bilan [--semaines N] (entier ≥ 1, 4 par défaut)'); return 2; }
  const r = lireRacine(racine), maintenant = io.now();
  const depuis = new Date(maintenant.getTime() - semaines * 7 * 86_400_000);
  for (const l of lignesBilan(bilan(r.passages, r.bruits, { maintenant, semaines, depot: depotGit(repo), lire: r.lire, criteres: r.criteres(depuis), tranches: r.tranches }))) io.out(l);
  return 0;
}
