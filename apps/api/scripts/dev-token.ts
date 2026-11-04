// Prints a JWT for a seeded user: pnpm --filter @itam/api token -- --role admin
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/modules/auth/auth.guard';

async function main() {
  const role = process.argv[process.argv.indexOf('--role') + 1] ?? 'admin';
  const prisma = new PrismaClient();
  const user = await prisma.users.findFirst({ where: { role: role as never, is_active: true } });
  await prisma.$disconnect();
  if (!user) throw new Error(`No active user with role ${role}; run the seed first`);
  console.log(signToken(user.id));
}

void main();
