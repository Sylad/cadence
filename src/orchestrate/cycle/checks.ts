import { type LotState, type Constat, lotKey } from '../state.js';
import { type LotCtx, workDir as wd, setGate, startSha } from './ctx.js';
import { withPlace, type Place } from '../gate-place.js';
import { tryGit } from '../../git.js';
import { sh } from './sh.js';
import { runGate, gateLabel, gateReplayable, redCandidates, replayGate } from '../gate-parts.js';
import { type VsBase, againstBaseline, redAtStart } from './baseline-run.js';
import { type TightTest } from '../workers.js';
import { noteUnstable, noteTight } from '../gate-notes.js';
/** Un contrôle lancé par le programme : sa commande, son code, et les tests rouges qui l'étaient déjà au sha de départ (L213). */
export type CheckRun = NonNullable<LotState['checks']>['runs'][number];/**
 * Les contrôles du programme (`orchestrate.build` puis `orchestrate.test`, L333 : les tests e2e lisent le `dist` que seul le build produit), joués dans `wd(c)` : chaque résultat est ajouté à `runs`, chaque rouge NOUVEAU à `red`
 * (un test déjà rouge au sha de départ n'en est pas un, L213). S'arrête au premier rouge : un build rouge rend le lot sans lancer les tests. Après une écriture (work) et, au sommet rebasé, avant l'avance de la branche du dépôt (R7).
 */
export async function programChecks(c: LotCtx, red: Constat[], runs: CheckRun[]): Promise<void> {
  try {
    // Sur l'hôte `gate.host` (L403) quand il y en a un : le HEAD du worktree du lot, s'il est propre ; sinon, ou sans hôte, en local.
    await withPlace({ config: c.config, repo: c.lot.repo, sha: tryGit(wd(c), ['rev-parse', 'HEAD']), dir: wd(c), needClean: true, label: `porte du lot ${c.lot.lot}`, local: (cmd) => sh(c, cmd), say: (line) => c.wave.log(`${lotKey(c.lot.project, c.lot.lot)} · ${line}`) }, (place) => runChecks(c, red, runs, place));
  } finally {
    // L395 : la porte se lit dans l'état du lot tant qu'une commande (ou le rejeu qui la suit) tourne, jamais après.
    setGate(c, undefined);
  }
}async function runChecks(c: LotCtx, red: Constat[], runs: CheckRun[], place: Place): Promise<void> {
  const l = c.lot;
  for (const [label, command] of [['build', c.config.build], ['tests', c.config.test]] as const) {
    if (!command) continue;
    if (label === 'tests') l.suiteRuns = (l.suiteRuns ?? 0) + 1;
    setGate(c, { label, started: new Date().toISOString() });
    const r = await runGate(place.run, command); // porte en parties (L512) : toutes jouées, chacune dans son dossier ; le CheckRun porte le libellé « dir : run ; … »
    const run: CheckRun = { label, command: gateLabel(command), code: r.code, ...place.stamp() };
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
      else run.code = 0;
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
}/**
 * Contrôles du sommet intégré (L328) : un rouge est relancé une fois avant de rendre le lot. Le 25-10, L326 a été rendu pour un rouge de charge (L325 tournait en même
 * temps) alors que le même sommet rejoué seul était vert. Rouge deux fois = rendu, avec le résultat de la seconde passe ; vert à la relance = une alerte sur le lot et une ligne du journal.
 */
export async function integratedChecks(c: LotCtx, key: string): Promise<{ red: Constat[]; runs: CheckRun[] }> {
  const first: Constat[] = [];
  let runs: CheckRun[] = [];
  await programChecks(c, first, runs);
  if (!first.length) return { red: first, runs };
  c.wave.log(`${key} tests rouges au sommet intégré, relancés une fois (${first.map(redExcerpt).join(' ; ')})`);
  const red: Constat[] = [];
  runs = [];
  await programChecks(c, red, runs);
  if (!red.length) c.lot.warnings.push(`rouge au sommet intégré, vert à la relance (charge de la machine ?) : ${first.map(redExcerpt).join(' ; ')}`);
  return { red, runs };
}const EXCERPT_LINES = 10;/**
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