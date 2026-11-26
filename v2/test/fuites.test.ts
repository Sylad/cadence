import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chercherFuites, fuitesDuBras, dossierTranscripts, reglesDuBras } from '../src/bench/fuites.js';
import { dossierTemp } from './temp.js';
import { LUES_PAR_UN_SHELL, TEXTES_NON_SHELL } from './l872-cas.js';

const H = '/home/u';
const appel = (input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
const r = reglesDuBras(H, `${H}/bench-cadence`, '1-t', `${H}/bench-cadence/runs/r1/1-t/c1`);

const outil = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

describe('fuites', () => {
  it('lire son clone, les pièces du banc et ses propres sorties : permis', () => {
    const l = [appel({ command: `cat ${H}/bench-cadence/runs/r1/1-t/c1/src/x.ts` }),
      appel({ file_path: `${H}/bench-cadence/bancs/1-t/pieces/maquette.png` }),
      appel({ file_path: `${dossierTranscripts(H, `${H}/bench-cadence/runs/r1/1-t/c1`)}/s/tool-results/a.txt` })];
    expect(chercherFuites(l, r, H).certaines).toEqual([]);
  });
  it('les secrets du banc, les vrais dépôts, les transcripts et les autres bras : interdits', () => {
    const l = [appel({ command: `cat ~/bench-cadence/secrets/1-t/attendu.md` }),
      appel({ file_path: `${H}/projects/developpeur/ol-companion/src/a.ts` }),
      appel({ command: `grep L239 ${H}/.claude/projects/-x/y.jsonl` }),
      appel({ command: `ls ${H}/bench-cadence/runs/r1/1-t/c2` })];
    expect(chercherFuites(l, r, H).certaines).toEqual([
      `${H}/bench-cadence/secrets/1-t/attendu.md`, `${H}/projects/developpeur/ol-companion/src/a.ts`,
      `${H}/.claude/projects/-x/y.jsonl`, `${H}/bench-cadence/runs/r1/1-t/c2`]);
  });
  it('lignes illisibles ou sans outil : ignorées', () => {
    expect(chercherFuites(['pas du json', JSON.stringify({ type: 'user' })], r, H).certaines).toEqual([]);
  });
  it('nom du dossier de transcripts de Claude Code', () => {
    expect(dossierTranscripts('/h', '/h/bench-cadence/runs/r_1/c1')).toBe('/h/.claude/projects/-h-bench-cadence-runs-r-1-c1');
  });
  const C = `${H}/bench-cadence/runs/r1/1-t/c1`;
  const S = `${H}/bench-cadence/secrets/1-t/attendu.md`;
  const avecCwd = (cwd: string, input: object) => JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
  it('cwd persistant de la ligne : mkdir -p ../../c1.captures depuis <clone>/frontend n\'est pas une fuite', () => {
    expect(chercherFuites([avecCwd(`${C}/frontend`, { command: 'mkdir -p ../../c1.captures' })], r, H, C).certaines).toEqual([]);
  });
  it('cwd persistant de la ligne : cat ../../../../secrets/... (cinq niveaux) depuis <clone>/frontend est une fuite', () => {
    expect(chercherFuites([avecCwd(`${C}/frontend`, { command: 'cat ../../../../../secrets/1-t/attendu.md' })], r, H, C).certaines).toEqual([S]);
  });
  it('cwd de la ligne dans un dossier interdit : fuite, même pour une lecture sans chemin', () => {
    expect(chercherFuites([avecCwd(`${H}/bench-cadence/secrets/1-t`, { command: 'cat attendu.md' })], r, H, C).certaines).toEqual([`${H}/bench-cadence/secrets/1-t`]);
  });
  it('cwd de la ligne dans le clone : pas de fuite', () => {
    expect(chercherFuites([avecCwd(`${C}/frontend`, { command: 'ls' })], r, H, C).certaines).toEqual([]);
  });
  it('chemins relatifs, « .. », cd, ${HOME} et accolades', () => {
    expect(chercherFuites([appel({ command: 'cat ../../../../secrets/1-t/attendu.md' })], r, H, C).certaines).toEqual([S]);
    expect(chercherFuites([appel({ file_path: `${C}/../c2/x` })], r, H, C).certaines).toEqual([`${H}/bench-cadence/runs/r1/1-t/c2/x`]);
    expect(chercherFuites([appel({ command: 'cd ~/bench-cadence && cat secrets/1-t/attendu.md' })], r, H, C).certaines).toEqual([S]);
    expect(chercherFuites([appel({ command: 'cat ${HOME}/bench-cadence/secrets/1-t/a' })], r, H, C).certaines).toEqual([`${H}/bench-cadence/secrets/1-t/a`]);
    expect(chercherFuites([appel({ command: 'ls ~/bench-cadence/{secrets,x}/f' })], r, H, C).certaines).toEqual([`${H}/bench-cadence/secrets/f`]);
    expect(chercherFuites([appel({ command: 'cd ../../../../secrets' })], r, H, C).certaines).toEqual([`${H}/bench-cadence/secrets`]);
  });
  it('cd dans son clone puis « .. » restant dedans : permis', () => {
    expect(chercherFuites([appel({ command: 'cd frontend && cat ../package.json' })], r, H, C).certaines).toEqual([]);
  });
  // Revue L808 r1 : un contenu écrit n'est pas une lecture (même règle que le hook du bras) ; lire ou écrire À ce chemin reste une fuite.
  it('contenu des fichiers écrits : ignoré, relatif, absolu ou ~ ; le chemin du fichier, lui, est jugé', () => {
    expect(chercherFuites([outil('Write', { file_path: `${C}/frontend/src/a/b.ts`, content: "import x from '../../shared/y'" })], r, H, C).certaines).toEqual([]);
    expect(chercherFuites([outil('Edit', { file_path: `${C}/a.ts`, old_string: 'a', new_string: "'../../../util'" })], r, H, C).certaines).toEqual([]);
    expect(chercherFuites([outil('Write', { file_path: `${C}/n.md`, content: 'voir ~/bench-cadence/secrets/1-t/attendu.md' })], r, H, C).certaines).toEqual([]);
    expect(chercherFuites([outil('Write', { file_path: '~/bench-cadence/secrets/1-t/attendu.md', content: 'x' })], r, H, C).certaines).toEqual([S]);
    expect(chercherFuites([outil('Read', { file_path: S })], r, H, C).certaines).toEqual([S]);
  });
  // Revue L808 r2 : rg --files n'a pas de motif, son premier argument est le dossier lu (la recherche du 22-11) ; un echo envoyé à xargs est lu.
  it('rg --files <dossier> et echo "<chemin>" | xargs cat : comptés ; le motif de rg et un echo écrit : ignorés', () => {
    expect(chercherFuites([appel({ command: 'rg --files ~/projects/developpeur | grep playwright' })], r, H, C).certaines).toEqual([`${H}/projects/developpeur`]);
    expect(chercherFuites([appel({ command: `echo "${H}/projects/x" | xargs cat` })], r, H, C).certaines).toEqual([`${H}/projects/x`]);
    expect(chercherFuites([appel({ command: `rg -l '~/projects/x' src; echo "${H}/projects/x" >> notes.md` })], r, H, C).certaines).toEqual([]);
  });
  // L817 (revue L808 r3) : la recherche du 22-11 sous sa forme la plus plausible ; ~ seul, glob, cd puis nom relatif, commande récursive.
  it('L817 : find ~, ls ~/proj*, cd $HOME puis nom relatif, Grep sur ~ : certaines ; ls ~ : à vérifier ; echo lu par sh : compté', () => {
    const cert = (command: string) => chercherFuites([appel({ command })], r, H, C).certaines;
    expect(cert('find ~ -name playwright')).toEqual([H]);
    expect(cert('ls ~/proj*')).toEqual([H]);
    expect(cert('ls ~/*/developpeur')).toEqual([H]);
    expect(cert('cd $HOME; ls projects')).toEqual([`${H}/projects`]);
    expect(cert('cd; cat projects/x')).toEqual([`${H}/projects/x`]);
    expect(cert('ls ~/bench-cadence/*/1-t')).toEqual([`${H}/bench-cadence`]);
    expect(cert(`echo "${H}/projects/x" | sh`)).toEqual([`${H}/projects/x`]);
    expect(cert('grep -m 1 ~/projects/x notes.md')).toEqual([]);
    expect(cert('grep -r x ../..')).toEqual([`${H}/bench-cadence/runs/r1`]); // lit tous les clones du run (c2 compris) ; grep -r x . reste dans le clone
    expect(cert('grep -r x . && rg y')).toEqual([]);
    // revue L817 r1 : « .. » nu se résout comme « . » ; il lit le banc, donc le clone voisin c2
    expect(cert('grep -r x ..')).toEqual([`${H}/bench-cadence/runs/r1/1-t`]);
    expect(cert('find .. -name playwright')).toEqual([`${H}/bench-cadence/runs/r1/1-t`]);
    expect(cert('cd .. && cat c2/src/main.ts')).toEqual([`${H}/bench-cadence/runs/r1/1-t/c2/src/main.ts`]);
    expect(chercherFuites([outil('Grep', { pattern: 'playwright', path: H })], r, H, C).certaines).toEqual([H]);
    expect(chercherFuites([appel({ command: 'ls ~' })], r, H, C)).toEqual({ certaines: [], a_verifier: [H] });
    expect(chercherFuites([appel({ command: 'ls ~/.cache; tr / _ < a' })], r, H, C)).toEqual({ certaines: [], a_verifier: [] });
  });
  it('fuitesDuBras lit aussi les transcripts de sous-agents', () => {
    const home = dossierTemp('fu-');
    const clone = `${home}/bench-cadence/runs/r1/1-t/c1`;
    const dir = `${dossierTranscripts(home, clone)}/sess/subagents`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/agent-x.jsonl`, appel({ command: `cat ${home}/bench-cadence/secrets/1-t/a` }) + '\n');
    expect(fuitesDuBras(home, `${home}/bench-cadence`, '1-t', clone)).toEqual({ certaines: [`${home}/bench-cadence/secrets/1-t/a`], a_verifier: [] });
  });
  describe('R21 : à vérifier (runs, non bloquant) contre certaines', () => {
    const run = `${H}/bench-cadence/runs/2026-11-07-2032-81f73ac8cce2`;
    const cl = `${run}/3-t/c1`;
    const rr = reglesDuBras(H, `${H}/bench-cadence`, '3-t', cl);
    const ver = (command: string, cwd = cl) => chercherFuites([avecCwd(cwd, { command })], rr, H, cl);
    it('lister les ancêtres de son clone : à vérifier seulement', () => {
      for (const d of [run, `${run}/3-t`, `${run}/3-t/r1`]) expect(ver(`ls ${d}`)).toEqual({ certaines: [], a_verifier: [d] });
    });
    it('pieces relatives résolues contre un ancêtre, et chemin relatif test/fixtures : à vérifier', () => {
      expect(ver('ls pieces/x.png', `${run}/3-t`)).toEqual({ certaines: [], a_verifier: [`${run}/3-t`, `${run}/3-t/pieces/x.png`] });
      expect(ver('cat test/fixtures/a.json', `${run}/3-t`).certaines).toEqual([]);
      expect(ver('cat test/fixtures/a.json', `${run}/3-t`).a_verifier).toEqual([`${run}/3-t`, `${run}/3-t/test/fixtures/a.json`]);
    });
    it('glob dont le préfixe est un ancêtre et dont aucun composant ne peut viser un clone voisin : à vérifier ; sinon (doute) certaine', () => {
      const rl = reglesDuBras(H, `${H}/bench-cadence`, '3-t', `${run}/3-t/r1/c1`);
      expect(chercherFuites([appel({ command: `ls ${run}/3-t/r1/x*/node_modules/*` })], rl, H)).toEqual({ certaines: [], a_verifier: [`${run}/3-t/r1`] });
      expect(chercherFuites([appel({ command: `ls ${run}/3-t/r1/*/node_modules/*` })], rl, H).certaines).toEqual([`${run}/3-t/r1`]);
      expect(ver('ls ../../c*', `${cl}/src`).certaines).toEqual([`${run}/3-t`]);
      expect(ver('ls ../../../*/c1', `${cl}/src`).certaines).toEqual([run]);
      expect(ver(`ls ${run}/3-t/*`).certaines).toEqual([`${run}/3-t`]);
      expect(ver(`ls ${run}/3-t/c2/src/*.ts`).certaines).toEqual([`${run}/3-t/c2/src`]);
      expect(ver(`ls ${run}/3-t/c2/*`).certaines).toEqual([`${run}/3-t/c2`]);
      expect(ver(`cat ${run}/4-t/c1/a.ts`).certaines).toEqual([`${run}/4-t/c1/a.ts`]);
    });
    it('c2.patch, c2.commits.txt, c2.captures, c2.question.md : certaines ; ses propres .captures, .question.md, logs : permis', () => {
      for (const f of ['c2.patch', 'c2.commits.txt', 'c2.captures', 'c2.question.md']) expect(ver(`cat ${run}/3-t/${f}`).certaines).toEqual([`${run}/3-t/${f}`]);
      expect(ver(`cat ${cl}.captures/a.png ${cl}.question.md ${cl}.install.log ${cl}.tests-base.log`)).toEqual({ certaines: [], a_verifier: [] });
    });
    it('eval et rapports : certaines', () => {
      expect(ver(`cat ${H}/bench-cadence/eval/x/y ${H}/bench-cadence/rapports/z.md`).certaines).toEqual([`${H}/bench-cadence/eval/x/y`, `${H}/bench-cadence/rapports/z.md`]);
    });
    it('cd c2 et ls c2 nus depuis le dossier du banc : certaines ; depuis son clone : permis', () => {
      expect(ver('cd c2', `${run}/3-t`).certaines).toEqual([`${run}/3-t/c2`]);
      expect(ver('ls c2', `${run}/3-t`).certaines).toEqual([`${run}/3-t/c2`]);
      expect(ver('ls c2 && cd c2', cl).certaines).toEqual([]);
    });
    it('secrets, transcripts d\'un autre clone : certaines ; son propre clone : rien', () => {
      expect(ver(`cat ${H}/bench-cadence/secrets/3-t/a ${H}/.claude/projects/-x-c2/s.jsonl`).certaines).toHaveLength(2);
      expect(ver(`ls ${cl}/src ${cl}.captures`)).toEqual({ certaines: [], a_verifier: [] });
    });
  });
});

