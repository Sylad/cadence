import { execFileSync } from 'node:child_process';

/**
 * Lance une commande (tsc) et, si elle échoue, lève une erreur qui porte sa sortie : tsc écrit ses diagnostics
 * (fichier:ligne) sur stdout, et execFileSync ne met que « Command failed » dans le message.
 */
export function runCompiler(file: string, args: string[], cwd: string): void {
  try {
    execFileSync(file, args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  } catch (e) {
    // stderr est déjà dans err.message (Node l'y ajoute) : on n'ajoute que stdout.
    const err = e as Error & { stdout?: string };
    const out = String(err.stdout ?? '').trim();
    throw new Error(`${err.message}${out ? `\n${out}` : ''}`, { cause: e });
  }
}
