// L839 (demande D-34) : le banc court du 25-11 a dit « ne pas garder » pour le mode script du ux-reviewer et pour le Code Mode de Claude Code.
// Le mode script et `cadence mesures` sont retirés ; l'étude garde un JSON par essai, tiré des sorties brutes, pour que le verdict reste vérifiable.
// Ce test compare les tableaux de l'étude à ces fichiers, et garde le compte d'outils de jetons-agents, seule chose livrée par le lot.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outilsDe } from '../scripts/jetons-agents.mjs';
import { OUTILS_CADENCE } from '../scripts/commandes-du-brief.mjs';
import { entreeDuLot } from './changelog-section.js';

const RACINE = join(import.meta.dirname, '..');
const ETUDE = join(RACINE, 'docs', 'etudes', '2026-11-25-code-mode-banc-court');
const etude = readFileSync(`${ETUDE}.md`, 'utf8');
const ESSAIS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
type Essai = { essai: string; bras: string; cout_usd: number; duree_ms: number; requetes_modele: number;
  jetons: { entree: number; ecriture_cache: number; lecture_cache: number; sortie: number; total: number };
  appels_outils: { total: number; par_outil: Record<string, number>; code_mode: number; journal_hook: number };
  defauts: { trouves: number; sur: number; detail: Record<string, { trouve: boolean; citation: string | null }> } };
const essais: Essai[] = ESSAIS.map((e) => JSON.parse(readFileSync(join(ETUDE, `${e}.json`), 'utf8')));
const fr = (n: number, d = 0) => n.toFixed(d).replace('.', ',');
const milliers = (n: number) => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
const moyenne = (bras: string, de: (e: Essai) => number) => { const l = essais.filter((e) => e.bras === bras).map(de); return l.reduce((a, b) => a + b, 0) / l.length; };

describe('L839 — appels d\'outils d\'un sous-agent (jetons-agents)', () => {
  const rep = (id: string, content: unknown[]) => JSON.stringify({ type: 'assistant', message: { id, model: 'm', usage: {}, content } });
  it('chaque tool_use compte une fois, même répété sous le même message ; SubagentHandback et le texte ne comptent pas', () => {
    const t = [rep('m1', [{ type: 'tool_use', id: 'a', name: 'Bash' }]), rep('m1', [{ type: 'tool_use', id: 'a', name: 'Bash' }]),
      rep('m2', [{ type: 'tool_use', id: 'b', name: 'mcp__playwright__browser_snapshot' }, { type: 'text', text: 'x' }]),
      rep('m3', [{ type: 'tool_use', id: 'c', name: 'SubagentHandback' }]), JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } })].join('\n');
    expect(outilsDe(t)).toBe(2);
    expect(outilsDe('')).toBe(0);
  });
});

describe('L839 — le verdict du banc court reste vérifiable', () => {
  it('chaque essai : jetons sommés, appels d\'outils détaillés et égaux au journal du hook, 7 défauts cités', () => {
    for (const e of essais) {
      const j = e.jetons;
      expect(j.entree + j.ecriture_cache + j.lecture_cache + j.sortie, e.essai).toBe(j.total);
      expect(Object.values(e.appels_outils.par_outil).reduce((a, b) => a + b, 0), e.essai).toBe(e.appels_outils.total);
      expect(e.appels_outils.journal_hook, e.essai).toBe(e.appels_outils.total);
      expect(Object.keys(e.defauts.detail), e.essai).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);
      expect(e.defauts.trouves, e.essai).toBe(Object.values(e.defauts.detail).filter((d) => d.trouve && d.citation).length);
    }
  });

  it('le tableau par essai de l\'étude porte les chiffres des fichiers', () => {
    for (const e of essais) {
      const ligne = etude.split('\n').find((l) => l.startsWith(`| ${e.essai} `)) ?? '';
      const cases = ligne.split('|').map((c) => c.trim());
      expect(cases.slice(2), e.essai).toEqual([`${e.defauts.trouves} / ${e.defauts.sur}`, `${fr(e.cout_usd, 2)} $`, milliers(e.jetons.total), milliers(e.jetons.sortie),
        `${Math.round(e.duree_ms / 1000)} s`, String(e.requetes_modele), String(e.appels_outils.total), '']);
    }
  });

  it('le Code Mode n\'est actif que dans le bras B, aux nombres d\'appels que l\'étude cite', () => {
    const cc = Object.fromEntries(essais.map((e) => [e.essai, e.appels_outils.code_mode]));
    expect(cc).toEqual({ A1: 0, A2: 0, B1: 16, B2: 18, C1: 0, C2: 0 });
    expect(etude).toContain('16 et 18 appels');
    expect(etude).not.toContain('50 et 57');
  });

  it('les écarts du verdict se recalculent : aucun mécanisme n\'est moins cher que le mode actuel, à défauts égaux', () => {
    const pct = (bras: string, de: (e: Essai) => number) => Math.round((moyenne(bras, de) / moyenne('A', de) - 1) * 100);
    const cout = (e: Essai) => e.cout_usd, jetons = (e: Essai) => e.jetons.total, duree = (e: Essai) => e.duree_ms;
    expect([pct('B', cout), pct('B', jetons), pct('B', duree)]).toEqual([26, 58, 23]);
    expect([pct('C', cout), pct('C', jetons)]).toEqual([3, 71]);
    expect(fr(moyenne('C', duree) / moyenne('A', duree), 1)).toBe('2,3');
    expect(etude).toContain('| Code Mode de Claude Code | **ne pas garder** | mêmes défauts retrouvés (7 sur 7), coût +26 %, jetons +58 %, durée +23 % |');
    expect(etude).toContain('| Mode script maison (`Mode: script`) | **ne pas garder** | mêmes défauts retrouvés (7 sur 7), coût +3 %, jetons +71 %, durée × 2,3 |');
    for (const e of essais) expect(e.defauts.trouves, e.essai).toBe(7);
  });
});

describe('L839 — le mode script et cadence mesures sont retirés', () => {
  it('l\'agent n\'a plus de mode script, et ne nomme plus la commande', () => {
    const agent = readFileSync(join(RACINE, 'agents', 'ux-reviewer.md'), 'utf8');
    expect(agent).not.toMatch(/Script mode|Mode: script|cadence mesures/);
  });

  it('la commande n\'existe plus : ni dans bin, ni dans l\'aide, ni dans les outils de cadence, ni dans le paquet', () => {
    expect(readFileSync(join(RACINE, 'bin', 'cadence.js'), 'utf8')).not.toContain('mesures');
    expect(readFileSync(join(RACINE, 'src', 'cli.ts'), 'utf8')).not.toContain('cadence mesures');
    expect(OUTILS_CADENCE).not.toContain('mesures');
    expect(readFileSync(join(RACINE, 'package.json'), 'utf8')).not.toMatch(/mesures-page|banc-ux-script/);
    for (const f of ['scripts/mesures-page.mjs', 'scripts/mesures-page-dom.mjs', 'scripts/banc-ux-script.mjs', 'docs/mesures-page.md']) expect(existsSync(join(RACINE, f)), f).toBe(false);
  });

  // L917 : le fragment est retiré par le commit de version ; l'entrée se lit alors dans la section publiée de CHANGELOG.md.
  it('l\'entrée du changelog ne promet plus d\'économie ni de commande', () => {
    const fragment = entreeDuLot(RACINE, 'L839');
    expect(fragment).not.toMatch(/cadence mesures|Mode: script|\d+ %|banc-ux-script/);
    expect(fragment).toContain('outils N');
  });
});
