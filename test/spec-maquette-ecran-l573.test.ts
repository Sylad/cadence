import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFiche } from '../src/spec.js';
import { checkSpec, completeIndex, specText } from '../src/orchestrate/spec.js';
import { runLot } from '../src/orchestrate/cycle.js';
import { claudeOut, git, harness, reviewReport, specReport, type Handler } from './orchestrate-harness.js';
import { gitRepo } from './helpers.js';
import { ecrit } from './spec-helpers.js';
import { parse, stringify } from 'yaml';

// L573 (issue #34) : une fiche qui déclare `ecran.maquette` (l'index) ET `ecran.maquette_ecran` (la page qui dessine les états) :
// ce qui est dessiné dans la page mais absent de l'index est complété par le programme, sans faire échouer trois passes.

const DOSSIER = 'docs/specs/prochain-match';
const PAGE = `${DOSSIER}/ecran/page.html`;

interface Cas {
  /** testid dessinés dans la page maquette_ecran (par défaut tous les champs de la fiche). */
  testids?: string[];
  etats?: string[];
  /** captures posées à côté de la page (par défaut : celles qui manquent du dossier de la fiche, `sansCapture`). */
  captures?: string[];
  sansTestid?: string;
  sansSection?: string;
  sansCapture?: string[];
  page?: string;
}

/** Une session spec qui a écrit la page maquette_ecran en plus de l'index : la page dessine ce que l'index n'a pas. */
function depot(o: Cas = {}) {
  const dir = gitRepo();
  const page = o.page ?? PAGE;
  const fiche = ecrit(dir, {
    sansTestid: o.sansTestid,
    sansSection: o.sansSection,
    sansCapture: o.sansCapture,
    fiche: (d) => {
      d.ecran.maquette_ecran = page;
    },
  });
  const doc = parse(readFileSync(join(dir, fiche), 'utf8')) as any;
  const ids: string[] = o.testids ?? doc.champs.map((c: any) => c.id);
  const etats: string[] = o.etats ?? doc.etats;
  const pageDir = join(dir, page, '..');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(dir, page), [...ids.map((i) => `<p data-testid="${i}">${i}</p>`), ...etats.map((e) => `<section id="etat-${e}"></section>`)].join('\n'));
  const files = [page];
  for (const e of etats) for (const w of [1440, 390]) {
    const nom = `maquette-${e}-${w}.png`;
    if (!(o.captures ?? o.sansCapture ?? []).includes(nom)) continue;
    writeFileSync(join(pageDir, nom), `page ${e} ${w}`);
    files.push(`${DOSSIER}/ecran/${nom}`);
  }
  git(dir, 'add', '--', ...files);
  git(dir, 'commit', '-q', '-m', 'feat(L1): page maquette_ecran', '--', ...files);
  return { dir, fiche };
}

const index = (dir: string) => readFileSync(join(dir, DOSSIER, 'maquette.html'), 'utf8');

