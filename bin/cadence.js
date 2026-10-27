#!/usr/bin/env node
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
} else if (['news', 'session', 'deliver', 'verify', 'skills', 'orchestrate', 'lead', 'corrections', 'perf', 'spec', 'ref', 'config', 'release'].includes(tool)) {
  process.exitCode = await run([tool, ...args], io);
} else if (tool === '--version' || tool === '-v') {
  process.exitCode = await run([tool], io);
} else {
  console.log(`cadence — une méthode de travail qui vit dans le dépôt

  cadence raf …     plan « reste à faire » relié aux commits (aussi disponible en « raf »)
  cadence news …    Nouveautés : une entrée avec capture par lot visible, JSON + page autonome
  cadence session start [--since "24 hours ago"] [--idle 2]
                    faits de reprise : notes de la veille, en cours, fait depuis, écarts, propositions
  cadence session close [--since …]    faits de clôture ; code 1 tant que ce n'est pas fermé
  cadence session start|close --all [--depth 1]   depuis un dossier non dépôt : une section par projet des sous-dossiers
  cadence session next "ligne" …       notes pour la prochaine session (remplacent les précédentes)
  cadence session next --clear         efface ces notes ; sans ligne ni --clear, la commande refuse
  cadence session context [--session <id>]   contexte de la session (variable CLAUDE_CODE_SESSION_ID, sinon la seule du dossier) publié par la bande cadence-hud ; code 2 sans chiffre frais
  cadence deliver [--dry-run] [--sha rév] [--config cadence.yaml] [-- arguments du script du projet]
                    CI du sha poussé → déploiement → vérifications de l'effet ;
                    ou le script de livraison du projet (deliver.script), sous verrou et journal
  cadence ref add <document.pdf> [--sections 3-5,9] [--slug nom]
                    enregistre un document de référence hors du dépôt : pages rendues, texte positionné, images, index des figures
                    et des passages qui les citent ; exige poppler, ImageMagick et tesseract (outil absent nommé avec sa commande, code 2)
  cadence ref measure <slug> <page> <page | x,y | x,y,l,h> [--quoi couleurs|contraste|boites|texte] [--largeur 1440] [--json]
                    mesure une zone d'une page rendue : couleurs, contraste WCAG 2.2, boîtes, mots OCR et taille de police estimée,
                    ramenés à 1440 px de large, tolérance déclarée
  cadence release patch|minor|major [--dry-run]
                    prépare le commit de version (fichiers de version, CHANGELOG) sans rien commiter ni publier ;
                    imprime les étapes du lead dans l'ordre et vérifie docs/whats-new.md
  cadence verify [--retry secondes] [--sha rév]
                    rejoue les vérifications d'effet (deliver.verify) hors livraison, une passe, en parallèle ;
                    code 0 tout vert, 1 un effet rouge, 2 rien à vérifier ; « session start » la lance aussi
  cadence orchestrate <projet>:<lot>[@modèle]… [--budget 2M] [--max-sessions 2] [--wave id] [--dry-run]
                    une session claude neuve par étape (implémentation, revues, corrections) ; --status, --resume ;
                    --max-sessions : sessions simultanées, toutes vagues confondues (CADENCE_MAX_SESSIONS)
                    --continue [--until HH:MM] [--priority a,b] : tire seul les lots prêts du plan, jusqu'à une borne
                    --waits [--since AAAA-MM-JJ] : l'attente de créneau de session par jour et par vague, lue dans les journaux
  cadence lead hold <étiquette> [--ttl minutes] | lead release <étiquette>
                    déclare, puis rend, une session lancée à la main par le lead : soustraite des créneaux libres
  cadence lead tour [dossier] [--idle 3] [--json]
                    le tableau du lead, sans modèle : une ligne par sous-dossier qui a un plan, ou la ligne du dossier courant
                    s'il est lui-même un projet ; une première ligne « cadence.yaml · ✗ erreur » si priority: est illisible
  cadence config set <clé> <valeur> --all [--dry-run] [--depth n]
                    pose la même clé dans le cadence.yaml de chaque projet du dossier (ceux de lead tour), commentaires et ordre gardés,
                    avec un lot de config qui la cite et un commit à chemin explicite par projet ; ne pousse pas ;
                    s'arrête sur une config qui ne se relit pas
  cadence corrections [dossier] [--classify [--model m]] [--cache fichier] [--sample n] [--until date] [--since date] [--json]
                    la mesure des passes de correction des vagues (dossier/.cadence/runs) : lots à ≥1 et ≥2 corrections,
                    par projet, visibles ou non, passes par cause ; --classify les classe par Ollama (hors quota)
  cadence perf [dossier] [--since date] [--json]
                    tableau de bord du workflow, sans modèle ni écriture : 7 derniers jours contre les 7 précédents, chaque vitesse
                    à côté de sa qualité, ⚠ au-delà de 25 % de dégradation ; --since est un jour qui tronque les fenêtres
  cadence spec check <fiche.yaml>
                    les invariants d'une fiche d'écran, back ou mixte (étape spec ; gabarits templates/fiche.yaml, fiche-back.yaml) ; code 1 si un écart, 2 si illisible
  cadence spec qa <fiche.yaml>
                    la section de docs/qa/expectations.md dérivée de la fiche (shows, never, api), sur la sortie standard
  cadence spec reseal <lot> <test> --reason "pourquoi" [--porteur <lot en cours>]
                    le chemin du lead quand un test d'acceptation scellé du lot en cours contredit la fiche : le test corrigé dans l'arbre,
                    l'empreinte de ce seul test refaite, la raison dans acceptation.json et en note du lot ; hors vague orchestrée.
                    Lot livré (vert: true), test instable au contrat inchangé : --porteur nomme le lot en cours qui porte la correction
  cadence skills install [--dir .claude] [--force]
                    installe les skills Claude Code session-start, session-close, deliver et l'agent ux-reviewer`);
  process.exitCode = !tool || ['help', '--help', '-h'].includes(tool) ? 0 : 2;
}
