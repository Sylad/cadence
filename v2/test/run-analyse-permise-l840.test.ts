// L840 : un cadence run d'adoption de cadence analyse ne s'arrête plus sur une question. Vécu du 25-11 : 5 runs d'adoption sur 6 ont vu `cadence analyse
// --init` et même `--help` refusées (deny `Bash(cadence:*)` posé sur toute session de run). Testé dans une session de run factice : la commande passe par
// les deux gardes que Claude Code applique (les motifs de --disallowedTools, puis les hooks PreToolUse des réglages), comme dans une vraie session.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executerRun, repondreRun } from '../src/run/run.js';
import { analyseCitee, DOC_ANALYSE, leverPourCadence } from '../../scripts/commandes-du-brief.mjs';
import { commite, depot, fauxClaude, git } from './run-outils.js';

type Appel = { args: string[]; env: NodeJS.ProcessEnv };
type Hook = { matcher?: string; hooks: { command: string }[] };
const prompt = (a: Appel) => a.args[a.args.indexOf('-p') + 1];
const interdits = (a: string[]) => a[a.indexOf('--disallowedTools') + 1].split(',');
const preToolUse = (a: string[]) => (JSON.parse(readFileSync(a[a.indexOf('--settings') + 1], 'utf8')) as { hooks?: { PreToolUse?: Hook[] } }).hooks?.PreToolUse ?? [];

/** Ce que Claude Code ferait d'un appel Bash dans la session lancée avec `args` : refusé par un motif `Bash(<préfixe>:*)` de --disallowedTools, ou par un
 * hook PreToolUse dont le matcher vise Bash et qui sort en code 2 ; permis sinon. */
