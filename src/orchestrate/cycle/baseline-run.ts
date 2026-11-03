import { type LotCtx, startSha, save } from './ctx.js';
import { type GateTest, gateLabel, runGate, gateReplayable, baselineCandidates, replayGate, type GateRan, redAloneGate, gateUnnamed } from '../gate-parts.js';
import { failedTests, compareBaseline } from '../baseline.js';
import { lotKey } from '../state.js';
import { type Place, withPlace } from '../gate-place.js';
import { mkdtempSync, lstatSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git, linkIgnored } from '../worktree.js';
import { sh } from './sh.js';
/**
 * Échecs des tests au sha de départ du lot (L213) : la commande est rejouée dans un worktree jetable de ce sha, hors du dépôt,
 * avec des liens vers les dossiers ignorés de tout niveau (node_modules, .venv… ; `dist` et les autres sorties de build exclus, une commande
 * de tests qui y écrit toucherait le build du lot) pour que les dépendances s'y trouvent. Les `node_modules` sont recréés entrée par entrée
 * pour que les paquets de workspace résolvent dans le worktree (`mirrorNodeModules`). Avec `orchestrate.testReplay`, un rouge nommé y est rejoué seul (L354) avant d'être retenu.
 * Null quand le worktree ne peut être monté : l'appelant garde alors les tests pour rouges.
 */
async function baselineFailures(c: LotCtx, test: GateTest): Promise<string[] | null> {
  const l = c.lot;
  const sha = startSha(c);
  const command = gateLabel(test); // clé de cache ; pour des parties (L512) le libellé « dir : run ; … », stable d'une lecture à l'autre
  if (!sha) return null;
  if (l.baseline?.verified && l.baseline.sha === sha && l.baseline.command === command) return l.baseline.failures;
  return atStartSha(c, sha, async (place) => {
    const r = await runGate(place.run, test);
    // Ligne de base comprise (L354) : un rouge du sha de départ est rejoué seul dans le même worktree avant d'être retenu. Sous charge, un test
    // qui passe seul au départ rougirait ici et excuserait une vraie régression du lot (« déjà rouge au départ »). Un échec sans nom reste tel quel ; en parties (L512), partie par partie.
    const found = r.code === 0 ? [] : failedTests(r.output);
    const named = gateReplayable(test, c.config.testReplay) && found.length ? baselineCandidates(r) : [];
    const { red: failures, unstable } = named.length ? await replayGate(place.run, c.config.testReplay, named, r) : { red: found, unstable: [] as string[] };
    if (unstable.length) c.wave.log(`${lotKey(l.project, l.lot)} · ligne de base ${sha.slice(0, 7)} : ${unstable.length} test(s) rouge(s) sous charge, vert(s) rejoué(s) seul(s), non retenu(s) comme déjà rouge(s) : ${unstable.join(' ; ')}`);
    l.baseline = { sha, command, failures, verified: true };
    save(c);
    return failures;
  });
}/** Parmi les tests rouges `names` du lot, ceux rouges SEULS aussi au sha de départ (L510) : la suite entière du départ a pu les voir verts (ordre, charge), ils n'en sont pas moins déjà rouges avant le lot. Vide sans `testReplay`, sans sha de départ, build du départ rouge ou worktree non monté. */
export async function redAtStart(c: LotCtx, names: string[], ran: GateRan): Promise<string[]> {
  const sha = startSha(c);
  return !sha || !gateReplayable(c.config.test, c.config.testReplay) || !names.length ? [] : (await atStartSha(c, sha, (place) => redAloneGate(place.run, c.config.testReplay, names, ran))) ?? [];
}/** Joue `fn` dans un worktree jetable du sha de départ (ligne de base L213, rouges au départ L510), liens vers les dossiers ignorés posés puis retirés avec lui. Null si le worktree ne se monte pas, si le build du départ est rouge ou si `fn` lève. */
async function atStartSha<T>(c: LotCtx, sha: string, fn: (place: Place) => Promise<T | null>): Promise<T | null> {
  const l = c.lot;
  const dir = mkdtempSync(join(tmpdir(), 'cadence-baseline-'));
  const links: string[] = [];
  try {
    git(l.repo, 'worktree', 'add', '--detach', '-f', dir, sha);
    links.push(...linkIgnored(l.repo, dir));
    // Sur l'hôte `gate.host` quand il y en a un (L403) ; le worktree local reste le lieu du rejeu si la connexion tombe.
    return await withPlace({ config: c.config, repo: l.repo, sha, dir, needClean: false, label: `porte du lot ${l.lot}`, detail: `(ligne de base ${sha.slice(0, 7)})`, local: (cmd) => sh(c, cmd, 30 * 60_000, {}, dir), say: (line) => c.wave.log(`${lotKey(l.project, l.lot)} · ${line}`) }, async (place) => {
      // Le build d'abord, comme dans la porte (L333) : les tests lisent ce qu'il produit (`dist`), le départ sans lui rougirait tout. Un build rouge au départ
      // ne dit rien des tests : rien à rendre, l'appelant garde les tests pour rouges.
      if (c.config.build && (await place.run(c.config.build)).code !== 0) return null;
      return fn(place);
    });
  } catch {
    return null;
  } finally {
    for (const k of links) if (lstatSync(k, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(k);
    try {
      git(l.repo, 'worktree', 'remove', '--force', dir);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
    try {
      git(l.repo, 'worktree', 'prune');
    } catch {
      // rien à élaguer
    }
  }
}export type VsBase = { kind: 'unknown' } | { kind: 'existing'; n: number } | { kind: 'new'; nouveaux: string[]; existants: number };/** Des tests rouges comparés à la ligne de base (L213) : tous déjà rouges au départ, ou au moins un nouveau, ou rien de comparable. */
export async function againstBaseline(c: LotCtx, command: GateTest, ran: GateRan): Promise<VsBase> {
  const now = failedTests(ran.output);
  // Un échec sans test nommé (en chaîne, ou dans une partie rouge, L512) : rien n'est comparable ni excusable, les tests restent rouges.
  if (!now.length || gateUnnamed(ran)) return { kind: 'unknown' };
  const base = await baselineFailures(c, command);
  if (!base?.length) return { kind: 'unknown' };
  const { nouveaux, existants } = compareBaseline(now, base);
  return nouveaux.length ? { kind: 'new', nouveaux, existants: existants.length } : { kind: 'existing', n: existants.length };
}