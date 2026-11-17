#!/usr/bin/env node
// L763 (issue #63) : hook PreToolUse des sessions de cadence run (../src/socle.ts). Une session claude -p n'est jamais réveillée par la fin d'une
// commande lancée en arrière-plan : elle attend sans fin (deux runs bloqués le 17-11, 21 et 55 min). Refuse Bash avec run_in_background, laisse
// passer tout le reste ; une entrée illisible passe aussi (ce hook ne garde rien d'autre). Le plafond du timeout vient des réglages du run.
import { readFileSync } from 'node:fs';

let entree;
try { entree = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (entree?.tool_name === 'Bash' && entree.tool_input?.run_in_background === true) {
  const max = Number(process.env.BASH_MAX_TIMEOUT_MS) || 600000;
  process.stderr.write(`Refusé par cadence run (issue #63) : dans cette session sans interface, la fin d'une commande en arrière-plan ne te réveille jamais `
    + `et le run attendrait sans fin. Relance la même commande au premier plan, sans run_in_background, avec un timeout en millisecondes à la hauteur `
    + `de sa durée, porte du dépôt comprise (orchestrate.test de cadence.yaml), jusqu'à ${max} ms. Une commande plus longue : joue ses parties une à une.\n`);
  process.exit(2);
}
