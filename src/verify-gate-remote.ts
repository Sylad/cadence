import { configuredCap } from './orchestrate/command.js';
import { testWorkersFrom } from './orchestrate/workers.js';
import { ConnectionLost, GATE_TIMEOUT_MS, isSha, openRemoteGate, type Ran } from './remote-gate.js';
import type { GateCtx } from './verify-gate.js';

/**
 * La porte de `cadence verify --gate` sur l'hôte `orchestrate.gate.host` (L403) : sha poussé, cache de dépendances, worktree jetable distant ; les mêmes étapes que la porte locale (`play` est son `runSteps`), le même verdict.
 * Rend le code de la porte, ou null quand elle doit être jouée en local : pas d'hôte, `verify.inPlace: true` qui impose l'arbre principal (R9), hôte injoignable, push ou cache impossible (R4, R5, jamais un rouge),
 * ou connexion perdue pendant une commande (R6, la porte entière est rejouée en local). Un autre code non nul d'une commande reste son verdict (R8). Le worktree distant est retiré dans tous les cas, au signal compris (R10, R19).
 */
export async function tryRemote(ctx: GateCtx, short: string, replayReason: string, play: (exec: (cmd: string) => Promise<Ran>, emit: (line: string) => void) => Promise<{ code: number; summary: string }>): Promise<number | null> {
  const { repo, sha, config, out } = ctx;
  const host = config.gate?.host;
  if (!host) return null;
  if (ctx.verify?.inPlace === true) {
    out(`verify --gate : verify.inPlace demande l'arbre principal, l'hôte ${host} est ignoré`);
    return null;
  }
  if (!isSha(sha)) {
    out('verify --gate : sha invalide pour la porte déportée (hexadécimal attendu)');
    return 2;
  }
  const base = ctx.env ?? process.env;
  const timeout = ctx.timeoutMs ?? GATE_TIMEOUT_MS;
  const opened = await openRemoteGate({ host, install: config.gate?.install, refs: config.gate?.refs, repo, sha, depsFrom: repo, worktreeDeps: config.worktreeDeps, env: base, timeoutMs: timeout, workers: (cores) => testWorkersFrom(base, cores, configuredCap(base)) });
  if (!opened.ok) {
    out(opened.stage === 'host' ? `verify --gate : porte déportée indisponible sur ${host} (${opened.cause}) — repli sur la porte locale` : `verify --gate : cache de dépendances impossible sur ${host} (${opened.cause}) — repli sur la porte locale`);
    return null;
  }
  const gate = opened.gate;
  out(`verify --gate ${short} : porte jouée sur l'hôte ${host} (sha ${short}, ${gate.cache})`);
  // Les lignes des étapes sont tenues jusqu'au bout : une connexion perdue en cours de porte la fait rejouer en local, les ✓ de l'hôte ne seraient pas ceux du verdict.
  const lines: string[] = [replayReason];
  try {
    const { code, summary } = await play(async (cmd) => {
      const r = await gate.run(cmd, timeout);
      if (r.lost) throw new ConnectionLost();
      return r;
    }, (l) => lines.push(l));
    for (const l of [...lines, summary]) out(l);
    return code;
  } catch (e) {
    if (!(e instanceof ConnectionLost)) throw e;
    out(`verify --gate : connexion perdue avec ${host} pendant la porte — rejouée en local`);
    return null;
  } finally {
    const orphan = gate.close();
    if (orphan) out(`verify --gate : nettoyage de l'hôte ${host} en échec (${orphan}) — le worktree orphelin y sera retiré au prochain appel`);
  }
}