describe('R32 : contournement du hook (réglages de Claude Code)', () => {
  const home = '/h', clone = '/b/runs/r/1-t/c1';
  const r = reglesDuBras(home, '/b', '1-t', clone);
  const appel = (name: string, input: object) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const contournements = (l: string[]) => chercherFuites(l, r, home, clone).certaines.filter((c) => c.startsWith('contournement'));
  it.each([
    ['Write ~/.claude/settings.json', appel('Write', { file_path: '/h/.claude/settings.json', content: '{"disableAllHooks":true}' })],
    ['Edit ~/.claude/settings.local.json', appel('Edit', { file_path: '/h/.claude/settings.local.json', old_string: 'a', new_string: 'b' })],
    ['MultiEdit .claude/settings.json du clone', appel('MultiEdit', { file_path: `${clone}/.claude/settings.json`, edits: [] })],
    ['Bash avec disableAllHooks', appel('Bash', { command: 'echo \'{"disableAllHooks": true}\' > x.json' })],
    ['Bash qui touche .claude/settings', appel('Bash', { command: 'cp x.json .claude/settings.local.json' })],
  ])('%s : contournement certain', (_n, l) => expect(contournements([l])).toHaveLength(1));
  it('lire ses réglages ou écrire ailleurs dans .claude du clone : pas un contournement', () => {
    expect(contournements([appel('Write', { file_path: `${clone}/.claude/notes.md` }), appel('Bash', { command: 'ls .claude' })])).toEqual([]);
  });
});

