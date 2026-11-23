import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chercherFuites, reglesDuBras } from '../src/bench/fuites.js';
import { lectureReferences } from '../src/sequence/mesures.js';
import { commandeLue, ecritureBash } from '../hooks/lecture.mjs';
import { dossierTemp } from './temp.js';

// Le vrai script du hook, lancé comme Claude Code le lance : JSON sur stdin, liste des pièces dans l'environnement (R31),
// refus = code 2 + raison sur stderr + décision JSON sur stdout.
const HOOK = join(import.meta.dirname, '..', 'hooks', 'lecture-obligatoire.mjs');
let n = 0;
const appel = (name: string, input: object, id = `t${++n}`) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const resultat = (id: string, is_error = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(is_error ? { is_error } : {}) }] } });
/** Un Read et son résultat (réussi par défaut). */
const lu = (input: object, erreur = false) => { const id = `t${++n}`; return [appel('Read', input, id), resultat(id, erreur)]; };
/** PDF minimal de `pages` pages (objets /Type /Page comptés quand pdfinfo est absent ou refuse le fichier). */
const pdf = (pages: number) => `%PDF-1.4\n1 0 obj << /Type /Pages /Count ${pages} >> endobj\n${Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj << /Type /Page >> endobj`).join('\n')}\n%%EOF\n`;

function monde() {
  const r = dossierTemp('hook-lecture-');
  const clone = join(r, 'run', 'c1'); mkdirSync(join(clone, 'src'), { recursive: true });
  const ref = join(r, 'ref'); mkdirSync(ref);
  const doc = join(ref, 'norme.md'), fig = join(ref, 'fig.png'), long = join(ref, 'long.md'), p40 = join(ref, 'p40.pdf');
  writeFileSync(doc, 'n\n'); writeFileSync(fig, 'p'); writeFileSync(long, 'l\n'.repeat(2500)); writeFileSync(p40, pdf(40));
  const t = join(r, 'projets', 'sess.jsonl'); mkdirSync(join(r, 'projets'));
  const ecrire = (lignes: string[], f = t) => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, `${lignes.join('\n')}\n`); };
  return { r, clone, doc, fig, long, p40, t, ecrire };
}
type Monde = ReturnType<typeof monde>;
function hook(entree: object, env: Record<string, string | undefined>): { code: number; stdout: string; stderr: string } {
  const p = spawnSync('node', [HOOK], { input: typeof entree === 'string' ? entree : JSON.stringify(entree), encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { code: p.status ?? -1, stdout: p.stdout, stderr: p.stderr };
}
/** Le hook joué comme `hook`, avec son temps CPU (utilisateur + système, relevé par `times` de bash, en ms) : ce que coûte la lecture, sans l'attente
 * d'un processeur occupé par d'autres (L763 : porte rouge à 1415 ms d'horloge sous une charge de 36 pour 24 cœurs, le hook inchangé). */
function hookCpu(entree: object, env: Record<string, string | undefined>): { code: number; cpu: number } {
  const p = spawnSync('bash', ['-c', 'node "$1" > /dev/null; c=$?; times; exit $c', 'bash', HOOK], { input: JSON.stringify(entree), encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const ms = (s: string) => { const m = /^(\d+)m([\d.]+)s$/.exec(s); if (!m) throw new Error(`times illisible : ${p.stdout}`); return (Number(m[1]) * 60 + Number(m[2])) * 1000; };
  const [u, s] = p.stdout.trim().split('\n').at(-1)!.trim().split(/\s+/);
  return { code: p.status ?? 1, cpu: ms(u) + ms(s) };
}
const env = (m: Monde, pieces: string[]) => ({ CADENCE_CLONE: m.clone, CADENCE_PIECES: JSON.stringify(pieces), CADENCE_BANC_RACINE: m.r, HOME: join(m.r, 'home') });
const ecriture = (m: Monde, file_path = join(m.clone, 'src', 'a.ts'), tool_name = 'Write') =>
  ({ hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path, content: 'x' }, transcript_path: m.t, cwd: m.clone });
function refuse(r: ReturnType<typeof hook>, motif: string | RegExp) {
  expect(r.code).toBe(2);
  if (typeof motif === 'string') expect(r.stderr).toContain(motif); else expect(r.stderr).toMatch(motif);
  expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
}
const permis = (r: ReturnType<typeof hook>) => expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);

describe('hook lecture obligatoire', () => {
  it('pièce non lue : refus qui la nomme, et pas les autres', () => {
    const m = monde(); m.ecrire(lu({ file_path: m.doc }));
    const r = hook(ecriture(m), env(m, [m.doc, m.fig]));
    refuse(r, m.fig); expect(r.stderr).not.toContain(m.doc);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/^Lis d'abord en entier/);
  });
  it('lue partiellement : refus (R30, R31 : partiel = non couvert)', () => {
    const m = monde();
    for (const [piece, partiel] of [[m.long, { limit: 10 }], [m.long, { offset: 3 }], [m.p40, { pages: '1-20' }]] as const) {
      m.ecrire(lu({ file_path: piece, ...partiel }));
      refuse(hook(ecriture(m), env(m, [piece])), piece);
    }
  });
  it('couverture : texte de 2500 lignes lu sans limit = partiel ; 1-2000 + 2001-2500 = lu', () => {
    const m = monde();
    m.ecrire(lu({ file_path: m.long }));
    refuse(hook(ecriture(m), env(m, [m.long])), m.long);
    m.ecrire([...lu({ file_path: m.long }), ...lu({ file_path: m.long, offset: 2001, limit: 500 })]);
    permis(hook(ecriture(m), env(m, [m.long])));
  });
  it('couverture : PDF de 40 pages lu en 1-20 puis 21-40 = lu', () => {
    const m = monde();
    m.ecrire([...lu({ file_path: m.p40, pages: '1-20' }), ...lu({ file_path: m.p40, pages: '21-40' })]);
    permis(hook(ecriture(m), env(m, [m.p40])));
  });
  it('un Read en erreur ne compte pas ; un Read sans résultat non plus', () => {
    const m = monde();
    m.ecrire(lu({ file_path: m.doc }, true));
    refuse(hook(ecriture(m), env(m, [m.doc])), m.doc);
    m.ecrire([appel('Read', { file_path: m.doc })]);
    refuse(hook(ecriture(m), env(m, [m.doc])), m.doc);
  });
  it('lue en entier : permis ; Edit et chemin relatif ; MultiEdit et NotebookEdit refusés sans lecture', () => {
    const m = monde();
    m.ecrire(lu({ file_path: m.doc }));
    permis(hook(ecriture(m), env(m, [m.doc])));
    permis(hook(ecriture(m, 'src/b.ts', 'Edit'), env(m, [m.doc])));
    m.ecrire([]);
    refuse(hook(ecriture(m, 'src/b.ts', 'MultiEdit'), env(m, [m.doc])), m.doc);
    refuse(hook({ tool_name: 'NotebookEdit', tool_input: { notebook_path: join(m.clone, 'n.ipynb') }, transcript_path: m.t, cwd: m.clone }, env(m, [m.doc])), m.doc);
  });
  it('image lue : permis', () => {
    const m = monde(); m.ecrire(lu({ file_path: m.fig }));
    permis(hook(ecriture(m), env(m, [m.fig])));
  });
  it('chemins comparés par realpath : pièce lue par un lien, clone donné par un lien', () => {
    const m = monde(); symlinkSync(join(m.r, 'ref'), join(m.r, 'lien-ref')); symlinkSync(m.clone, join(m.r, 'lien-clone'));
    m.ecrire(lu({ file_path: join(m.r, 'lien-ref', 'norme.md') }));
    permis(hook(ecriture(m), env(m, [m.doc])));
    m.ecrire([]);
    refuse(hook(ecriture(m, join(m.r, 'lien-clone', 'src', 'neuf.ts')), env(m, [m.doc])), m.doc);
  });
  it('écriture hors du banc, captures et question du bras, outil non concerné : permis', () => {
    const m = monde(); m.ecrire([]);
    permis(hook(ecriture(m, `${m.clone}.captures/a.png`), env(m, [m.doc])));
    permis(hook(ecriture(m, `${m.clone}.question.md`), env(m, [m.doc])));
    permis(hook(ecriture(m, join(tmpdir(), 'notes-du-bras.md')), env(m, [m.doc])));
    permis(hook({ ...ecriture(m), tool_name: 'Bash', tool_input: { command: 'ls' } }, env(m, [m.doc])));
  });
  it('R32 : refus des réglages de Claude Code (~/.claude/, **/.claude/settings*.json) et du banc hors du clone, même pièces lues', () => {
    const m = monde(); m.ecrire(lu({ file_path: m.doc }));
    const e = env(m, [m.doc]);
    for (const f of [join(e.HOME, '.claude', 'settings.json'), join(e.HOME, '.claude', 'settings.local.json'), join(e.HOME, '.claude', 'hooks', 'x.sh'),
      join(m.clone, '.claude', 'settings.local.json'), join(tmpdir(), 'ailleurs', '.claude', 'settings.json')])
      for (const outil of ['Write', 'Edit', 'MultiEdit']) refuse(hook(ecriture(m, f, outil), e), /réglage de Claude Code/);
    refuse(hook(ecriture(m, join(m.r, 'run', 'c1x', 'a.ts')), e), /dossier du banc/);
    refuse(hook(ecriture(m, join(m.r, 'run', 'c1.reglages', 'settings.json')), e), /dossier du banc/);
    refuse(hook(ecriture(m, join(m.r, 'historique.jsonl')), e), /dossier du banc/);
    permis(hook(ecriture(m, join(m.clone, '.claude', 'notes.md')), e));
    refuse(hook(ecriture(m), { ...e, CADENCE_BANC_RACINE: undefined }), /CADENCE_BANC_RACINE/);
  });
  it('liste vide : permis ; liste absente, illisible ou clone absent : refus (fermé)', () => {
    const m = monde(); m.ecrire([]);
    permis(hook(ecriture(m), env(m, [])));
    refuse(hook(ecriture(m), { ...env(m, []), CADENCE_PIECES: undefined }), /CADENCE_PIECES/);
    refuse(hook(ecriture(m), { ...env(m, []), CADENCE_PIECES: '{"pieces":[]}' }), /CADENCE_PIECES/);
    refuse(hook(ecriture(m), { ...env(m, []), CADENCE_CLONE: undefined }), /CADENCE_CLONE/);
  });
  it('fermé en cas d\'erreur : entrée illisible ou transcript illisible → « hook en erreur »', () => {
    const m = monde();
    refuse(hook('pas du json' as unknown as object, env(m, [m.doc])), /^hook en erreur : /);
    mkdirSync(m.t.replace(/\.jsonl$/, '.dir.jsonl'));
    refuse(hook({ ...ecriture(m), transcript_path: m.t.replace(/\.jsonl$/, '.dir.jsonl') }, env(m, [m.doc])), /^hook en erreur : /);
  });
  it('lue par un sous-agent : permis, que le hook reçoive le transcript principal ou celui du sous-agent', () => {
    const m = monde();
    const sous = join(m.r, 'projets', 'sess', 'subagents', 'agent-1.jsonl');
    m.ecrire(lu({ file_path: m.fig }));
    m.ecrire(lu({ file_path: m.doc }).map((l) => JSON.stringify({ isSidechain: true, ...JSON.parse(l) })), sous);
    permis(hook(ecriture(m), env(m, [m.doc, m.fig])));
    permis(hook({ ...ecriture(m), transcript_path: sous }, env(m, [m.doc, m.fig])));
  });
  it('le hook et la mesure lectureReferences partagent la définition de « lire »', () => {
    const m = monde();
    const cas: [string, string[]][] = [[m.long, lu({ file_path: m.long })], [m.p40, lu({ file_path: m.p40, pages: '1-39' })], [m.doc, lu({ file_path: m.doc }, true)]];
    for (const [piece, lignes] of cas) {
      m.ecrire(lignes);
      refuse(hook(ecriture(m), env(m, [piece])), piece);
      const mes = lectureReferences(lignes, [piece], m.clone);
      expect(mes.ouvertes.length === 0 || mes.partielles.length === 1, piece).toBe(true);
    }
  });
  it('rapide : transcript de 20 Mo lu en moins d\'une seconde au calme (pièce lue à la fin)', () => {
    const m = monde();
    // L752 : témoin mesuré juste avant, même hook sur un transcript d'une ligne (démarrage de node, lecture des pièces) ; la borne suit : une seconde,
    // cinq témoins au plus. Une lecture quadratique la dépasse toujours. L763 : les deux en temps CPU (hookCpu), plus en temps d'horloge, qu'une
    // machine chargée par d'autres runs gonflait sans que le témoin, mesuré à un autre instant, le suive.
    m.ecrire(lu({ file_path: m.doc }));
    permis(hook(ecriture(m), env(m, [m.doc])));
    const temoin = hookCpu(ecriture(m), env(m, [m.doc])).cpu;
    const fd = openSync(m.t, 'w');
    const bruit = `${appel('Bash', { command: 'x'.repeat(2000) })}\n${lu({ file_path: join(m.clone, 'src', 'a.ts') }).join('\n')}\n${resultat('t0').replace('"x"', `"${'y'.repeat(5000)}"`)}\n`;
    for (let k = 0; k < 20 << 20; k += bruit.length) writeSync(fd, bruit);
    writeSync(fd, `${lu({ file_path: m.doc }).join('\n')}\n`); closeSync(fd);
    permis(hook(ecriture(m), env(m, [m.doc])));
    const r = hookCpu(ecriture(m), env(m, [m.doc]));
    expect(r.code).toBe(0);
    expect(r.cpu).toBeLessThan(Math.max(1000, 5 * temoin));
  });
});

describe('ecritureBash (R31 ronde 3) : une commande Bash qui écrit dans le clone', () => {
  const c = '/b/runs/r/s/c1';
  it.each([
    'echo x > a.txt', 'echo x >> src/a.ts', `printf x > ${c}/a.txt`, 'cat <<EOF > src/a.ts\nconst a = 1;\nEOF', 'ls | tee out.log',
    "sed -i 's/a/b/' src/a.ts", 'sed -i.bak -e s/a/b/ src/a.ts', "perl -pi -e 's/a/b/' src/a.ts", 'cp /tmp/x.ts src/', 'mv a.ts b.ts', 'rm -rf src',
    'install -m 644 /tmp/x src/x', 'touch src/n.ts', 'git apply /tmp/p.diff', 'git checkout -- src/a.ts', `git -C ${c} restore src/a.ts`, 'patch -p1 < /tmp/p.diff',
    `python3 -c "open('a.txt','w').write('x')"`, "node -e \"require('fs').writeFileSync('a.txt','x')\"", 'cd src && echo x > a.ts', `cd /tmp && echo x > ${c}/a.txt`,
    'npx prettier --write src', 'npx eslint --fix .', 'npx ng generate component x', 'nest g module y', 'git stash', 'git stash pop', 'git reset --hard HEAD',
    'git merge main', 'git clean -fd', `python3 - <<'PY'\nopen('a.txt','w')\nPY`,
  ])('écrit : %s', (cmd) => expect(ecritureBash(cmd, c, c)).toBe(true));
  it.each([
    'npx vitest run', 'npm test', 'npm run build', 'git status', 'git diff HEAD~1', 'git log --oneline -5', 'ls -la src', 'cat src/a.ts',
    'echo x > /dev/null', 'npx vitest run 2>&1 | tail -20', 'npm test 2>&1', 'echo x > /tmp/notes.md', 'cd /tmp && echo x > a.txt', 'cp src/a.ts /tmp/a.ts',
    "grep -n 'a > b' src/a.ts", 'git log --format="%h > %s"', 'cat <<EOF > /tmp/x.md\nif a > b then\nEOF', "sed -n '1,5p' src/a.ts", 'node scripts/run.js',
    "python3 -c \"print('x')\"", 'rm -rf /tmp/build-cache', 'touch /tmp/marque',
    'git stash list', 'git stash show -p', 'npx prettier --check src', 'npx ng build', 'cd /tmp && npx prettier --write x.ts', 'grep -w a src/a.ts',
  ])('n\'écrit pas : %s', (cmd) => expect(ecritureBash(cmd, c, c)).toBe(false));
  it('cwd hors du clone : une cible relative ne vise pas le clone', () => expect(ecritureBash('echo x > a.txt', c, '/tmp')).toBe(false));
});

describe('hook lecture obligatoire, Bash et code du hook (R31 ronde 3)', () => {
  const bash = (m: Monde, command: string, cwd = m.clone) => ({ tool_name: 'Bash', tool_input: { command }, transcript_path: m.t, cwd });
  it('Bash qui écrit dans le clone : refusé tant que la pièce n\'est pas lue, permis ensuite ; les commandes de lecture et de test passent', () => {
    const m = monde(); m.ecrire([]);
    refuse(hook(bash(m, 'echo x > a.txt'), env(m, [m.doc])), m.doc);
    refuse(hook(bash(m, "sed -i 's/a/b/' src/a.ts"), env(m, [m.doc])), m.doc);
    for (const cmd of ['npx vitest run', 'git status', 'git diff', 'ls', 'cat src/a.ts', 'npm run build 2>&1 | tail -5']) permis(hook(bash(m, cmd), env(m, [m.doc])));
    m.ecrire(lu({ file_path: m.doc }));
    permis(hook(bash(m, 'echo x > a.txt'), env(m, [m.doc])));
  });
  it('Bash qui touche aux réglages de Claude Code : refusé même pièces lues ; sans environnement : refusé', () => {
    const m = monde(); m.ecrire(lu({ file_path: m.doc }));
    refuse(hook(bash(m, 'echo \'{"disableAllHooks":true}\' > ~/.claude/settings.json'), env(m, [m.doc])), /réglages de Claude Code/);
    refuse(hook(bash(m, 'ls'), { ...env(m, [m.doc]), CADENCE_CLONE: undefined }), /CADENCE_CLONE/);
  });
  it('le code du hook (v2/hooks) : écriture refusée, par outil ou par Bash', () => {
    const m = monde(); m.ecrire(lu({ file_path: m.doc }));
    const ici = join(import.meta.dirname, '..', 'hooks');
    refuse(hook(ecriture(m, join(ici, 'lecture.mjs'), 'Edit'), env(m, [m.doc])), /code du hook/);
    refuse(hook(bash(m, `echo 'process.exit(0)' > ${join(ici, 'lecture-obligatoire.mjs')}`), env(m, [m.doc])), /code du hook/);
  });
  it('la mesure ferme la fenêtre de lecture sur une écriture par Bash', () => {
    const m = monde();
    const l = [JSON.stringify({ type: 'assistant', cwd: m.clone, message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo x > a.txt' } }] } }), ...lu({ file_path: m.doc })];
    expect(lectureReferences(l, [m.doc], m.clone)).toMatchObject({ ouvertes: [], apres_ecriture: [m.doc] });
    const neutre = [JSON.stringify({ type: 'assistant', cwd: m.clone, message: { content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'npx vitest run' } }] } }), ...lu({ file_path: m.doc })];
    expect(lectureReferences(neutre, [m.doc], m.clone).ouvertes).toEqual([m.doc]);
  });
});

// L808 (banc séquence aether-b68-court r2 du 22-11, ROUGE « aucune fuite ») : le bras cadence-run, dont la sonde Node posée dans qa/ ne trouvait
// pas playwright (installé dans frontend/node_modules), a lancé `ls -d ~/projects/developpeur/maritime-atlas/qa/node_modules/playwright
// ~/projects/developpeur/*/node_modules/playwright` : une LECTURE hors du clone, comptée fuite certaine (deux chemins). Au banc
// (CADENCE_LECTURE_BORNEE = id du banc, posé par lancerBras), le hook refuse l'appel que le détecteur compterait comme fuite certaine, avec la même règle.
describe('L808 : lecture hors du clone refusée au banc, avec la règle du détecteur de fuites', () => {
  const borne = (m: Monde, pieces: string[] = []) => ({ ...env(m, pieces), CADENCE_LECTURE_BORNEE: 'b' });
  const outilE = (m: Monde, tool_name: string, tool_input: object, cwd = m.clone) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, transcript_path: m.t, cwd });
  const projets = (m: Monde) => join(m.r, 'home', 'projects');
  it('la commande du banc du 22-11 : refusée au banc, le message nomme le chemin et dit où chercher ; permise hors banc (cadence run)', () => {
    const m = monde(); m.ecrire([]);
    const cmd = `ls -d ~/projects/developpeur/maritime-atlas/qa/node_modules/playwright ~/projects/developpeur/*/node_modules/playwright ${m.clone}/frontend/node_modules/@playwright 2>/dev/null | head; npm root -g`;
    const r = hook(outilE(m, 'Bash', { command: cmd }), borne(m));
    refuse(r, `${projets(m)}/developpeur/maritime-atlas/qa/node_modules/playwright`);
    expect(r.stderr).toMatch(/hors de ton dépôt/); expect(r.stderr).toContain(m.clone); expect(r.stderr).toMatch(/node_modules/);
    permis(hook(outilE(m, 'Bash', { command: cmd }), env(m, [])));
  });
  it('Read, Glob et Grep hors du clone (vrais dépôts, secrets, transcripts) et cd relatif : refusés au banc', () => {
    const m = monde(); m.ecrire([]);
    refuse(hook(outilE(m, 'Read', { file_path: join(projets(m), 'developpeur', 'maritime-atlas', 'qa', 'x.mjs') }), borne(m)), /hors de ton dépôt/);
    refuse(hook(outilE(m, 'Glob', { pattern: '**/*.ts', path: join(m.r, 'secrets') }), borne(m)), /hors de ton dépôt/);
    refuse(hook(outilE(m, 'Grep', { pattern: 'L', path: join(m.r, 'home', '.claude', 'projects', '-x') }), borne(m)), /hors de ton dépôt/);
    refuse(hook(outilE(m, 'Bash', { command: 'cd ../../home/projects && ls' }), borne(m)), /hors de ton dépôt/);
  });
  it('le clone, ses captures, les pièces, ses propres transcripts, le dossier temporaire et la commande sans chemin : permis au banc', () => {
    const m = monde(); m.ecrire([]);
    const home = join(m.r, 'home'), transcripts = join(home, '.claude', 'projects', m.clone.replace(/[^A-Za-z0-9]/g, '-'));
    permis(hook(outilE(m, 'Read', { file_path: join(m.clone, 'src', 'a.ts') }), borne(m)));
    permis(hook(outilE(m, 'Read', { file_path: m.doc }), borne(m, [m.doc])));
    permis(hook(outilE(m, 'Read', { file_path: join(transcripts, 's', 'tool-results', 'a.txt') }), borne(m)));
    permis(hook(outilE(m, 'Bash', { command: `cd ${m.clone}/frontend && npx vitest run; ls ../../c1.captures; cat /tmp/x/serve.log` }), borne(m)));
    permis(hook(outilE(m, 'Bash', { command: 'npm root -g' }), borne(m)));
    permis(hook(outilE(m, 'Bash', { command: `ls ${join(m.r, 'bancs', 'b')}` }), borne(m))); // son banc, comme reglesDuBras
    refuse(hook(outilE(m, 'Bash', { command: `ls ${join(m.r, 'bancs', 'autre')}` }), borne(m)), /hors de ton dépôt/);
    refuse(hook(outilE(m, 'Read', { file_path: join(m.clone, 'a.ts') }), { ...borne(m), CADENCE_LECTURE_BORNEE: '../x' }), /CADENCE_LECTURE_BORNEE/);
  });
  it('même règle que le détecteur : refusé au banc si et seulement si chercherFuites compte une fuite certaine', () => {
    const m = monde(); m.ecrire([]);
    const home = join(m.r, 'home'), regles = { ...reglesDuBras(home, m.r, 'b', m.clone), autorises: [...reglesDuBras(home, m.r, 'b', m.clone).autorises, m.doc] };
    const cas: [string, object][] = [
      ['Bash', { command: 'ls ~/projects/developpeur/*/node_modules/playwright' }], ['Bash', { command: `ls ${m.clone}/qa` }],
      ['Bash', { command: 'cd .. && ls' }], ['Bash', { command: `cat ${join(m.r, 'eval', 'x.md')}` }], ['Read', { file_path: m.doc }],
      ['Read', { file_path: join(m.r, 'rapports', 'r.md') }], ['Bash', { command: `ls ${join(m.r, 'bancs', 'b', 'x')} ${join(m.r, 'bancs')}` }], ['Grep', { pattern: 'x', path: join(m.clone, 'src') }], ['Bash', { command: 'echo ~/projects' }],
    ];
    for (const [name, input] of cas) {
      const certaine = chercherFuites([appel(name, input)], regles, home, m.clone).certaines.length > 0;
      expect([name, input, hook(outilE(m, name, input), borne(m, [m.doc])).code]).toEqual([name, input, certaine ? 2 : 0]);
    }
  });
  // Revue L808 r1 (M1) : 128 fichiers de maritime-atlas (source du clone aether) citent ~/projects ; les écrire, les chercher ou le dire dans un
  // message de commit n'est pas une lecture hors du clone.
  it('revue r1 : un texte écrit ou un motif qui cite ~/projects passe (Write, Edit, Grep, commit, heredoc, echo, grep) ; la lecture reste refusée', () => {
    const m = monde(); m.ecrire([]);
    const home = join(m.r, 'home'), regles = reglesDuBras(home, m.r, 'b', m.clone), f = join(m.clone, 'docs', 'a.md');
    const passent: [string, object][] = [
      ['Write', { file_path: f, content: 'Sources : ~/projects/developpeur/maritime-atlas/qa\n' }],
      ['Edit', { file_path: f, old_string: 'cd ~/projects/developpeur', new_string: `cd ${projets(m)}/developpeur/maritime-atlas` }],
      ['MultiEdit', { file_path: f, edits: [{ old_string: '~/projects/x', new_string: '~/projects/y' }] }],
      ['Grep', { pattern: '~/projects/developpeur', path: m.clone }], ['Grep', { pattern: `${projets(m)}/developpeur`, glob: '*.md' }],
      ['Glob', { pattern: 'docs/**/*.md' }],
      ['Bash', { command: 'git add -A && git commit -m "docs: le chemin ~/projects/developpeur ; suite" && git log -1', description: 'commit qui cite ~/projects/x' }],
      ['Bash', { command: `git commit -qm "$(cat <<'EOF'\nfix: ne lit plus ~/projects/developpeur\n\n${projets(m)}/x cité\nEOF\n)"` }],
      ['Bash', { command: `cat > docs/b.md <<EOF\nVoir ~/projects/developpeur/maritime-atlas\nEOF` }],
      ['Bash', { command: 'echo "voir ~/projects/developpeur" >> docs/a.md; printf \'%s\\n\' \'~/projects/x\' > docs/c.md' }],
      ['Bash', { command: 'grep -rn "~/projects/developpeur" docs | head; rg -l -e \'~/projects\' src' }],
    ];
    for (const [name, input] of passent) {
      expect([name, input, hook(outilE(m, name, input), borne(m)).code]).toEqual([name, input, 0]);
      expect([name, input, chercherFuites([appel(name, input)], regles, home, m.clone).certaines]).toEqual([name, input, []]); // le détecteur suit la même règle
    }
    const refuses: [string, object][] = [
      ['Read', { file_path: join(projets(m), 'developpeur', 'a.md') }], ['Read', { file_path: '~/projects/developpeur/a.md' }],
      ['Edit', { file_path: join(projets(m), 'developpeur', 'a.md'), old_string: 'a', new_string: 'b' }],
      ['Grep', { pattern: 'x', path: '../../home/projects' }], ['Glob', { pattern: `${projets(m)}/**/*.ts` }], ['Glob', { pattern: '**/*.ts', path: '~/projects' }],
      ['Bash', { command: 'git commit -m "x" && cat ~/projects/developpeur/a.md' }], ['Bash', { command: 'git commit -m "$(cat ~/projects/developpeur/a.md)"' }],
      ['Bash', { command: 'grep -rn motif ~/projects/developpeur' }], ['Bash', { command: 'grep -e motif ~/projects/developpeur/a.md' }],
      ['Bash', { command: 'echo "$(cat ~/projects/developpeur/a.md)"' }], ['Bash', { command: 'cat <<EOF | bash\nls ~/projects/developpeur\nEOF' }],
      ['Bash', { command: `python3 - <<'EOF'\nprint(open('${projets(m)}/developpeur/a.md').read())\nEOF` }],
      // revue r2 : rg --files n'a pas de motif (la recherche du 22-11), et un echo envoyé à xargs donne des chemins à lire
      ['Bash', { command: 'rg --files ~/projects/developpeur | grep playwright' }], ['Bash', { command: 'rg --files --hidden -g "*.mjs" ~/projects/developpeur' }],
      ['Bash', { command: `echo "${projets(m)}/developpeur/a.md" | xargs cat` }], ['Bash', { command: `printf '%s\\n' "${projets(m)}/x" |& sort | xargs -n1 cat` }],
    ];
    for (const [name, input] of refuses) {
      expect([name, input, hook(outilE(m, name, input), borne(m)).code]).toEqual([name, input, 2]);
      expect([name, input, chercherFuites([appel(name, input)], regles, home, m.clone).certaines.length > 0]).toEqual([name, input, true]);
    }
  });
  it('revue r1 : commandeLue ne retire que les textes écrits', () => {
    expect(commandeLue('git commit -am "a ; b" && ls x').replace(/ +/g, ' ')).toBe('git commit -am && ls x');
    expect(commandeLue('git checkout -m "a b"')).toBe('git checkout -m "a b"'); // pas un message
    expect(commandeLue('echo ~/projects "x y" $HOME').replace(/ +/g, ' ')).toBe('echo ~/projects $HOME'); // sans guillemets : le shell le développe, gardé
    expect(commandeLue('grep -f motifs.txt a/b')).toBe('grep -f motifs.txt a/b');
    expect(commandeLue('cat a | grep -v x/y z/t').replace(/ +/g, ' ')).toBe('cat a | grep -v z/t');
    expect(commandeLue('rg --files a/b | grep c/d').replace(/ +/g, ' ')).toBe('rg --files a/b | grep '); // revue r2 : --files, aucun motif
    expect(commandeLue('rg --type-list a/b; rg -l x/y a/b').replace(/ +/g, ' ')).toBe('rg --type-list a/b; rg -l a/b');
    expect(commandeLue('echo "/a/b" | xargs cat; echo "/c/d" || xargs cat; echo "/e/f" | tee g').replace(/ +/g, ' ')).toBe('echo "/a/b" | xargs cat; echo || xargs cat; echo | tee g');
    expect(commandeLue('node - <<EOF\nrequire("/a/b")\nEOF')).toContain('/a/b');
    expect(commandeLue('tee x.md <<EOF\n/a/b\nEOF')).not.toContain('/a/b');
  });
  // L817 (revue L808 r3) : un echo n'est effacé que si sa sortie va à un fichier ou à un filtre qui ne lit pas (tee, sort…), jamais dans $(…) ou un
  // sous-shell ; ~ et $HOME seuls, les globs, cd puis nom relatif et les commandes récursives sont jugés ; l'argument d'une option n'est pas le motif.
  it('L817 : echo lu par sh, while read, parallel, $(…), sous-shell ; find ~, ls ~/proj*, cd puis nom relatif : refusés et comptés', () => {
    const m = monde(); m.ecrire([]);
    const home = join(m.r, 'home'), regles = reglesDuBras(home, m.r, 'b', m.clone), P = projets(m);
    const passent: [string, object][] = [
      ['Bash', { command: `grep -m 1 ${P}/x notes.md` }], ['Bash', { command: `grep -A 3 -B2 "${P}/x" docs/a.md` }], ['Bash', { command: `rg -g "*.md" -t md ${P}/x src` }],
      ['Bash', { command: `echo "${P}/x" | tee -a notes.md` }], ['Bash', { command: `printf '%s\\n' "${P}/x" | sort | uniq | head -1 >> notes.md` }],
      ['Bash', { command: 'ls ~/.cache ~/.npm; find . -name playwright; grep -rn x .. ; cd ~/.cache && ls' }], ['Grep', { pattern: 'x', path: join(m.clone, 'src') }],
      ['Bash', { command: 'tr / _ < a.txt; ls ~' }], ['Glob', { pattern: '**/*.ts' }],
    ];
    for (const [name, input] of passent) {
      expect([name, input, hook(outilE(m, name, input), borne(m)).code]).toEqual([name, input, 0]);
      expect([name, input, chercherFuites([appel(name, input)], regles, home, m.clone).certaines]).toEqual([name, input, []]);
    }
    const refuses: [string, object][] = [
      ['Bash', { command: `echo "${P}/x" | sh` }], ['Bash', { command: `echo "cat ${P}/x" | bash` }], ['Bash', { command: `echo "${P}/x" | parallel cat` }],
      ['Bash', { command: `printf "%s" "${P}/x" | while read f; do cat "$f"; done` }], ['Bash', { command: `cat $(echo "${P}/x")` }],
      ['Bash', { command: `(echo "${P}/x") | xargs cat` }], ['Bash', { command: `diff a.md <(echo "${P}/x" | xargs cat)` }],
      ['Bash', { command: 'find ~ -name playwright' }], ['Bash', { command: 'find $HOME -name playwright -type d' }], ['Bash', { command: 'ls ~/proj*' }],
      ['Bash', { command: 'ls ~/*/developpeur' }], ['Bash', { command: 'cd $HOME; ls projects' }], ['Bash', { command: 'cd; cat projects/x' }],
      ['Bash', { command: 'cd ~ && find . -name playwright' }], ['Bash', { command: 'rg -l playwright ~' }], ['Bash', { command: 'grep -rl x $HOME' }],
      ['Bash', { command: 'ls -R ~ | grep playwright' }], ['Bash', { command: 'du -sh /' }], ['Bash', { command: 'ls projects', }, ],
      ['Grep', { pattern: 'playwright', path: '~' }], ['Glob', { pattern: '**/playwright', path: '~' }], ['Glob', { pattern: '~/p*/developpeur' }],
    ];
    for (const [name, input] of refuses) {
      const cwd = name === 'Bash' && (input as { command: string }).command === 'ls projects' ? home : m.clone; // dossier courant déjà dans ~ (cd d'un appel précédent)
      expect([name, input, hook(outilE(m, name, input, cwd), borne(m)).code]).toEqual([name, input, 2]);
      const l = JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', id: 'x', name, input }] } });
      expect([name, input, chercherFuites([l], regles, home, m.clone).certaines.length > 0]).toEqual([name, input, true]);
    }
  });
  it('L817 : commandeLue garde un echo lu, efface un echo écrit ; le motif de grep et rg suit les options à argument', () => {
    const c = (s: string) => commandeLue(s).replace(/ +/g, ' ');
    expect(c('echo "/a/b" | sh; echo "/c" | bash -s; echo "/d" | parallel cat')).toBe('echo "/a/b" | sh; echo "/c" | bash -s; echo "/d" | parallel cat');
    expect(c('cat $(echo "/a/b"); (echo "/c") | xargs cat')).toBe('cat $(echo "/a/b"); (echo "/c") | xargs cat');
    expect(c('echo "/a/b" | tee f | sort; echo "/c" > g; echo "/d"')).toBe('echo | tee f | sort; echo > g; echo ');
    expect(c('grep -m 1 /a/b c.md; grep -rA 3 x/y z; rg -g "*.md" -r t x/y z; rg -rt x/y z')).toBe('grep -m 1 c.md; grep -rA 3 z; rg -g "*.md" -r t z; rg -rt z');
    expect(c('grep -r x/y z; rg --max-count 2 x/y z; grep -- -x/y z')).toBe('grep -r z; rg --max-count 2 z; grep -- z');
  });
  // Revue L808 r1 (2) : en séquence, les règles de l'étape (reglesEtape) arrivent par CADENCE_LECTURE_ZONES ; le test « même règle » sur une vraie
  // séquence est dans passage.test.ts (« L808 : en séquence… »).
  it('revue r1 : CADENCE_LECTURE_ZONES ajoute des zones permises et refusées ; illisible = refus', () => {
    const m = monde(); m.ecrire([]);
    const seq = join(m.r, 'sequences', 's1'), z = (o: object) => ({ ...borne(m), CADENCE_LECTURE_ZONES: JSON.stringify(o) });
    const zones = { autorises: [join(seq, 'etapes', '1')], certains: [join(m.r, 'sequences'), join(m.r, 'run', 'etape-1.c2.json')] };
    permis(hook(outilE(m, 'Read', { file_path: join(seq, 'etapes', '2', 'demande.md') }), borne(m))); // sans zones : règle du banc court
    refuse(hook(outilE(m, 'Read', { file_path: join(seq, 'etapes', '2', 'demande.md') }), z(zones)), /hors de ton dépôt/);
    permis(hook(outilE(m, 'Read', { file_path: join(seq, 'etapes', '1', 'demande.md') }), z(zones)));
    refuse(hook(outilE(m, 'Bash', { command: 'cat ../etape-1.c2.json' }), z(zones)), /hors de ton dépôt/);
    refuse(hook(outilE(m, 'Read', { file_path: join(m.clone, 'a.ts') }), { ...borne(m), CADENCE_LECTURE_ZONES: '{"autorises":"x"}' }), /CADENCE_LECTURE_ZONES/);
    refuse(hook(outilE(m, 'Read', { file_path: join(m.clone, 'a.ts') }), { ...borne(m), CADENCE_LECTURE_ZONES: 'non' }), /CADENCE_LECTURE_ZONES/);
  });
  it('réglages du bras : le hook voit aussi Read, Glob et Grep', () => {
    const s = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'briefs', 'settings-sequence-v2.json'), 'utf8'));
    expect(s.hooks.PreToolUse[0].matcher.split('|')).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']));
  });
});
