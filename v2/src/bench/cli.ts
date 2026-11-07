import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../cli.js';
import { listerBancs, racineBanc } from './banc.js';
import { chargerBras, executeurClaude, lancerBras, type Executeur, type Mesure } from './bras.js';
import { fuitesDuBras } from './fuites.js';
import { juger, type Jugement } from './juges.js';
import { preparer } from './preparer.js';
import { BARRE_SPEC, ligneHistorique, rapport, statut, verdict, type ResultatBanc, type Verdict } from './verdict.js';

const REPO = join(import.meta.dirname, '..', '..', '..');
const COURT = ['1', '3', '6'];

export function empreinte(repo: string): string {
  const arbres = ['v2/src', 'v2/briefs'].map((p) => execFileSync('git', ['rev-parse', `HEAD:${p}`], { cwd: repo, encoding: 'utf8' }).trim());
  return createHash('sha1').update(arbres.join('\n')).digest('hex').slice(0, 12);
}

export function passage(o: { racine: string; numeros?: string[]; ref: string; cand: string; hebdo: boolean; juge: string;
  exec: Executeur; prep: typeof preparer; maintenant: Date; empreinte: string; home: string; out: (l: string) => void }): Verdict {
  const date = o.maintenant.toISOString().slice(0, 10);
  const dirRun = join(o.racine, 'runs', `${date}-${o.empreinte}`);
  const bras = chargerBras(o.racine);
  for (const n of [o.ref, o.cand]) if (!bras[n]) throw new Error(`bras « ${n} » absent de ${o.racine}/bras.yaml`);
  const res: ResultatBanc[] = listerBancs(o.racine, o.numeros).map((b, i) => {
    const ordre = i % 2 === 0 ? [o.ref, o.cand] : [o.cand, o.ref];
    const mesures: Record<string, Mesure> = {}; const clones: Record<string, string> = {}; const fuites: Record<string, string[]> = {};
    const mapping: Record<string, string> = {}; // c1/c2 -> bras : écrit seulement après les juges (aveugle)
    let jugement: Jugement | null = null;
    try {
      ordre.forEach((n, k) => {
        const c = join(dirRun, b.id, `c${k + 1}`);
        mapping[`c${k + 1}`] = n; clones[n] = c;
        o.prep(b, c);
        o.out(`${b.id} : bras ${n}…`);
        mesures[n] = lancerBras(b, bras[n], c, o.exec);
        fuites[n] = fuitesDuBras(o.home, o.racine, b.id, c);
      });
      if (ordre.some((n) => mesures[n].echec !== null)) o.out(`${b.id} : un bras en échec, juges sautés`);
      else {
        o.out(`${b.id} : juges…`);
        jugement = juger(b, clones, join(o.racine, 'eval', `${date}-${o.empreinte}`, b.id), o.juge, o.exec);
      }
    } catch (e) {
      const msg = `préparation : ${e instanceof Error ? e.message : String(e)}`;
      for (const n of ordre) if (!mesures[n]) {
        mesures[n] = { bras: n, banc: b.id, debut: o.maintenant.toISOString(), fin: o.maintenant.toISOString(), duree_s: 0, tokens: 0,
          cout_usd: 0, questions: 0, questions_texte: [], sessions: [], echec: msg };
        fuites[n] = [];
      }
      o.out(`${b.id} : ${msg}`);
    }
    const r: ResultatBanc = { banc: b.id, taille: b.taille, visible: b.visible, reponses: b.reponses, frais: b.frais, mesures, jugement, fuites };
    mkdirSync(join(dirRun, b.id), { recursive: true });
    writeFileSync(join(dirRun, b.id, 'resultat.json'), JSON.stringify({ ...r, clones: mapping }, null, 2));
    return r;
  });
  const v = verdict(res, o.ref, o.cand, BARRE_SPEC);
  mkdirSync(join(o.racine, 'rapports'), { recursive: true });
  const base = join(o.racine, 'rapports', `${date}-${o.empreinte}`);
  writeFileSync(`${base}.md`, rapport(res, o.ref, o.cand, v, { date, empreinte: o.empreinte }));
  writeFileSync(`${base}.json`, JSON.stringify({ verdict: v, resultats: res }, null, 2));
  appendFileSync(join(o.racine, 'historique.jsonl'), `${ligneHistorique(v, { date: o.maintenant.toISOString(), empreinte: o.empreinte,
    candidat: o.cand, bancs: res.map((r) => r.banc), hebdo: o.hebdo, frais: res.filter((r) => r.frais).length })}\n`);
  o.out(`${v.vert ? 'VERT' : 'ROUGE'} — rapport : ${base}.md`);
  return v;
}

function option(args: string[], nom: string): string | undefined {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function bench(args: string[], io: Io): Promise<number> {
  const [sous, ...reste] = args;
  const racine = racineBanc(io.env);
  const emp = empreinte(REPO);
  const hist = existsSync(join(racine, 'historique.jsonl')) ? readFileSync(join(racine, 'historique.jsonl'), 'utf8').split('\n') : [];
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
  const numeros = sous === 'court' ? COURT : sous === 'hebdo' ? undefined : sous === 'lancer' ? (option(reste, 'bancs')?.split(',') ?? null) : null;
  if (numeros === null) { io.err('usage : cadence2 bench court|hebdo|lancer --bancs 1,3|statut|verifier-publication|ajouter [--candidat c] [--reference r]'); return 2; }
  const v = passage({ racine, numeros, ref: option(reste, 'reference') ?? 'A', cand: option(reste, 'candidat') ?? 'equipe-legere',
    hebdo: sous === 'hebdo', juge: option(reste, 'juge') ?? 'opus', exec: executeurClaude, prep: preparer,
    maintenant: io.now(), empreinte: emp, home: io.env.HOME ?? '', out: io.out });
  return v.vert ? 0 : 1;
}
