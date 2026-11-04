#!/usr/bin/env sh
# Introspect the database into prisma/schema.prisma, then drop index declarations Prisma
# cannot express on Unsupported columns (they stay in the DB, defined by the SQL migrations).
set -e
npx prisma db pull --force
sed -i '/@@index(\[cidr(ops: InetOps)\]/d' prisma/schema.prisma
npx prisma format >/dev/null
