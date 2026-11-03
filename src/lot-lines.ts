import { gateProgress, gateText } from './audit.js';
import type { Lot, Plan } from './plan.js';
import { formatWindow, windowOf } from './plan-window.js';

/** Les lignes de tête de `raf show` : titre, état détaillé (L463), objectif, dates, dépendances, drapeaux, champs d'extension (L464), acquittement docs et condition de tirage. Une ligne par fait posé, aucune pour un fait absent. */
export function lotLines(plan: Plan, lot: Lot): string[] {
  const lots = plan.lots();
  const lines = [...headLines(lot, lots), ...flagLines(lot)];
  if (lot.docsOk) lines.push(`docs-ok : ${lot.docsOk.date} — ${lot.docsOk.reason}`);
  const gate = gateProgress(lots, lot);
  if (lot.gate && gate) lines.push(lot.gate.invalid ? `gate : ${gateText(gate)}` : `gate : ${gate.n} lots ${gate.label} faits`);
  return lines;
}

function headLines(lot: Lot, lots: Lot[]): string[] {
  const lines = [`${lot.id}  ${lot.status}  ${lot.title}`];
  if (lot.state) lines.push(`état : ${lot.state}`);
  if (lot.goal) lines.push(`goal : ${lot.goal}`);
  const dates = [['créé', lot.created], ['démarré', lot.started], [lot.status === 'dropped' ? 'abandonné' : 'terminé', lot.finished]].filter(([, d]) => d);
  if (dates.length) lines.push(dates.map(([k, d]) => `${k} : ${d}`).join('  '));
  if (lot.delivered) lines.push(`livré : ${lot.delivered.date} ${lot.delivered.sha.slice(0, 7)}`);
  if (lot.after.length) lines.push(`after : ${lot.after.join(', ')}`);
  const planned = windowOf(lots, lot);
  if (planned) lines.push(`prévu : ${formatWindow(planned)}`);
  if (lot.public) lines.push(`public : ${lot.public}`);
  return lines;
}

function flagLines(lot: Lot): string[] {
  const lines: string[] = [];
  // L439 : le livreur lit ici si le lot est visible et s'il porte un verdict UX ; deux lignes stables, absentes d'un lot non visible.
  if (lot.visible) lines.push('visible : oui');
  if (lot.screen) lines.push(`screen : ${lot.screen}`);
  if (lot.visible) lines.push(lot.ux ? `ux : ${lot.ux.verdict}` : 'ux : absent');
  if (lot.spec) lines.push('spec : true');
  if (lot.uses) lines.push(`uses : ${lot.uses.join(', ')}`);
  for (const [name, value] of Object.entries(lot.extras ?? {})) lines.push(`${name} : ${value}`);
  return lines;
}

/**
 * Le lot tel que `raf list --json` l'exporte (L464) : les clés du fichier du plan (`docs_ok`, `state_before`, pas `docsOk` ni `stateBefore`), sans `problems` (diagnostic de `raf check`).
 * Les noms exportés sont ceux que garantit docs/stabilite.md : renommer un champ du type interne `Lot` ne les change pas.
 */
export function lotJson(lot: Lot): Record<string, unknown> {
  const { docsOk, stateBefore, problems: _problems, unestimated: _unestimated, ...rest } = lot;
  return { ...rest, ...(docsOk ? { docs_ok: docsOk } : {}), ...(stateBefore ? { state_before: stateBefore } : {}) };
}
