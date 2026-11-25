#!/usr/bin/env node
// Hook PreToolUse de toute session de cadence run (L840, L792). Les motifs de --disallowedTools ne savent pas dire « cadence analyse sans --ecrire » ni
// « cadence spec sauf check|qa » : il refuse tout cadence ou raf hors `cadence analyse` bornée et, avec --spec (fiches au brief), `cadence spec check|qa`.
import { readFileSync } from 'node:fs';
import { cadenceHorsPermises } from '../../scripts/commandes-du-brief.mjs';

let entree;
try { entree = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); } // illisible : passe, les interdits par outil restent posés
const refus = entree?.tool_name === 'Bash' ? cadenceHorsPermises(entree.tool_input?.command ?? '', entree.cwd, { specCheck: process.argv.includes('--spec') }) : null;
if (refus) {
  process.stderr.write(`Refusé par cadence run : \`${refus}\` — dans cette session, les seules commandes cadence permises sont \`cadence analyse\` (sans option, `
    + '--init, --contre <ref>, --outil <nom>, --help) et, quand le brief les nomme, `cadence spec check|qa <fiche.yaml>` ; le plan, les vagues, les autres '
    + 'modes d\'analyse et les autres outils de cadence et de raf restent au lead.\n');
  process.exit(2);
}
