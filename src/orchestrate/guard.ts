import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { hooksDir, headSha } from '../git.js';

const MARK = '# cadence orchestrate — hook pre-push temporaire (retiré à la fin de la vague)';

const waveLine = (wave: string) => `# wave: ${wave}`;

const hook = (wave: string) => `#!/bin/sh
${MARK}
${waveLine(wave)}
# Une session lancée par l'orchestrateur porte CADENCE_ORCHESTRATED : elle ne pousse jamais.
if [ -n "$CADENCE_ORCHESTRATED" ]; then
  echo "cadence orchestrate : push refusé pendant la vague $CADENCE_ORCHESTRATED (le lead pousse)" >&2
  exit 1
fi
exit 0
`;

const hookPath = (repo: string) => join(hooksDir(repo), 'pre-push');

/**
 * Pose le hook pre-push temporaire. Refus (raison) quand un autre hook pre-push existe : le remplacer
 * modifierait un fichier suivi (husky) ou sauterait une règle du projet. Un hook laissé par une vague
 * interrompue (même marque) est simplement remplacé.
 */
export function installPrePush(repo: string, wave = '?'): { ok: true } | { ok: false; reason: string } {
  const file = hookPath(repo);
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(MARK)) {
    return { ok: false, reason: `un hook pre-push existe déjà (${file}) : l'orchestrateur ne le remplace pas` };
  }
  writeFileSync(file, hook(wave));
  chmodSync(file, 0o755);
  return { ok: true };
}

/** Retire le hook s'il est le nôtre ; avec `wave`, seulement s'il a été posé par cette vague (jamais celui d'une autre vague vivante). */
export function removePrePush(repo: string, wave?: string): void {
  const file = hookPath(repo);
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  if (!text.includes(MARK)) return;
  if (wave !== undefined && !text.split('\n').includes(waveLine(wave))) return;
  rmSync(file, { force: true });
}

/** Pourrait-on poser le hook ? (préconditions, sans écrire) */
export function canInstallPrePush(repo: string): string | null {
  const file = hookPath(repo);
  return existsSync(file) && !readFileSync(file, 'utf8').includes(MARK) ? `un hook pre-push existe déjà (${file}) : l'orchestrateur ne le remplace pas` : null;
}

function out(repo: string, args: string[], timeout = 20_000): string | null {
  try {
    // trimEnd seulement : la première colonne d'un `status --porcelain` peut être une espace.
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trimEnd();
  } catch {
    return null;
  }
}

/** Ce qui change quand une session pousse : la référence amont locale et les têtes du dépôt distant. */
export interface Snapshot {
  head: string | null;
  /** `git status --porcelain` des fichiers suivis. */
  tracked: string[];
  untracked: string[];
  upstream: string | null;
  remote: string | null;
}

export function snapshot(repo: string, opts: { remote?: boolean } = {}): Snapshot {
  const lines = (out(repo, ['status', '--porcelain', '--untracked-files=all']) ?? '').split('\n').filter(Boolean);
  const keep = (l: string) => !/^.. \.cadence\//.test(l) && !/^\?\? \.cadence\//.test(l);
  return {
    head: headSha(repo),
    tracked: lines.filter((l) => !l.startsWith('??') && keep(l)),
    untracked: lines.filter((l) => l.startsWith('??') && keep(l)).map((l) => l.slice(3)),
    upstream: out(repo, ['rev-parse', '-q', '--verify', '@{u}']),
    remote: opts.remote === false ? null : out(repo, ['ls-remote', '--heads']),
  };
}

/** Écart de la référence amont ou du dépôt distant depuis `before` : un push est parti. */
export function pushed(before: Snapshot, after: Snapshot): boolean {
  if (before.upstream !== after.upstream) return true;
  return before.remote !== null && after.remote !== null && before.remote !== after.remote;
}
