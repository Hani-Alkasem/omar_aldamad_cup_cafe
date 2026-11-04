/** 12 attempts span about a day: 30 s, 1 m, 2 m, 4 m … capped at 6 h, with ±20% jitter. */
export const MAX_ATTEMPTS = 12;
const BASE_MS = 30_000;
const CAP_MS = 6 * 3600_000;

export function retryDelayMs(attempt: number, retryAfterHeader?: string | string[], random = Math.random): number {
  const ra = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
  if (ra) {
    const secs = Number(ra);
    const at = Number.isFinite(secs) ? secs * 1000 : Date.parse(ra) - Date.now();
    if (Number.isFinite(at) && at > 0) return Math.min(at, CAP_MS);
  }
  const raw = Math.min(BASE_MS * 2 ** Math.max(0, attempt - 1), CAP_MS);
  return Math.round(raw * (0.8 + random() * 0.4));
}

/** Retry server trouble and throttling; a 4xx (other than 408/429) will not fix itself. */
export const isRetryableStatus = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;
