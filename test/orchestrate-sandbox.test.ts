import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { sandboxEnv, PROD_VARS } from '../src/orchestrate/sandbox.js';
import { realClaude, runSession, type StepSpec } from '../src/orchestrate/launch.js';
import { tempDir } from './helpers.js';

const spec: StepSpec = { kind: 'implement', sessionId: 's', brief: 'b', model: 'sonnet', schema: {}, cwd: '/tmp', wave: 'w', permissionMode: 'auto', addDirs: [], timeoutMs: 5_000 };

describe('sandboxEnv (L168)', () => {
  it('coupé par défaut : kubeconfig vide et variables de prod retirées', () => {
    const e = sandboxEnv(false);
    expect(e.set).toEqual({ KUBECONFIG: '/dev/null' });
    for (const v of ['KUBERNETES_SERVICE_HOST', 'ARGOCD_AUTH_TOKEN', 'CLOUDFLARE_API_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) expect(e.unset).toContain(v);
    expect(e.unset).toEqual(PROD_VARS);
  });
  it('prodAccess : rien ne change', () => {
    expect(sandboxEnv(true)).toEqual({ set: {}, unset: [] });
  });
});

describe('runSession : environnement de la session (L168)', () => {
  const run = async (s: StepSpec) => {
    const calls: { env: Record<string, string>; unset?: string[] }[] = [];
    await runSession(s, { claude: async (_a, o) => (calls.push(o), { code: 0, stdout: '{}', stderr: '', timedOut: false }), agents: {} });
    return calls[0];
  };
  it('chaque session reçoit KUBECONFIG=/dev/null et la liste à retirer', async () => {
    for (const kind of ['implement', 'fix', 'precheck', 'review', 'ux'] as const) {
      const c = await run({ ...spec, kind });
      expect(c.env.KUBECONFIG).toBe('/dev/null');
      expect(c.unset).toEqual(PROD_VARS);
    }
  });
  it('prodAccess lève la restriction', async () => {
    const c = await run({ ...spec, prodAccess: true });
    expect(c.env.KUBECONFIG).toBeUndefined();
    expect(c.unset ?? []).toEqual([]);
  });
});

describe('une session de vague ne voit pas le cluster (L168)', () => {
  // Faux kubectl : répond « pods » seulement si KUBECONFIG désigne un vrai fichier de configuration, comme le vrai.
  const setup = () => {
    const dir = tempDir();
    const kc = join(dir, 'kubeconfig');
    writeFileSync(kc, 'server: https://prod:6443\n');
    writeFileSync(join(dir, 'kubectl'), '#!/bin/sh\ngrep -qs "^server:" "$KUBECONFIG" || { echo "connection refused" >&2; exit 1; }\necho "NAME READY"\n');
    chmodSync(join(dir, 'kubectl'), 0o755);
    // Faux claude : lance « kubectl get pods » et rapporte code et variables de prod vues.
    const bin = join(dir, 'fake-claude.sh');
    writeFileSync(bin, '#!/bin/sh\nkubectl get pods >/dev/null 2>&1; echo "kubectl=$? GH=${GH_TOKEN:-vide} KC=$KUBECONFIG"\n');
    chmodSync(bin, 0o755);
    const base = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, KUBECONFIG: kc, GH_TOKEN: 'secret' };
    return { dir, bin, base };
  };
  const seen = async (prodAccess: boolean) => {
    const { dir, bin, base } = setup();
    let stdout = '';
    await runSession({ ...spec, cwd: dir, prodAccess }, { claude: async (a, o) => { const r = await realClaude(bin, base)(a, o); stdout = r.stdout; return r; }, agents: {} });
    return stdout;
  };
  it('« kubectl get pods » échoue, GH_TOKEN absent', async () => {
    expect(await seen(false)).toMatch(/^kubectl=1 GH=vide KC=\/dev\/null/);
  });
  it('avec prodAccess, il réussit', async () => {
    expect(await seen(true)).toMatch(/^kubectl=0 GH=secret/);
  });
});

describe('README (L168)', () => {
  it('nomme chaque variable retirée, sans promettre un préfixe entier', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const v of PROD_VARS) expect(readme, v).toContain(v);
    expect(readme).not.toMatch(/`AWS_\*`|`ARGOCD_\*`|`CLOUDFLARE_\*`|`CF_API_\*`/);
  });
});
