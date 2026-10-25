export interface Purge {
  removed: number;
  kept: number;
  freedBytes: number;
}
export function direPurge(purge: Purge): string;
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
}): { sha: string; dir: string; fingerprint: string; purge: Purge };
