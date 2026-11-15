import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { argsDuRejeu, avecSeparateur, casSousLeSeuil, evalAvecRejeu, option, plafondDe } from '../scripts/eval-plugin.mjs';

// L740 : un cas sous le seuil sur un seul run sur six arrêtait la release (14-11 et 15-11, Δ +0,92 et +0,96). Il est rejoué une fois (runs
// « with ») ; l'éval n'échoue que s'il reste sous le seuil au rejeu, et le rapport dit « rejoué » avec les deux mesures.
const root = join(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'eval-l740-')); dirs.push(d); return d; };

const agregat = (scores: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  suite: { threshold: 1 }, costUsd: 2, partial: false,
  cases: Object.entries(scores).map(([name, score]) => ({ name, aggregates: { score } })), ...extra,
});

/** Un faux `claude plugin eval` : écrit l'agrégat que `reponses` donne pour cet appel dans --output-dir, et rend le code du vrai. */
function fauxEval(reponses: ((args: string[]) => object | null)[]) {
  const appels: string[][] = [];
  const run = (_cmd: string, args: string[]) => {
    appels.push(args);
    const a = reponses[appels.length - 1]!(args);
    const dir = option(args, '--output-dir')!;
    mkdirSync(dir, { recursive: true });
    if (a) writeFileSync(join(dir, 'aggregate-result.json'), JSON.stringify(a));
    if (appels.length === 1) writeFileSync(join(dir, 'report.html'), '<html><body class="x"><h1>Rapport</h1></body></html>');
    if (!a) return 2;
    const ag = a as ReturnType<typeof agregat>;
    return ag.partial ? 2 : ag.cases.some((c) => c.aggregates.score < 1) ? 1 : 0;
  };
  return { run, appels };
}

const ARGV = ['claude', 'plugin', 'eval', '.', '--max-cost-usd', '5', '--no-publish', '--trust-plugin'];

