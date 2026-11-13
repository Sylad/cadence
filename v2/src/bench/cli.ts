import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Io } from '../cli.js';
import { ajouterBanc } from './ajouter.js';
import { chargerBanc, listerBancs, racineBanc, type Banc } from './banc.js';
import { chargerBras, executeurClaude, lancerBras, libererReglages, type DefBras, type Executeur, type Mesure } from './bras.js';
import { fuitesDuBras } from './fuites.js';
import { etatGit, juger, travailNonLivre, type Jugement } from './juges.js';
import { preparer } from './preparer.js';
import { mesurerSansJuge } from './sans-juge.js';
import { BARRE_SPEC, banBase, ligneHistorique, parisJour, PUBLIE, rapport, statut, verdict, verdictSansJuge, type MesureSansJuge, type ResultatBanc, type Verdict } from './verdict.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const COURT = ['1', '3', '6'];

export function empreinte(repo: string): string {
  try {
    const arbres = ['v2/src', 'v2/briefs'].map((p) => execFileSync('git', ['rev-parse', `HEAD:${p}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    const hooks = execFileSync('git', ['ls-tree', 'HEAD', 'v2/hooks'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); // hooks d'un bras : vide sans eux
    return createHash('sha1').update([...arbres, ...(hooks ? [hooks] : [])].join('\n')).digest('hex').slice(0, 12);
  } catch { return 'inconnue'; }
}

/** Premier sujet de commit « Taille … » de base..HEAD (le bras classe sa demande). */
const tailleDeclaree = (c: string, base: string): string | undefined => { try { return execFileSync('git', ['log', '--reverse', '--format=%s', `${base}..HEAD`], { cwd: c, encoding: 'utf8' }).split('\n').find((l) => l.startsWith('Taille')); } catch { return undefined; } };

const plusRecent = (dir: string, t: number): string | null => {
  for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name), r = f.isDirectory() ? plusRecent(p, t) : statSync(p).mtimeMs > t ? p : null; if (r) return r; }
  return null;
};

/** Le dépôt dont le banc lance le code, branche et commit (L689 : le 13-11, `cadence2` du PATH mesurait un clone arrêté sur une autre branche). */
export const depotMesure = (repo: string): string => {
  const g = (...a: string[]) => { try { return execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return '?'; } };
  return `${repo} (${g('symbolic-ref', 'HEAD').replace('refs/heads/', 'branche ')}, ${g('rev-parse', 'HEAD').slice(0, 8)})`;
};

/** Le passage ne mesure que ce que l'empreinte décrit : null = prêt, sinon la raison du refus. */
export function pretAPasser(repo: string, bras: Record<string, DefBras>, racine = ''): string | null {
  const sale = execFileSync('git', ['status', '--porcelain', '--', 'v2/src', 'v2/briefs', 'v2/hooks'], { cwd: repo, encoding: 'utf8' }).trim();
  if (sale) return `v2/src, v2/briefs ou v2/hooks a des changements non commités (l'empreinte ne les voit pas) :\n${sale}`;
  const cli = join(repo, 'v2', 'dist', 'cli.js');
  if (!existsSync(cli)) return 'v2/dist/cli.js absent : lancer « npm run build » dans v2';
  const neuf = plusRecent(join(repo, 'v2', 'src'), statSync(cli).mtimeMs);
  if (neuf) return `${neuf} est plus récent que v2/dist/cli.js : lancer « npm run build » dans v2`;
  const briefs = join(repo, 'v2', 'briefs') + '/';
  for (const d of Object.values(bras)) for (const f of [d.brief, ...(d.settings ? [d.settings] : [])])
    if (!resolve(racine, f).startsWith(briefs)) return `brief ou réglages du bras ${d.nom} hors de ${briefs} : ${f}`;
  return null;
}

const vivant = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const bootId = (): string => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; } };

/** Un seul passage à la fois par racine : verrou à création exclusive, repris si son pid est mort. */
export function verrouiller(racine: string): () => void {
  const f = join(racine, 'passage.lock');
  mkdirSync(racine, { recursive: true });
  for (let essai = 0; ; essai++) {
    try {
      const fd = openSync(f, 'wx'); writeFileSync(fd, `${process.pid} ${new Date().toISOString()} ${bootId()}`.trim()); closeSync(fd);
      return () => rmSync(f, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || essai > 0) throw e;
      const contenu = readFileSync(f, 'utf8');
      const [pid, , boot] = contenu.split(' '); const ici = bootId();
      const autreDemarrage = Boolean(boot && ici && boot !== ici); // le pid a pu être réutilisé après un redémarrage de WSL
      if (!autreDemarrage && vivant(Number(pid))) throw new Error(`un passage est déjà en cours (${contenu}) : ${f}`);
      rmSync(f, { force: true });
    }
  }
}

/** Garde le patch et les commits du bras à côté du clone, puis efface le clone (≈ 1 Go) ; captures et journaux restent. */
export function archiver(c: string, base: string | undefined): void {
  libererReglages(c);
  if (base) for (const [ext, a] of [['patch', ['diff', '--binary', `${base}..HEAD`]], ['commits.txt', ['log', '--oneline', `${base}..HEAD`]]] as const)
    try { writeFileSync(`${c}.${ext}`, execFileSync('git', a, { cwd: c, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* clone illisible */ }
  rmSync(c, { recursive: true, force: true });
}

/** L689 : `micro` (banc 1) et `mecanique` (1, 3 et 6) se jouent sans juge IA et n'autorisent jamais la publication. `Enfants` : un processus cadence2 par banc, `paralleles` à la fois. */
export type Niveau = 'micro' | 'mecanique';
export type Enfants = { lanceur: string[]; paralleles: number; env?: NodeJS.ProcessEnv };

type OptPassage = { racine: string; numeros?: string[]; ref: string; cand: string; hebdo: boolean; juge: string; repetitions?: number; garderClones?: boolean;
  exec: Executeur; prep: typeof preparer; maintenant: Date; empreinte: string; home: string; out: (l: string) => void; eclair?: boolean;
  niveau?: Niveau; enfants?: Enfants; depot?: string };

/** Un banc (une répétition) à jouer, sérialisable pour un processus enfant. */
export type Tache = { racine: string; dirRun: string; run: string; ref: string; cand: string; N: number; juge: string; garderClones: boolean;
  maintenant: string; home: string; sansJuge: boolean; bid: string; i: number; k: number };
type Joue = { r: ResultatBanc; clones: Record<string, string> };

const idTache = (t: Tache) => (t.N > 1 ? `${t.bid}#${t.k}` : t.bid);

const enEchec = (bras: string, banc: string, quand: string, echec: string): Mesure => ({ bras, banc, debut: quand, fin: quand, duree_s: 0, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec });

export async function passage(o: OptPassage): Promise<Verdict & { eclair_ok?: boolean }> {
  const liberer = verrouiller(o.racine);
  try { return await passageVerrouille(o); } finally { try { rmSync(join(o.racine, 'en-cours.json'), { force: true }); } finally { liberer(); } }
}

/** Un banc : préparation, bras l'un après l'autre (ordre alterné), fuites, puis les juges, ou la mesure sans juge (L689) ; écrit resultat.json. */
export function jouerBanc(t: Tache, exec: Executeur, prep: typeof preparer, out: (l: string) => void, signaler: (phase: string) => void): Joue {
  const bras = chargerBras(t.racine);
  const ordre = (t.i + t.k - 1) % 2 === 0 ? [t.ref, t.cand] : [t.cand, t.ref];
  const idBanc = idTache(t); const sous = t.N > 1 ? join(t.bid, `r${t.k}`) : t.bid;
  const mesures: Record<string, Mesure> = {}; const clones: Record<string, string> = {}; const fuites: Record<string, string[]> = {}; const aVerifier: Record<string, string[]> = {}; const suiteBase: Record<string, number> = {}; const bases: Record<string, string> = {};
  const mapping: Record<string, string> = {}; // c1/c2 -> bras : écrit seulement après les juges (aveugle)
  let jugement: Jugement | null = null; let sansJuge: Record<string, MesureSansJuge> | undefined; let phase = 'banc invalide'; let b: Banc | undefined;
  const aller = (p: string) => { phase = p; signaler(p); };
  try {
    const bc = chargerBanc(t.racine, t.bid); b = bc;
    ordre.forEach((n, j) => {
      const c = join(t.dirRun, sous, `c${j + 1}`);
      mapping[`c${j + 1}`] = n; clones[n] = c;
      aller('préparation'); suiteBase[n] = prep(bc, c).testsBase;
      out(`${idBanc} : bras ${n}…`);
      const avant = etatGit(c); bases[n] = avant.head;
      aller(`bras ${n}`); const m = lancerBras(bc, bras[n], c, exec, undefined, { pieces: [], racine: t.racine });
      mesures[n] = { ...m, banc: idBanc, echec: m.echec ?? travailNonLivre(avant, etatGit(c)), taille_declaree: tailleDeclaree(c, avant.head) };
      aller('fuites'); const fu = fuitesDuBras(t.home, t.racine, t.bid, c); fuites[n] = fu.certaines; aVerifier[n] = fu.a_verifier;
    });
    if (ordre.some((n) => mesures[n].echec !== null)) out(`${idBanc} : un bras en échec, ${t.sansJuge ? 'mesure sautée' : 'juges sautés'}`);
    else if (t.sansJuge) {
      aller('mesure sans juge');
      sansJuge = Object.fromEntries(ordre.map((n) => [n, mesurerSansJuge(bc, clones[n])]));
    } else {
      out(`${idBanc} : juges…`);
      aller('juges');
      jugement = juger(bc, clones, join(t.racine, 'eval', t.run, sous), t.juge, exec);
    }
  } catch (e) {
    const msg = `${phase} : ${e instanceof Error ? e.message : String(e)}`;
    for (const n of ordre) if (!mesures[n]) {
      mesures[n] = enEchec(n, idBanc, t.maintenant, msg);
      fuites[n] = []; aVerifier[n] = [];
    }
    out(`${idBanc} : ${msg}`);
  }
  const r: ResultatBanc = { banc: idBanc, taille: b?.taille ?? 'fonction', visible: b?.visible ?? false, reponses: b?.reponses ?? false, frais: b?.frais ?? false,
    mesures, jugement, fuites, fuites_a_verifier: aVerifier, ...(sansJuge && { sans_juge: sansJuge }) };
  mkdirSync(join(t.dirRun, sous), { recursive: true });
  writeFileSync(join(t.dirRun, sous, 'resultat.json'), JSON.stringify({ ...r, clones: mapping, suite_base: suiteBase }, null, 2));
  if (!t.garderClones) for (const n of ordre) if (clones[n]) archiver(clones[n], bases[n]);
  return { r, clones: mapping };
}

const PHASE = '@phase ';

/** Processus enfant (`cadence2 bench _banc <tache.json>`) : joue le banc avec claude, écrit `<tache.json>.joue.json`, ses phases sur la sortie. */
export function bancEnfant(f: string, out: (l: string) => void): number {
  const t = JSON.parse(readFileSync(f, 'utf8')) as Tache;
  writeFileSync(`${f}.joue.json`, JSON.stringify(jouerBanc(t, executeurClaude, preparer, out, (p) => out(PHASE + p))));
  return 0;
}

/** Un banc dans un processus enfant. Un enfant qui ne démarre pas, meurt sans résultat ou en laisse un illisible met les deux bras en échec ; le passage continue. */
function bancDansEnfant(t: Tache, e: Enfants, dir: string, out: (l: string) => void, signaler: (phase: string) => void): Promise<Joue> {
  return new Promise((fin) => {
    const id = idTache(t); const f = join(dir, `${id.replace('#', '-r')}.tache.json`);
    writeFileSync(f, JSON.stringify(t));
    let termine = false; let erreur: string | undefined;
    const finir = (cause?: string) => {
      if (termine) return;
      termine = true;
      if (!cause) {
        try { return fin(JSON.parse(readFileSync(`${f}.joue.json`, 'utf8')) as Joue); } catch (x) { cause = `résultat du banc illisible (${x instanceof Error ? x.message : String(x)})`; }
      }
      out(`${id} : ${cause}`);
      const mesures = { [t.ref]: enEchec(t.ref, id, t.maintenant, cause), [t.cand]: enEchec(t.cand, id, t.maintenant, cause) };
      fin({ r: { banc: id, taille: 'fonction', visible: false, reponses: false, frais: false, mesures, jugement: null, fuites: { [t.ref]: [], [t.cand]: [] } }, clones: {} });
    };
    const p = spawn(e.lanceur[0], [...e.lanceur.slice(1), 'bench', '_banc', f], { env: e.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const flux of [p.stdout, p.stderr]) createInterface({ input: flux }).on('line', (l) => (l.startsWith(PHASE) ? signaler(l.slice(PHASE.length)) : out(l)));
    p.on('error', (x) => { erreur = x.message; if (p.pid === undefined) finir(`processus du banc non démarré (${erreur})`); }); // sans écouteur, l'erreur ferait tomber le passage entier
    p.on('close', (code, signal) => {
      if (existsSync(`${f}.joue.json`)) return finir();
      finir(`processus du banc arrêté sans résultat (${erreur ?? signal ?? `code ${code}`})`);
    });
  });
}

/** Au plus `n` tâches à la fois ; les résultats gardent l'ordre des tâches. */
export async function enParallele<T, R>(taches: T[], n: number, jouer: (t: T) => Promise<R>): Promise<R[]> {
  const res: R[] = []; let suivant = 0;
  const file = async () => { for (let i = suivant++; i < taches.length; i = suivant++) res[i] = await jouer(taches[i]); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, taches.length)) }, file));
  return res;
}

async function passageVerrouille(o: OptPassage): Promise<Verdict & { eclair_ok?: boolean }> {
  const { jour: date, hhmm } = parisJour(o.maintenant); // nom du passage à l'heure de Paris, comme statut
  const id = `${date}-${hhmm}-${o.empreinte}`;
  const dirRun = join(o.racine, 'runs', id);
  const bras = chargerBras(o.racine);
  for (const n of [o.ref, o.cand]) if (!bras[n]) throw new Error(`bras « ${n} » absent de ${o.racine}/bras.yaml`);
  const N = o.repetitions ?? 1;
  const ids = listerBancs(o.racine, o.numeros);
  const debut = new Date(); const phases: Record<string, string> = {}; let termines = 0;
  const taches: Tache[] = ids.flatMap((bid, i) => Array.from({ length: N }, (_, k) => ({
    racine: o.racine, dirRun, run: id, ref: o.ref, cand: o.cand, N, juge: o.juge, garderClones: o.garderClones ?? false,
    maintenant: o.maintenant.toISOString(), home: o.home, sansJuge: o.niveau !== undefined, bid, i, k: k + 1,
  })));
  /** `en-cours.json` : ce que le HUD montre pendant le passage (écrit par renommage, jamais à moitié) ; `en_parallele` (L689) : la phase de chaque banc en cours. */
  const signaler = (t: Tache) => (phase: string) => {
    const f = join(o.racine, 'en-cours.json');
    phases[idTache(t)] = phase;
    writeFileSync(`${f}.tmp`, JSON.stringify({ run: id, debut: debut.toISOString(), candidat: o.cand, reference: o.ref, bancs_total: ids.length * N, banc: t.bid, repetition: t.k,
      phase, phase_debut: new Date().toISOString(), termines, en_parallele: phases }));
    renameSync(`${f}.tmp`, f);
  };
  const fini = (t: Tache, j: Joue) => { termines++; delete phases[idTache(t)]; return j; };
  const dirTaches = join(dirRun, 'taches');
  if (o.enfants) mkdirSync(dirTaches, { recursive: true });
  if (o.depot) o.out(`banc ${o.niveau ?? 'avec juges'} : dépôt mesuré ${o.depot}, empreinte ${o.empreinte}, ${o.enfants ? Math.min(o.enfants.paralleles, taches.length) : 1} banc(s) à la fois`);
  const enfants = o.enfants;
  const joues = enfants
    ? await enParallele(taches, enfants.paralleles, async (t) => fini(t, await bancDansEnfant(t, enfants, dirTaches, o.out, signaler(t))))
    : taches.map((t) => fini(t, jouerBanc(t, o.exec, o.prep, o.out, signaler(t))));
  const res = joues.map((j) => j.r);
  const v = (o.niveau ? verdictSansJuge : verdict)(res, o.ref, o.cand, BARRE_SPEC);
  const e = o.eclair ? controlesEclair(res, o.ref, o.cand) : undefined;
  e?.lignes.forEach((l) => o.out(l));
  const duree_s = Math.round((Date.now() - debut.getTime()) / 1000);
  mkdirSync(join(o.racine, 'rapports'), { recursive: true });
  const base = join(o.racine, 'rapports', id);
  writeFileSync(`${base}.md`, rapport(res, o.ref, o.cand, v, { date, empreinte: o.empreinte, repetitions: N, eclair: e?.lignes, niveau: o.niveau, depot: o.depot, duree_s }));
  writeFileSync(`${base}.json`, JSON.stringify({ verdict: v, resultats: res.map((r, i) => ({ ...r, clones: joues[i].clones })) }, null, 2));
  appendFileSync(join(o.racine, 'historique.jsonl'), `${ligneHistorique(v, { date: o.maintenant.toISOString(), empreinte: o.empreinte,
    candidat: o.cand, reference: o.ref, modele_candidat: bras[o.cand].modele, bancs: res.map((r) => r.banc), hebdo: o.hebdo, frais: new Set(res.filter((r) => r.frais).map((r) => banBase(r.banc))).size,
    ...(e && { eclair_ok: e.ok }), ...(o.niveau && { niveau: o.niveau }), duree_s })}\n`);
  o.out(`${v.vert ? 'VERT' : 'ROUGE'} — ${duree_s} s — rapport : ${base}.md`);
  return { ...v, eclair_ok: e?.ok };
}

/** Banc éclair : deux contrôles rapides sur le banc 1 (temps ≤ 1,2 × A, aucune question du candidat). */
export function controlesEclair(res: ResultatBanc[], ref: string, cand: string): { lignes: string[]; ok: boolean } {
  const rouge = (cause: string) => ({ ok: false, lignes: [`temps candidat ≤ ${BARRE_SPEC.temps_max_retouche.toString().replace('.', ',')} × A : ROUGE (${cause})`, `questions du candidat : 0 / ? ROUGE (${cause})`] });
  if (res.length === 0) return rouge('aucun banc joué');
  for (const r of res) for (const b of [ref, cand]) {
    const x = r.mesures[b];
    if (!x) return rouge(`mesure absente : bras ${b}, banc ${r.banc}`);
    if (x.echec !== null) return rouge(`bras en échec : ${b}, ${x.echec}`);
  }
  const m = (b: string) => res.reduce((a, r) => ({ t: a.t + r.mesures[b].duree_s, q: a.q + r.mesures[b].questions }), { t: 0, q: 0 });
  const a = m(ref), c = m(cand), tempsOk = c.t <= BARRE_SPEC.temps_max_retouche * a.t, questionsOk = c.q === 0;
  return { ok: tempsOk && questionsOk, lignes: [
    `temps candidat ≤ ${BARRE_SPEC.temps_max_retouche.toString().replace('.', ',')} × A : ${tempsOk ? 'ok' : 'ROUGE'} (${c.t} s contre ${a.t} s)`,
    `questions du candidat : 0 / ${c.q} ${questionsOk ? 'ok' : 'ROUGE'}`] };
}

const option = (args: string[], nom: string): string | undefined => { const i = args.indexOf(`--${nom}`); return i >= 0 ? args[i + 1] : undefined; };

const entierOption = (args: string[], nom: string, defaut: number): number | null => { const v = option(args, nom); if (v === undefined) return defaut; return /^[1-9]\d*$/.test(v) ? Number(v) : null; };

/** L689 : trois bancs à la fois par défaut pour micro et mécanique. */
export const PARALLELES = 3;

/** Bancs joués en même temps (L689, décision du lead du 13-11) : micro et mécanique en parallèle ; les passages avec juges, que la garde compte, en série tant
 * qu'aucun vrai passage n'a comparé série et parallèle (dans le court, A est premier bras 2 bancs sur 3, donc sous plus de charge). Le nombre, ou la raison du refus. */
export function bancsALaFois(niveau: Niveau | undefined, demande: number | undefined): number | string {
  if (niveau) return demande ?? PARALLELES;
  if (demande !== undefined && demande > 1) return '--paralleles N > 1 seulement avec micro ou mecanique : les passages avec juges, comptés par la garde de publication, tournent en série tant qu\'aucun vrai passage n\'a comparé série et parallèle';
  return 1;
}

/** La commande qui lance le banc de CE dépôt, celui dont la garde de publication lit l'empreinte (L689). */
export const commandeBanc = (repo: string, sous: string) => `node ${join(repo, 'v2', 'bin', 'cadence2.js')} bench ${sous}`;

/** Les bras qu'exige la garde, écrits dans la commande : `bench sequence` a ses propres défauts (candidat sequence-v2). */
const BRAS_PUBLIES = `--candidat ${PUBLIE.candidat} --reference ${PUBLIE.reference}`;

/** Ce qu'il faut lancer, depuis la version à publier, pour que la garde accepte (L689). */
export const pourPublier = (repo: string) =>
  `lancer, depuis la version à publier : « ${commandeBanc(repo, 'court')} » puis « ${commandeBanc(repo, `sequence <id> --repetitions 2 ${BRAS_PUBLIES}`)} » (${PUBLIE.candidat} contre ${PUBLIE.reference})`;

const SOUS: Record<string, { numeros?: string[]; niveau?: Niveau }> = { court: { numeros: COURT }, hebdo: {}, eclair: { numeros: ['1'] }, micro: { numeros: ['1'], niveau: 'micro' }, mecanique: { numeros: COURT, niveau: 'mecanique' } };

export async function bench(args: string[], io: Io, repo = REPO): Promise<number> {
  const [sous, ...reste] = args;
  if (sous === '_banc' && reste[0]) return bancEnfant(reste[0], io.out);
  const racine = racineBanc(io.env);
  const hist = existsSync(join(racine, 'historique.jsonl')) ? readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n') : [];
  const emp = empreinte(repo);
  const modeles = (): Record<string, string> => { try { return Object.fromEntries(Object.values(chargerBras(racine)).map((d) => [d.nom, d.modele])); } catch { return {}; } };
  if (sous === 'statut') { // L689 (décision de Sylvain du 13-11) : plus de banc du weekend exigé ; seule la garde court + séquence compte, avant une release
    const s = statut(hist, io.now(), emp, modeles(), PUBLIE);
    io.out(`banc : dernier passage ${s.dernier ?? 'aucun'} ; publication ${s.publication_ok ? 'permise' : 'refusée'} sur l'empreinte ${emp}${s.publication_ok ? '' : ` : ${pourPublier(repo)}`}`);
    if (s.frais_semaine === 0) io.out('⚠ aucun banc frais cette semaine : en ajouter avec « cadence2 bench ajouter »');
    return 0;
  }
  if (sous === 'verifier-publication') {
    const ok = statut(hist, io.now(), emp, modeles(), PUBLIE).publication_ok;
    io.out(ok ? `banc court et séquence verts sur l'empreinte ${emp}`
      : `publication refusée sur l'empreinte ${emp} : il faut le dernier banc court ET la dernière séquence verts, ${PUBLIE.candidat} contre ${PUBLIE.reference}, même modèle ; ${pourPublier(repo)}`);
    return ok ? 0 : 1;
  }
  if (sous === 'ajouter') {
    const [projetDir, lot, fichierDemande] = reste;
    const taille = option(reste, 'taille') ?? 'fonction';
    if (!projetDir || !lot || !fichierDemande || !['retouche', 'fonction', 'grosse'].includes(taille)) {
      io.err('usage : cadence2 bench ajouter <projet> <lot> <demande.md> --install c --tests c [--taille retouche|fonction|grosse] [--visible]'); return 2;
    }
    try {
      io.out(`banc ajouté : ${ajouterBanc({ racine, projetDir: resolve(io.cwd, projetDir), lot, demande: readFileSync(resolve(io.cwd, fichierDemande), 'utf8'),
        install: option(reste, 'install') ?? 'true', tests: option(reste, 'tests') ?? 'true', taille: taille as 'retouche' | 'fonction' | 'grosse', visible: reste.includes('--visible') })}`);
      return 0;
    } catch (e) { io.err(`cadence2 bench ajouter : ${e instanceof Error ? e.message : String(e)}`); return 1; }
  }
  const bancs = option(reste, 'bancs');
  const choix = sous === 'lancer' ? (bancs ? { numeros: bancs.split(',') } : null) : Object.hasOwn(SOUS, sous ?? '') ? SOUS[sous!] : null;
  if (choix === null) {
    io.err('usage : cadence2 bench micro|mecanique|court|hebdo|eclair|lancer --bancs 1,3|statut|verifier-publication|ajouter [--candidat c] [--reference r] [--repetitions N] [--paralleles N] [--garder-clones]');
    return 2;
  }
  const rep = entierOption(reste, 'repetitions', 1);
  const demande = option(reste, 'paralleles') === undefined ? undefined : entierOption(reste, 'paralleles', 1);
  if (rep === null || demande === null) { io.err('usage : --repetitions N et --paralleles N (entiers ≥ 1) avec micro|mecanique|court|hebdo|eclair|lancer'); return 2; }
  const par = bancsALaFois(choix.niveau, demande);
  if (typeof par === 'string') { io.err(`bench refusé : ${par}`); return 2; }
  const ref = option(reste, 'reference') ?? PUBLIE.reference; const cand = option(reste, 'candidat') ?? PUBLIE.candidat;
  let refus: string | null;
  try {
    const tous = chargerBras(racine);
    refus = ref === cand ? `--candidat et --reference désignent le même bras (${ref})` : [ref, cand].find((n) => !tous[n]) ? `bras absent de ${racine}/bras.yaml` : emp === 'inconnue' ? 'empreinte inconnue (pas de dépôt git)'
      : pretAPasser(repo, { [ref]: tous[ref], [cand]: tous[cand] }, racine);
  } catch (e) { refus = e instanceof Error ? e.message : String(e); }
  if (refus) { io.err(`bench refusé : ${refus}`); return 2; }
  const v = await passage({ racine, numeros: choix.numeros, niveau: choix.niveau, ref, cand, eclair: sous === 'eclair',
    hebdo: sous === 'hebdo', repetitions: rep, garderClones: reste.includes('--garder-clones'), juge: option(reste, 'juge') ?? 'opus', exec: executeurClaude, prep: preparer,
    maintenant: io.now(), empreinte: emp, home: io.env.HOME ?? '', out: io.out, depot: depotMesure(repo),
    ...(par > 1 && { enfants: { lanceur: [process.execPath, join(repo, 'v2', 'bin', 'cadence2.js')], paralleles: par } }) });
  return v.vert && v.eclair_ok !== false ? 0 : 1;
}
