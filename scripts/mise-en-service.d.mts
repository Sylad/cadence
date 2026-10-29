export interface Purge {
  removed: number;
  kept: number;
  freedBytes: number;
  /** Message d'une purge échouée après la bascule (avertissement, la version est en service). */
  error?: string;
}
export interface ModUpdate {
  updated: boolean;
  dir: string;
  reason?: 'absente' | 'sans source';
  error?: string;
}
export function direMod(mod: ModUpdate): string;
export function direPurge(purge: Purge): string;
export function copiesUtilisees(releases: string): Set<string>;
export function copiesDesVaguesNonFinies(releases: string, launchDirs: string[]): Set<string>;
export function lanceursConnus(repo: string, env?: NodeJS.ProcessEnv): string[];
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
  launchDirs?: string[];
  modDir?: string;
  syncMod?: (source: string, modDir: string) => void;
}): { sha: string; dir: string; fingerprint: string; purge: Purge; mod: ModUpdate };
