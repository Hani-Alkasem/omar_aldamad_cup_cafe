import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * Creates a fresh database and applies the real migrations with `prisma migrate deploy`,
 * so the tests exercise exactly the DDL that ships.
 *
 * TEST_DATABASE_ADMIN_URL points at any database on a Postgres 16 server where the user may
 * CREATE DATABASE (default: the docker-compose service).
 */
export default async function setup() {
  const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://itam:itam@localhost:5432/postgres';
  const dbName = `itam_test_${process.pid}`;
  const url = new URL(admin);
  url.pathname = `/${dbName}`;
  url.searchParams.set('connection_limit', '20');
  const testUrl = url.toString();

  const client = new PrismaClient({ datasourceUrl: admin });
  await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  await client.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  await client.$disconnect();

  execSync('npx prisma migrate deploy', { cwd: __dirname + '/..', env: { ...process.env, DATABASE_URL: testUrl }, stdio: 'pipe' });

  process.env.DATABASE_URL = testUrl;
  process.env.JWT_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

  return async () => {
    const c = new PrismaClient({ datasourceUrl: admin });
    await c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await c.$disconnect();
  };
}