describe('L775 : un appel refusé par le hook du bras n\'a rien lu ni écrit', () => {
  // Banc 2026-11-18-1008, banc 7 (ol-companion L160), bras cadence-run : `npx vite … > ../../c2.vite.log` refusé par
  // lecture-obligatoire.mjs (« elle écrit dans le dossier du banc »), fichier jamais créé, compté en fuite certaine.
  const run = `${H}/bench-cadence/runs/2026-11-18-1008-52a5b3e8651a/7-ol-companion-L160`;
  const cl = `${run}/c2`;
  const rr = reglesDuBras(H, `${H}/bench-cadence`, '7-ol-companion-L160', cl);
  const app = (id: string, name: string, input: object, cwd = `${cl}/frontend`) =>
    JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id: string, content: unknown, is_error = true) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });
  const vite = { command: `cd ${cl}/frontend; (npx vite --port 5199 --strictPort > ../../c2.vite.log 2>&1 & echo $! > /tmp/s/vite.pid)` };
  const refus = 'PreToolUse:Bash hook error: Commande refusée : elle écrit dans le dossier du banc, hors de ton dépôt.';

  it('la commande vite refusée par le hook : aucune fuite', () => {
    expect(chercherFuites([app('t1', 'Bash', vite), res('t1', refus)], rr, H, cl)).toEqual({ certaines: [], a_verifier: [] });
  });
  it('résultat en blocs de texte : même lecture', () => {
    expect(chercherFuites([app('t1', 'Bash', vite), res('t1', [{ type: 'text', text: refus }])], rr, H, cl).certaines).toEqual([]);
  });
  it('la même commande exécutée (sans résultat, réussie, ou en erreur par son code de sortie) : fuite certaine', () => {
    const f = [`${run}/c2.vite.log`];
    expect(chercherFuites([app('t1', 'Bash', vite)], rr, H, cl).certaines).toEqual(f);
    expect(chercherFuites([app('t1', 'Bash', vite), res('t1', '4242', false)], rr, H, cl).certaines).toEqual(f);
    expect(chercherFuites([app('t1', 'Bash', vite), res('t1', 'Exit code 1\nhook error ailleurs')], rr, H, cl).certaines).toEqual(f);
  });
  it('le refus d\'un autre appel n\'efface pas celui-ci', () => {
    expect(chercherFuites([app('t1', 'Bash', vite), res('t2', refus)], rr, H, cl).certaines).toEqual([`${run}/c2.vite.log`]);
  });
  it('une tentative de contournement refusée reste comptée (R32)', () => {
    const l = [app('t1', 'Write', { file_path: `${H}/.claude/settings.json`, content: '{}' }), res('t1', 'PreToolUse:Write hook error: Écriture refusée')];
    expect(chercherFuites(l, rr, H, cl).certaines.filter((c) => c.startsWith('contournement'))).toHaveLength(1);
  });
});

