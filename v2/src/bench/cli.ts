import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Io } from '../cli.js';
import { ajouterBanc } from './ajouter.js';
import { listerBancs, racineBanc } from './banc.js';
import { chargerBras, executeurClaude, lancerBras, type DefBras, type Executeur, type Mesure } from './bras.js';
import { fuitesDuBras } from './fuites.js';
import { juger, type Jugement } from './juges.js';
import { preparer } from './preparer.js';
import { BARRE_SPEC, ligneHistorique, rapport, statut, verdict, type ResultatBanc, type Verdict } from './verdict.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const COURT = ['1', '3', '6'];

export function empreinte(repo: string): string {
  try {
    const arbres = ['v2/src', 'v2/briefs'].map((p) => execFileSync('git', ['rev-parse', `HEAD:${p}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return createHash('sha1').update(arbres.join('\n')).digest('hex').slice(0, 12);
  } catch { return 'inconnue'; }
}

const plusRecent = (dir: string, t: number): string | null => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    const r = f.isDirectory() ? plusRecent(p, t) : statSync(p).mtimeMs > t ? p : null;
    if (r) return r;
  }
  return null;
};

/** Le passage ne mesure que ce que l'empreinte décrit : null = prêt, sinon la raison du refus. */
export function pretAPasser(repo: string, bras: Record<string, DefBras>, racine = ''): string | null {
  const sale = execFileSync('git', ['status', '--porcelain', '--', 'v2/src', 'v2/briefs'], { cwd: repo, encoding: 'utf8' }).trim();
  if (sale) return `v2/src ou v2/briefs a des changements non commités (l'empreinte ne les voit pas) :\n${sale}`;
  const cli = join(repo, 'v2', 'dist', 'cli.js');
  if (!existsSync(cli)) return 'v2/dist/cli.js absent : lancer « npm run build » dans v2';
  const neuf = plusRecent(join(repo, 'v2', 'src'), statSync(cli).mtimeMs);
  if (neuf) return `${neuf} est plus récent que v2/dist/cli.js : lancer « npm run build » dans v2`;
  const briefs = join(repo, 'v2', 'briefs') + '/';
  for (const d of Object.values(bras)) if (!resolve(racine, d.brief).startsWith(briefs)) return `brief du bras ${d.nom} hors de ${briefs} : ${d.brief}`;
  return null;
}

const vivant = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

const bootId = (): string => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; } };

/** Un seul passage à la fois par racine : verrou à création exclusive, repris si son pid est mort. */
function verrouiller(racine: string): () => void {
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

type OptPassage = { racine: string; numeros?: string[]; ref: string; cand: string; hebdo: boolean; juge: string;
  exec: Executeur; prep: typeof preparer; maintenant: Date; empreinte: string; home: string; out: (l: string) => void;
  avantVerdict?: (res: ResultatBanc[]) => void };

export function passage(o: OptPassage): Verdict {
  const liberer = verrouiller(o.racine);
  try { return passageVerrouille(o); } finally { liberer(); }
}

function passageVerrouille(o: OptPassage): Verdict {
  const date = o.maintenant.toISOString().slice(0, 10);
  const id = `${date}-${o.maintenant.toISOString().slice(11, 16).replace(':', '')}-${o.empreinte}`;
  const dirRun = join(o.racine, 'runs', id);
  const bras = chargerBras(o.racine);
  for (const n of [o.ref, o.cand]) if (!bras[n]) throw new Error(`bras « ${n} » absent de ${o.racine}/bras.yaml`);
  const clonesParBanc: Record<string, unknown>[] = [];
  const res: ResultatBanc[] = listerBancs(o.racine, o.numeros).map((b, i) => {
    const ordre = i % 2 === 0 ? [o.ref, o.cand] : [o.cand, o.ref];
    const mesures: Record<string, Mesure> = {}; const clones: Record<string, string> = {}; const fuites: Record<string, string[]> = {};
    const mapping: Record<string, string> = {}; // c1/c2 -> bras : écrit seulement après les juges (aveugle)
    let jugement: Jugement | null = null; let phase = 'préparation';
    try {
      ordre.forEach((n, k) => {
        const c = join(dirRun, b.id, `c${k + 1}`);
        mapping[`c${k + 1}`] = n; clones[n] = c;
        phase = 'préparation'; o.prep(b, c);
        o.out(`${b.id} : bras ${n}…`);
        phase = `bras ${n}`; mesures[n] = lancerBras(b, bras[n], c, o.exec);
        phase = 'fuites'; fuites[n] = fuitesDuBras(o.home, o.racine, b.id, c);
      });
      if (ordre.some((n) => mesures[n].echec !== null)) o.out(`${b.id} : un bras en échec, juges sautés`);
      else {
        o.out(`${b.id} : juges…`);
        phase = 'juges';
        jugement = juger(b, clones, join(o.racine, 'eval', id, b.id), o.juge, o.exec);
      }
    } catch (e) {
      const msg = `${phase} : ${e instanceof Error ? e.message : String(e)}`;
      for (const n of ordre) if (!mesures[n]) {
        mesures[n] = { bras: n, banc: b.id, debut: o.maintenant.toISOString(), fin: o.maintenant.toISOString(), duree_s: 0, tokens: 0,
          cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: msg };
        fuites[n] = [];
      }
      o.out(`${b.id} : ${msg}`);
    }
    clonesParBanc.push(mapping);
    const r: ResultatBanc = { banc: b.id, taille: b.taille, visible: b.visible, reponses: b.reponses, frais: b.frais, mesures, jugement, fuites };
    mkdirSync(join(dirRun, b.id), { recursive: true });
    writeFileSync(join(dirRun, b.id, 'resultat.json'), JSON.stringify({ ...r, clones: mapping }, null, 2));
    return r;
  });
  const v = verdict(res, o.ref, o.cand, BARRE_SPEC);
  mkdirSync(join(o.racine, 'rapports'), { recursive: true });
  const base = join(o.racine, 'rapports', id);
  writeFileSync(`${base}.md`, rapport(res, o.ref, o.cand, v, { date, empreinte: o.empreinte }));
  writeFileSync(`${base}.json`, JSON.stringify({ verdict: v, resultats: res.map((r, i) => ({ ...r, clones: clonesParBanc[i] })) }, null, 2));
  appendFileSync(join(o.racine, 'historique.jsonl'), `${ligneHistorique(v, { date: o.maintenant.toISOString(), empreinte: o.empreinte,
    candidat: o.cand, bancs: res.map((r) => r.banc), hebdo: o.hebdo, frais: res.filter((r) => r.frais).length })}\n`);
  o.avantVerdict?.(res);
  o.out(`${v.vert ? 'VERT' : 'ROUGE'} — rapport : ${base}.md`);
  return v;
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
  const a = m(ref); const c = m(cand);
  const tempsOk = c.t <= BARRE_SPEC.temps_max_retouche * a.t; const questionsOk = c.q === 0;
  return { ok: tempsOk && questionsOk, lignes: [
    `temps candidat ≤ ${BARRE_SPEC.temps_max_retouche.toString().replace('.', ',')} × A : ${tempsOk ? 'ok' : 'ROUGE'} (${c.t} s contre ${a.t} s)`,
    `questions du candidat : 0 / ${c.q} ${questionsOk ? 'ok' : 'ROUGE'}`] };
}

function option(args: string[], nom: string): string | undefined {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function bench(args: string[], io: Io): Promise<number> {
  const [sous, ...reste] = args;
  const racine = racineBanc(io.env);
  const hist = existsSync(join(racine, 'historique.jsonl')) ? readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n') : [];
  const emp = empreinte(REPO);
  if (sous === 'statut') {
    const s = statut(hist, io.now(), emp);
    io.out(`banc : dernier passage ${s.dernier ?? 'aucun'} ; publication ${s.publication_ok ? 'permise' : 'refusée'} sur l'empreinte ${emp}`);
    if (!s.banc_du_weekend) io.out('⚠ BANC DU WEEKEND MANQUANT : lancer « cadence2 bench hebdo » avant toute publication');
    if (s.frais_semaine === 0) io.out('⚠ aucun banc frais cette semaine : en ajouter avec « cadence2 bench ajouter »');
    return s.banc_du_weekend ? 0 : 1;
  }
  if (sous === 'verifier-publication') {
    const ok = statut(hist, io.now(), emp).publication_ok;
    io.out(ok ? `banc vert sur l'empreinte ${emp}` : `aucun banc vert sur l'empreinte ${emp} : lancer « cadence2 bench court »`);
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
  if (numeros === null) { io.err('usage : cadence2 bench court|hebdo|eclair|lancer --bancs 1,3|statut|verifier-publication|ajouter [--candidat c] [--reference r]'); return 2; }
  const ref = option(reste, 'reference') ?? 'A'; const cand = option(reste, 'candidat') ?? 'equipe-legere';
  let refus: string | null;
  try {
    const tous = chargerBras(racine);
    refus = [ref, cand].find((n) => !tous[n]) ? `bras absent de ${racine}/bras.yaml` : emp === 'inconnue' ? 'empreinte inconnue (pas de dépôt git)'
      : pretAPasser(REPO, { [ref]: tous[ref], [cand]: tous[cand] }, racine);
  } catch (e) { refus = e instanceof Error ? e.message : String(e); }
  if (refus) { io.err(`bench refusé : ${refus}`); return 2; }
  let eclair = true;
  const v = passage({ racine, numeros, ref, cand,
    avantVerdict: sous === 'eclair' ? (res) => { const e = controlesEclair(res, ref, cand); eclair = e.ok; e.lignes.forEach((l) => io.out(l)); } : undefined,
    hebdo: sous === 'hebdo', juge: option(reste, 'juge') ?? 'opus', exec: executeurClaude, prep: preparer,
    maintenant: io.now(), empreinte: emp, home: io.env.HOME ?? '', out: io.out });
  return v.vert && eclair ? 0 : 1;
}
