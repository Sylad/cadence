import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gardeBancV2, release } from '../src/release.js';
import type { Day } from '../src/dates.js';
import { commit, gitRepo } from './helpers.js';

// Refonte du 07-11 (docs/v2/2026-11-07-cadence-2-design.md §4.1) : aucune 2.x sans banc vert sur l'empreinte publiée.
describe('garde de publication 2.x', () => {
  it('1.62.2 : pas de banc demandé (v1 gelée, correctifs)', () => {
    expect(() => gardeBancV2('1.62.2', () => ({ code: 1, sortie: '' }))).not.toThrow();
  });
  it('2.0.0 sans banc vert : refus, avec la raison', () => {
    expect(() => gardeBancV2('2.0.0', () => ({ code: 1, sortie: 'aucun banc vert sur l\'empreinte e1' }))).toThrow(/banc vert.*e1/s);
  });
  it('2.0.0 sans banc vert, avec un dossier de publication qui cite l empreinte exacte : permis', () => {
    const v = () => ({ code: 1, sortie: "publication refusée sur l'empreinte 5194fed874a1 : …" });
    expect(() => gardeBancV2('2.0.0', v, () => '# 2.0.0\n\nEmpreinte de v2 : 5194fed874a1\n')).not.toThrow();
  });
  it('2.0.0 sans banc vert : un dossier sur une autre empreinte, ou absent, ne suffit pas', () => {
    const v = () => ({ code: 1, sortie: "publication refusée sur l'empreinte 5194fed874a1 : …" });
    expect(() => gardeBancV2('2.0.0', v, () => 'Empreinte de v2 : e8f9e5514920\n')).toThrow(/ne cite pas l'empreinte 5194fed874a1/);
    expect(() => gardeBancV2('2.0.0', v, () => undefined)).toThrow(/ni dossier docs\/v2\/publications\/2\.0\.0\.md/);
    expect(() => gardeBancV2('2.0.0', v, () => 'mentionne 5194fed874a1 en passant\n')).toThrow(/ne cite pas/);
  });
  it('2.0.0 avec banc vert : permis', () => {
    expect(() => gardeBancV2('2.0.0', () => ({ code: 0, sortie: 'banc vert' }))).not.toThrow();
    expect(gardeBancV2('2.0.0', () => ({ code: 0, sortie: 'banc vert' }))).toEqual([]);
  });
  // L903 (D-39, Sylvain du 26-11) : une alerte du banc complet ne bloque plus ; verifier-publication rend 0 et l'alerte suit en ⚠, que la garde rend.
  it('2.0.0, mécanique vert pendant une alerte : permis, et la ligne ⚠ est rendue pour cadence release', () => {
    const sortie = "banc mécanique ou complet vert sur l'empreinte 5194fed874a1\n⚠ banc complet rouge le 2026-11-22 sur l'empreinte e0 (séquence Y) : ne bloque pas la publication (L903) ; à rejouer vert au banc complet du week-end : sequence Y\n";
    expect(gardeBancV2('2.0.0', () => ({ code: 0, sortie }))).toEqual(["⚠ banc complet rouge le 2026-11-22 sur l'empreinte e0 (séquence Y) : ne bloque pas la publication (L903) ; à rejouer vert au banc complet du week-end : sequence Y"]);
  });
  it('2.0.0, alerte en cours sans mécanique vert : refus (code 1), l\'alerte dans le message', () => {
    const sortie = "publication refusée sur l'empreinte 5194fed874a1 : il faut le dernier banc mécanique (1, 3 et 7) vert\n⚠ banc complet rouge le 2026-11-22 sur l'empreinte e0 (séquence Y) : ne bloque pas la publication (L903)\n";
    expect(() => gardeBancV2('2.0.0', () => ({ code: 1, sortie }), () => undefined)).toThrow(/il faut le dernier banc mécanique.*⚠ banc complet rouge/s);
  });
});

describe('release() de bout en bout', () => {
  // Le faux cadence2 écrit ses arguments dans un marqueur : preuve que la garde l'a bien appelé.
  const FAUX = "require('node:fs').writeFileSync('.banc-appele', process.argv.slice(2).join(' '));\nconsole.log(\"banc vert sur l'empreinte test\");\nprocess.exit(CODE);\n";
  const fixture = (code: number | null, script = FAUX.replace('CODE', String(code))): string => {
    const dir = gitRepo();
    writeFileSync(join(dir, 'package.json'), '{\n  "name": "acme",\n  "version": "1.2.3"\n}\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Une chose (L7).\n');
    if (code !== null) {
      mkdirSync(join(dir, 'v2', 'bin'), { recursive: true });
      writeFileSync(join(dir, 'v2', 'bin', 'cadence2.js'), script);
    }
    execFileSync('git', ['add', '.'], { cwd: dir });
    commit(dir, 'chore: initial');
    return dir;
  };
  it('major sur un dépôt sans v2/bin/cadence2.js : refus qui parle du banc vert', () => {
    expect(() => release(['major'], true, fixture(null), '2026-11-07' as Day, () => {})).toThrow(/banc vert/);
  });
  it('major avec un cadence2 qui rend 1 : refus, et la garde a bien appelé le banc', () => {
    const dir = fixture(1);
    expect(() => release(['major'], true, dir, '2026-11-07' as Day, () => {})).toThrow(/banc vert/);
    expect(readFileSync(join(dir, '.banc-appele'), 'utf8')).toContain('bench verifier-publication');
  });
  it('major, mécanique vert pendant une alerte (L903) : le dry-run passe et affiche la ligne ⚠ sous la ligne de version', () => {
    const dir = fixture(0, "console.log(\"banc mécanique ou complet vert sur l'empreinte test\");\nconsole.log('⚠ banc complet rouge le 2026-11-22 sur l\\'empreinte e0 (banc court) : ne bloque pas la publication (L903) ; à rejouer vert au banc complet du week-end : court');\n");
    const out: string[] = [];
    expect(release(['major'], true, dir, '2026-11-07' as Day, (l) => out.push(l))).toBe(0);
    const i = out.findIndex((l) => l.includes('→ 2.0.0'));
    expect(out[i + 1]).toBe("  ⚠ banc complet rouge le 2026-11-22 sur l'empreinte e0 (banc court) : ne bloque pas la publication (L903) ; à rejouer vert au banc complet du week-end : court");
  });
  it('major avec un banc vert : le dry-run passe, le banc a été appelé, la ligne → 2.0.0 est sortie', () => {
    const dir = fixture(0);
    const out: string[] = [];
    const code = release(['major'], true, dir, '2026-11-07' as Day, (l) => out.push(l));
    expect(code).toBe(0);
    expect(readFileSync(join(dir, '.banc-appele'), 'utf8')).toContain('bench verifier-publication');
    expect(out.some((l) => l.includes('→ 2.0.0'))).toBe(true);
  });
});
