// L842 (D-33) : une commande de la porte d'un cadence run, et le rejeu seul de ses tests rouges avant toute correction. Vert seul, un test est « sensible à la
// charge » : noté (journal, état, détail de fin), compté vert, sans passe de correction ; rouge seul, la correction se fait comme avant. La déduction du filtre,
// le rejeu et sa preuve vivent dans scripts/rejeu-rouges.mjs ; la mesure (commits d'une correction, passes « porte rouge » sans commit de code) dans scripts/passes-porte-rouge.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { lignesARelire } from '../../../scripts/analyse.mjs';
import { jouerRejeu, rejeuxDesTests, rejouerRouges } from '../../../scripts/rejeu-rouges.mjs';
export { avecMesure } from '../../../scripts/passes-porte-rouge.mjs'; // les commits d'une correction, écrits à côté de la mesure qui les lit

/** Un test rouge dans la suite de la porte, vert rejoué seul. */
export interface Sensible { test: string; ms: number; commande: string }
/** Le run qui joue sa porte : son worktree et les tests sensibles déjà notés. */
type Joueur = { worktree: string; sensibles_charge?: Sensible[] };

export const ligneSensible = (x: Sensible) =>
  `test sensible à la charge : ${x.test} — rouge dans la suite, vert rejoué seul (${(x.ms / 1000).toFixed(1)} s) : compté vert, aucune correction pour lui (L842)`;
export const lignesSensibles = (liste: Sensible[] = []) => liste.map(ligneSensible);

/** Les rejeux des commandes de test, lus dans le cadence.yaml du worktree (celui du commit jugé, comme la porte, L764). */
function rejeux(cwd: string) {
  try { return rejeuxDesTests((parse(readFileSync(join(cwd, 'cadence.yaml'), 'utf8')) as { orchestrate?: unknown } | null)?.orchestrate, cwd); } catch { return new Map(); }
}

/** Les rouges d'une commande de test rejoués seuls ; `vert` : il n'en reste aucun ; `dit` : ce que la sortie rendue à la session ajoute. */
function rejeuSeul(e: Joueur, c: string, sortie: string, out: (l: string) => void): { vert: boolean; dit: string } {
  const rejeu = rejeux(e.worktree).get(c), j = rejouerRouges(sortie, rejeu, (x) => jouerRejeu(x, e.worktree));
  if (j.raison) {
    out(`porte du run : rouges non rejoués seuls (L842) — ${j.raison}`);
    return { vert: false, dit: `\nrouges non rejoués seuls (L842) : ${j.raison}` };
  }
  const s = j.sensibles.map((x) => ({ ...x, commande: c }));
  for (const x of s) out(ligneSensible(x));
  if (s.length) e.sensibles_charge = [...(e.sensibles_charge ?? []), ...s];
  if (!s.length && !j.rouges.length) return { vert: false, dit: '' }; // aucun test rouge nommé : la commande reste rouge, rien n'a été rejoué
  const verts = s.length ? ` — vert(s) seul(s), sensible(s) à la charge, à ne pas corriger : ${s.map((x) => x.test).join(' ; ')}` : '';
  return { vert: !j.rouges.length, dit: `\nrejeu seul des rouges (L842, ${rejeu?.forme}) : encore rouge(s) seul(s) : ${j.rouges.join(' ; ') || 'aucun'}${verts}` };
}

/** Une commande de la porte ; en échec (pas un délai dépassé), ses rouges sont rejoués seuls d'abord. `ok` : verte, ou rouge de tests sensibles seulement. */
function jouerCommande(c: string, e: Joueur, out: (l: string) => void, ms: number): { ok: boolean; sortie: string; stdout: string } {
  const r = spawnSync('bash', ['-c', c], { cwd: e.worktree, encoding: 'utf8', timeout: ms, maxBuffer: 64 << 20 });
  const stdout = r.stdout ?? '', tout = `${stdout}${r.stderr ?? ''}`;
  if (r.status === 0) return { ok: true, sortie: '', stdout };
  const seul = r.status === null ? { vert: false, dit: '' } : rejeuSeul(e, c, tout, out);
  return { ok: seul.vert, sortie: `$ ${c}\n${tout.slice(-4000)}${r.error ? `\n${r.error.message}` : ''}${seul.dit}`, stdout };
}

/** Les commandes de la porte jusqu'à la première rouge (`p`) ; `dites` : ce que l'analyse d'une porte verte dit à relire (L801, scripts/analyse.mjs). */
export function jouerCommandes(cmds: string[], e: Joueur, out: (l: string) => void, ms: number): { p: { ok: boolean; sortie: string }; dites: string[] } {
  const dites: string[] = [];
  for (const c of cmds) {
    const r = jouerCommande(c, e, out, ms);
    if (!r.ok) return { p: { ok: false, sortie: r.sortie }, dites };
    dites.push(...lignesARelire(r.stdout));
  }
  return { p: { ok: true, sortie: '' }, dites };
}
