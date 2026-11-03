import type { OrchestrateConfig } from './config.js';
import { recordedGate, type RecordedGate } from './gate-record.js';
import type { GateTest } from './orchestrate/gate-parts.js';
import { git, gitFailure } from './orchestrate/worktree.js';
import { shellArg } from './orchestrate/workers.js';

/**
 * Les fichiers suivis au sha, hors documentation (`docs/`, `.md`, `.txt`), journal `CHANGELOG` (nom exact), plan et `cadence.yaml`, qui citent le chemin du plan (L482) ; vide si aucun ou si git échoue.
 * Chaîne cherchée telle quelle (`-F`), pas comme un motif.
 */
function planReaders(repo: string, sha: string, planFile: string | undefined): string[] {
  if (!planFile) return [];
  try {
    const out = git(repo, 'grep', '-l', '-z', '-I', '-F', '-e', planFile, sha, '--', '.', ':(exclude)docs', ':(exclude)*.md', ':(exclude)*.txt', ':(exclude).cadence', ':(exclude)cadence.yaml', ':(exclude)CHANGELOG');
    return out.split('\0').map((l) => l.slice(sha.length + 1)).filter(Boolean);
  } catch {
    return []; // git grep rend 1 sans correspondance
  }
}

/** Le plan dont les commits seuls sont traversés : aucun si un test le lit, déclaré (L450) ou deviné d'après le code qui cite son chemin sans que `gate.readsPlan` le dise (L482). */
function crossablePlan(repo: string, sha: string, planFile: string | undefined, declared: unknown): string | undefined {
  return declared || planReaders(repo, sha, planFile).length ? undefined : planFile;
}

/** La fin de la raison du rejeu quand les commits de plan seuls ne sont pas traversés : déclaré (L450) ou deviné d'après le code (L482) ; vide sinon. */
function planNote(repo: string, sha: string, planFile: string | undefined, declared: unknown): string {
  const crossing = ' ; les commits de plan seuls ne reprennent pas le verdict d\'un sha dessous';
  if (!planFile) return '';
  if (declared) return ` (orchestrate.gate.readsPlan : un test lit le plan${crossing.replace(' ;', ',')})`;
  const readers = planReaders(repo, sha, planFile);
  if (!readers.length) return '';
  return ` (le code lit le plan, gate.readsPlan absent : ${readers.slice(0, 3).join(', ')}${readers.length > 3 ? ', …' : ''} cite ${planFile}${crossing} — déclarer orchestrate.gate.readsPlan)`;
}


/** Un fichier de test d'après son nom : `*.test.*`, `*.spec.*`, `*.e2e.*`, `*_test.*`, `test_*`. Le dossier ne suffit pas : un helper ou une fixture sous `test/` n'est pas un test que `testReplay` sait jouer, et le test qui l'importe ne cite pas le plan lui-même. */
const isTestFile = (path: string): boolean => /\.(test|spec|e2e)\.[^/]+$/i.test(path) || /(^|\/)test_[^/]*$|_test\.[^/]+$/i.test(path);

/** Un script de skill d'après son chemin : sous un dossier `skills/` (les scripts des skills /reprise et /cloture). Pas `scripts/` : le build ou un test du projet peut le lancer. */
const isToolScript = (path: string): boolean => /(^|\/)skills\//.test(path);

/** Ce que la porte rejoue sous un commit de plan seul quand le verdict du sha dessous vaut pour le reste (L566) : les tests `files` (vide : aucun), les `scripts` de skills qui citent le plan sans être des tests. */
interface PlanReplay {
  files: string[];
  scripts: string[];
}

/**
 * Les lecteurs du plan à rejouer seuls (L566), ou null quand la porte entière reste à rejouer : plan inconnu, porte en parties ou rejeu seul (`testReplay`) absent (cadence ne devine pas comment jouer un fichier),
 * un autre code que des tests et des scripts de skills qui cite le plan (src, CI : L482), `readsPlan: true` dont aucun test n'est détecté (lecteur inconnu, par prudence).
 * Déclaré en liste : ces chemins, tous. Sinon les fichiers qui citent le plan (L482) qui sont des tests ; non déclaré et seulement des scripts de skills qui le citent : rien à rejouer, le verdict du dessous vaut
 * en entier (un test qui lance un script se déclare en liste).
 */