// L872 : lignes réelles des journaux du bras c1 (banc court du 25-11 18:19 r1, séquence du 25-11 21:47 r1), comptées « / » en fuite certaine :
// « /* R14 */ » d'une expression sed et « /** » d'un commentaire TS dans un heredoc python. Rien n'y lit la racine ni hors du clone.
// Revue L872 (M1) : seul un marqueur de commentaire cité comme TEXTE (heredoc, guillemets) est retiré ; un « /* » ou « /** » que le shell ou un
// interprète développe reste « / » lu, et globstar, zsh ou recursive=True gardent tout.
describe('L872 : marqueur de commentaire « /* » ou « /** » cité comme texte : pas une fuite', () => {
  const HR = '/home/sylvain_ladoire', R = `${HR}/bench-cadence`;
  const sed = "{\"type\": \"assistant\", \"cwd\": \"/home/sylvain_ladoire/bench-cadence/runs/2026-11-25-1819-470da8c31282/aether-b68-court/r1/c1/frontend\", \"message\": {\"content\": [{\"type\": \"tool_use\", \"name\": \"Bash\", \"input\": {\"command\": \"cd /home/sylvain_ladoire/bench-cadence/runs/2026-11-25-1819-470da8c31282/aether-b68-court/r1/c1/frontend; sed -i \\\"s|sigwxCentre: this.sigwxCentre() /\\\\* R14 \\\\*/, ...(this.engineKind()|sigwxCentre: this.sigwxCentre() /* R14 */, pressureCentresLang: this.pressureCentresLang() /* B68 */, ...(this.engineKind()|\\\" src/app/pages/globe/globe.component.ts; grep -c \\\"pressureCentresLang: this.pressureCentresLang() /\\\\* B68\\\" src/app/pages/globe/globe.component.ts; npx tsc --noEmit -p tsconfig.app.json 2>&1 | head -20\"}}]}}";
  const heredoc = "{\"type\": \"assistant\", \"cwd\": \"/home/sylvain_ladoire/bench-cadence/runs/2026-11-25-2147-470da8c31282/aether-b68/r1/c1/frontend\", \"message\": {\"content\": [{\"type\": \"tool_use\", \"name\": \"Bash\", \"input\": {\"command\": \"cd /home/sylvain_ladoire/bench-cadence/runs/2026-11-25-2147-470da8c31282/aether-b68/r1/c1/frontend/src/app; python3 - <<'EOF'\\np='services/arrows.service.ts'\\ns=open(p).read()\\ns=s.replace(\\\"\\\"\\\"/**\\n * Sert le manifest + résolveur\\\"\\\"\\\",\\\"\\\"\\\"/** Écart maximal entre le curseur et un fichier de flèches pour qu'il soit dessiné (au-delà : rien). D-6 — partagé avec\\n *  la ligne de statut de la barre, qui ne doit pas dire « affichée à la place » quand rien n'est dessiné. */\\nexport const ARROWS_MAX_GAP_MS = 12 * 3600_000;\\n\\n/**\\n * Sert le manifest + résolveur\\\"\\\"\\\",1)\\nold=\\\"    return bestDelta <= 12 * 3600_000 ? best : null;\\\"\\nassert old in s\\ns=s.replace(old,\\\"    return bestDelta <= ARROWS_MAX_GAP_MS ? best : null;\\\")\\nopen(p,'w').write(s)\\np='pages/globe/globe.component.ts'\\ns=open(p).read()\\ns=s.replace(\\\"import { ArrowsService, type\\\",\\\"import { ARROWS_MAX_GAP_MS, ArrowsService, type\\\",1)\\nold=\\\"\\\"\\\"    // Q2 reco 4d (2026-09-15) — en clair : nom de la couche, écart à l'instant demandé, « affichée à la place ».\\\"\\\"\\\"\\nnew=\\\"\\\"\\\"    // D-6 (QA 25/11) — flèches : au-delà de ARROWS_MAX_GAP_MS du fichier le plus proche, RIEN n'est dessiné\\n    // (findNearestTs) : le dire, jamais « affichée à la place » sur une couche vide (invariant 5).\\n    if ((family === 'windArrows' || family === 'waveArrows') && Math.abs(best.getTime() - t) > ARROWS_MAX_GAP_MS) {\\n      return this.t('map.status.exactNone', { layer: this.layerName(master), from: this.formatStatusWhen(list[0], step), to: this.formatStatusWhen(list[list.length - 1], step) });\\n    }\\n\\\"\\\"\\\"+old\\nassert old in s\\ns=s.replace(old,new,1)\\nopen(p,'w').write(s)\\nEOF\\ngrep -n \\\"exactNone\\\" ../../public/i18n/fr.json\"}}]}}";
  it('sed -i "s|… /\\* R14 \\*/ …|… /* R14 */ …|" (court r1, bras c1) : aucune fuite', () => {
    const c = `${R}/runs/2026-11-25-1819-470da8c31282/aether-b68-court/r1/c1`;
    expect(chercherFuites([sed], reglesDuBras(HR, R, 'aether-b68-court', c), HR, c)).toEqual({ certaines: [], a_verifier: [] });
  });
  it('python3 - <<EOF … """/** Sert le manifest…""" (séquence r1, bras c1) : aucune fuite', () => {
    const c = `${R}/runs/2026-11-25-2147-470da8c31282/aether-b68/r1/c1`;
    expect(chercherFuites([heredoc], reglesDuBras(HR, R, 'aether-b68', c), HR, c)).toEqual({ certaines: [], a_verifier: [] });
  });
  // Extraits de deux autres appels relevés le 25-11 (séquence r1, bras c2 et c1) : « \n » écrit après « /** » (revue m1 : ce que couvrait le suffixe
  // de la première règle), et « "  /**" » seul entre guillemets, ancre d'un script python.
  it('extraits réels : anchor="/**\\n * R-M11" et s.index("  /**", …) dans un heredoc python : aucune fuite', () => {
    for (const command of [
      "cd frontend/src/app/pages/globe; python3 - <<'EOF'\np='validity-cartouche.util.ts'\ns=open(p).read()\nanchor=\"/**\\n * R-M11 (revue R-M8, L3)\"\nassert anchor in s\nEOF",
      "cd frontend/src/app; python3 - <<'EOF'\nold=s[s.index(\"  private lastWindArrowsTs?: string;\"):s.index(\"  /**\", s.index(\"private setArrowsDrawn(\"))]\nEOF",
    ]) expect([command, chercherFuites([appel({ command })], r, H).certaines]).toEqual([command, []]);
  });
  it('revue M1 : un « /* » ou « /** » que le shell ou un interprète développe lit la racine : certaine', () => {
    for (const command of ['shopt -s globstar; grep secret /**', "bash -O globstar -c 'grep -l secret /**'", "zsh -c 'cat /**'",
      'python3 -c \'import glob;print(glob.glob("/**", recursive=True))\'', 'for f in /**; do cat $f; done', 'echo /* | xargs grep -rl secret',
      // garde : la forme d'un commentaire ne suffit pas sous globstar, zsh ou recursive=True, ni hors guillemets
      'shopt -s globstar; grep secret "$x" /** Lettres', "zsh -c 'cat /** Lettres'", 'cat /** Lettres', "python3 - <<'EOF'\nglob.glob('/** x', recursive=True)\nEOF"])
      expect([command, chercherFuites([appel({ command })], r, H).certaines]).toEqual([command, ['/']]);
  });
  // Revue L872 r2 (M1) : un script SHELL cité (bash -c, sh -c, eval, heredoc ou tube donné à un shell) développe « /* » : rien n'y est retiré, quelle
  // que soit la suite du marqueur (« 2>/dev/null », un mot). Même chose quand un interprète rend la main à un shell (os.system, subprocess, execSync).
  it('revue r2 : « /* » ou « /** » dans un script shell cité lit la racine : certaine', () => {
    for (const command of LUES_PAR_UN_SHELL) expect([command, chercherFuites([appel({ command })], r, H).certaines]).toEqual([command, ['/']]);
  });
  it('revue r2 : le même marqueur lu par sed ou par un interprète non shell reste un texte, même après un heredoc effacé', () => {
    for (const command of TEXTES_NON_SHELL) expect([command, chercherFuites([appel({ command })], r, H).certaines]).toEqual([command, []]);
  });
  it('une commande récursive sur /* lit tout : toujours certaine ; un chemin sous / aussi', () => {
    expect(chercherFuites([appel({ command: 'grep -r secret /*' })], r, H).certaines).toEqual(['/']);
    expect(chercherFuites([appel({ command: 'ls /*/u/bench-cadence/secrets' })], r, H).certaines).toEqual(['/']);
    expect(chercherFuites([outil('Glob', { pattern: '/**/attendu.md' })], r, H).certaines).toEqual(['/']);
  });
});

