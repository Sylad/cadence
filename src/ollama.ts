// L'appel /api/chat d'Ollama commun au classeur des causes et au sous-classeur (L575, sorti de corrections.ts).
import { UNREACHABLE } from './corrections-echecs.js';

/** Les options d'un appel Ollama ; `onFail` reçoit la raison de chaque réponse perdue (L575). */
export interface OllamaOpts { url: string; model: string; fetch?: typeof fetch; onFail?: (reason: string) => void }

/** Appel `/api/chat` d'Ollama (température 0, sortie contrainte par `format`) : le texte du message, null sur réponse refusée ou échec réseau (la raison va à `onFail`). Commun au classeur et au sous-classeur. */
export async function ollamaChat(opts: OllamaOpts, format: object, system: string, user: string): Promise<string | null> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const res = await doFetch(`${opts.url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        options: { temperature: 0 },
        format,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!res.ok) {
      opts.onFail?.(`réponse HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { message?: { content?: string } };
    return body.message?.content ?? '';
  } catch {
    opts.onFail?.(UNREACHABLE);
    return null;
  }
}

/** Une réponse lisible mais hors liste est aussi une réponse perdue : sa raison va à `onFail`. */
export function failIfNull<T>(opts: OllamaOpts, value: T | null): T | null {
  if (value === null) opts.onFail?.('réponse hors liste');
  return value;
}
