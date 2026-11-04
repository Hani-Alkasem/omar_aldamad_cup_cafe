/**
 * Operator commands, shipped in the API image (no dev tooling needed):
 *
 *   node dist/cli.js create-admin --email ops@example.com [--name "Ops"]
 *   node dist/cli.js token (--email <e> | --role <role>) [--expires 8h]
 *   node dist/cli.js create-service-client --name discovery-worker
 *
 * Secrets are printed once to stdout; nothing else is written outside the database.
 */
import { PrismaClient } from '@prisma/client';
import { signToken } from './modules/auth/auth.guard';
import { hashSecret, newClientSecret, prefixOf } from './modules/service-clients/secrets';

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

async function main() {
  const prisma = new PrismaClient();
  try {
    switch (args[0]) {
      case 'create-admin': {
        const email = flag('email') ?? fail('--email is required');
        const user = (await prisma.users.findFirst({ where: { email } })) ?? (await prisma.users.create({ data: { email, display_name: flag('name') ?? email, role: 'admin' } }));
        if (user.role !== 'admin') fail(`${email} exists with role ${user.role}`);
        console.log(signToken(user.id, undefined, flag('expires') ?? '8h'));
        break;
      }
      case 'token': {
        const email = flag('email');
        const role = flag('role');
        if (!email && !role) fail('--email or --role is required');
        const user = await prisma.users.findFirst({ where: { is_active: true, ...(email ? { email } : { role: role as never }) } });
        if (!user) fail('no active user matches');
        console.log(signToken(user!.id, undefined, flag('expires') ?? '8h'));
        break;
      }
      case 'create-service-client': {
        const name = flag('name') ?? fail('--name is required');
        const secret = newClientSecret();
        const user = await prisma.users.create({ data: { email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}@service.invalid`, display_name: `Service: ${name}`, role: 'discovery_service' } });
        const c = await prisma.service_clients.create({ data: { name, user_id: user.id, secret_hash: await hashSecret(secret), secret_prefix: prefixOf(secret) } });
        console.log(`WORKER_CLIENT_ID=${c.id}\nWORKER_CLIENT_SECRET=${secret}`);
        break;
      }
      default:
        fail('usage: cli.js create-admin --email <e> | token (--email <e> | --role <r>) [--expires 8h] | create-service-client --name <n>');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
