// La borne des portes simultanées sur un hôte (L624) : une porte déportée n'occupe ni session claude ni processeur local, mais l'hôte, lui, a ses cœurs.

/** Portes simultanées sur un hôte quand `gate.maxParallel` est absent. */
export const GATE_HOST_DEFAULT = 2;

/** Compteur d'attente en mémoire, un par hôte : les lots d'une vague partagent un processus. */
class HostGates {
  private active = 0;
  private waiters: { limit: number; start: () => void }[] = [];

  /** Rend la libération (sans effet la seconde fois) quand moins de `limit` portes tiennent l'hôte ; sinon attend son tour, dans l'ordre des demandes. */
  acquire(limit: number): Promise<() => void> {
    return new Promise((resolve) => {
      let done = false;
      const start = () => {
        this.active++;
        resolve(() => {
          if (done) return;
          done = true;
          this.active--;
          this.admit();
        });
      };
      this.waiters.push({ limit, start });
      this.admit();
    });
  }

  /** Fait partir, dans l'ordre, les demandes que la borne de chacune laisse passer. */
  private admit(): void {
    while (this.waiters.length && this.active < this.waiters[0]!.limit) this.waiters.shift()!.start();
  }
}

const hosts = new Map<string, HostGates>();

/** Les portes de cet hôte : le même objet pour le même hôte, pendant toute la vie du processus. */
export function hostGates(host: string): HostGates {
  let g = hosts.get(host);
  if (!g) hosts.set(host, (g = new HostGates()));
  return g;
}
