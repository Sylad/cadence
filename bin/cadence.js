#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from '../dist/cli.js';

const [tool, ...args] = process.argv.slice(2);
const io = {
  cwd: process.cwd(),
  env: process.env,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  now: () => new Date(),
};

if (tool === 'raf') {
  process.exitCode = await run(args, io);
} else if (['news', 'session', 'deliver', 'verify', 'skills', 'orchestrate', 'lead'].includes(tool)) {
  process.exitCode = await run([tool, ...args], io);
} else if (tool === '--version' || tool === '-v') {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
} else {
  console.log(`cadence — une méthode de travail qui vit dans le dépôt

  cadence raf …     plan « reste à faire » relié aux commits (aussi disponible en « raf »)
  cadence news …    Nouveautés : une entrée avec capture par lot visible, JSON + page autonome
  cadence session start [--since "24 hours ago"] [--idle 2]
                    faits de reprise : notes de la veille, en cours, fait depuis, écarts, propositions
  cadence session close [--since …]    faits de clôture ; code 1 tant que ce n'est pas fermé
  cadence session next "ligne" …       notes pour la prochaine session (remplacent les précédentes)
  cadence session next --clear         efface ces notes ; sans ligne ni --clear, la commande refuse
  cadence deliver [--dry-run] [--sha rév] [--config cadence.yaml] [-- arguments du script du projet]
                    CI du sha poussé → déploiement → vérifications de l'effet ;
                    ou le script de livraison du projet (deliver.script), sous verrou et journal
  cadence verify [--retry secondes] [--sha rév]
                    rejoue les vérifications d'effet (deliver.verify) hors livraison, une passe, en parallèle ;
                    code 0 tout vert, 1 un effet rouge, 2 rien à vérifier ; « session start » la lance aussi
  cadence orchestrate <projet>:<lot>[@modèle]… [--budget 2M] [--max-sessions 2] [--wave id] [--dry-run]
                    une session claude neuve par étape (implémentation, revues, corrections) ; --status, --resume ;
                    --max-sessions : sessions simultanées, toutes vagues confondues (CADENCE_MAX_SESSIONS)
  cadence lead tour [dossier] [--idle 3] [--json]
                    le tableau du lead, sans modèle : une ligne par sous-dossier qui a un plan
  cadence skills install [--dir .claude] [--force]
                    installe les skills Claude Code session-start, session-close, deliver et l'agent ux-reviewer`);
  process.exitCode = !tool || ['help', '--help', '-h'].includes(tool) ? 0 : 2;
}
