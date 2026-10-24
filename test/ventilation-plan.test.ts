import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir } from './helpers.js';

const PLAN = 'lots:\n  - { id: L1, estimate: 3, status: done }\n';

/** Les ids que `read_plan` de docs/perf/ventilation.py lit pour le projet « p » du dossier donné. */
function planIds(folder: string): string[] {
  const code = `
import json, os, sys, yaml
folder = ${JSON.stringify(folder)}
src = open('docs/perf/ventilation.py').read()
start = src.index('def read_plan')
exec(src[start:src.index('plans = {}')])
p = read_plan('p')
print(json.dumps(None if p is None else sorted(p)))`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', code], { encoding: 'utf8' }));
}

function projet(plan: string): string {
  const dir = tempDir();
  mkdirSync(join(dir, 'p', plan.slice(0, plan.lastIndexOf('/'))), { recursive: true });
  writeFileSync(join(dir, 'p', plan), PLAN);
  return dir;
}

describe('docs/perf/ventilation.py — emplacement du plan', () => {
  it('lit le plan à .cadence/raf.yaml quand cadence.yaml n\'a pas de plan:', () => {
    expect(planIds(projet('.cadence/raf.yaml'))).toEqual(['L1']);
  });

  it('retombe sur docs/plan/raf.yaml pour un projet pas encore migré', () => {
    expect(planIds(projet('docs/plan/raf.yaml'))).toEqual(['L1']);
  });
});