function verdict(args: string[], cwd: string, command: string, env: NodeJS.ProcessEnv = process.env): string {
  const motif = interdits(args).map((x) => /^Bash\((.*):\*\)$/.exec(x)?.[1]).find((p) => p && (command === p || command.startsWith(`${p} `)));
  if (motif) return `refusé (motif ${motif})`;
  for (const h of preToolUse(args).filter((x) => !x.matcher || new RegExp(`^(?:${x.matcher})$`).test('Bash'))) {
    for (const { command: c } of h.hooks) {
      const r = spawnSync('bash', ['-c', c], { cwd, env, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8' });
      if (r.status === 2) return `refusé (hook) ${r.stderr}`;
    }
  }
  return 'permis';
}
function avec(repo: string, fichiers: Record<string, string>): string {
  for (const [f, t] of Object.entries(fichiers)) { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), t); }
  git(repo, 'add', '-A'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fichiers');
  return repo;
}
const PERMISES = ['cadence analyse --init', 'cadence analyse --help', 'cadence analyse', 'cadence analyse --contre main', 'cadence analyse --init --outil eslint --contre main',
  'npx cadence analyse --init', 'cadence analyse --contre main 2>&1 > analyse.txt', 'cadence analyse --init && git add -A', 'cadence analyse --init &>/dev/null',
  'cadence analyse 2>&1 --init | tail', 'cadence analyse >&2 --contre main', 'cadence analyse &> log.txt --init'];
/** Revue r1 (M1) : une redirection avant l'option (`2>&1`, `>&2`, `&>`, `&>>`, `2>&-`, `<&`, `>|`) ne cache pas --ecrire ni --migrer, ni ne coupe la commande. */
const REDIRIGEES = ['cadence analyse 2>&1 --ecrire', 'cadence analyse >&2 --migrer --contre main', 'cadence analyse &>/dev/null --ecrire', 'cadence analyse &>>log --ecrire',
  'cadence analyse &> /dev/null --ecrire', 'cadence analyse 2>&- --ecrire', 'cadence analyse 0<&3 --migrer', 'cadence analyse >| f --ecrire',
  'cadence analyse 2>&1 >&2 --migrer --contre main', 'cadence analyse {fd}>&2 --ecrire', '>f cadence deliver', '2>&1 cadence analyse --ecrire'];
const REFUSEES = ['cadence deliver', 'cadence deliver --dry-run', 'cadence analyse --ecrire', 'cadence analyse --migrer --contre main', 'cadence analyse --init --init',
  'cadence analyse --contre', 'cadence analyse --contre main --frobnicate', 'cadence run --liste', 'cadence spec L1 on', 'cadence spec check docs/specs/a/fiche.yaml',
  'raf done L1', 'cadence', 'cadence --version', 'cadence analyse --init; cadence deliver', 'npx cadence verify --gate', ...REDIRIGEES];

describe('L840 : cadence analyse permise dans la session d un run, et seulement elle', () => {
  it('session de run factice : cadence analyse --init (et --help, sans option, --contre) permise, cadence deliver et le reste refusés', () => {
    const vus: Record<string, string> = {};
    const fait = commite('fait.txt');
    const e = executerRun({ repo: depot(), demande: 'Crée fait.txt', exec: fauxClaude([(cwd, args) => {
      for (const c of [...PERMISES, ...REFUSEES]) vus[c] = verdict(args, cwd, c);
      fait(cwd);
    }]), out: () => {} });
    expect(e.etat).toBe('integre');
    for (const c of PERMISES) expect(vus[c], c).toBe('permis');
    for (const c of REFUSEES) expect(vus[c], c).toMatch(/^refusé/);
    expect(vus['cadence deliver']).toBe('refusé (motif cadence deliver)');
    expect(vus['cadence analyse --ecrire']).toContain('les seules commandes cadence permises sont `cadence analyse` (sans option, --init, --contre <ref>');
    expect(vus['cadence spec check docs/specs/a/fiche.yaml']).toBe('refusé (motif cadence spec)'); // sans fiche nommée au brief, spec reste interdite
    for (const c of REDIRIGEES.filter((x) => x.includes('analyse'))) expect(vus[c], c).toMatch(/^refusé \(hook\)/);
  });

  it('reprise par --reponse : la session reprise garde la même règle', () => {
    const repo = depot(), appels: Appel[] = [];
    const vus: string[] = [];
    const exec = fauxClaude([(cwd) => writeFileSync(`${cwd}.question.md`, 'Laquelle ?'), (cwd, args) => {
      vus.push(verdict(args, cwd, 'cadence analyse --init'), verdict(args, cwd, 'cadence deliver')); commite('fait.txt')(cwd);
    }], appels);
    const e = executerRun({ repo, demande: 'x', exec, out: () => {} });
    expect(repondreRun(e.id, repo, 'la première', { exec, out: () => {} }).etat).toBe('integre');
    expect(vus[0]).toBe('permis');
    expect(vus[1]).toMatch(/^refusé/);
  });

  it('avec des fiches nommées au brief : spec check et analyse permises ensemble, le brief dit les deux exceptions', () => {
    // le dépôt déclare analyse: (brief qui la nomme, sans pièce) : une pièce jointe ferait refuser toute écriture avant sa lecture (test suivant)
    const repo = avec(depot(), { 'docs/specs/accueil/fiche.yaml': 'ecran: {}\n', 'cadence.yaml': 'orchestrate:\n  test: test -f fait.txt\nanalyse:\n  - { name: x, command: "true", format: tsc }\n' });
    const vus: Record<string, string> = {}, appels: Appel[] = [];
    executerRun({ repo, demande: 'Corrige le libellé', sansPorte: true, exec: fauxClaude([(cwd, args) => {
      for (const c of ['cadence analyse --init', 'cadence spec check docs/specs/accueil/fiche.yaml', 'cadence spec L1 on', 'cadence deliver']) vus[c] = verdict(args, cwd, c);
      commite('fait.txt')(cwd);
    }], appels), out: () => {} });
    expect(vus['cadence analyse --init']).toBe('permis');
    expect(vus['cadence spec check docs/specs/accueil/fiche.yaml']).toBe('permis');
    expect(vus['cadence spec L1 on']).toMatch(/^refusé \(hook\)/);
    expect(vus['cadence deliver']).toMatch(/^refusé/);
    expect(prompt(appels[0])).toContain("N'utilise ni `raf` ni `cadence` (seules exceptions : `cadence spec check`, nommée dans les vérifications plus haut ; "
      + '`cadence analyse` (sans option, `--init`, `--contre <ref>`, `--outil <nom>`, `--help`), nommée plus haut)');
  });

  it('la demande cite cadence analyse, la clé analyse: ou l analyse statique : docs/analyse.md jointe comme pièce (mode complet), nommée dans le brief', () => {
    for (const demande of ['Adopte l analyse statique du dépôt', 'Lance cadence analyse --init et commite la base', 'Déclare la clé analyse: de cadence.yaml']) {
      const appels: Appel[] = [];
      const e = executerRun({ repo: depot(), demande, exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
      expect(e.pieces, demande).toContain(DOC_ANALYSE);
      expect(e.mode, demande).toBe('complet');
      expect(JSON.parse(appels[0].env.CADENCE_PIECES!), demande).toContain(DOC_ANALYSE); // le hook lecture-obligatoire l'exige avant toute écriture
      const p = prompt(appels[0]);
      expect(p).toContain(`Pièce jointe : ${DOC_ANALYSE} (la documentation de cadence analyse), à lire en entier avant d'écrire.`);
      expect(p).toContain('`cadence analyse` (sans option, `--init`, `--contre <ref>`, `--outil <nom>`, `--help`) est permise dans cette session');
      expect(p.indexOf('Pièce jointe')).toBeLessThan(p.indexOf('\n---\n'));
    }
    // mode complet (pièce jointe) : les hooks du bras (lecture-obligatoire, avec l'environnement de la session) et cadence-permise laissent passer --init
    let avant = '';
    executerRun({ repo: depot(), demande: 'Adopte cadence analyse', exec: fauxClaude([(cwd, args, env) => { avant = verdict(args, cwd, 'cadence analyse --init', env); commite('fait.txt')(cwd); }]), out: () => {} });
    expect(avant).toBe('permis');
    expect(readFileSync(DOC_ANALYSE, 'utf8')).toMatch(/^# Static analysis per technology/); // la pièce existe, publiée avec le paquet (files de package.json)
  });

  it('le lot du plan cite cadence analyse (titre ou note) : la pièce est jointe sans mot de la demande ; un identifiant de demande ne suffit pas (revue r1, M2)', () => {
    const plan = 'version: 1\nproject: x\nprefix: L\nlots:\n  - id: L1\n    title: "Adopter cadence analyse dans ce projet (D-31)"\n    status: todo\n'
      + '  - id: L2\n    title: Autre\n    status: todo\n    notes:\n      - { date: 2026-11-24, text: "lot d adoption : cadence analyse --init" }\n  - id: L3\n    title: Analyse du besoin\n    status: todo\n'
      + '  - id: L4\n    title: "Adoption (D-31)"\n    status: todo\n';
    for (const [i, [lot, jointe]] of ([['L1', true], ['L2', true], ['L3', false], ['L4', false]] as const).entries()) {
      const repo = avec(depot(), { '.cadence/raf.yaml': plan }), appels: Appel[] = [];
      const e = executerRun({ id: `20261125090000-${200 + i}`, repo, demande: 'Fais le lot', lot, exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
      expect(e.pieces.includes(DOC_ANALYSE), lot).toBe(jointe);
    }
  });

  it('ni demande ni lot qui la cite : pas de pièce ; un dépôt qui déclare analyse: nomme la commande sans pièce ; sinon brief inchangé', () => {
    const appels: Appel[] = [];
    const e = executerRun({ repo: depot(), demande: 'Crée fait.txt et fais l analyse du besoin', exec: fauxClaude([commite('fait.txt')], appels), out: () => {} });
    expect(e.pieces).toEqual([]);
    expect(e.mode).toBe('leger');
    expect(prompt(appels[0])).toContain("N'utilise ni `raf` ni `cadence`. Ignore");
    expect(prompt(appels[0])).not.toContain('Analyse statique');
    const declare = avec(depot(), { 'cadence.yaml': 'orchestrate:\n  test: test -f fait.txt\nanalyse:\n  - { name: x, command: "true", format: tsc }\n' }), a2: Appel[] = [];
    const e2 = executerRun({ repo: declare, demande: 'Crée fait.txt', sansPorte: true, exec: fauxClaude([commite('fait.txt')], a2), out: () => {} });
    expect(e2.pieces).toEqual([]);
    expect(prompt(a2[0])).toContain('Analyse statique : `cadence analyse`');
    expect(prompt(a2[0])).not.toContain('Pièce jointe');
    expect(prompt(a2[0])).toContain("N'utilise ni `raf` ni `cadence` (seule exception : `cadence analyse`");
  });

  it('analyseCitee et leverPourCadence : mots cités, faux amis écartés', () => {
    const repo = depot();
    for (const d of ['cadence analyse', 'CADENCE ANALYSE --init', 'la clé analyse: du cadence.yaml', 'Analyse statique ESLint'])
      expect(analyseCitee(repo, d), d).toBe(true);
    for (const d of ['analyse du besoin', 'D-31', 'demande d-31 du registre', 'Adopte (D-31)', 'Analyse les logs', 'cadence spec check']) expect(analyseCitee(repo, d), d).toBe(false);
    expect(leverPourCadence("N'utilise ni `raf` ni `cadence`.")).toBe("N'utilise ni `raf` ni `cadence`.");
  });
});
