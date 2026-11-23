import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Io } from '../cli.js';
import { ajouterBanc } from './ajouter.js';
import { chargerBanc, listerBancs, piecesBanc, racineBanc, type Banc } from './banc.js';
import { chargeMachine, lignesCharge, nombreCoeurs, nommer, occupants, refusCharge, registreCreneaux, type Charge } from './charge.js';
import { chargerBras, executeurClaude, lancerBras, libererReglages, type DefBras, type Executeur, type Mesure } from './bras.js';
import { enteteEnvironnement, environnement, ligneComparaison, modelesExacts, passagePrecedent, versionClaude, type Environnement } from './environnement.js';
import { fuitesDuBras, trierFuitesReference } from './fuites.js';
import { etatGit, juger, travailNonLivre, type Jugement } from './juges.js';
import { preparer } from './preparer.js';
import { distPerime, ligneRefus, nonCommite } from './refus-complet.js';
import { mesurerSansJuge, sansLivrable } from './sans-juge.js';
import { BANCS_COURT, BARRE_SPEC, banBase, LIBELLE_COURT, bancsARemesurer, bruitParBanc, COMPLET_MAX_JOURS, ecartPaire, SUFFIXE_BRUIT_COMPTE, SUFFIXE_BRUIT_MAIN, ligneHistorique, titreVerdict, parisJour, PUBLIE, rapport, statut, verdict, verdictSansJuge, type MesureSansJuge, type PassageLu, type ResultatBanc, type Verdict } from './verdict.js';

export const REPO = join(import.meta.dirname, '..', '..', '..');

