import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/** Minimal location chain + rack with a unique name so specs never collide. */
export async function makeRack(prisma: PrismaClient, heightU = 42) {
  const tag = randomUUID().slice(0, 8);
  const site = await prisma.sites.create({ data: { name: `site-${tag}` } });
  const building = await prisma.buildings.create({ data: { site_id: site.id, name: 'B' } });
  const room = await prisma.rooms.create({ data: { building_id: building.id, name: 'R' } });
  return prisma.racks.create({ data: { room_id: room.id, name: `rack-${tag}`, height_u: heightU } });
}

export async function makeUser(prisma: PrismaClient, role: 'admin' | 'dc_technician' | 'network_engineer' | 'auditor' | 'discovery_service') {
  return prisma.users.create({ data: { email: `${role}-${randomUUID().slice(0, 8)}@example.com`, display_name: role, role } });
}

/** A private VRF per spec keeps subnets from colliding across tests. */
export async function makeVrf(prisma: PrismaClient) {
  return prisma.vrfs.create({ data: { name: `vrf-${randomUUID().slice(0, 8)}` } });
}
