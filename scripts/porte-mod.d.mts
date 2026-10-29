export interface Lancement {
  status: number;
  output: string;
}
export function typesDuMod(opts: { dir: string; mods?: string }): 'présents' | 'copiés' | null;
export function porteDuMod(opts: { dir: string; mods?: string; run?: (commande: string, args: string[]) => Lancement }): { ok: boolean; output: string };
