import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// L190 — la note de mesure de l'étape spec back doit tomber juste quand on refait le compte.
const root = join(import.meta.dirname, '..');
const md = readFileSync(join(root, 'docs/mesures/etape-spec-back-2026-10-16.md'), 'utf8');
const ligne = (cause: string) => md.split('\n').find((l) => l.startsWith(`| ${cause}`))!;

// Compte les passes citées dans la colonne « Lots et passes » : « L217 ×2 » vaut 2, « L221 (…, …) » vaut le nombre de parties.
const cellule = (l: string) => l.split('|')[4];
const cites = (l: string) => {
  let n = 0;
  for (const m of cellule(l).matchAll(/L\d+(?: ×(\d))?(?: \(([^)]*)\))?/g)) {
    n += m[1] ? Number(m[1]) : m[2] ? m[2].split(/,/).length : 1;
  }
  return n;
};

describe('note de mesure de l\'étape spec back (L190)', () => {
  it('chaque cause : la colonne « Passes » égale le nombre de passes citées, et le total fait 17', () => {
    const causes = ['spec floue', 'règle de gestion', 'dérive d\'architecture', 'test manquant', 'bug de code'];
    let total = 0;
    for (const c of causes) {
      const l = ligne(c);
      const n = Number(l.split('|')[2]);
      if (n > 0) expect(cites(l), c).toBe(n);
      total += n;
    }
    expect(total).toBe(17);
  })

  it('la passe L230 du « test manquant » n\'est pas classée contre la règle de la note (premier constat : maquette.md)', () => {
    expect(ligne('test manquant')).not.toMatch(/L230/);
    expect(ligne('bug de code')).toMatch(/L230 \(R9 d'un lot mixte\), L230 \(ligne fixe/);
  })

  it('les parts de la lecture suivent le classement (4 sur 17 = 24 %, 10 sur 17 = 59 %)', () => {
    expect(md).toMatch(/vaut 24 % \(4 sur 17\)/);
    expect(md).toMatch(/font 59 % des passes/);
    expect(md).not.toMatch(/29 % \(5 sur 17\)|65 % des passes/);
  })

  it('la méthode dit que les passes des mineurs comptent, et donne les chiffres sans elles', () => {
    expect(md).toMatch(/passe des mineurs/);
    expect(md).toMatch(/6 des 17 passes/);
    expect(md).toMatch(/70 %/);
    expect(md).toMatch(/40 %/);
  })

  it('le nombre d\'hypothèses par fiche est relevé (spec : « suivi à part »)', () => {
    expect(md).toMatch(/hypothèses par fiche/i);
    expect(md).toMatch(/36 hypothèses/);
  })
})
