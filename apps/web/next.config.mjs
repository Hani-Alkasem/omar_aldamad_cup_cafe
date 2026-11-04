import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained server for the container image; trace files from the monorepo root.
  output: 'standalone',
  experimental: { outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)) },
  transpilePackages: ['@itam/shared'],
  poweredByHeader: false,
};
export default nextConfig;
