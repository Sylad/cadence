import { gateProgress, gateText } from './audit.js';
import type { Lot, Plan } from './plan.js';

/** Les lignes de tête de `raf show` : titre, état détaillé (L463), objectif, dates, dépendances, drapeaux, champs d'extension (L464), acquittement docs et condition de tirage. Une ligne par fait posé, aucune pour un fait absent. */
export function lotLines(plan: Plan, lot: Lot): string[] {
  const lines = [...headLines(lot), ...flagLines(lot)];
  if (lot.docsOk) lines.push(`docs-ok : ${lot.docsOk.date} — ${lot.docsOk.reason}`);
  const gate = gateProgress(plan.lots(), lot);
  if (lot.gate && gate) lines.push(lot.gate.invalid ? `gate : ${gateText(gate)}` : `gate : ${gate.n} lots ${gate.label} faits`);
  return lines;
}

function headLines(lot: Lot): string[] {
  const lines = [`${lot.id}  ${lot.status}  ${lot.title}`];
  if (lot.state) lines.push(`état : ${lot.state}`);
  if (lot.goal) lines.push(`goal : ${lot.goal}`);
  const dates = [['créé', lot.created], ['démarré', lot.started], [lot.status === 'dropped' ? 'abandonné' : 'terminé', lot.finished]].filter(([, d]) => d);
  if (dates.length) lines.push(dates.map(([k, d]) => `${k} : ${d}`).join('  '));
  if (lot.after.length) lines.push(`after : ${lot.after.join(', ')}`);
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
