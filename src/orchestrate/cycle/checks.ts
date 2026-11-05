import { type LotState, type Constat, lotKey } from '../state.js';
import { type LotCtx, workDir as wd, setGate, startSha } from './ctx.js';
import { withPlace, type Place } from '../gate-place.js';
import { tryGit } from '../../git.js';
import { sh } from './sh.js';
import { gateLabel, gateReplayable, redCandidates, replayGate } from '../gate-parts.js';
import { playTests, type Portee } from './porte-ciblee.js';
import { type VsBase, againstBaseline, redAtStart } from './baseline-run.js';
import { type TightTest } from '../workers.js';
import { noteUnstable, noteTight } from '../gate-notes.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../../config-set.js';
import { RafError } from '../../plan.js';
/** Un contrôle lancé par le programme : sa commande, son code, et les tests rouges qui l'étaient déjà au sha de départ (L213). */
export type CheckRun = NonNullable<LotState['checks']>['runs'][number];

/**
 * L504 : le cadence.yaml que le lot a modifié est relu avec les chargeurs de la copie EN SERVICE (celle qui joue cette vague). Une clé que seul le code du lot connaît (31-10 : `orchestrate.probe` posé par L497)
 * fait refuser toute commande cadence sur le dépôt dès l'intégration, jusqu'à `npm run service` : le lot la pose dans un lot qui suit la mise en service. Un cadence.yaml que le lot n'a pas touché n'est pas son défaut.
 */
function configRefusee(c: LotCtx): Constat | null {
  const dir = wd(c);
  const start = startSha(c);
  const file = join(dir, 'cadence.yaml');
  if (!start || !tryGit(dir, ['diff', '--name-only', start, 'HEAD', '--', 'cadence.yaml']) || !existsSync(file)) return null;
  try {
    validateConfig(file, dir);
  } catch (e) {
    if (!(e instanceof RafError)) throw e;
    const motif = e.message.split('\n')[0]!.replaceAll(file, 'cadence.yaml');
    return { source: 'code', gravite: 'bloquant', fichier: 'cadence.yaml', texte: `cadence.yaml refusé par la copie en service de cadence (${motif}) : une clé posée avant sa mise en service casse toute commande cadence sur le dépôt. Retirer la clé (ou corriger la valeur) ; elle se pose dans un lot qui suit \`npm run service\`.` };
  }
  return null;
}

/**
 * Les contrôles du programme (`orchestrate.build` puis `orchestrate.test`, L333 : les tests e2e lisent le `dist` que seul le build produit), joués dans `wd(c)` : chaque résultat est ajouté à `runs`, chaque rouge NOUVEAU à `red`
 * (un test déjà rouge au sha de départ n'en est pas un, L213). S'arrête au premier rouge : un build rouge rend le lot sans lancer les tests. Après une écriture (work) et, au sommet rebasé, avant l'avance de la branche du dépôt (R7).
 * `portee` (L590) : `ciblee` (défaut, après une écriture) ne joue que les tests liés aux fichiers du lot, la suite complète quand il n'y en a pas ; `complete` (intégration) joue toujours la suite entière.
 */
