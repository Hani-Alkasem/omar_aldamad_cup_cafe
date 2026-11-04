import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const money = z.number().nonnegative().max(1e12).multipleOf(0.01);
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. USD').default('USD');

export const ContractType = z.enum(['warranty', 'support', 'lease', 'maintenance', 'license']);
export type ContractType = z.infer<typeof ContractType>;
export const DepreciationMethod = z.enum(['none', 'straight_line', 'declining_balance']);
export type DepreciationMethod = z.infer<typeof DepreciationMethod>;

export const CreateVendorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  website: z.string().url().max(500).optional(),
  supportEmail: z.string().email().max(254).optional(),
  supportPhone: z.string().trim().max(50).optional(),
  notes: z.string().max(5000).optional(),
});
export type CreateVendorInput = z.infer<typeof CreateVendorSchema>;

export const CreatePurchaseOrderSchema = z.object({
  poNumber: z.string().trim().min(1).max(64),
  vendorId: uuid,
  orderDate: isoDate,
  totalAmount: money.optional(),
  currency,
  notes: z.string().max(5000).optional(),
});
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderSchema>;

export const CreateContractSchema = z
  .object({
    vendorId: uuid,
    contractType: ContractType,
    contractNumber: z.string().trim().min(1).max(100),
    startDate: isoDate,
    endDate: isoDate,
    cost: money.optional(),
    currency,
    autoRenew: z.boolean().default(false),
    noticeDays: z.number().int().min(0).max(365).default(30),
    notes: z.string().max(5000).optional(),
    assetIds: z.array(uuid).max(1000).default([]),
  })
  .refine((c) => c.endDate >= c.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] });
export type CreateContractInput = z.infer<typeof CreateContractSchema>;

export const LinkAssetsSchema = z.object({ assetIds: z.array(uuid).min(1).max(1000) });
export type LinkAssetsInput = z.infer<typeof LinkAssetsSchema>;

export const ExpiringQuerySchema = z.object({
  withinDays: z.coerce.number().int().min(0).max(3650).default(90),
  type: ContractType.optional(),
});
export type ExpiringQuery = z.infer<typeof ExpiringQuerySchema>;

export const UpsertFinancialsSchema = z
  .object({
    purchaseOrderId: uuid.nullable().optional(),
    purchaseDate: isoDate.nullable().optional(),
    inServiceDate: isoDate.nullable().optional(),
    purchaseCost: money.nullable().optional(),
    currency,
    depreciationMethod: DepreciationMethod.default('straight_line'),
    usefulLifeMonths: z.number().int().min(1).max(600).nullable().optional(),
    salvageValue: money.default(0),
    disposalDate: isoDate.nullable().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.purchaseCost != null && f.salvageValue > f.purchaseCost) {
      ctx.addIssue({ code: 'custom', path: ['salvageValue'], message: 'salvageValue cannot exceed purchaseCost' });
    }
    if (f.depreciationMethod !== 'none' && (f.purchaseCost == null || f.usefulLifeMonths == null)) {
      ctx.addIssue({ code: 'custom', path: ['depreciationMethod'], message: 'depreciation needs purchaseCost and usefulLifeMonths' });
    }
    if (f.purchaseDate && f.inServiceDate && f.inServiceDate < f.purchaseDate) {
      ctx.addIssue({ code: 'custom', path: ['inServiceDate'], message: 'inServiceDate is before purchaseDate' });
    }
  });
export type UpsertFinancialsInput = z.infer<typeof UpsertFinancialsSchema>;

export const CreateMaintenanceSchema = z.object({
  title: z.string().trim().min(1).max(200),
  intervalDays: z.number().int().min(1).max(3650),
  firstDueOn: isoDate,
  notes: z.string().max(5000).optional(),
});
export type CreateMaintenanceInput = z.infer<typeof CreateMaintenanceSchema>;

export const CompleteMaintenanceSchema = z.object({ doneOn: isoDate.optional() });
export type CompleteMaintenanceInput = z.infer<typeof CompleteMaintenanceSchema>;

export const ComponentKind = z.enum(['cpu', 'memory', 'disk', 'gpu', 'nic', 'psu', 'firmware']);
export type ComponentKind = z.infer<typeof ComponentKind>;

export const CreateComponentSchema = z.object({
  kind: ComponentKind,
  slot: z.string().trim().max(64).optional(),
  manufacturer: z.string().trim().max(100).optional(),
  model: z.string().trim().max(200).optional(),
  serialNumber: z.string().trim().max(128).optional(),
  /** cores for CPUs, GB for memory/disks/GPU memory, W for PSUs. */
  capacity: z.number().nonnegative().max(1e9).optional(),
  attributes: z.record(z.unknown()).default({}),
});
export type CreateComponentInput = z.infer<typeof CreateComponentSchema>;

export interface DepreciationSummary {
  method: DepreciationMethod;
  cost: number | null;
  salvage: number;
  ageMonths: number;
  accumulated: number;
  bookValue: number | null;
  monthlyCharge: number | null;
  fullyDepreciatedOn: string | null;
}
