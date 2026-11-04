/** Worker configuration, validated once at startup. */
export interface WorkerConfig {
  apiUrl: string;
  token: string;
  redisUrl: string;
  /** Runs processed in parallel by this process (each run has its own host concurrency). */
  concurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const apiUrl = (env.API_URL ?? 'http://localhost:4000/api/v1').replace(/\/$/, '');
  const token = env.WORKER_TOKEN ?? '';
  if (!token) throw new Error('WORKER_TOKEN is required: a JWT for a discovery_service user');
  const u = new URL(apiUrl);
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  // Claims carry decrypted credentials. Refuse to fetch them in clear text off-box.
  if (u.protocol !== 'https:' && !loopback && env.ALLOW_INSECURE_API !== 'true') {
    throw new Error(`API_URL ${apiUrl} is not HTTPS; credentials would cross the network unencrypted (set ALLOW_INSECURE_API=true only inside a trusted overlay)`);
  }
  const concurrency = Number(env.WORKER_CONCURRENCY ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('WORKER_CONCURRENCY must be 1-32');
  return { apiUrl, token, redisUrl: env.REDIS_URL ?? 'redis://localhost:6379', concurrency };
}