describe('index de la maquette complété depuis maquette_ecran (L573, issue #34)', () => {
  it('un champ dessiné dans maquette_ecran et absent de l\'index : l\'entrée data-testid est ajoutée à l\'index, une fois', () => {
    const { dir, fiche } = depot({ sansTestid: 'score' });
    expect(index(dir)).not.toContain('data-testid="score"');
    expect(completeIndex(dir, fiche)).toEqual([`${DOSSIER}/maquette.html`]);
    expect(index(dir).match(/data-testid="score"/g)).toHaveLength(1);
    expect(index(dir)).toContain('<p data-testid="score">Score</p>');
    expect(checkSpec(dir, fiche, 'L1')).toEqual([]);
  });

  it('un état dessiné dans maquette_ecran et absent de l\'index : la section etat-… est ajoutée', () => {
    const { dir, fiche } = depot({ sansSection: 'erreur' });
    completeIndex(dir, fiche);
    expect(index(dir)).toContain('<section id="etat-erreur"></section>');
    expect(checkSpec(dir, fiche, 'L1')).toEqual([]);
  });

  it('les captures maquette-<état>-<largeur>.png de la page sont copiées dans le dossier de la fiche, sans écraser une capture déjà là', () => {
    const { dir, fiche } = depot({ sansCapture: ['maquette-erreur-1440.png', 'maquette-erreur-390.png'], captures: ['maquette-erreur-1440.png', 'maquette-erreur-390.png', 'maquette-vide-1440.png'] });
    const déjà = readFileSync(join(dir, DOSSIER, 'maquette-vide-1440.png'), 'utf8');
    const faits = completeIndex(dir, fiche);
    expect(faits).toEqual(expect.arrayContaining([`${DOSSIER}/maquette-erreur-1440.png`, `${DOSSIER}/maquette-erreur-390.png`]));
    expect(faits).not.toContain(`${DOSSIER}/maquette-vide-1440.png`);
    expect(readFileSync(join(dir, DOSSIER, 'maquette-erreur-390.png'), 'utf8')).toBe('page erreur 390');
    expect(readFileSync(join(dir, DOSSIER, 'maquette-vide-1440.png'), 'utf8')).toBe(déjà);
  });

  it('rien d\'inventé : un champ absent de l\'index ET de la page reste un écart, sans entrée ajoutée', () => {
    const { dir, fiche } = depot({ sansTestid: 'score', testids: ['equipe-domicile'] });
    expect(completeIndex(dir, fiche)).toEqual([]);
    expect(index(dir)).not.toContain('data-testid="score"');
    expect(checkSpec(dir, fiche, 'L1').join('\n')).toContain('data-testid="score" absent');
  });

  it('rien d\'inventé : une capture absente du dossier ET de la page reste un écart', () => {
    const { dir, fiche } = depot({ sansCapture: ['maquette-vide-390.png'], captures: [] });
    expect(completeIndex(dir, fiche)).toEqual([]);
    expect(existsSync(join(dir, DOSSIER, 'maquette-vide-390.png'))).toBe(false);
    expect(checkSpec(dir, fiche, 'L1').join('\n')).toContain('maquette-vide-390.png : capture absent');
  });

  it('rejoué : le second appel n\'écrit rien (idempotent)', () => {
    const { dir, fiche } = depot({ sansTestid: 'score', sansSection: 'erreur' });
    completeIndex(dir, fiche);
    const avant = index(dir);
    expect(completeIndex(dir, fiche)).toEqual([]);
    expect(index(dir)).toBe(avant);
  });

  it('une fiche sans maquette_ecran : rien n\'est touché', () => {
    const dir = gitRepo();
    const fiche = ecrit(dir, { sansTestid: 'score' });
    expect(completeIndex(dir, fiche)).toEqual([]);
    expect(index(dir)).not.toContain('data-testid="score"');
  });

  it('maquette_ecran identique à l\'index, absente du dépôt ou hors du dépôt : rien n\'est touché ni ne plante', () => {
    for (const page of [`${DOSSIER}/maquette.html`, `${DOSSIER}/inexistante.html`, '../../hors.html', '/etc/hostname']) {
      const dir = gitRepo();
      const fiche = ecrit(dir, { sansTestid: 'score', fiche: (d) => (d.ecran.maquette_ecran = page) });
      expect(completeIndex(dir, fiche)).toEqual([]);
      expect(index(dir)).not.toContain('data-testid="score"');
    }
  });

  it('fiche illisible ou absente, index absent : aucun plantage, rien d\'écrit', () => {
    const dir = gitRepo();
    expect(completeIndex(dir, `${DOSSIER}/fiche.yaml`)).toEqual([]);
    mkdirSync(join(dir, DOSSIER), { recursive: true });
    writeFileSync(join(dir, DOSSIER, 'fiche.yaml'), ': : [');
    expect(completeIndex(dir, `${DOSSIER}/fiche.yaml`)).toEqual([]);
  });

  it('l\'id d\'un champ est cherché tel quel dans la page : « score » ne se contente pas de « score-final »', () => {
    const { dir, fiche } = depot({ sansTestid: 'score', testids: ['equipe-domicile'] });
    writeFileSync(join(dir, PAGE), `${readFileSync(join(dir, PAGE), 'utf8')}\n<p data-testid="score-final"></p>`);
    expect(completeIndex(dir, fiche)).toEqual([]);
  });

  it('le libellé du champ est échappé dans l\'entrée ajoutée', () => {
    const { dir, fiche } = depot({ sansTestid: 'score' });
    const f = parse(readFileSync(join(dir, fiche), 'utf8')) as any;
    f.champs.find((c: any) => c.id === 'score').libelle = 'A <b> & "c"';
    writeFileSync(join(dir, fiche), stringify(f));
    completeIndex(dir, fiche);
    expect(index(dir)).toContain('<p data-testid="score">A &lt;b&gt; &amp; &quot;c&quot;</p>');
  });
});

