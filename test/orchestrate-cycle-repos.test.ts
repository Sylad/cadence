import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { OrchestrateConfig } from '../src/config.js';
import { renderBrief, reposText, type BriefVars } from '../src/orchestrate/briefs.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, commitFile, git, harness, precheckReport, reviewReport, workReport, type Call, type Handler } from './orchestrate-harness.js';
import { gitRepo, tempDir } from './helpers.js';

const NB = '../gitops';

/** Un dépôt voisin non cadence, avec un premier commit. */
function neighbour(): string {
  const dir = gitRepo();
  commitFile(dir, 'README.md', 'init');
  return dir;
}

type Script = Partial<Record<Call['kind'], Handler[]>>;

/** Un lot L1 dont le travail est aussi dans un dépôt voisin ; `script` reçoit le chemin du voisin. */
function scenario(script: (nb: string) => Script, config: Partial<OrchestrateConfig> = {}) {
  const nb = neighbour();
  const h = harness({ script: script(nb) });
  const c = h.lot('L1', { repos: [{ rel: NB, path: nb }] }, config);
  return { h, c, nb };
}

/** Une implémentation qui commite dans le dépôt du projet ET dans le voisin. */
const both = (nb: string): Handler => (call) => {
  const p = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): côté projet');
  const n = commitFile(nb, 'chart.yaml', 'feat(L1): côté voisin');
  return claudeOut(workReport({ commits: [p, n] }));
};
/** Tout le travail est dans le voisin : le dépôt du projet ne bouge pas. */
const onlyNeighbour = (nb: string): Handler => () => claudeOut(workReport({ commits: [commitFile(nb, 'chart.yaml', 'feat(L1): côté voisin')] }));
const ok: Handler = () => claudeOut(reviewReport());

