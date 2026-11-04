import { z } from 'zod';
import { IpStatus } from './enums';

const uuid = z.string().uuid();

export const CreateSubnetSchema = z.object({
  cidr: z.string().trim().min(3).max(64),
  name: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  vrfId: uuid.nullable().optional(),
  vlanId: uuid.nullable().optional(),
});
export type CreateSubnetInput = z.infer<typeof CreateSubnetSchema>;

export const AllocateIpSchema = z.object({
  assetId: uuid.nullable().optional(),
  portId: uuid.nullable().optional(),
  status: IpStatus.exclude(['available']).default('assigned'),
  dnsName: z.string().trim().max(253).optional(),
  description: z.string().trim().max(2000).optional(),
});
export type AllocateIpInput = z.infer<typeof AllocateIpSchema>;

export const ReserveIpSchema = AllocateIpSchema.extend({
  ip: z.string().trim().min(2).max(45),
  status: IpStatus.exclude(['available']).default('reserved'),
});
export type ReserveIpInput = z.infer<typeof ReserveIpSchema>;

export interface SubnetSummary {
  id: string;
  cidr: string;
  name: string | null;
  vrfId: string | null;
  vlanId: string | null;
  parentId: string | null;
  family: 4 | 6;
  /** Usable host addresses as a decimal string (IPv6 sizes exceed Number). */
  totalHosts: string;
  usedHosts: number;
  utilisationPct: number;
}

export interface SubnetTreeNode extends SubnetSummary {
  children: SubnetTreeNode[];
}