export function empreinte(repo: string): string {
  try {
    const arbres = ['v2/src', 'v2/briefs'].map((p) => execFileSync('git', ['rev-parse', `HEAD:${p}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    const hooks = execFileSync('git', ['ls-tree', 'HEAD', 'v2/hooks'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); // hooks d'un bras : vide sans eux
    return createHash('sha1').update([...arbres, ...(hooks ? [hooks] : [])].join('\n')).digest('hex').slice(0, 12);
  } catch { return 'inconnue'; }
}

/** Premier sujet de commit « Taille … » de base..HEAD (le bras classe sa demande). */
const tailleDeclaree = (c: string, base: string): string | undefined => { try { return execFileSync('git', ['log', '--reverse', '--format=%s', `${base}..HEAD`], { cwd: c, encoding: 'utf8' }).split('\n').find((l) => l.startsWith('Taille')); } catch { return undefined; } };

/** Le dépôt dont le banc lance le code, branche et commit (L689 : le 13-11, `cadence2` du PATH mesurait un clone arrêté sur une autre branche). */
export const depotMesure = (repo: string): string => {
  const g = (...a: string[]) => { try { return execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return '?'; } };
  return `${repo} (${g('symbolic-ref', 'HEAD').replace('refs/heads/', 'branche ')}, ${g('rev-parse', 'HEAD').slice(0, 8)})`;
};

/** Le passage ne mesure que ce que l'empreinte décrit : null = prêt, sinon la raison du refus. */
export function pretAPasser(repo: string, bras: Record<string, DefBras>, racine = ''): string | null {
  const sale = nonCommite(repo) ?? distPerime(repo);
  if (sale) return sale;
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

/** L689 : `micro` (banc 1) et `mecanique` (1, 3 et 7) se jouent sans juge IA et n'autorisent jamais la publication. `Enfants` : un processus cadence2 par banc, `paralleles` à la fois.
 * L738 : `bruit`, A contre A sans juge, remesure le bruit de temps des bancs ; ni vert ni rouge, il n'écrit pas dans l'historique que lit la garde. */
export type Niveau = 'micro' | 'mecanique' | 'bruit';

/** L738 : le second bras d'un passage A contre A, même définition que A sous un autre nom (les mesures d'un banc sont rangées par nom de bras). */
export const jumeau = (b: string) => `${b}-bis`;
/** Les bras de bras.yaml, plus le jumeau de la référence quand le candidat l'est. */
export function brasDuPassage(racine: string, ref: string, cand: string): Record<string, DefBras> {
  const bras = chargerBras(racine);
  return cand === jumeau(ref) && bras[ref] && !bras[cand] ? { ...bras, [cand]: { ...bras[ref], nom: cand } } : bras;
}
/** `pas_horloge_ms` (L752, tests) : horloge des bras joués dans les enfants, avancée de ce pas à chaque lecture depuis `maintenant` ; sinon l'horloge réelle. */
export type Enfants = { lanceur: string[]; paralleles: number; env?: NodeJS.ProcessEnv; pas_horloge_ms?: number };
/** Horloge qui avance de `pas_ms` à chaque lecture (L751, L752) : chaque bras lit début puis fin et dure `pas_ms`, quelle que soit la charge machine. */
export function horlogeAPas(depart: string | Date, pas_ms: number): () => Date {
  let t = new Date(depart).getTime();
  return () => new Date((t += pas_ms));
}

type OptPassage = { racine: string; numeros?: string[]; ref: string; cand: string; hebdo: boolean; juge: string; repetitions?: number; garderClones?: boolean;
  exec: Executeur; prep: typeof preparer; maintenant: Date; empreinte: string; home: string; out: (l: string) => void; eclair?: boolean;
  niveau?: Niveau; enfants?: Enfants; depot?: string; bruitCompte?: boolean; version?: () => string; horloge?: () => Date;
  charge?: () => number[]; malgreCharge?: string[] }; // charge (L762) : load average, remplacé par les tests ; malgreCharge : occupants nommés quand --malgre-charge a forcé le banc ; version (L742) : claude --version ; horloge (L751) : début et fin des bras joués en ligne (duree_s, « temps total ») ; les deux remplacées par les tests

/** Un banc (une répétition) à jouer, sérialisable pour un processus enfant. `joues` (L737) : passages antérieurs de ce banc, pour alterner l'ordre des bras. */
export type Tache = { racine: string; dirRun: string; run: string; ref: string; cand: string; N: number; juge: string; garderClones: boolean;
  maintenant: string; home: string; sansJuge: boolean; bid: string; i: number; k: number; joues?: number; pas_horloge_ms?: number };
/** `rejeu` (L734) : clones gardés dont la suite est rouge, à rejouer seuls après les autres bancs du passage. */
type Joue = { r: ResultatBanc; clones: Record<string, string>; rejeu?: { bid: string; dossier: string; bras: Record<string, { clone: string; base: string }> } };

const idTache = (t: Tache) => (t.N > 1 ? `${t.bid}#${t.k}` : t.bid);

const enEchec = (bras: string, banc: string, quand: string, echec: string): Mesure => ({ bras, banc, debut: quand, fin: quand, duree_s: 0, tokens: 0, cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec });

export async function passage(o: OptPassage): Promise<Verdict & { eclair_ok?: boolean }> {
  const liberer = verrouiller(o.racine);
  try { return await passageVerrouille(o); } finally { try { rmSync(join(o.racine, 'en-cours.json'), { force: true }); } finally { liberer(); } }
}

/** Un banc : préparation, bras l'un après l'autre (ordre alterné), fuites, puis les juges, ou la mesure sans juge (L689) ; écrit resultat.json. */
export function jouerBanc(t: Tache, exec: Executeur, prep: typeof preparer, out: (l: string) => void, signaler: (phase: string) => void, horloge?: () => Date): Joue {
  const bras = brasDuPassage(t.racine, t.ref, t.cand);
  // L737 : l'ordre alterne d'un banc à l'autre, d'une répétition à l'autre, et d'un passage du même banc au suivant (le 13-15-11, cadence-run jouait toujours premier au banc 3)
  const ordre = (t.i + t.k - 1 + (t.joues ?? 0)) % 2 === 0 ? [t.ref, t.cand] : [t.cand, t.ref];
  const idBanc = idTache(t); const sous = t.N > 1 ? join(t.bid, `r${t.k}`) : t.bid;
  const mesures: Record<string, Mesure> = {}; const clones: Record<string, string> = {}; const fuites: Record<string, string[]> = {}; const aVerifier: Record<string, string[]> = {}; const suiteBase: Record<string, number> = {}; const bases: Record<string, string> = {};
  const fuitesSignalees: Record<string, string[]> = {};
  const mapping: Record<string, string> = {}; // c1/c2 -> bras : écrit seulement après les juges (aveugle)
  let jugement: Jugement | null = null; let sansJuge: Record<string, MesureSansJuge> | undefined; let nonLivre: Record<string, string> | undefined; let phase = 'banc invalide'; let b: Banc | undefined;
  const aller = (p: string) => { phase = p; signaler(p); };
  try {
    const bc = chargerBanc(t.racine, t.bid); b = bc;
    ordre.forEach((n, j) => {
      const c = join(t.dirRun, sous, `c${j + 1}`);
      mapping[`c${j + 1}`] = n; clones[n] = c;
      aller('préparation'); suiteBase[n] = prep(bc, c).testsBase;
      out(`${idBanc} : bras ${n}…`);
      const avant = etatGit(c); bases[n] = avant.head;
      aller(`bras ${n}`); const m = lancerBras(bc, bras[n], c, exec, horloge, { pieces: piecesBanc(bc), racine: t.racine });
      mesures[n] = { ...m, banc: idBanc, echec: m.echec ?? travailNonLivre(avant, etatGit(c)), taille_declaree: tailleDeclaree(c, avant.head) };
      aller('fuites'); const fu = fuitesDuBras(t.home, t.racine, t.bid, c); fuites[n] = fu.certaines; aVerifier[n] = fu.a_verifier;
    });
    if (clones[t.ref] && clones[t.cand]) { // L798 : une fuite de la référence sans effet possible sur le candidat (jouée après lui) est signalée, pas bloquante
      const tri = trierFuitesReference(fuites[t.ref], join(t.dirRun, sous), clones[t.cand], ordre.indexOf(t.ref) > ordre.indexOf(t.cand));
      fuites[t.ref] = tri.bloquantes; if (tri.signalees.length) fuitesSignalees[t.ref] = tri.signalees;
    }
    if (ordre.some((n) => mesures[n].echec !== null)) out(`${idBanc} : un bras en échec, ${t.sansJuge ? 'mesure sautée' : 'juges sautés'}`);
    else if (t.sansJuge) {
      // L733 : sans juge, rien d'autre ne verrait qu'un bras n'a écrit que du plan ou de la doc ; son temps ne compte pas, le banc est à rejouer
      const nl = Object.fromEntries(ordre.flatMap((n) => { const x = sansLivrable(clones[n], bases[n]); return x ? [[n, x]] : []; }));
      if (Object.keys(nl).length) { nonLivre = nl; out(`${idBanc} : banc non mesurable, à rejouer (${Object.entries(nl).map(([n, x]) => `${n} : ${x}`).join(' ; ')})`); }
      else {
        aller('mesure sans juge');
        sansJuge = Object.fromEntries(ordre.map((n) => [n, mesurerSansJuge(bc, clones[n])]));
      }
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
    mesures, jugement, fuites, fuites_a_verifier: aVerifier, ...(Object.keys(fuitesSignalees).length && { fuites_signalees: fuitesSignalees }), ...(sansJuge && { sans_juge: sansJuge }), ...(nonLivre && { non_livre: nonLivre }) };
  mkdirSync(join(t.dirRun, sous), { recursive: true });
  writeFileSync(join(t.dirRun, sous, 'resultat.json'), JSON.stringify({ ...r, clones: mapping, suite_base: suiteBase }, null, 2));
  const aRejouer = ordre.filter((n) => sansJuge && (!sansJuge[n].suite_ok || sansJuge[n].caches_ok === false)); // L734 : rouge peut-être de charge, clone gardé
  if (!t.garderClones) for (const n of ordre) if (clones[n] && !aRejouer.includes(n)) archiver(clones[n], bases[n]);
  return { r, clones: mapping, ...(aRejouer.length && { rejeu: { bid: t.bid, dossier: join(t.dirRun, sous), bras: Object.fromEntries(aRejouer.map((n) => [n, { clone: clones[n], base: bases[n] }])) } }) };
}

const PHASE = '@phase ';

/** Processus enfant (`cadence2 bench _banc <tache.json>`) : joue le banc avec claude, écrit `<tache.json>.joue.json`, ses phases sur la sortie. */
export function bancEnfant(f: string, out: (l: string) => void): number {
  const t = JSON.parse(readFileSync(f, 'utf8')) as Tache;
  const horloge = t.pas_horloge_ms ? horlogeAPas(t.maintenant, t.pas_horloge_ms) : undefined; // L752 : posée par les tests (Enfants.pas_horloge_ms)
  writeFileSync(`${f}.joue.json`, JSON.stringify(jouerBanc(t, executeurClaude, preparer, out, (p) => out(PHASE + p), horloge)));
  return 0;
}

/** Un banc dans un processus enfant. Un enfant qui ne démarre pas, meurt sans résultat ou en laisse un illisible met les deux bras en échec ; le passage continue. */
function bancDansEnfant(t: Tache, e: Enfants, dir: string, out: (l: string) => void, signaler: (phase: string) => void): Promise<Joue> {
  return new Promise((fin) => {
    const id = idTache(t); const f = join(dir, `${id.replace('#', '-r')}.tache.json`);
    writeFileSync(f, JSON.stringify(e.pas_horloge_ms ? { ...t, pas_horloge_ms: e.pas_horloge_ms } : t));
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

/**
 * L734 (vécu du 15-11, banc 1 : 28 findBy expirés sous la charge des 3 bancs, 68/68 au calme) : une suite rouge d'un bras est rejouée seule, après la fin
 * de tous les bancs du passage, comme orchestrate.testReplay ; le rejeu compte, la mesure sous charge reste dans `rejoue`. Le clone est archivé ensuite.
 */
export function rejouerSuites(joues: Joue[], racine: string, garderClones: boolean, out: (l: string) => void): void {
  for (const { r, rejeu } of joues) for (const [n, { clone, base }] of Object.entries(rejeu?.bras ?? {})) {
    const avant = r.sans_juge![n];
    out(`${r.banc} : suite de ${n} rouge pendant les autres bancs, rejouée seule…`);
    try {
      r.sans_juge![n] = { ...mesurerSansJuge(chargerBanc(racine, rejeu!.bid), clone, undefined, true), rejoue: { suite_ok: avant.suite_ok, caches_ok: avant.caches_ok } };
      const f = join(rejeu!.dossier, 'resultat.json');
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), sans_juge: r.sans_juge }, null, 2));
    } catch (e) { out(`${r.banc} : rejeu de ${n} impossible, la suite reste rouge (${e instanceof Error ? e.message : String(e)})`); }
    finally { if (!garderClones) archiver(clone, base); }
  }
}

/** L737 : les passages déjà rapportés (`rapports/<run>.json` d'un banc court, micro ou mécanique ; les séquences n'ont pas de `resultats`), dans l'ordre des noms. */
export function lirePassages(racine: string): PassageLu[] {
  const d = join(racine, 'rapports');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
    try { const x = JSON.parse(readFileSync(join(d, f), 'utf8')) as { resultats?: unknown }; return Array.isArray(x.resultats) ? [{ run: f.slice(0, -5), resultats: x.resultats as ResultatBanc[] }] : []; }
    catch { return []; }
  });
}

async function passageVerrouille(o: OptPassage): Promise<Verdict & { eclair_ok?: boolean }> {
  const { jour: date, hhmm } = parisJour(o.maintenant); // nom du passage à l'heure de Paris, comme statut
  const id = `${date}-${hhmm}-${o.empreinte}${o.niveau === 'bruit' ? (o.bruitCompte ? SUFFIXE_BRUIT_COMPTE : SUFFIXE_BRUIT_MAIN) : ''}`; // correctif L738 : seul le samedi compte
  const dirRun = join(o.racine, 'runs', id);
  const bras = brasDuPassage(o.racine, o.ref, o.cand);
  for (const n of [o.ref, o.cand]) if (!bras[n]) throw new Error(`bras « ${n} » absent de ${o.racine}/bras.yaml`);
  const N = o.repetitions ?? 1;
  const ids = listerBancs(o.racine, o.numeros);
  const passes = lirePassages(o.racine);
  const dejaJoues = (bid: string) => passes.filter((p) => p.resultats.some((r) => banBase(r.banc) === bid)).length;
  const version = (o.version ?? versionClaude)(); // L742 : au lancement, avant toute session
  const charge = o.charge ?? chargeMachine, depart = charge(); // L762 : charge au départ, avant la première session
  const debut = new Date(); const phases: Record<string, string> = {}; let termines = 0;
  const taches: Tache[] = ids.flatMap((bid, i) => Array.from({ length: N }, (_, k) => ({
    racine: o.racine, dirRun, run: id, ref: o.ref, cand: o.cand, N, juge: o.juge, garderClones: o.garderClones ?? false,
    maintenant: o.maintenant.toISOString(), home: o.home, sansJuge: o.niveau !== undefined, bid, i, k: k + 1, joues: dejaJoues(bid),
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
    : taches.map((t) => fini(t, jouerBanc(t, o.exec, o.prep, o.out, signaler(t), o.horloge)));
  rejouerSuites(joues, o.racine, o.garderClones ?? false, o.out);
  const res = joues.map((j) => j.r);
  const v = (o.niveau ? verdictSansJuge : verdict)(res, o.ref, o.cand, { ...BARRE_SPEC, bruit: bruitParBanc(passes, o.maintenant) }); // L737 : bruit tiré des passages d'avant celui-ci ; L738 : des 14 derniers jours
  const e = o.eclair ? controlesEclair(res, o.ref, o.cand) : undefined;
  e?.lignes.forEach((l) => o.out(l));
  const duree_s = Math.round((Date.now() - debut.getTime()) / 1000);
  const ch: Charge = { coeurs: nombreCoeurs(), depart, fin: charge(), ...(o.malgreCharge && { malgre_charge: o.malgreCharge }) };
  mkdirSync(join(o.racine, 'rapports'), { recursive: true });
  const base = join(o.racine, 'rapports', id);
  const env = environnement(version, Object.fromEntries([o.ref, o.cand].map((n) => [n, bras[n].modele])), res.flatMap((r) => Object.values(r.mesures)), { alias: o.juge, jugements: res.map((r) => r.jugement) });
  const entete = enteteEnvironnement(env, passagePrecedent(o.racine, id));
  writeFileSync(`${base}.md`, rapport(res, o.ref, o.cand, v, { date, empreinte: o.empreinte, repetitions: N, eclair: e?.lignes, niveau: o.niveau, depot: o.depot, duree_s, environnement: entete, charge: lignesCharge(ch) }));
  writeFileSync(`${base}.json`, JSON.stringify({ verdict: v, environnement: env, charge: ch, resultats: res.map((r, i) => ({ ...r, clones: joues[i].clones })) }, null, 2));
  if (entete[0].startsWith('⚠')) o.out(entete[0]);
  if (o.niveau === 'bruit') { // L738 : seul l'écart compte, lu au prochain passage dans rapports/<run>.json ; la garde ne voit pas ce passage
    const ecarts = res.map((r) => ecartPaire(r)); // correctif L738 : toujours montré, compté pour le seuil seulement quand le banc complet l'a joué
    o.out(`bruit remesuré, ${o.ref} contre ${o.cand} : ${res.map((r, i) => `${r.banc} ${ecarts[i]?.toFixed(2) ?? 'non mesuré'}`).join(' ; ')} — ${duree_s} s — rapport : ${base}.md`);
    if (!o.bruitCompte) o.out('bruit lancé à la main : mesure montrée, non comptée pour le seuil de temps (seules comptent les paires du banc complet du samedi)');
    return { ...v, vert: ecarts.every((x) => x !== null) };
  }
  appendFileSync(join(o.racine, 'historique.jsonl'), `${ligneHistorique(v, { date: o.maintenant.toISOString(), empreinte: o.empreinte,
    candidat: o.cand, reference: o.ref, modele_candidat: bras[o.cand].modele, bancs: res.map((r) => r.banc), hebdo: o.hebdo, frais: new Set(res.filter((r) => r.frais).map((r) => banBase(r.banc))).size,
    ...(e && { eclair_ok: e.ok }), ...(o.niveau && { niveau: o.niveau }), ...(o.malgreCharge && { malgre_charge: true }), duree_s, modeles_exacts: modelesExacts(env) })}\n`);
  o.out(`${titreVerdict(v)} — ${duree_s} s — rapport : ${base}.md`);
  return { ...v, eclair_ok: e?.ok };
}

/** L738 : les numéros des bancs du court que le banc complet remesure (`bancsARemesurer`). */
export const numerosARemesurer = (racine: string, maintenant: Date): string[] =>
  bancsARemesurer(lirePassages(racine), maintenant, listerBancs(racine, BANCS_COURT)).map((id) => id.split('-')[0]);

/**
 * L738 : `cadence2 bench bruit [--bancs 3,7]`, passage A contre A sans juge (A et son jumeau, même empreinte de bras), un banc après l'autre,
 * sur les bancs donnés ou ceux à remesurer. 0 si chaque banc a mesuré son écart, 1 sinon, 2 si refusé ; rien à remesurer : 0. Correctif de revue L738 : à la main,
 * le passage est `-bruit-main`, jamais compté ; `bruitCompte` (`bruitDuSamedi`, appelé par `complet` seulement, aucune sous-commande) le nomme `-bruit`, compté.
 */
async function remesurerBruit(racine: string, bancs: string | undefined, emp: string, repo: string, io: Io, bruitCompte = false): Promise<number> {
  const numeros = bancs ? bancs.split(',').filter(Boolean) : numerosARemesurer(racine, io.now());
  if (!numeros.length) { io.out('bruit : aucun banc à remesurer (aucun banc bruité, aucun bruit qui expire dans les 7 jours)'); return 0; }
  const ref = PUBLIE.reference, cand = jumeau(ref);
  let refus: string | null;
  try {
    const tous = chargerBras(racine);
    refus = !tous[ref] ? `bras ${ref} absent de ${racine}/bras.yaml` : tous[cand] ? `bras ${cand} déjà défini dans ${racine}/bras.yaml : il est réservé au jumeau de ${ref}`
      : emp === 'inconnue' ? 'empreinte inconnue (pas de dépôt git)' : pretAPasser(repo, { [ref]: tous[ref] }, racine);
  } catch (e) { refus = e instanceof Error ? e.message : String(e); }
  if (refus) { io.err(`bench bruit refusé : ${refus}`); return 2; }
  const v = await passage({ racine, numeros, niveau: 'bruit', ref, cand, hebdo: false, juge: 'opus', exec: executeurClaude, prep: preparer,
    maintenant: io.now(), empreinte: emp, home: io.env.HOME ?? '', out: io.out, depot: depotMesure(repo), bruitCompte });
  return v.vert ? 0 : 1;
}

/** Correctif de revue L738 : le passage A contre A du banc complet, seul compté pour le bruit ; à la main, `bench bruit` ne peut pas débloquer la garde L730. */
export const bruitDuSamedi = (numeros: string[], io: Io, repo = REPO): Promise<number> => remesurerBruit(racineBanc(io.env), numeros.join(','), empreinte(repo), repo, io, true);

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

/** Ce qu'il faut lancer, depuis la version à publier, pour que la garde accepte : le banc mécanique ; pendant une alerte (L730, garde en quatre règles),
 * chaque banc rouge en attente rejoué (`a_rejouer` du statut : le court, ou la séquence de cet id ; un rejeu vert lève l'alerte pour les versions suivantes aussi), puis le banc mécanique s'il manque. */
export const pourPublier = (repo: string, aRejouer: string[] = []) => {
  const meca = `« ${commandeBanc(repo, 'mecanique')} » (${PUBLIE.candidat} contre ${PUBLIE.reference}, sans juge, ≈ 30 min)`;
  if (!aRejouer.length) return `lancer, depuis la version à publier : ${meca}`;
  const cmd = (b: string) => `« ${commandeBanc(repo, b === 'court' ? 'court' : `${b} --repetitions 2 ${BRAS_PUBLIES}`)} »`;
  return `rejouer vert, depuis la version à publier : ${aRejouer.map(cmd).join(', ')} ; puis, si la garde le demande encore, ${meca}`;
};

/** Les lignes ⚠ de la garde (L730) : banc complet rouge (la garde exige les bancs rouges rejoués), banc complet absent ou trop ancien. */
export function alertesGarde(s: ReturnType<typeof statut>): string[] {
  return [
    ...(s.alerte ? [`⚠ ${s.alerte} : la publication exige de nouveau le banc complet ; elle reste refusée tant que chaque banc rouge (${s.a_rejouer.join(', ')}) n'est pas rejoué vert après lui, sur la version corrigée ou une suivante ; corriger le défaut, et revenir sur une version publiée depuis qu'il est apparu`] : []),
    ...(s.jours_depuis_complet === null ? ['⚠ aucun banc complet dans l\'historique : le minuteur du samedi le lance (cadence2 bench complet, docs/v2/banc.md)']
      : s.jours_depuis_complet > COMPLET_MAX_JOURS ? [`⚠ dernier banc complet il y a ${s.jours_depuis_complet} jours : le minuteur du samedi n'a pas tourné (systemctl list-timers cadence-banc.timer)`] : []),
  ];
}

export const SOUS: Record<string, { numeros?: string[]; niveau?: Niveau }> = { court: { numeros: BANCS_COURT }, hebdo: {}, eclair: { numeros: ['1'] }, micro: { numeros: ['1'], niveau: 'micro' }, mecanique: { numeros: BANCS_COURT, niveau: 'mecanique' } };

/** L742 : `cadence2 bench comparer <a> <b>` (noms de rapports/, .json ou .md tolérés) dit d'abord si l'environnement de b diffère de celui de a, puis le titre de
 * chaque rapport. 0 environnements identiques, 1 différents ou non comparables, 2 usage ou rapport illisible. */
function comparer(racine: string, [a, b]: string[], io: Io): number {
  if (!a || !b) { io.err('usage : cadence2 bench comparer <passage-a> <passage-b> (noms des rapports de ~/bench-cadence/rapports/)'); return 2; }
  const nom = (r: string) => r.replace(/\.(json|md)$/, ''), f = (r: string, ext: string) => join(racine, 'rapports', `${nom(r)}.${ext}`);
  let x: { environnement?: Environnement }, y: typeof x;
  try { [x, y] = [a, b].map((r) => JSON.parse(readFileSync(f(r, 'json'), 'utf8'))); } catch (e) { io.err(`bench comparer : ${e instanceof Error ? e.message : String(e)}`); return 2; }
  const ligne = y.environnement ? ligneComparaison(nom(a), x.environnement, y.environnement) : `Environnement non comparable : ${nom(b)} ne le note pas (rapport d'avant L742)`;
  io.out(`${nom(b)} contre ${nom(a)} — ${ligne}`);
  for (const r of [a, b]) io.out(`${nom(r)} : ${existsSync(f(r, 'md')) ? readFileSync(f(r, 'md'), 'utf8').split('\n')[0].replace(/^#\s*/, '') : 'rapport .md absent'}`);
  return ligne.startsWith('Environnement identique') ? 0 : 1;
}

export async function bench(args: string[], io: Io, repo = REPO): Promise<number> {
  const [sous, ...reste] = args;
  if (sous === '_banc' && reste[0]) return bancEnfant(reste[0], io.out);
  const racine = racineBanc(io.env);
  const hist = existsSync(join(racine, 'historique.jsonl')) ? readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n') : [];
  const emp = empreinte(repo);
  const modeles = (): Record<string, string> => { try { return Object.fromEntries(Object.values(chargerBras(racine)).map((d) => [d.nom, d.modele])); } catch { return {}; } };
  if (sous === 'statut') { // L730 : la garde est proportionnée ; une alerte du banc complet se lit ici (⚠, reprise par le hook de démarrage et le tour)
    const s = statut(hist, io.now(), emp, modeles(), PUBLIE);
    io.out(`banc : dernier passage ${s.dernier ?? 'aucun'} ; garde : banc ${s.mode} ; publication ${s.publication_ok ? 'permise' : 'refusée'} sur l'empreinte ${emp}${s.publication_ok ? '' : ` : ${pourPublier(repo, s.a_rejouer)}`}`);
    for (const l of alertesGarde(s)) io.out(l);
    const refus = ligneRefus(racine); if (refus) io.out(refus); // L804 : un banc complet qui n'a pas mesuré se voit au tour du lead, avec sa cause
    if (s.frais_semaine === 0) io.out('⚠ aucun banc frais cette semaine : en ajouter avec « cadence2 bench ajouter »');
    return 0;
  }
  if (sous === 'verifier-publication') {
    const s = statut(hist, io.now(), emp, modeles(), PUBLIE);
    io.out(s.publication_ok ? `banc mécanique ou complet vert sur l'empreinte ${emp}` // permise : aucune alerte ne tient (le mode est alors mécanique)
      : s.mode === 'complet' ? `publication refusée sur l'empreinte ${emp} : ${s.alerte} ; tant qu'une alerte tient, rien ne publie : chaque banc rouge (${s.a_rejouer.join(', ')}) doit être rejoué vert après lui (version corrigée ou suivante), ${PUBLIE.candidat} contre ${PUBLIE.reference}, même modèle ; ${pourPublier(repo, s.a_rejouer)}`
        : `publication refusée sur l'empreinte ${emp} : il faut le dernier banc mécanique (${LIBELLE_COURT}) vert, ${PUBLIE.candidat} contre ${PUBLIE.reference}, même modèle, sans passage rouge après lui ; ${pourPublier(repo)}`);
    return s.publication_ok ? 0 : 1;
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
  if (sous === 'comparer') return comparer(racine, reste, io);
  const bancs = option(reste, 'bancs');
  if (sous === 'bruit') return remesurerBruit(racine, bancs, emp, repo, io);
  const choix = sous === 'lancer' ? (bancs ? { numeros: bancs.split(',') } : null) : Object.hasOwn(SOUS, sous ?? '') ? SOUS[sous!] : null;
  if (choix === null) {
    io.err('usage : cadence2 bench micro|mecanique|court|hebdo|eclair|lancer --bancs 1,3|bruit [--bancs 3,7]|complet|statut|verifier-publication|comparer <a> <b>|ajouter [--candidat c] [--reference r] [--repetitions N] [--paralleles N] [--garder-clones] [--malgre-charge]');
    return 2;
  }
  const rep = entierOption(reste, 'repetitions', 1);
  const demande = option(reste, 'paralleles') === undefined ? undefined : entierOption(reste, 'paralleles', 1);
  if (rep === null || demande === null) { io.err('usage : --repetitions N et --paralleles N (entiers ≥ 1) avec micro|mecanique|court|hebdo|eclair|lancer'); return 2; }
  const par = bancsALaFois(choix.niveau, demande);
  if (typeof par === 'string') { io.err(`bench refusé : ${par}`); return 2; }
  // L762 : le banc mécanique ne part pas sous la charge du lead (runs de cadence run, sessions de lead hold), sauf --malgre-charge, noté au rapport
  const forcer = reste.includes('--malgre-charge');
  if (forcer && choix.niveau !== 'mecanique') { io.err('bench refusé : --malgre-charge ne va qu\'avec mecanique'); return 2; }
  let malgreCharge: string[] | undefined;
  if (choix.niveau === 'mecanique') {
    const occ = occupants(registreCreneaux(io.env), io.now());
    if (forcer) { malgreCharge = nommer(occ); io.out(`banc mécanique forcé malgré la charge (--malgre-charge) : ${malgreCharge.length ? malgreCharge.join(' ; ') : 'aucun run ni session du lead'} ; noté au rapport`); }
    else { const r = refusCharge(occ); if (r) { io.err(`bench refusé : ${r}`); return 2; } }
  }
  const ref = option(reste, 'reference') ?? PUBLIE.reference; const cand = option(reste, 'candidat') ?? PUBLIE.candidat;
  let refus: string | null;
  try {
    const tous = chargerBras(racine);
    refus = ref === cand ? `--candidat et --reference désignent le même bras (${ref})` : [ref, cand].find((n) => !tous[n]) ? `bras absent de ${racine}/bras.yaml` : emp === 'inconnue' ? 'empreinte inconnue (pas de dépôt git)'
      : pretAPasser(repo, { [ref]: tous[ref], [cand]: tous[cand] }, racine);
  } catch (e) { refus = e instanceof Error ? e.message : String(e); }
  if (refus) { io.err(`bench refusé : ${refus}`); return 2; }
  const v = await passage({ racine, numeros: choix.numeros, ...(malgreCharge && { malgreCharge }), niveau: choix.niveau, ref, cand, eclair: sous === 'eclair',
    hebdo: sous === 'hebdo', repetitions: rep, garderClones: reste.includes('--garder-clones'), juge: option(reste, 'juge') ?? 'opus', exec: executeurClaude, prep: preparer,
    maintenant: io.now(), empreinte: emp, home: io.env.HOME ?? '', out: io.out, depot: depotMesure(repo),
    ...(par > 1 && { enfants: { lanceur: [process.execPath, join(repo, 'v2', 'bin', 'cadence2.js')], paralleles: par } }) });
  return v.non_mesurable ? 3 : v.vert && v.eclair_ok !== false ? 0 : 1;
}