export async function programChecks(c: LotCtx, red: Constat[], runs: CheckRun[], portee: Portee = 'ciblee'): Promise<void> {
  const config = configRefusee(c);
  if (config) {
    red.push(config);
    return;
  }
  // L624 : la porte qui attend un créneau de porte sur l'hôte (`gate.maxParallel`) se lit dans l'état du lot (« porte en attente de l'hôte »), et le lot ne tient alors ni file du pool ni créneau annoncé : il n'occupe ni session ni processeur local.
  const onWait = () => setGate(c, { label: c.config.build ? 'build' : 'tests', started: new Date().toISOString(), remote: true, waiting: true });
  try {
    // Sur l'hôte `gate.host` (L403) quand il y en a un : le HEAD du worktree du lot, s'il est propre ; sinon, ou sans hôte, en local.
    await withPlace({ config: c.config, repo: c.lot.repo, sha: tryGit(wd(c), ['rev-parse', 'HEAD']), dir: wd(c), needClean: true, label: `porte du lot ${c.lot.lot}`, local: (cmd) => sh(c, cmd), say: (line) => c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} · ${line}`), owner: c.lot, onWait, onLocal: () => c.lot.gate && setGate(c, { label: c.lot.gate.label, started: c.lot.gate.started }) }, (place) => runChecks(c, red, runs, place, portee));
  } finally {
    // L395 : la porte se lit dans l'état du lot tant qu'une commande (ou le rejeu qui la suit) tourne, jamais après.
    setGate(c, undefined);
  }
}

async function runChecks(c: LotCtx, red: Constat[], runs: CheckRun[], place: Place, portee: Portee): Promise<void> {
  const l = c.lot;
  for (const [label, command] of [['build', c.config.build], ['tests', c.config.test]] as const) {
    if (!command) continue;
    setGate(c, { label, started: new Date().toISOString(), ...(place.remote() ? { remote: true as const } : {}) });
    // Tests : ciblés sur les fichiers du lot ou suite complète (L590) ; build et suite complète comme avant. `settle` : le rouge de charge que le rejeu seul a absous passe à 0 dans le CheckRun et dans la liste des portes.
    const { r, run, settle } = await playTests(c, place, label, command, portee);
    runs.push(run);
    if (r.code === 0) continue;
    const vs: VsBase = label === 'tests' ? await againstBaseline(c, command, r) : { kind: 'unknown' };
    const onlyExisting = (n: number): void => {
      run.dejaRouges = n;
      const note = `${n} test(s) déjà rouge(s) au sha de départ ${(l.baseline?.sha ?? '').slice(0, 7)}, pas un défaut du lot : listés à part, la revue a lieu`;
      if (!l.warnings.includes(note)) l.warnings.push(note);
    };
    if (vs.kind === 'existing') {
      onlyExisting(vs.n);
      continue;
    }
    // Un rouge absent de la ligne de base est rejoué SEUL avant d'être compté (L354) : sous charge, des tests qui passent seuls rougissent ensemble.
    // Sans `orchestrate.testReplay` rien n'est rejoué : le rouge est compté tel quel et rien n'est tenu pour instable (L354).
    const named = label !== 'tests' || !gateReplayable(c.config.test, c.config.testReplay) ? [] : vs.kind === 'new' ? vs.nouveaux : redCandidates(r);
    const { red: still, unstable, tight } = named.length ? await replayGate(place.run, c.config.testReplay, named, r) : { red: [] as string[], unstable: [] as string[], tight: [] as TightTest[] };
    if (unstable.length) {
      noteUnstable(c, unstable.filter((t) => !tight.some((k) => k.test === t)));
      noteTight(c, tight);
      run.instables = unstable;
    }
    if (unstable.length && !still.length) {
      if (vs.kind === 'new' && vs.existants) run.dejaRouges = vs.existants;
      else settle();
      continue;
    }
    // L510 : un rouge qui reste rouge seul dans le lot mais que la suite entière du départ avait vu vert (ordre, charge) peut être rouge seul au départ aussi : déjà rouge, ni correction ni escalade.
    const atStart = still.length ? await redAtStart(c, still, r) : [];
    if (atStart.length) {
      const note = `${atStart.length} test(s) déjà rouge(s) au sha de départ ${startSha(c)?.slice(0, 7)} (rouge(s) seuls aussi, absent(s) de la ligne de base), pas un défaut du lot : ${atStart.join(' ; ')}`;
      if (!l.warnings.includes(note)) l.warnings.push(note);
      if (atStart.length === still.length) {
        run.dejaRouges = atStart.length + (vs.kind === 'new' ? vs.existants : 0);
        continue;
      }
    }
    const fresh = still.filter((t) => !atStart.includes(t));
    const alone = unstable.length ? `\n(${unstable.length} test(s) rouge(s) sous charge, verts rejoués seuls : instables, à ne pas corriger)` : '';
    if (vs.kind === 'new') {
      const left = vs.nouveaux.filter((t) => !unstable.includes(t) && !atStart.includes(t));
      red.push({ source: 'tests', gravite: 'bloquant', texte: `${run.command} en échec (code ${r.code}) : ${left.length} test(s) rouge(s) qui ne l'étaient pas au sha de départ :\n${left.map((t) => `- ${t}`).join('\n')}${vs.existants ? `\n(${vs.existants} autre(s) test(s) déjà rouge(s) au sha de départ : à ne pas corriger)` : ''}${alone}` });
      return;
    }
    // Des instables sont écartés : la sortie de la suite entière les montre encore en FAIL, le constat ne nomme que ceux qui restent rouges.
    const shown = unstable.length || atStart.length ? `${fresh.length} test(s) rouge(s) après rejeu seul :\n${fresh.map((t) => `- ${t}`).join('\n')}` : r.output.trim().split('\n').slice(-40).join('\n');
    red.push({ source: 'tests', gravite: 'bloquant', texte: `${run.command} en échec (code ${r.code}) :\n${shown}${alone}` });
    return;
  }
}

/**
 * Contrôles du sommet intégré (L328) : un rouge est relancé une fois avant de rendre le lot. Le 25-10, L326 a été rendu pour un rouge de charge (L325 tournait en même
 * temps) alors que le même sommet rejoué seul était vert. Rouge deux fois = rendu, avec le résultat de la seconde passe ; vert à la relance = une alerte sur le lot et une ligne du journal.
 */
export async function integratedChecks(c: LotCtx, key: string): Promise<{ red: Constat[]; runs: CheckRun[] }> {
  const first: Constat[] = [];
  let runs: CheckRun[] = [];
  await programChecks(c, first, runs, 'complete');
  if (!first.length) return { red: first, runs };
  c.wave.log(`${key} tests rouges au sommet intégré, relancés une fois (${first.map(redExcerpt).join(' ; ')})`);
  const red: Constat[] = [];
  runs = [];
  await programChecks(c, red, runs, 'complete');
  if (!red.length) c.lot.warnings.push(`rouge au sommet intégré, vert à la relance (charge de la machine ?) : ${first.map(redExcerpt).join(' ; ')}`);
  return { red, runs };
}

const EXCERPT_LINES = 10;

/**
 * Le constat rouge d'un contrôle, en une ligne pour le motif d'un refus (L328) : la commande, puis les tests rouges nommés quand le constat les liste (« - nom »),
 * sinon la fin de la sortie. La première ligne seule laissait « npx vitest run en échec (code 1) : » sans un nom de test.
 */
export function redExcerpt(k: Constat): string {
  const [head, ...rest] = k.texte.split('\n');
  const lines = rest.map((x) => x.trim()).filter(Boolean);
  const named = lines.filter((x) => x.startsWith('- '));
  const shown = named.length ? named.slice(0, EXCERPT_LINES) : lines.slice(-EXCERPT_LINES);
  const more = named.length > EXCERPT_LINES ? [`… (+${named.length - EXCERPT_LINES})`] : [];
  return [head.replace(/\s*:$/, ''), ...shown, ...more].join(' ; ');
}