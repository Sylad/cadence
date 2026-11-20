#!/usr/bin/env node
// L792 (revue r1, M1) : hook PreToolUse des sessions de cadence run dont le brief nomme `cadence spec check` (scripts/commandes-du-brief.mjs). Les motifs
// de --disallowedTools ne savent pas dire « cadence spec sauf check|qa » : ce hook refuse tout appel de cadence ou de raf autre que `cadence spec check|qa`
// (`cadence spec <lot> on|off` écrit le plan). Une entrée illisible passe : les interdits par outil restent posés.
import { readFileSync } from 'node:fs';
import { cadenceHorsSpecCheck } from '../../scripts/commandes-du-brief.mjs';

let entree;
try { entree = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const refus = entree?.tool_name === 'Bash' ? cadenceHorsSpecCheck(entree.tool_input?.command ?? '', entree.cwd) : null;
if (refus) {
  process.stderr.write(`Refusé par cadence run : \`${refus}\` — dans cette session, la seule commande cadence permise est \`cadence spec check|qa <fiche.yaml>\`, `
    + 'qui lit une fiche sans rien écrire ; le plan, les vagues et les autres outils de cadence et de raf restent au lead.\n');
  process.exit(2);
}
