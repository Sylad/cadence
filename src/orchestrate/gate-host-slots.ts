// La borne des portes simultanées sur un hôte (L624) : une porte déportée n'occupe ni session claude ni processeur local, mais l'hôte, lui, a ses cœurs.

/** Portes simultanées sur un hôte quand `gate.maxParallel` est absent. */
export const GATE_HOST_DEFAULT = 2;

/** Une demande de créneau : `promise` rend la libération ; `started()` dit si le créneau est déjà tenu ; `cancel()` retire la demande encore en attente, ou libère le créneau déjà obtenu (L639, une porte qui demande deux machines n'en garde qu'une). */
export interface Turn {
  promise: Promise<() => void>;
  started(): boolean;
  cancel(): void;
}

/** Compteur d'attente en mémoire, un par hôte : les lots d'une vague partagent un processus. */
class HostGates {
  private active = 0;
  private waiters: { limit: number; start: () => void }[] = [];

  /** Rend la libération (sans effet la seconde fois) quand moins de `limit` portes tiennent l'hôte ; sinon attend son tour, dans l'ordre des demandes. */
  acquire(limit: number): Promise<() => void> {
    return this.request(limit).promise;
  }

  /** Comme `acquire`, mais la demande peut être annulée (L639). */
  request(limit: number): Turn {
    let done = false;
    let started = false;
    let release!: () => void;
    const waiter = { limit, start: () => {} };
    const promise = new Promise<() => void>((resolve) => {
      waiter.start = () => {
        started = true;
        this.active++;
        release = () => {
          if (done) return;
          done = true;
          this.active--;
          this.admit();
        };
        resolve(release);
      };
    });
    this.waiters.push(waiter);
    this.admit();
    return {
      promise,
      started: () => started,
      cancel: () => {
        if (started) return release();
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      },
    };
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

const local = new HostGates();

/** Les portes de la machine locale (L639, `gate.overflow`) : une à la fois, tenue par tous les lots du processus ; ni les sessions claude ni le pool n'y comptent. */
export const localGates = (): HostGates => local;

/** Portes simultanées sur la machine locale avec `gate.overflow`. */
export const GATE_LOCAL_LIMIT = 1;