describe('éval du plugin : rejeu d\'un cas sous le seuil (L740)', () => {
  it('le cas du 15-11 (livrer-sh-sans-bloc 0,83) rejoué à 1,00 : éval verte, le rapport dit « rejoué » et garde les deux mesures', () => {
    const out = join(tmp(), 'r');
    const f = fauxEval([
      () => agregat({ 'deliver-sha': 1, 'livrer-sh-sans-bloc': 5 / 6 }),
      () => agregat({ 'livrer-sh-sans-bloc': 1 }, { costUsd: 0.4 }),
    ]);
    const log: string[] = [];
    expect(evalAvecRejeu([...ARGV, '--output-dir', out], { run: f.run, log: (s) => log.push(s) })).toBe(0);
    expect(f.appels).toHaveLength(2);
    // le rejeu : ce cas seul, bras « with » seul, dans un sous-dossier du premier passage, avec le reste du plafond (5 − 2)
    const r = f.appels[1]!;
    expect(option(r, '--case')).toBe('livrer-sh-sans-bloc');
    expect(option(r, '--ablation')).toBe('none');
    expect(option(r, '--output-dir')).toBe(join(out, 'rejeu', 'livrer-sh-sans-bloc'));
    expect(option(r, '--max-cost-usd')).toBe('3');
    expect(r.filter((a) => a === '--max-cost-usd')).toHaveLength(1);
    expect(r).toContain('--trust-plugin');
    const md = readFileSync(join(out, 'rejeu.md'), 'utf8');
    expect(md).toContain('livrer-sh-sans-bloc : 0,83 au premier passage, rejoué : 1,00 — passe');
    expect(JSON.parse(readFileSync(join(out, 'rejeu.json'), 'utf8')).rejoues).toEqual([
      { name: 'livrer-sh-sans-bloc', premier: 5 / 6, rejeu: 1, passe: true },
    ]);
    expect(readFileSync(join(out, 'report.html'), 'utf8')).toMatch(/<body class="x"><section id="rejeu-l740"[^]*rejoué : 1,00/);
    expect(log.join('\n')).toContain('rejoué une fois');
  });

  it('un cas qui reste sous le seuil au rejeu fait échouer l\'éval, avec ses deux mesures', () => {
    const out = join(tmp(), 'r');
    const f = fauxEval([() => agregat({ 'orchestrate-id-avec-slash': 5 / 6 }), () => agregat({ 'orchestrate-id-avec-slash': 2 / 3 })]);
    expect(evalAvecRejeu([...ARGV, '--output-dir', out], { run: f.run, log: () => {} })).toBe(1);
    const md = readFileSync(join(out, 'rejeu.md'), 'utf8');
    expect(md).toContain('orchestrate-id-avec-slash : 0,83 au premier passage, rejoué : 0,67 — échoue');
    expect(md).toContain('Éval rouge : orchestrate-id-avec-slash reste sous le seuil.');
  });

  it('chaque cas sous le seuil est rejoué une seule fois ; un seul qui reste dessous suffit à faire échouer', () => {
    const out = join(tmp(), 'r');
    const f = fauxEval([
      () => agregat({ a: 0.5, b: 5 / 6, c: 1 }),
      () => agregat({ a: 1 }),
      () => agregat({ b: 0.5 }),
    ]);
    expect(evalAvecRejeu([...ARGV, '--output-dir', out], { run: f.run, log: () => {} })).toBe(1);
    expect(f.appels.slice(1).map((a) => option(a, '--case'))).toEqual(['a', 'b']);
  });

  it('une éval verte au premier passage ne rejoue rien et n\'écrit pas de rapport de rejeu', () => {
    const out = join(tmp(), 'r');
    const f = fauxEval([() => agregat({ a: 1 })]);
    expect(evalAvecRejeu([...ARGV, '--output-dir', out], { run: f.run, log: () => {} })).toBe(0);
    expect(f.appels).toHaveLength(1);
    expect(existsSync(join(out, 'rejeu.md'))).toBe(false);
  });

  it('un premier passage interrompu (plafond de coût, partiel) ne rejoue rien et garde son code', () => {
    const out = join(tmp(), 'r');
    const f = fauxEval([() => agregat({ a: 0.5 }, { partial: true })]);
    expect(evalAvecRejeu([...ARGV, '--output-dir', out], { run: f.run, log: () => {} })).toBe(2);
    expect(f.appels).toHaveLength(1);
  });

  it('plafond déjà consommé : pas de rejeu, le cas échoue avec la raison', () => {
    const out = join(tmp(), 'r');
    const f = fauxEval([() => agregat({ a: 0.5 }, { costUsd: 5 })]);
    expect(evalAvecRejeu([...ARGV, '--output-dir', out], { run: f.run, log: () => {} })).toBe(1);
    expect(f.appels).toHaveLength(1);
    expect(readFileSync(join(out, 'rejeu.md'), 'utf8')).toContain('a : 0,50 au premier passage, rejeu impossible (plafond de coût atteint) — échoue');
  });

  it('un rejeu sans résultat complet fait échouer le cas', () => {
    const out = join(tmp(), 'r');
    const f = fauxEval([() => agregat({ a: 0.5 }), () => null]);
    expect(evalAvecRejeu([...ARGV, '--output-dir', out], { run: f.run, log: () => {} })).toBe(1);
    expect(readFileSync(join(out, 'rejeu.md'), 'utf8')).toMatch(/rejeu impossible \(pas de résultat complet \(code 2\)\)/);
  });

  it('sans --output-dir, le premier passage écrit dans evals/results/<horodatage>/ (comme claude plugin eval)', () => {
    const f = fauxEval([() => null]);
    const cwd = process.cwd();
    const d = tmp();
    process.chdir(d);
    try {
      evalAvecRejeu(ARGV, { run: f.run, maintenant: new Date('2026-11-15T21:13:59.885Z'), log: () => {} });
    } finally { process.chdir(cwd); }
    expect(option(f.appels[0]!, '--output-dir')).toMatch(/evals\/results\/2026-11-15T21-13-59-885Z$/);
  });

  it('le seuil lu est celui de l\'agrégat (--threshold), et argsDuRejeu retire les options qu\'il remplace', () => {
    expect(casSousLeSeuil({ suite: { threshold: 0.8 }, cases: [{ name: 'a', aggregates: { score: 5 / 6 } }, { name: 'b', aggregates: { score: 0.5 } }] }))
      .toEqual([{ name: 'b', score: 0.5 }]);
    expect(argsDuRejeu(['.', '--case=x*', '--json', 'j.json', '--report', 'r.html', '--runs', '3'], 'b', '/o'))
      .toEqual(['.', '--runs', '3', '--case', 'b', '--ablation', 'none', '--output-dir', '/o']);
  });

  it('autour de npm run eval:plugin (l\'étape de cadence release) : les options passent après --, le plafond est lu dans le script', () => {
    const d = tmp();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { 'eval:plugin': 'claude plugin eval . --max-cost-usd 5 --no-publish' } }));
    expect(plafondDe('npm', ['run', 'eval:plugin', '--', '--trust-plugin'], d)).toBe(5);
    expect(plafondDe('npm', ['run', 'eval:plugin', '--', '--max-cost-usd', '2'], d)).toBe(2);
    expect(plafondDe('claude', ['plugin', 'eval', '.'], d)).toBeUndefined();
    expect(avecSeparateur('npm', ['run', 'eval:plugin'])).toEqual(['run', 'eval:plugin', '--']);
    expect(avecSeparateur('npm', ['run', 'eval:plugin', '--', '--trust-plugin'])).toEqual(['run', 'eval:plugin', '--', '--trust-plugin']);
    const out = join(d, 'r');
    const f = fauxEval([() => agregat({ a: 5 / 6 }), () => agregat({ a: 1 })]);
    const cwd = process.cwd();
    process.chdir(d);
    try {
      expect(evalAvecRejeu(['npm', 'run', 'eval:plugin', '--output-dir', out], { run: f.run, log: () => {} })).toBe(0);
    } finally { process.chdir(cwd); }
    expect(f.appels[0]!.slice(0, 3)).toEqual(['run', 'eval:plugin', '--']);
    expect(f.appels[1]!.slice(0, 3)).toEqual(['run', 'eval:plugin', '--']);
    expect(option(f.appels[1]!, '--max-cost-usd')).toBe('3');
  });

  it('package.json n\'est pas touché (le cliquet qualité refuse un changement de ses scripts dans un lot de code)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['eval:plugin']).toBe('claude plugin eval . --max-cost-usd 5 --no-publish');
  });

  it('le script se lance en ligne de commande et rend le code de la commande qu\'il enveloppe', () => {
    const d = tmp();
    writeFileSync(join(d, 'faux.mjs'), 'process.exit(3);\n');
    const r = spawnSync(process.execPath, [join(root, 'scripts/eval-plugin.mjs'), process.execPath, join(d, 'faux.mjs'), '--output-dir', join(d, 'r')], { encoding: 'utf8' });
    expect(r.status).toBe(3);
  });

  it('docs/releasing.md (étape de l\'éval) dit la règle du rejeu', () => {
    const rel = readFileSync(join(root, 'docs/releasing.md'), 'utf8');
    const etape = rel.slice(rel.indexOf('Run the plugin evaluation'), rel.indexOf('git push origin main v<version>'));
    expect(etape).toMatch(/replayed once/);
    expect(etape).toMatch(/rejeu\.md/);
    expect(etape).toContain('node scripts/eval-plugin.mjs npm run eval:plugin -- --trust-plugin');
  });
});
