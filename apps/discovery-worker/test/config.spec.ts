import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('requires a token', () => {
    expect(() => loadConfig({})).toThrow(/WORKER_CLIENT_ID/);
    expect(loadConfig({ WORKER_CLIENT_ID: 'c', WORKER_CLIENT_SECRET: 's' }).client).toEqual({ id: 'c', secret: 's' });
  });

  it('refuses plain HTTP off-box, because claims carry decrypted credentials', () => {
    expect(() => loadConfig({ WORKER_TOKEN: 't', API_URL: 'http://api.internal:4000/api/v1' })).toThrow(/not HTTPS/);
    expect(loadConfig({ WORKER_TOKEN: 't', API_URL: 'http://localhost:4000/api/v1' }).apiUrl).toBe('http://localhost:4000/api/v1');
    expect(loadConfig({ WORKER_TOKEN: 't', API_URL: 'https://itam.example.com/api/v1/' }).apiUrl).toBe('https://itam.example.com/api/v1');
    expect(loadConfig({ WORKER_TOKEN: 't', API_URL: 'http://api:4000/api/v1', ALLOW_INSECURE_API: 'true' }).apiUrl).toBe('http://api:4000/api/v1');
  });
});