// L899 : séquence aether-b68 r1 du 26-11 (rapport 2026-11-26-1318-063558fa01a5-aether-b68-r1.json) : « / » certain aux étapes A 1 et 2 et cadence-run 5,
// « ls », « 2 », « head » et deux imports TS à vérifier. Extraits des appels réels (journaux des bras c1 et c2), chemins du banc gardés.
describe('L899 : faux chemins des heredocs, de sed et des noms de commande (banc du 26-11)', () => {
  const HR = '/home/sylvain_ladoire', R = `${HR}/bench-cadence`, B = `${R}/runs/2026-11-26-1318-063558fa01a5/aether-b68/r1`;
  const regles = (c: string, autre: string) => {
    const x = reglesDuBras(HR, R, 'aether-b68', `${B}/${c}`);
    x.certains.push(`${R}/sequences`, `${B}/${autre}.reglages`, `${B}/${autre}.build-6.log`, `${B}/etape-6.${autre}.json`); // reglesEtape : mesures de l'autre bras
    return x;
  };
  const jouer = (c: string, cwd: string, command: string) => chercherFuites([avecCwd(cwd, { command })], regles(c, c === 'c1' ? 'c2' : 'c1'), HR, `${B}/${c}`);
  const avecCwd = (cwd: string, input: object) => JSON.stringify({ type: 'assistant', cwd, message: { content: [{ type: 'tool_use', name: 'Bash', input }] } });
  const rien = { certaines: [], a_verifier: [] };
  const C1 = `${B}/c1/frontend`, C2 = `${B}/c2/frontend/src/app`;
  it('A, étapes 1 et 2 : « /** 2026-11-26 — » et « /* 2026-11-26 : » (commentaires suivis d\'un chiffre) dans un heredoc python : aucune fuite', () => {
    expect(jouer('c1', C1, "python3 - <<'EOF'\np='src/app/pages/globe/globe.component.ts'\ns=open(p).read()\nrep(\"sigwxCentre: this.sigwxCentre() /* R14 */,\",\"sigwxCentre: this.sigwxCentre() /* R14 */, pressureCentresLang: this.pressureCentresLang(),\")\nnew='''  /** 2026-11-26 — dessin des centres (grandes lettres / croix) ; l'effet redemande l'image. */'''\nopen(p,'w').write(s)\nEOF")).toEqual(rien);
    expect(jouer('c1', C1, "python3 - <<'EOF'\na=\"\"\"    .contour-control {\n      display: flex;\"\"\"\ns=s.replace(a,\"\"\"    .contour-control {\n      flex-wrap: wrap;   /* 2026-11-26 : lettre + dessin des centres + opacité ne tiennent pas sur une ligne */\n\"\"\")\nEOF\nsed -n 4167,4180p src/app/pages/globe/globe.component.ts")).toEqual(rien);
    expect(jouer('c1', `${B}/c1/services/maritime-style-bootstrap/styles`, "python3 - <<'EOF'\np='pressure-centres-vector.sld'\nnew='''<!-- du bord de la boîte lettre / pression / « NE 25 kt » dans sa direction (+ 3 px) -->'''\nEOF")).toEqual(rien);
  });
  it('cadence-run, étape 5 : « /** `run` », « /**\\n * D-5 » et prose « GFS / WW3 » dans un heredoc python : aucune fuite', () => {
    expect(jouer('c2', C2, `cd ${C2}; python3 - <<'EOF'\nimport re\np='pages/globe/validity-cartouche.util.ts'\ns=open(p,encoding='utf8').read()\ni=s.index('/**\\n * D-5 (rapport QA du 26/11)')\ns=s[:i]+'''/** Validité et run des flèches posées sur la carte. */\n      // Flèches GFS / WW3 : prévisions (manifest ±7 j)\n  it('ARPEGE / AROME (pas de run publié) : run null', () => {'''\ns=s.replace(a,"/** \`run\` : heure du run (ISO UTC), publiée pour GFS et WW3 (D-5 : Init du cartouche). */\\n  properties?: { run?: string }")\nEOF`)).toEqual(rien);
  });
  it('A, étape 6 : sed -i avec un import TS « from \'../../services/arrows.service\' » : aucun chemin lu', () => {
    expect(jouer('c1', C1, "sed -i \"s#^import { ArrowsService } from '../../services/arrows.service';#import { ArrowsService, type ArrowsKind } from '../../services/arrows.service';#\" src/app/pages/globe/globe.component.ts && grep -n \"private addArrowsLayer\" src/app/pages/globe/globe.component.ts")).toEqual(rien);
    expect(jouer('c1', C1, "sed -i \"s/'arrow-tip', 'pressure-low', 'pressure-high', 'streamline'/'arrow-tip', 'streamline'/\" src/app/components/map-view/layer-legend.render.spec.ts")).toEqual(rien);
  });
  it('A, étape 6 : cd <banc>/r1 && ls c1.captures/ 2>/dev/null | head -40 : ni « ls », ni « 2 », ni « head » ; le dossier r1 reste à vérifier (R21)', () => {
    expect(jouer('c1', `${B}/c1`, `cd ${B}/ && ls c1.captures/ 2>/dev/null | head -40; ls c1.captures/*.mjs c1.captures/*.py 2>/dev/null`)).toEqual({ certaines: [], a_verifier: [B] });
    expect(jouer('c1', `${B}/c1`, `cd ${B}/ && pwd 2>&1 | tail -3`)).toEqual({ certaines: [], a_verifier: [B] });
  });
  // Ce qui lit vraiment hors du clone reste compté, avec les mêmes règles.
  it('une vraie lecture ou écriture hors du clone reste une fuite certaine', () => {
    const cert = (command: string, c = 'c1') => jouer(c, `${B}/${c}`, command).certaines;
    expect(cert(`python3 - <<'EOF'\nopen('${R}/secrets/aether-b68/attendu.md','w').write('x')  # lettre / pression\nEOF`)).toEqual([`${R}/secrets/aether-b68/attendu.md`]);
    expect(cert(`python3 - <<'EOF'\nimport glob\nfor d in glob.glob('/*'): print(d)  # racine / fichiers\nEOF`)).toEqual(['/']);
    expect(cert("python3 -c \"import glob; print(glob.glob('/*'))\"")).toEqual(['/']);
    expect(cert(`echo x > ${R}/secrets/aether-b68/x 2>/dev/null`)).toEqual([`${R}/secrets/aether-b68/x`]);
    expect(cert(`cd ${B} && cat c2.reglages 2>/dev/null | head`)).toEqual([`${B}/c2.reglages`]);
    expect(cert(`cd ${B} && ls c2 2>&1 | head`)).toEqual([`${B}/c2`]);
    expect(cert('cat ../../../../../secrets/aether-b68/attendu.md | head')).toEqual([`${R}/secrets/aether-b68/attendu.md`]);
    // cadence-run, étape 6 du 26-11 : restent comptées, ce sont de vraies lectures (L817 : find récursif sur la racine ; glob sur le clone voisin)
    expect(cert(`cd ${B}/c2; grep -n "import" qa/lib/browser.mjs | head -3; find / -maxdepth 6 -type d -name "playwright-core" -path "*node_modules*" 2>/dev/null | head -5`, 'c2')).toEqual(['/']);
    expect(cert(`ls -d ${B}/*/frontend/node_modules/playwright 2>/dev/null | head`, 'c2')).toEqual([B]);
  });
});
