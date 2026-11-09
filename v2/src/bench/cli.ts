import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Io } from '../cli.js';
import { ajouterBanc } from './ajouter.js';
import { chargerBanc, listerBancs, racineBanc, type Banc } from './banc.js';
import { chargerBras, executeurClaude, lancerBras, libererReglages, type DefBras, type Executeur, type Mesure } from './bras.js';
import { fuitesDuBras } from './fuites.js';
import { etatGit, juger, travailNonLivre, type Jugement } from './juges.js';
import { preparer } from './preparer.js';
import { BARRE_SPEC, banBase, ligneHistorique, parisJour, rapport, statut, verdict, type ResultatBanc, type Verdict } from './verdict.js';

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

type OptPassage = { racine: string; numeros?: string[]; ref: string; cand: string; hebdo: boolean; juge: string; repetitions?: number; garderClones?: boolean;
  exec: Executeur; prep: typeof preparer; maintenant: Date; empreinte: string; home: string; out: (l: string) => void; eclair?: boolean };

export function passage(o: OptPassage): Verdict & { eclair_ok?: boolean } {
  const liberer = verrouiller(o.racine);
  try { return passageVerrouille(o); } finally { try { rmSync(join(o.racine, 'en-cours.json'), { force: true }); } finally { liberer(); } }
}