describe('le constat nomme maquette_ecran (L573)', () => {
  it('un champ, un état, une capture présents dans maquette_ecran et absents de l\'index : « présent dans maquette_ecran, absent de l\'index »', () => {
    const { dir, fiche } = depot({ sansTestid: 'score', sansSection: 'erreur' });
    const p = checkSpec(dir, fiche, 'L1').join('\n');
    expect(p).toContain('data-testid="score" présent dans maquette_ecran, absent de l\'index');
    expect(p).toContain('section id="etat-erreur" présente dans maquette_ecran, absente de l\'index');
  });

  it('sans maquette_ecran, le constat garde sa forme d\'avant', () => {
    const dir = gitRepo();
    const fiche = ecrit(dir, { sansTestid: 'score' });
    expect(checkSpec(dir, fiche, 'L1')).toEqual([`maquette.html : data-testid="score" absent (chaque champ de la fiche le porte)`]);
  });

  it('checkFiche accepte maquette_ecran (texte) et refuse une valeur qui n\'est pas un texte', () => {
    const doc = parse(readFileSync(join(__dirname, '..', 'templates', 'fiche.yaml'), 'utf8')) as any;
    expect(checkFiche(doc)).toEqual([]);
    doc.ecran.maquette_ecran = 'docs/specs/mon-ecran/ecran.html';
    expect(checkFiche(doc)).toEqual([]);
    doc.ecran.maquette_ecran = 42;
    expect(checkFiche(doc).join('\n')).toContain('ecran.maquette_ecran : texte attendu');
  });
});

describe('le brief spec nomme l\'index et la forme de l\'entrée (L573)', () => {
  it('le brief d\'un écran nomme maquette.html comme index, l\'entrée data-testid, la section etat-… et la clé maquette_ecran', () => {
    const t = specText({ dir: 'docs/specs', screen: 'page' });
    expect(t).toContain('maquette_ecran');
    expect(t).toContain('<p data-testid="<id du champ>">');
    expect(t).toContain('<section id="etat-<état>">');
    expect(t).toMatch(/index/);
  });

  it('la maquette légère porte la même consigne', () => {
    expect(specText({ dir: 'docs/specs', screen: 'page', light: true })).toContain('maquette_ecran');
  });
});

describe('la passe spec complète l\'index avant de contrôler (L573)', () => {
  it('index incomplet + page maquette_ecran complète : une seule passe spec, l\'index complété est commité, le lot va à la revue', async () => {
    const h0: Handler = (call) => {
      const cwd = call.opts.cwd;
      const { fiche } = (() => {
        const d = depotDans(cwd);
        return d;
      })();
      return claudeOut(specReport({ fiche }));
    };
    const ok: Handler = () => claudeOut(reviewReport());
    const h = harness({ lots: [{ title: 'Une page', screen: 'page' as const }], script: { spec: [h0], maquette: [ok] } });
    await runLot(h.lot('L1', { visible: true, screen: 'page' }, { maquette: true }));
    expect(h.calls.slice(0, 2).map((c) => c.kind)).toEqual(['spec', 'maquette']);
    const wd = h.calls[0].opts.cwd;
    expect(readFileSync(join(wd, DOSSIER, 'maquette.html'), 'utf8')).toContain('data-testid="score"');
    expect(existsSync(join(wd, DOSSIER, 'maquette-erreur-390.png'))).toBe(true);
    expect(git(wd, 'status', '--porcelain', '--', DOSSIER).trim()).toBe('');
    expect(git(wd, 'log', '--format=%s', '-n', '1', '--', `${DOSSIER}/maquette.html`)).toMatch(/L1/);
  });
});

/** Ce que fait l'agent spec dans le dépôt de travail du lot : comme `depot`, sur un dépôt existant. */
function depotDans(cwd: string) {
  const fiche = ecrit(cwd, { sansTestid: 'score', sansSection: 'erreur', sansCapture: ['maquette-erreur-1440.png', 'maquette-erreur-390.png'], fiche: (d) => (d.ecran.maquette_ecran = PAGE) });
  const pageDir = join(cwd, DOSSIER, 'ecran');
  mkdirSync(pageDir, { recursive: true });
  const doc = parse(readFileSync(join(cwd, fiche), 'utf8')) as any;
  writeFileSync(join(cwd, PAGE), [...doc.champs.map((c: any) => `<p data-testid="${c.id}"></p>`), ...doc.etats.map((e: string) => `<section id="etat-${e}"></section>`)].join('\n'));
  const files = [PAGE];
  for (const e of ['erreur']) for (const w of [1440, 390]) {
    writeFileSync(join(pageDir, `maquette-${e}-${w}.png`), `page ${e} ${w}`);
    files.push(`${DOSSIER}/ecran/maquette-${e}-${w}.png`);
  }
  git(cwd, 'add', '--', ...files);
  git(cwd, 'commit', '-q', '-m', 'feat(L1): page maquette_ecran', '--', ...files);
  return { fiche };
}
