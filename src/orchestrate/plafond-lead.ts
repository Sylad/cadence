// Le plafond que le lead applique (L802, D-30) : sous le réglage CADENCE_MAX_SESSIONS, le lead peut se borner plus bas (rythme du quota, par exemple),
// et la bande cadence-hud, `orchestrate --status` et `lead tour` doivent compter les créneaux sur ce plafond-là, pas sur le réglage.
// Le fichier vit dans le foyer de cadence (`plafond-lead.json`) : la bande le lit sans la CLI, comme les sessions du lead.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Nom du fichier du plafond du lead dans le foyer de cadence ; le collecteur de la bande (plugins/cadence-hud/hooks/collect.ts) lit le même. */
export const LEAD_CAP_FILE = 'plafond-lead.json';

export interface LeadCap {
  cap: number;
  since: string;
}

/** Le plafond posé par `cadence lead plafond <n>`, ou null : absent, illisible ou hors des entiers ≥ 1 (un fichier abîmé ne borne rien). */
export function readLeadCap(home: string): LeadCap | null {
  try {
    const raw = JSON.parse(readFileSync(join(home, LEAD_CAP_FILE), 'utf8')) as { cap?: unknown; since?: unknown };
    return typeof raw.cap === 'number' && Number.isInteger(raw.cap) && raw.cap >= 1 ? { cap: raw.cap, since: String(raw.since ?? '') } : null;
  } catch {
    return null;
  }
}

/** Pose le plafond du lead (`cap`), ou le retire (`null`). */
export function writeLeadCap(home: string, cap: number | null, now: Date): void {
  const file = join(home, LEAD_CAP_FILE);
  if (cap === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ cap, since: now.toISOString() }));
  renameSync(`${file}.tmp`, file);
}

/** Le plafond appliqué : le plus bas du réglage et du plafond du lead ; le lead ne relève jamais le réglage. */
export const appliedCap = (setting: number, lead: LeadCap | null): number => (lead ? Math.min(setting, lead.cap) : setting);