function passageVerrouille(o: OptPassage): Verdict & { eclair_ok?: boolean } {
  const { jour: date, hhmm } = parisJour(o.maintenant); // nom du passage à l'heure de Paris, comme statut
  const id = `${date}-${hhmm}-${o.empreinte}`;
  const dirRun = join(o.racine, 'runs', id);
  const bras = chargerBras(o.racine);
  for (const n of [o.ref, o.cand]) if (!bras[n]) throw new Error(`bras « ${n} » absent de ${o.racine}/bras.yaml`);
  const clonesParBanc: Record<string, unknown>[] = [];
  const N = o.repetitions ?? 1;
  const ids = listerBancs(o.racine, o.numeros);
  const debut = new Date().toISOString(); let termines = 0;
  /** `en-cours.json` : ce que le HUD montre pendant le passage (écrit par renommage, jamais à moitié). */
  const signaler = (banc: string, repetition: number, phase: string) => {
    const f = join(o.racine, 'en-cours.json');
    writeFileSync(`${f}.tmp`, JSON.stringify({ run: id, debut, candidat: o.cand, reference: o.ref, bancs_total: ids.length * N, banc, repetition, phase, phase_debut: new Date().toISOString(), termines }));
    renameSync(`${f}.tmp`, f);
  };
  const jouer = (bid: string, i: number, k: number): ResultatBanc => {
    const ordre = (i + k - 1) % 2 === 0 ? [o.ref, o.cand] : [o.cand, o.ref];
    const idBanc = N > 1 ? `${bid}#${k}` : bid; const sous = N > 1 ? join(bid, `r${k}`) : bid;
    const mesures: Record<string, Mesure> = {}; const clones: Record<string, string> = {}; const fuites: Record<string, string[]> = {}; const aVerifier: Record<string, string[]> = {}; const suiteBase: Record<string, number> = {}; const bases: Record<string, string> = {};
    const mapping: Record<string, string> = {}; // c1/c2 -> bras : écrit seulement après les juges (aveugle)
    let jugement: Jugement | null = null; let phase = 'banc invalide'; let b: Banc | undefined;
    const aller = (p: string) => { phase = p; signaler(bid, k, p); };
    try {
      const bc = chargerBanc(o.racine, bid); b = bc;
      ordre.forEach((n, j) => {
        const c = join(dirRun, sous, `c${j + 1}`);
        mapping[`c${j + 1}`] = n; clones[n] = c;
        aller('préparation'); suiteBase[n] = o.prep(bc, c).testsBase;
        o.out(`${idBanc} : bras ${n}…`);
        const avant = etatGit(c); bases[n] = avant.head;
        aller(`bras ${n}`); const m = lancerBras(bc, bras[n], c, o.exec, undefined, { pieces: [], racine: o.racine });
        mesures[n] = { ...m, banc: idBanc, echec: m.echec ?? travailNonLivre(avant, etatGit(c)), taille_declaree: tailleDeclaree(c, avant.head) };
        aller('fuites'); const fu = fuitesDuBras(o.home, o.racine, bid, c); fuites[n] = fu.certaines; aVerifier[n] = fu.a_verifier;
      });
      if (ordre.some((n) => mesures[n].echec !== null)) o.out(`${idBanc} : un bras en échec, juges sautés`);
      else {
        o.out(`${idBanc} : juges…`);
        aller('juges');
        jugement = juger(bc, clones, join(o.racine, 'eval', id, sous), o.juge, o.exec);
      }
    } catch (e) {
      const msg = `${phase} : ${e instanceof Error ? e.message : String(e)}`;
      for (const n of ordre) if (!mesures[n]) {
        mesures[n] = { bras: n, banc: idBanc, debut: o.maintenant.toISOString(), fin: o.maintenant.toISOString(), duree_s: 0, tokens: 0,
          cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: msg };
        fuites[n] = []; aVerifier[n] = [];
      }
      o.out(`${idBanc} : ${msg}`);
    }
    clonesParBanc.push(mapping);
    const r: ResultatBanc = { banc: idBanc, taille: b?.taille ?? 'fonction', visible: b?.visible ?? false, reponses: b?.reponses ?? false, frais: b?.frais ?? false, mesures, jugement, fuites, fuites_a_verifier: aVerifier };
    mkdirSync(join(dirRun, sous), { recursive: true });
    writeFileSync(join(dirRun, sous, 'resultat.json'), JSON.stringify({ ...r, clones: mapping, suite_base: suiteBase }, null, 2));
    if (!o.garderClones) for (const n of ordre) if (clones[n]) archiver(clones[n], bases[n]);
    termines++;
    return r;
  };
  const res: ResultatBanc[] = ids.flatMap((bid, i) => Array.from({ length: N }, (_, k) => jouer(bid, i, k + 1)));
  const v = verdict(res, o.ref, o.cand, BARRE_SPEC);
  const e = o.eclair ? controlesEclair(res, o.ref, o.cand) : undefined;
  e?.lignes.forEach((l) => o.out(l));
  mkdirSync(join(o.racine, 'rapports'), { recursive: true });
  const base = join(o.racine, 'rapports', id);
  writeFileSync(`${base}.md`, rapport(res, o.ref, o.cand, v, { date, empreinte: o.empreinte, repetitions: N, eclair: e?.lignes }));
  writeFileSync(`${base}.json`, JSON.stringify({ verdict: v, resultats: res.map((r, i) => ({ ...r, clones: clonesParBanc[i] })) }, null, 2));
  appendFileSync(join(o.racine, 'historique.jsonl'), `${ligneHistorique(v, { date: o.maintenant.toISOString(), empreinte: o.empreinte,
    candidat: o.cand, reference: o.ref, modele_candidat: bras[o.cand].modele, bancs: res.map((r) => r.banc), hebdo: o.hebdo, frais: new Set(res.filter((r) => r.frais).map((r) => banBase(r.banc))).size, ...(e && { eclair_ok: e.ok }) })}\n`);
  o.out(`${v.vert ? 'VERT' : 'ROUGE'} — rapport : ${base}.md`);
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

const repetitions = (args: string[]): number | null => { const v = option(args, 'repetitions'); if (v === undefined) return 1; return /^[1-9]\d*$/.test(v) ? Number(v) : null; };

const option = (args: string[], nom: string): string | undefined => { const i = args.indexOf(`--${nom}`); return i >= 0 ? args[i + 1] : undefined; };

export async function bench(args: string[], io: Io): Promise<number> {
  const [sous, ...reste] = args;
  const racine = racineBanc(io.env);
  const hist = existsSync(join(racine, 'historique.jsonl')) ? readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n') : [];
  const emp = empreinte(REPO);
  const modeles = (): Record<string, string> => { try { return Object.fromEntries(Object.values(chargerBras(racine)).map((d) => [d.nom, d.modele])); } catch { return {}; } };
  if (sous === 'statut') {
    const s = statut(hist, io.now(), emp, modeles());
    io.out(`banc : dernier passage ${s.dernier ?? 'aucun'} ; publication ${s.publication_ok ? 'permise' : 'refusée'} sur l'empreinte ${emp}`);
    if (!s.banc_du_weekend) io.out('⚠ BANC DU WEEKEND MANQUANT : lancer « cadence2 bench hebdo » avant toute publication');
    if (s.frais_semaine === 0) io.out('⚠ aucun banc frais cette semaine : en ajouter avec « cadence2 bench ajouter »');
    return s.banc_du_weekend ? 0 : 1;
  }
  if (sous === 'verifier-publication') {
    const ok = statut(hist, io.now(), emp, modeles()).publication_ok;
    io.out(ok ? `banc court et séquence verts sur l'empreinte ${emp}` : `publication refusée sur l'empreinte ${emp} : il faut le dernier banc court ET la dernière séquence verts, même candidat et même modèle`);
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
  const numeros = sous === 'court' ? COURT : sous === 'hebdo' ? undefined : sous === 'eclair' ? ['1'] : sous === 'lancer' ? (option(reste, 'bancs')?.split(',') ?? null) : null;
  if (numeros === null) { io.err('usage : cadence2 bench court|hebdo|eclair|lancer --bancs 1,3|statut|verifier-publication|ajouter [--candidat c] [--reference r] [--repetitions N] [--garder-clones]'); return 2; }
  const rep = repetitions(reste);
  if (rep === null) { io.err('usage : --repetitions N (entier ≥ 1) avec court|hebdo|eclair|lancer'); return 2; }
  const ref = option(reste, 'reference') ?? 'A'; const cand = option(reste, 'candidat') ?? 'equipe-legere';
  let refus: string | null;
  try {
    const tous = chargerBras(racine);
    refus = ref === cand ? `--candidat et --reference désignent le même bras (${ref})` : [ref, cand].find((n) => !tous[n]) ? `bras absent de ${racine}/bras.yaml` : emp === 'inconnue' ? 'empreinte inconnue (pas de dépôt git)'
      : pretAPasser(REPO, { [ref]: tous[ref], [cand]: tous[cand] }, racine);
  } catch (e) { refus = e instanceof Error ? e.message : String(e); }
  if (refus) { io.err(`bench refusé : ${refus}`); return 2; }
  const v = passage({ racine, numeros, ref, cand, eclair: sous === 'eclair',
    hebdo: sous === 'hebdo', repetitions: rep, garderClones: reste.includes('--garder-clones'), juge: option(reste, 'juge') ?? 'opus', exec: executeurClaude, prep: preparer,
    maintenant: io.now(), empreinte: emp, home: io.env.HOME ?? '', out: io.out });
  return v.vert && v.eclair_ok !== false ? 0 : 1;
}