describe('sessions d\'un lot à dépôt voisin (L62)', () => {
  it('chaque session reçoit le voisin en --add-dir, à la suite des dossiers de la configuration', async () => {
    const { h, c, nb } = scenario((n) => ({ implement: [both(n)], review: [ok] }), { addDirs: ['/autre/dossier'] });
    await runLot(c);
    expect(h.calls.map((k) => k.kind)).toEqual(['implement', 'review']);
    for (const call of h.calls) {
      expect(call.args.filter((_a, k) => call.args[k - 1] === '--add-dir')).toEqual(['/autre/dossier', nb]);
    }
  });

  it('le brief d\'implémentation nomme le voisin et exige que ses commits citent le lot ; celui de la revue dit de les lire', async () => {
    const { h, c, nb } = scenario((n) => ({ implement: [both(n)], review: [ok] }));
    await runLot(c);
    const [implement, review] = h.calls;
    expect(implement.brief).toContain(NB);
    expect(implement.brief).toContain(nb);
    expect(implement.brief).toMatch(/neighbouring repositor/i);
    expect(implement.brief).toMatch(/cites the lot \(`feat\(L1\): …`\)/);
    expect(review.brief).toContain(NB);
    expect(review.brief).toContain(`git -C ${nb} log`);
  });

  it('sans dépôt voisin, aucun brief ne parle de dépôts voisins et aucun --add-dir n\'est ajouté', async () => {
    const h = harness({ script: { implement: [(call) => claudeOut(workReport({ commits: [commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a')] }))], review: [ok] } });
    await runLot(h.lot('L1'));
    for (const call of h.calls) {
      expect(call.brief).not.toMatch(/neighbouring/i);
      expect(call.args).not.toContain('--add-dir');
    }
  });

  it('le travail fait seulement dans le voisin compte : pas de « sans commit », la revue part, le verdict garde le sha lu du voisin', async () => {
    const { h, c, nb } = scenario((n) => ({ implement: [onlyNeighbour(n)], review: [ok] }));
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(c.lot.steps[0].commits?.join('\n')).toMatch(/\[\.\.\/gitops\] [0-9a-f]{7} feat\(L1\): côté voisin/);
    const review = h.plan().lot('L1').review!;
    expect(review.repos).toEqual({ [NB]: git(nb, 'rev-parse', 'HEAD') });
    expect(review.commit).toBeNull();
    expect(review.verdict).toContain(`dépôts relus : ${NB}@${git(nb, 'rev-parse', '--short=7', 'HEAD')}`);
  });

  it('le verdict enregistre le sha lu du projet ET celui de chaque voisin', async () => {
    const { h, c, nb } = scenario((n) => ({ implement: [both(n)], review: [ok] }));
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    const review = h.plan().lot('L1').review!;
    expect(review.commit).toBe(git(h.repo, 'log', '-1', '--format=%H', '--grep=côté projet'));
    expect(review.repos).toEqual({ [NB]: git(nb, 'rev-parse', 'HEAD') });
  });

  it('reprise : un commit du voisin postérieur à la revue rend le lot au lead, le verdict n\'est pas enregistré', async () => {
    const { h, c, nb } = scenario(() => ({ fix: [() => claudeOut(workReport({}))] }));
    // état laissé par une vague coupée après une revue conforme avec un mineur : la passe des mineurs reprend
    commitFile(h.repo, 'a.txt', 'feat(L1): côté projet');
    commitFile(nb, 'chart.yaml', 'feat(L1): côté voisin');
    const minor = { gravite: 'mineur', fichier: 'a.txt', ligne: 1, texte: 'nommage' };
    c.lot.code = { conforme: true, bloquants: 0, majeurs: 0, mineurs: 1, verdict: 'conforme', sousTaches: [], nonVerifie: [], head: git(h.repo, 'rev-parse', 'HEAD'), repoHeads: { [NB]: git(nb, 'rev-parse', 'HEAD') } };
    c.lot.minorPass = true;
    c.lot.minorFix = true;
    c.lot.constats = [{ source: 'code', ...minor }];
    c.lot.next = 'fix';
    commitFile(nb, 'late.yaml', 'feat(L1): postérieur à la revue');
    await runLot(c);
    expect(h.calls.map((k) => k.kind)).toEqual(['fix']);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toContain(`un commit est postérieur à la revue dans ${NB} : verdict non enregistré`);
    expect(h.plan().lot('L1').review).toBeUndefined();
  });

  it('un commit du voisin qui ne cite pas le lot est signalé en avertissement', async () => {
    const { c } = scenario((nb) => ({
      implement: [
        (call) => {
          const p = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): côté projet');
          commitFile(nb, 'x.yaml', 'chore: sans lot');
          return claudeOut(workReport({ commits: [p] }));
        },
      ],
      review: [ok],
    }));
    await runLot(c);
    expect(c.lot.warnings.join('\n')).toMatch(/commit qui ne cite pas L1 dans \.\.\/gitops : [0-9a-f]{7} chore: sans lot/);
  });

  it('un voisin laissé sale par l\'implémentation rend le lot au lead', async () => {
    const { c } = scenario((nb) => ({
      implement: [
        (call) => {
          const p = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): côté projet');
          commitFile(nb, 'y.yaml', 'feat(L1): y');
          writeFileSync(join(nb, 'y.yaml'), 'modifié sans commit\n');
          return claudeOut(workReport({ commits: [p] }));
        },
      ],
    }));
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(c.lot.outcome).toMatch(/dépôt sale après implement : \.\.\/gitops: y\.yaml/);
  });

  it('un push depuis le voisin arrête la vague (incident), comme dans le dépôt du projet', async () => {
    const { h, c, nb } = scenario((n) => ({
      implement: [
        (call) => {
          const p = commitFile(call.opts.cwd, 'a.txt', 'feat(L1): a');
          commitFile(n, 'x.yaml', 'feat(L1): voisin');
          git(n, 'push', '-q'); // le hook n'est pas posé dans ce test unitaire : le contrôle d'après-session le voit
          return claudeOut(workReport({ commits: [p] }));
        },
      ],
    }));
    const bare = join(tempDir(), 'origin-nb.git');
    git(nb, 'init', '-q', '--bare', '-b', 'main', bare);
    git(nb, 'remote', 'add', 'origin', bare);
    git(nb, 'push', '-q', '-u', 'origin', 'main');
    await runLot(c);
    expect(c.lot.status).toBe('failed');
    expect(h.wave.incident).toMatch(/push détecté .*\.\.\/gitops/);
  });

  it('la revue qui modifie le voisin rend le lot au lead (pas la vague), aucun verdict enregistré (L133)', async () => {
    const { h, c } = scenario((nb) => ({
      implement: [both(nb)],
      review: [
        () => {
          commitFile(nb, 'intrus.yaml', 'fix(L1): la revue a corrigé');
          return claudeOut(reviewReport());
        },
      ],
    }));
    await runLot(c);
    expect(c.lot.status).toBe('handed-back');
    expect(h.wave.incident).toBeNull();
    expect(c.lot.outcome).toMatch(/a modifié le dépôt dans/);
    expect(h.plan().lot('L1').review).toBeUndefined();
  });

  it('un fichier non suivi laissé par la revue dans le voisin : déplacé dans stray/<voisin avec _>, le lot continue (L162)', async () => {
    const { h, c, nb } = scenario((n) => ({
      implement: [both(n)],
      review: [
        () => {
          writeFileSync(join(nb, 'capture.png'), 'png');
          return claudeOut(reviewReport());
        },
      ],
    }));
    await runLot(c);
    expect(c.lot.status).toBe('ready');
    expect(h.wave.incident).toBeNull();
    expect(existsSync(join(nb, 'capture.png'))).toBe(false);
    expect(existsSync(join(h.wave.store.lotDir(c.lot.project, c.lot.lot), 'stray', relative(h.repo, nb).replace(/[\\/]/g, '_'), 'capture.png'))).toBe(true);
    expect(c.lot.warnings.join('\n')).toMatch(/capture\.png/);
    expect(c.lot.warnings.join('\n')).toMatch(/dans \.\.\/gitops/);
  });

  it('le contrôle préalable ne part pas quand le voisin porte déjà des commits du lot', async () => {
    const nb = neighbour();
    commitFile(nb, 'deja.yaml', 'feat(L1): déjà là');
    const h = harness({ script: { implement: [onlyNeighbour(nb)], review: [ok] } });
    const c = h.lot('L1', { repos: [{ rel: NB, path: nb }] }, { precheck: true });
    await runLot(c);
    expect(h.calls.map((k) => k.kind)).toEqual(['implement', 'review']);
  });

  it('le contrôle préalable part pour un lot sans aucun commit, voisin compris', async () => {
    const { h, c } = scenario((nb) => ({ precheck: [() => claudeOut(precheckReport())], implement: [onlyNeighbour(nb)], review: [ok] }), { precheck: true });
    await runLot(c);
    expect(h.calls.map((k) => k.kind)).toEqual(['precheck', 'implement', 'review']);
    expect(h.calls[0].brief).toContain(NB);
  });
});

describe('brief : variable {{repos}}', () => {
  const vars = (over: Partial<BriefVars> = {}): BriefVars => ({ chemin: '/p', lot: 'L1', titre: 't', objectif: 'o', commits: '', reponse: '', constats: '', ux: '', choix: '', checks: '', news: '', captures: '', ...over });

  it('absente des variables, elle vaut vide (les appelants d\'avant n\'ont rien à changer)', () => {
    expect(renderBrief('implement', vars())).not.toContain('{{');
    expect(renderBrief('review', vars())).not.toMatch(/neighbouring/);
  });

  it('chaque gabarit d\'écriture et de revue la porte', () => {
    for (const kind of ['implement', 'fix', 'fix-minors', 'review', 'review-small', 'review-recheck', 'precheck'] as const) {
      expect(renderBrief(kind, vars({ repos: 'REPOS-MARK' })), kind).toContain('REPOS-MARK');
    }
  });

  it('un voisin déclaré avec cite : la consigne d\'écriture exige que ses commits contiennent aussi la chaîne, celle de revue la dit', () => {
    const repos = [{ rel: NB, path: '/x/gitops', cite: 'ol-companion' }, { rel: '../autre', path: '/x/autre' }];
    const write = reposText('write', 'L1', repos);
    expect(write).toContain(`In \`${NB}\` every commit also contains \`ol-companion\``);
    expect(write).not.toContain("In `../autre` every commit also");
    expect(reposText('read', 'L1', repos)).toContain(`In \`${NB}\` only the commits that also contain \`ol-companion\` count`);
    expect(reposText('write', 'L1', [{ rel: NB, path: '/x/gitops' }])).not.toContain('also contains');
  });
});
