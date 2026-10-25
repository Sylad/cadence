import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Io } from '../cli.js';
import { RafError } from '../plan.js';
import { AGENTS_DIR } from '../skills.js';
import { realClaude, readAgents } from '../orchestrate/launch.js';
import { add } from './add.js';
import { analyse } from './analyse.js';
import { checkInventaire, readInventaire, summaryInventaire } from './check.js';
import { buildCorpus } from './corpus.js';
import { diffLectures } from './diff.js';
import { chargerPlaywright, lancer, rendre } from './corpus-render.js';
import { evaluer, formatEvaluation } from './evaluate.js';
import { measure } from './measure.js';
import { referencesDir } from './store.js';

const USAGE_ADD = 'usage : cadence ref add <document.pdf> [--sections 3-5,9] [--slug nom]';
const USAGE_ANALYSE = 'usage : cadence ref analyse <document.pdf> [--sections 3-5,9] [--slug nom] [--model sonnet|opus|haiku]';
const USAGE_CHECK = 'usage : cadence ref check <inventaire.json | lecture.json>';
const USAGE_DIFF = 'usage : cadence ref diff <lecture-a.json> <lecture-b.json> [--out inventaire.json] [--seuil 30]';
const USAGE_EVAL = 'usage : cadence ref eval <attendu.json | dossier> <lecture.json | dossier> [--json]';
const USAGE_CORPUS = 'usage : cadence ref corpus <dossier> [--sans-rendu]';
const USAGE_MEASURE = 'usage : cadence ref measure <slug> <page> <page | x,y | x,y,l,h> [--quoi couleurs|contraste|boites|texte] [--largeur 1440] [--json]';

/** `cadence ref <sous-verbe> …` : les documents de référence (issue #14) ; `check` valide un inventaire ou une lecture. */
export function refCommand(rest: string[], values: { sections?: string; slug?: string; model?: string; config?: string; 'sans-rendu'?: boolean; out?: string; seuil?: string; 'model-b'?: string; unique?: boolean; quoi?: string; largeur?: string; json?: boolean }, root: string, io: Io): number | Promise<number> {
  const [verb, ...args] = rest;
  const configPath = resolve(io.cwd, values.config ?? join(root, 'cadence.yaml'));
  const refsDir = (): string => referencesDir(root, configPath, io.env);
  if (verb === 'add' && args.length === 1) {
    add({ document: args[0]!, slug: values.slug, sections: values.sections, env: io.env, cwd: io.cwd, refsDir, now: io.now(), out: io.out });
    return 0;
  }
  if (verb === 'analyse' && args.length === 1) {
    const claude = realClaude(io.env.CADENCE_CLAUDE_BIN || 'claude', io.env);
    return analyse({ document: args[0]!, slug: values.slug, sections: values.sections, model: values.model, env: io.env, cwd: io.cwd, refsDir, configPath, claudeHome: io.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), now: io.now(), out: io.out, err: io.err, claude, agents: readAgents(AGENTS_DIR) });
  }
  if (verb === 'measure' && args.length === 3) {
    measure({ slug: args[0]!, page: args[1]!, zone: args[2]!, quoi: values.quoi, largeur: values.largeur, env: io.env, refsDir, json: values.json === true, out: io.out });
    return 0;
  }
  if (verb === 'check' && args.length === 1) {
    // pas d'outil système ni de references.dir : seul le fichier donné est lu (R30)
    const inventaire = readInventaire(resolve(io.cwd, args[0]!));
    const problems = checkInventaire(inventaire);
    for (const m of problems) io.out(`✗ ${m}`);
    if (problems.length > 0) {
      io.out(`${problems.length} écart(s)`);
      return 1;
    }
    io.out(summaryInventaire(inventaire as Record<string, unknown>));
    return 0;
  }
  if (verb === 'diff' && args.length === 2) {
    return diffLectures({ a: resolve(io.cwd, args[0]!), b: resolve(io.cwd, args[1]!), seuil: values.seuil, out: values.out === undefined ? undefined : resolve(io.cwd, values.out), log: io.out });
  }
  if (verb === 'eval' && args.length === 2) {
    const ev = evaluer(resolve(io.cwd, args[0]!), resolve(io.cwd, args[1]!));
    if (values.json === true) io.out(JSON.stringify(ev, null, 2));
    else for (const l of formatEvaluation(ev)) io.out(l);
    return 0;
  }
  if (verb === 'corpus' && args.length === 1) return corpus(resolve(io.cwd, args[0]!), values['sans-rendu'] === true, io);
  const others = (u: string) => u.replace('usage : ', '');
  throw new RafError(verb === 'add' ? USAGE_ADD : verb === 'analyse' ? USAGE_ANALYSE : verb === 'measure' ? USAGE_MEASURE : verb === 'check' ? USAGE_CHECK : verb === 'diff' ? USAGE_DIFF : verb === 'eval' ? USAGE_EVAL : verb === 'corpus' ? USAGE_CORPUS : `${USAGE_ADD}\n       ${others(USAGE_ANALYSE)}\n       ${others(USAGE_MEASURE)}\n       ${others(USAGE_CHECK)}\n       ${others(USAGE_DIFF)}\n       ${others(USAGE_EVAL)}\n       ${others(USAGE_CORPUS)}`);
}

/** `ref corpus <dossier>` : un sous-dossier par piège (document.html, attendu.json, puis document.pdf et page-<n>.png sauf --sans-rendu). */
async function corpus(dossier: string, sansRendu: boolean, io: Io): Promise<number> {
  if (existsSync(dossier)) throw new RafError(`ref corpus : ${dossier} existe déjà (un corpus n'est jamais mêlé à un autre : choisissez un dossier neuf)`);
  const navigateur = sansRendu ? null : await lancer(chargerPlaywright(io.env, io.cwd));
  const cas = buildCorpus();
  for (const c of cas) {
    mkdirSync(join(dossier, c.nom), { recursive: true });
    writeFileSync(join(dossier, c.nom, 'document.html'), c.html);
    writeFileSync(join(dossier, c.nom, 'attendu.json'), `${JSON.stringify(c.inventaire, null, 2)}\n`);
  }
  if (navigateur) {
    await rendre(navigateur, dossier, cas);
    // `ref add` empreint le PDF, qui change à chaque rendu : l'attendu porte celle du PDF écrit
    for (const c of cas) {
      c.inventaire.document.sha256 = createHash('sha256').update(readFileSync(join(dossier, c.nom, 'document.pdf'))).digest('hex');
      writeFileSync(join(dossier, c.nom, 'attendu.json'), `${JSON.stringify(c.inventaire, null, 2)}\n`);
    }
  }
  io.out(`corpus : ${cas.length} cas, ${cas.reduce((n, c) => n + c.pages, 0)} pages, ${cas.reduce((n, c) => n + c.inventaire.elements.length, 0)} éléments attendus dans ${dossier}${sansRendu ? ' (sans rendu : ni PDF ni PNG)' : ''}`);
  return 0;
}
