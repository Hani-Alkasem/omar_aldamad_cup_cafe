import { z } from 'zod';

export const AssetType = z.enum([
  'physical_server',
  'blade_server',
  'virtual_machine',
  'switch',
  'router',
  'firewall',
  'load_balancer',
  'storage_array',
  'patch_panel',
  'pdu',
  'ups',
  'workstation',
  'mobile_device',
  'other',
]);
export type AssetType = z.infer<typeof AssetType>;

export const AssetStatus = z.enum(['planned', 'in_stock', 'active', 'maintenance', 'retired', 'disposed']);
export type AssetStatus = z.infer<typeof AssetStatus>;

export const RackFace = z.enum(['front', 'rear']);
export type RackFace = z.infer<typeof RackFace>;

export const MountDepth = z.enum(['full', 'half', 'zero_u']);
export type MountDepth = z.infer<typeof MountDepth>;

export const IpStatus = z.enum(['available', 'assigned', 'reserved', 'dhcp']);
export type IpStatus = z.infer<typeof IpStatus>;

export const RelationshipType = z.enum(['runs_on', 'connects_to', 'depends_on', 'powered_by']);
export type RelationshipType = z.infer<typeof RelationshipType>;

export const Role = z.enum(['admin', 'dc_technician', 'network_engineer', 'auditor']);
export type Role = z.infer<typeof Role>;
