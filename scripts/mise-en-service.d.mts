export interface Purge {
  removed: number;
  kept: number;
  freedBytes: number;
}
export function direPurge(purge: Purge): string;
export function copiesUtilisees(releases: string): Set<string>;
export function defaultRoot(): string;
export function defaultBinDir(): string;
export function checkAccepted(repo: string, rev: string): string;
export function checkLotsDone(repo: string, sha: string, served?: string): void;
export function fingerprint(dir: string): string;
export function mettreEnService(opts: {
  repo: string;
  rev: string;
  root?: string;
  binDir?: string;
  install?: (dir: string) => void;
  inUse?: (releases: string) => Set<string>;
}): { sha: string; dir: string; fingerprint: string; purge: Purge };
