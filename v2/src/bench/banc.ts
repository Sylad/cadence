import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type Taille = 'retouche' | 'fonction' | 'grosse';
export interface Banc { id: string; dir: string; secrets: string; projet: string; source: string; base: string;
  install: string; tests: string; visible: boolean; taille: Taille; frais: boolean; reponses: boolean }
export class BancInvalide extends Error {}

const TAILLES: Taille[] = ['retouche', 'fonction', 'grosse'];
const REQUIS = ['projet', 'source', 'base', 'install', 'tests'] as const;

export const racineBanc = (env: NodeJS.ProcessEnv) => env.BENCH_ROOT ?? join(env.HOME ?? '', 'bench-cadence');

export function chargerBanc(racine: string, id: string): Banc {
  const dir = join(racine, 'bancs', id);
  const y = (parse(readFileSync(join(dir, 'banc.yaml'), 'utf8')) ?? {}) as Record<string, unknown>;
  for (const k of REQUIS) if (typeof y[k] !== 'string' || !y[k]) throw new BancInvalide(`banc ${id} : champ « ${k} » manquant`);
  if (!TAILLES.includes(y.taille as Taille)) throw new BancInvalide(`banc ${id} : taille « ${String(y.taille)} » inconnue (${TAILLES.join(', ')})`);
  return { id, dir, secrets: join(racine, 'secrets', id), projet: y.projet as string, source: y.source as string, base: y.base as string, install: y.install as string,
    tests: y.tests as string, visible: y.visible === true, taille: y.taille as Taille, frais: y.frais === true, reponses: existsSync(join(dir, 'reponses.md')) };
}

/** Ids des bancs (dossiers de `bancs/`) ; chacun est chargé par le passage, où un banc invalide devient un échec. */
export function listerBancs(racine: string, numeros?: string[]): string[] {
  const dir = join(racine, 'bancs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    .filter((id) => !numeros || numeros.includes(id.split('-')[0]))
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
}

export const lireDemande = (b: Banc) => readFileSync(join(b.dir, 'demande.md'), 'utf8').trim();
