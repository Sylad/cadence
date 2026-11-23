import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { cadenceHome } from '../src/orchestrate/registry.js';
import { appliedCap, LEAD_CAP_FILE, readLeadCap, writeLeadCap } from '../src/orchestrate/plafond-lead.js';
import { maxSessions, shownCap, slotsLine } from '../src/orchestrate/status.js';
import { parseOrchestrateArgs } from '../src/orchestrate/command.js';
import { tempDir } from './helpers.js';

// Le mod est hors du typecheck de cadence (tsconfig.json) : son module est chargé à l'exécution, par une URL que tsc ne suit pas.
const { COLLECTOR } = (await import(new URL('../plugins/cadence-hud/hooks/collect.ts', import.meta.url).href)) as { COLLECTOR: string };

// L802 (D-30) : le 20-11, la bande disait « créneaux libres : 4 sur 5 » quand le lead se bornait à 3 (D-19, rythme du quota). Le plafond que le lead
// s'applique s'écrit (`cadence lead plafond <n>`, plafond-lead.json du foyer) et tout ce qui compte les créneaux le lit : la bande, --status, lead tour, les lancements.

beforeEach(() => {
  process.env.CADENCE_HOME = tempDir();
});

const T0 = new Date('2026-11-20T18:50:00Z');

async function cad(env: Record<string, string>, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { cwd: tempDir(), env: { RAF_TODAY: '2026-11-20', ...env }, out: (l) => out.push(l), err: (l) => err.push(l), now: () => T0 });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('plafond du lead (L802)', () => {
  it('R1 — lire et écrire : absent, posé, retiré ; un fichier abîmé ne borne rien ; le plafond appliqué est le plus bas, jamais au-dessus du réglage', () => {
    const home = cadenceHome();
    expect(readLeadCap(home)).toBeNull();
    writeLeadCap(home, 3, T0);
    expect(readLeadCap(home)).toEqual({ cap: 3, since: T0.toISOString() });
    expect(appliedCap(5, readLeadCap(home))).toBe(3);
    expect(appliedCap(2, readLeadCap(home))).toBe(2);
    writeLeadCap(home, null, T0);
    expect(existsSync(join(home, LEAD_CAP_FILE))).toBe(false);
    for (const raw of ['{', '{"cap":0}', '{"cap":2.5}', '{"cap":"3"}']) {
      writeFileSync(join(home, LEAD_CAP_FILE), raw);
      expect(readLeadCap(home)).toBeNull();
    }
  });

  it('R2 — cadence lead plafond pose, montre et retire ; refuse ce qui n’est pas un entier ≥ 1', async () => {
    const env = { CADENCE_MAX_SESSIONS: '5' };
    expect((await cad(env, 'lead', 'plafond')).out).toBe('plafond du lead : aucun · créneaux sur 5 (réglage CADENCE_MAX_SESSIONS)');
    const set = await cad(env, 'lead', 'plafond', '3');
    expect(set.code).toBe(0);
    expect(set.out).toBe('plafond du lead : 3 (réglage 5), posé depuis 0 min (2026-11-20 18:50 UTC) · créneaux, lancements de vague, bande et lead tour sur 3 ; le retirer : cadence lead plafond aucun');
    expect((await cad({ CADENCE_MAX_SESSIONS: '2' }, 'lead', 'plafond')).out).toBe('plafond du lead : 3, sans effet (réglage 2, le lead ne le relève pas), posé depuis 0 min (2026-11-20 18:50 UTC) · créneaux sur 2');
    expect((await cad(env, 'lead', 'plafond', 'aucun')).out).toBe('plafond du lead : aucun · créneaux sur 5 (réglage CADENCE_MAX_SESSIONS)');
    // sans argument, il dit depuis quand le plafond est posé (le champ `since` du fichier) : un plafond du rythme du quota survit à la remise à zéro
    writeLeadCap(process.env.CADENCE_HOME!, 3, new Date('2026-11-18T16:20:00Z'));
    expect((await cad(env, 'lead', 'plafond')).out).toBe('plafond du lead : 3 (réglage 5), posé depuis 2 j 2 h (2026-11-18 16:20 UTC) · créneaux, lancements de vague, bande et lead tour sur 3 ; le retirer : cadence lead plafond aucun');
    writeFileSync(join(process.env.CADENCE_HOME!, LEAD_CAP_FILE), '{"cap":3}');
    expect((await cad(env, 'lead', 'plafond')).out).toBe('plafond du lead : 3 (réglage 5) · créneaux, lancements de vague, bande et lead tour sur 3 ; le retirer : cadence lead plafond aucun');
    for (const bad of ['0', 'trois', '2.5']) {
      const r = await cad(env, 'lead', 'plafond', bad);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/plafond invalide/);
    }
  });

  it('R3 — la ligne des créneaux compte sur le plafond appliqué et dit l’écart ; un lancement le respecte, un --max-sessions explicite l’emporte', () => {
    const env = { CADENCE_MAX_SESSIONS: '5' };
    expect(shownCap(env)).toEqual({ cap: 5, setting: 5 });
    expect(slotsLine(5, T0, 5).line).toMatch(/créneaux libres : 5 sur 5$/);
    writeLeadCap(cadenceHome(), 3, T0);
    const { cap, setting } = shownCap(env);
    expect({ cap, setting }).toEqual({ cap: 3, setting: 5 });
    expect(slotsLine(cap, T0, setting).line).toMatch(/créneaux libres : 3 sur 3 \(plafond du lead, réglage 5\)$/);
    const io = { cwd: '/', env, out: () => {}, err: () => {}, now: () => T0 };
    expect(maxSessions(parseOrchestrateArgs([]), io)).toBe(3);
    expect(maxSessions(parseOrchestrateArgs(['--max-sessions', '4']), io)).toBe(4);
    expect(shownCap(env, 4)).toEqual({ cap: 4, setting: 4 });
  });

  it('R4 — le vrai collecteur de la bande lit le même fichier : cap appliqué et réglage, jamais au-dessus du réglage', () => {
    const home = cadenceHome(), cwd = tempDir();
    mkdirSync(home, { recursive: true });
    const collect = (max: string) => {
      const r = spawnSync('python3', ['-I', '-c', COLLECTOR], { encoding: 'utf8', cwd, env: { ...process.env, CADENCE_HOME: home, CADENCE_MAX_SESSIONS: max } });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as { cap: number; capSetting: number };
      return { cap: out.cap, capSetting: out.capSetting };
    };
    expect(collect('5')).toEqual({ cap: 5, capSetting: 5 });
    writeLeadCap(home, 3, T0);
    expect(collect('5')).toEqual({ cap: 3, capSetting: 5 });
    expect(collect('2')).toEqual({ cap: 2, capSetting: 2 });
    writeFileSync(join(home, LEAD_CAP_FILE), '{"cap": true}');
    expect(collect('5')).toEqual({ cap: 5, capSetting: 5 });
  });
});
