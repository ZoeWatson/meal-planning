/**
 * HTTP transport for the reference sync server.
 *
 * The whole backend contract is two calls, which is what keeps the server
 * dependency-free and lets it be swapped for Supabase, a Cloudflare Worker, or a
 * Raspberry Pi in a cupboard without the app noticing.
 */

import {
  SyncError, type Change, type PullResult, type PushResult, type SyncTransport,
} from '../domain/sync/types';

const TIMEOUT_MS = 15_000;

export class HttpSyncTransport implements SyncTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly spaceId: string,
  ) {}

  async push(changes: readonly Change[]): Promise<PushResult> {
    return this.request<PushResult>('push', {
      method: 'POST',
      body: JSON.stringify({ changes }),
    });
  }

  async pull(since: number, limit = 500): Promise<PullResult> {
    return this.request<PullResult>(`pull?since=${since}&limit=${limit}`, { method: 'GET' });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/sync/${encodeURIComponent(this.spaceId)}/${path}`;

    // AbortSignal.timeout is not available everywhere this might run, and a sync
    // that hangs forever is worse than one that fails — the UI would sit on
    // "syncing" indefinitely with no way back.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...init.headers },
      });
    } catch (err) {
      // Network failure, DNS, CORS, timeout: all worth retrying later.
      throw new SyncError(
        controller.signal.aborted ? 'Sync timed out.' : 'Could not reach the sync server.',
        true,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // 5xx is the server's problem and may pass; 4xx means this request is wrong
      // and retrying it unchanged will fail identically forever.
      throw new SyncError(
        `Sync server returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        response.status >= 500 || response.status === 429,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new SyncError('Sync server returned malformed JSON.', false, err);
    }
  }
}

/**
 * Derives the server-side namespace from a human-typed pairing code.
 *
 * The code IS the credential: anyone who has it can read and write the space.
 * That is a deliberate trade for a personal tool — it means no accounts, no
 * passwords, and no login screen between you and a shopping list in a supermarket.
 * It is also why the reference server should not hold anything more sensitive than
 * what you are having for dinner.
 *
 * Hashing rather than using the code directly keeps the plaintext out of URLs and
 * server logs, so a leaked log does not hand over the code itself.
 */
export async function spaceIdFromCode(code: string): Promise<string> {
  const normalised = code.trim().toLowerCase().replace(/\s+/g, '-');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`meal-sync:${normalised}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Four short words are easier to type on a phone than a random string. */
const WORDS = [
  'apple', 'basil', 'cedar', 'daisy', 'ember', 'fern', 'ginger', 'hazel',
  'indigo', 'juniper', 'kelp', 'lemon', 'maple', 'nutmeg', 'olive', 'pepper',
  'quince', 'rosemary', 'sage', 'thyme', 'umber', 'violet', 'walnut', 'yarrow',
];

export function generatePairingCode(): string {
  const picks = new Uint32Array(4);
  crypto.getRandomValues(picks);
  return [...picks].map((n) => WORDS[n % WORDS.length]).join('-');
}
