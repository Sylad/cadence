import { execFileSync } from 'node:child_process';

/**
 * Lance une commande (tsc) et, si elle échoue, lève une erreur qui porte sa sortie : tsc écrit ses diagnostics
 * (fichier:ligne) sur stdout, et execFileSync ne met que « Command failed » dans le message.
 */
export function runCompiler(file: string, args: string[], cwd: string): void {
  try {
    execFileSync(file, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    const out = [err.stdout, err.stderr].map((s) => String(s ?? '').trim()).filter(Boolean).join('\n');
    throw new Error(`${err.message}${out ? `\n${out}` : ''}`, { cause: e });
  }
}