function planReplay(repo: string, sha: string, planFile: string | undefined, declared: unknown, config: OrchestrateConfig): PlanReplay | null {
  if (!planFile) return null;
  const canReplay = typeof config.test === 'string' && !!config.testReplay;
  const readers = planReaders(repo, sha, planFile);
  const files = readers.filter(isTestFile);
  const scripts = readers.filter((r) => !isTestFile(r) && isToolScript(r));
  if (files.length + scripts.length < readers.length) return null;
  if (Array.isArray(declared)) return canReplay ? { files: declared as string[], scripts } : null;
  if (!readers.length) return null;
  if (files.length) return canReplay ? { files, scripts } : null;
  return declared ? null : { files: [], scripts };
}

const replayCommand = (testReplay: string, files: string[]): string => testReplay.replaceAll('{files}', () => files.map(shellArg).join(' '));

const listed = (xs: string[]): string => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ', …' : ''}`;

/** Ce que `verify --gate` fait d'un commit de plan seul au-dessus d'un sha dont des lecteurs du plan sont connus (L566) : `found` (verdict du dessous repris en entier), ou `steps` (seuls ces lecteurs rejoués, `note` dit pourquoi), `notice` : une ligne à écrire. */
interface NarrowedGate {
  found?: RecordedGate;
  steps?: { name: string; cmd: string; gate: GateTest }[];
  note?: string;
  notice?: string;
}

/** Rend null quand la porte entière reste à rejouer (`planReplay` null, ou aucune porte de vague enregistrée au sha dessous ou plus bas sous des commits de plan seuls). */
function narrowedGate(ctx: { repo: string; sha: string; config: OrchestrateConfig; planFile?: string; launchDirs?: string[] }, allSteps: { name: string; cmd: string }[]): NarrowedGate | null {
  const { repo, sha, config } = ctx;
  const narrow = planReplay(repo, sha, ctx.planFile, config.gate?.readsPlan, config);
  if (!narrow) return null;
  let below: ReturnType<typeof recordedGate>;
  try {
    below = recordedGate(ctx.launchDirs ?? [], repo, sha, allSteps, ctx.planFile);
  } catch {
    return null; // état des vagues illisible : la porte entière est rejouée
  }
  if (!('found' in below)) return null;
  if (narrow.files.length === 0) return { found: below.found, notice: `verify --gate ${sha.slice(0, 7)} : le code qui cite le plan n'est pas un test (${listed(narrow.scripts)}) : les commits de plan seuls sont traversés` };
  const cmd = replayCommand(config.testReplay!, narrow.files);
  const scripts = narrow.scripts.length ? ` ; ${listed(narrow.scripts)} cite(nt) le plan sans être un test : non rejoué(s)` : '';
  const note = `verdict repris de la porte de la vague ${below.found.wave} (lot ${below.found.lot}) au sha ${below.found.checked.slice(0, 7)}, sous les seuls commits de plan de ${sha.slice(0, 7)}, pour le build et la suite complète ; seuls les lecteurs du plan sont rejoués : ${narrow.files.join(', ')}${scripts}`;
  return { steps: [{ name: 'tests', cmd, gate: cmd }], note };
}

type Basis = { found: RecordedGate } | { reason: string };

/**
 * Sur quoi `verify --gate` s'appuie avant de rejouer (L397, L444, L450, L482, L566) : la porte déjà jouée par une vague (`recorded`), les étapes à jouer (`steps`, la porte entière sauf sous un commit de plan seul
 * dont seuls des lecteurs du plan sont rejoués) et la raison du rejeu (`replayReason`, qui prend celle de `recorded` quand elle est de rigueur). `out` reçoit les lignes que cette décision doit dire.
 */
export function gateBasis(ctx: Parameters<typeof narrowedGate>[0], allSteps: { name: string; cmd: string; gate: GateTest }[], out: (line: string) => void): { recorded: Basis; steps: typeof allSteps; replayReason: (reason: string) => string } {
  const { repo, sha, config } = ctx;
  let recorded: Basis = { reason: 'aucune porte de vague enregistrée pour ce sha' };
  try {
    // Un test qui lit le plan (orchestrate.gate.readsPlan, L450) voit un autre contenu après un `raf done` : les commits de plan seuls ne sont pas traversés.
    recorded = recordedGate(ctx.launchDirs ?? [], repo, sha, allSteps, crossablePlan(repo, sha, ctx.planFile, config.gate?.readsPlan));
  } catch (e) {
    recorded = { reason: `état des vagues illisible (${gitFailure(e)})` };
  }
  const narrow = 'found' in recorded ? null : narrowedGate(ctx, allSteps);
  if (narrow?.found) recorded = { found: narrow.found };
  if (narrow?.notice) out(narrow.notice);
  const replayReason = (reason: string): string => narrow?.note ?? `verdict rejoué : ${reason}${planNote(repo, sha, ctx.planFile, config.gate?.readsPlan)}`;
  return { recorded, steps: narrow?.steps ?? allSteps, replayReason };
}
