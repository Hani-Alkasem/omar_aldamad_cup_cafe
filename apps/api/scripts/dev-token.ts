// Prints a JWT for a seeded user: pnpm --filter @itam/api token -- --role admin [--expires 30d]
// The discovery worker needs a longer-lived token than people: --role discovery_service --expires 30d
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/modules/auth/auth.guard';

async function main() {
  const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const role = arg('--role') ?? 'admin';
  const expires = arg('--expires') ?? '8h';
  const prisma = new PrismaClient();
  const user = await prisma.users.findFirst({ where: { role: role as never, is_active: true } });
  await prisma.$disconnect();
  if (!user) throw new Error(`No active user with role ${role}; run the seed first`);
  console.log(signToken(user.id, undefined, expires));
}

void main();
