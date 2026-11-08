import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lectureReferences } from '../src/sequence/mesures.js';
import { ecritureBash } from '../hooks/lecture.mjs';

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
  const r = mkdtempSync(join(tmpdir(), 'hook-lecture-'));
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
  it('rapide : transcript de 20 Mo lu en moins d\'une seconde (pièce lue à la fin)', () => {
    const m = monde();
    const fd = openSync(m.t, 'w');
    const bruit = `${appel('Bash', { command: 'x'.repeat(2000) })}\n${lu({ file_path: join(m.clone, 'src', 'a.ts') }).join('\n')}\n${resultat('t0').replace('"x"', `"${'y'.repeat(5000)}"`)}\n`;
    for (let k = 0; k < 20 << 20; k += bruit.length) writeSync(fd, bruit);
    writeSync(fd, `${lu({ file_path: m.doc }).join('\n')}\n`); closeSync(fd);
    const t0 = performance.now(); const r = hook(ecriture(m), env(m, [m.doc])); const ms = performance.now() - t0;
    permis(r);
    expect(ms).toBeLessThan(1000);
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
