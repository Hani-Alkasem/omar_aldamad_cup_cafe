import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CompleteMaintenanceInput,
  CreateContractInput,
  CreateMaintenanceInput,
  CreatePurchaseOrderInput,
  CreateVendorInput,
  ExpiringQuery,
  LinkAssetsInput,
  UpsertFinancialsInput,
} from '@itam/shared';
import { toDomainError } from '../../common/db-errors';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { depreciate } from './depreciation';

type Ctx = { user: AuthUser; requestId?: string };

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : s === null ? null : undefined);
const num = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));
export const today = () => new Date().toISOString().slice(0, 10);

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Assets that should carry a warranty: physical gear, not VMs or patch panels. */
const WARRANTABLE = ['physical_server', 'blade_server', 'switch', 'router', 'firewall', 'load_balancer', 'storage_array', 'ups', 'pdu', 'workstation', 'mobile_device'] as const;

@Injectable()
export class LifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertAssets(tx: Tx, ids: string[]) {
    const found = await tx.assets.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw unprocessable('ASSET_NOT_FOUND', `Unknown asset(s): ${missing.join(', ')}`, { missing });
  }

  private rethrowDuplicate(err: unknown, code: string, message: string): never {
    if (toDomainError(err)?.code === 'DUPLICATE') throw conflict(code, message);
    throw err;
  }

  // ─── Vendors & purchase orders ────────────────────────────────────────────
  listVendors() {
    return this.prisma.vendors.findMany({ orderBy: { name: 'asc' } }).then((vs) =>
      vs.map((v) => ({ id: v.id, name: v.name, website: v.website, supportEmail: v.support_email, supportPhone: v.support_phone })),
    );
  }

  async createVendor(input: CreateVendorInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.vendors
        .create({ data: { name: input.name, website: input.website, support_email: input.supportEmail, support_phone: input.supportPhone, notes: input.notes } })
        .catch((e) => this.rethrowDuplicate(e, 'VENDOR_EXISTS', `Vendor "${input.name}" already exists`));
      const dto = { id: v.id, name: v.name, website: v.website, supportEmail: v.support_email, supportPhone: v.support_phone };
      await this.audit.record(tx, { entity: 'vendor', entityId: v.id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
      return dto;
    }, TX_OPTIONS);
  }

  async createPurchaseOrder(input: CreatePurchaseOrderInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.vendors.findUnique({ where: { id: input.vendorId } }))) throw notFound('Vendor', input.vendorId);
      const po = await tx.purchase_orders
        .create({ data: { po_number: input.poNumber, vendor_id: input.vendorId, order_date: toDate(input.orderDate)!, total_amount: input.totalAmount, currency: input.currency, notes: input.notes } })
        .catch((e) => this.rethrowDuplicate(e, 'PO_EXISTS', `Purchase order ${input.poNumber} already exists`));
      const dto = { id: po.id, poNumber: po.po_number, vendorId: po.vendor_id, orderDate: day(po.order_date), totalAmount: num(po.total_amount), currency: po.currency };
      await this.audit.record(tx, { entity: 'purchase_order', entityId: po.id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
      return dto;
    }, TX_OPTIONS);
  }

  // ─── Contracts ────────────────────────────────────────────────────────────
  private contractDto(c: Prisma.contractsGetPayload<{ include: { vendors: true; contract_assets: { include: { assets: { select: { id: true; name: true; asset_tag: true } } } } } }>, asOf = today()) {
    const end = day(c.end_date)!;
    const noticeBy = new Date(Date.parse(`${end}T00:00:00Z`) - c.notice_days * 86_400_000).toISOString().slice(0, 10);
    return {
      id: c.id,
      vendor: { id: c.vendors.id, name: c.vendors.name },
      contractType: c.contract_type,
      contractNumber: c.contract_number,
      startDate: day(c.start_date),
      endDate: end,
      cost: num(c.cost),
      currency: c.currency,
      autoRenew: c.auto_renew,
      noticeDays: c.notice_days,
      noticeBy,
      daysLeft: daysBetween(asOf, end),
      status: end < asOf ? 'expired' : day(c.start_date)! > asOf ? 'pending' : 'active',
      assets: c.contract_assets.map((ca) => ({ id: ca.assets.id, name: ca.assets.name, assetTag: ca.assets.asset_tag })),
    };
  }

  private readonly contractInclude = { vendors: true, contract_assets: { include: { assets: { select: { id: true, name: true, asset_tag: true } } } } } as const;

  async createContract(input: CreateContractInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.vendors.findUnique({ where: { id: input.vendorId } }))) throw notFound('Vendor', input.vendorId);
      if (input.assetIds.length) await this.assertAssets(tx, input.assetIds);
      const c = await tx.contracts
        .create({
          data: {
            vendor_id: input.vendorId,
            contract_type: input.contractType,
            contract_number: input.contractNumber,
            start_date: toDate(input.startDate)!,
            end_date: toDate(input.endDate)!,
            cost: input.cost,
            currency: input.currency,
            auto_renew: input.autoRenew,
            notice_days: input.noticeDays,
            notes: input.notes,
            contract_assets: { create: input.assetIds.map((asset_id) => ({ asset_id })) },
          },
          include: this.contractInclude,
        })
        .catch((e) => this.rethrowDuplicate(e, 'CONTRACT_EXISTS', `Contract ${input.contractNumber} already exists for this vendor`));
      const dto = this.contractDto(c);
      await this.audit.record(tx, { entity: 'contract', entityId: c.id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
      return dto;
    }, TX_OPTIONS);
  }

  async getContract(id: string) {
    const c = await this.prisma.contracts.findUnique({ where: { id }, include: this.contractInclude });
    if (!c) throw notFound('Contract', id);
    return this.contractDto(c);
  }

  async linkAssets(id: string, input: LinkAssetsInput, link: boolean, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.contracts.findUnique({ where: { id }, include: this.contractInclude });
      if (!before) throw notFound('Contract', id);
      if (link) {
        await this.assertAssets(tx, input.assetIds);
        await tx.contract_assets.createMany({ data: input.assetIds.map((asset_id) => ({ contract_id: id, asset_id })), skipDuplicates: true });
      } else {
        await tx.contract_assets.deleteMany({ where: { contract_id: id, asset_id: { in: input.assetIds } } });
      }
      const after = await tx.contracts.findUniqueOrThrow({ where: { id }, include: this.contractInclude });
      const dto = this.contractDto(after);
      await this.audit.record(tx, { entity: 'contract', entityId: id, action: 'update', before: this.contractDto(before), after: dto, userId: ctx.user.id, requestId: ctx.requestId });
      return dto;
    }, TX_OPTIONS);
  }

  /** Contracts ending within the window (today inclusive), soonest first, with their notice date. */
  async expiring(q: ExpiringQuery) {
    const from = today();
    const until = new Date(Date.now() + q.withinDays * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.prisma.contracts.findMany({
      where: { end_date: { gte: toDate(from)!, lte: toDate(until)! }, ...(q.type ? { contract_type: q.type } : {}) },
      include: this.contractInclude,
      orderBy: { end_date: 'asc' },
    });
    return rows.map((c) => {
      const dto = this.contractDto(c, from);
      return { ...dto, inNoticeWindow: dto.noticeBy <= from };
    });
  }

  /** Active warrantable hardware with no warranty or support contract in force today. */
  async coverageGaps() {
    const now = toDate(today())!;
    const rows = await this.prisma.assets.findMany({
      where: {
        type: { in: [...WARRANTABLE] },
        status: { in: ['active', 'maintenance'] },
        NOT: { contract_assets: { some: { contracts: { contract_type: { in: ['warranty', 'support'] }, start_date: { lte: now }, end_date: { gte: now } } } } },
      },
      select: { id: true, name: true, type: true, asset_tag: true, serial_number: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((a) => ({ id: a.id, name: a.name, type: a.type, assetTag: a.asset_tag, serialNumber: a.serial_number }));
  }

  // ─── Financials & depreciation ────────────────────────────────────────────
  private financialsDto(f: Prisma.asset_financialsGetPayload<object> | null, assetId: string, asOf = today()) {
    if (!f) return { assetId, recorded: false as const, depreciation: null };
    const record = {
      purchaseOrderId: f.purchase_order_id,
      purchaseDate: day(f.purchase_date),
      inServiceDate: day(f.in_service_date),
      purchaseCost: num(f.purchase_cost),
      currency: f.currency,
      depreciationMethod: f.depreciation_method,
      usefulLifeMonths: f.useful_life_months,
      salvageValue: num(f.salvage_value) ?? 0,
      disposalDate: day(f.disposal_date),
    };
    const depreciation = depreciate(
      {
        method: record.depreciationMethod,
        cost: record.purchaseCost,
        salvage: record.salvageValue,
        lifeMonths: record.usefulLifeMonths,
        startDate: record.inServiceDate ?? record.purchaseDate,
      },
      record.disposalDate && record.disposalDate < asOf ? record.disposalDate : asOf,
    );
    return { assetId, recorded: true as const, ...record, depreciation };
  }

  async getFinancials(assetId: string) {
    if (!(await this.prisma.assets.findUnique({ where: { id: assetId }, select: { id: true } }))) throw notFound('Asset', assetId);
    return this.financialsDto(await this.prisma.asset_financials.findUnique({ where: { asset_id: assetId } }), assetId);
  }

  async upsertFinancials(assetId: string, input: UpsertFinancialsInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.assets.findUnique({ where: { id: assetId }, select: { id: true } }))) throw notFound('Asset', assetId);
      if (input.purchaseOrderId && !(await tx.purchase_orders.findUnique({ where: { id: input.purchaseOrderId } }))) {
        throw notFound('Purchase order', input.purchaseOrderId);
      }
      const before = await tx.asset_financials.findUnique({ where: { asset_id: assetId } });
      const data = {
        purchase_order_id: input.purchaseOrderId ?? null,
        purchase_date: toDate(input.purchaseDate) ?? null,
        in_service_date: toDate(input.inServiceDate) ?? null,
        purchase_cost: input.purchaseCost ?? null,
        currency: input.currency,
        depreciation_method: input.depreciationMethod,
        useful_life_months: input.usefulLifeMonths ?? null,
        salvage_value: input.salvageValue,
        disposal_date: toDate(input.disposalDate) ?? null,
      };
      const saved = await tx.asset_financials.upsert({ where: { asset_id: assetId }, create: { asset_id: assetId, ...data }, update: data });
      const after = this.financialsDto(saved, assetId);
      await this.audit.record(tx, {
        entity: 'asset_financials',
        entityId: assetId,
        action: before ? 'update' : 'create',
        before: before ? this.financialsDto(before, assetId) : null,
        after,
        userId: ctx.user.id,
        requestId: ctx.requestId,
      });
      return after;
    }, TX_OPTIONS);
  }

  // ─── Maintenance ──────────────────────────────────────────────────────────
  private maintenanceDto(m: Prisma.maintenance_schedulesGetPayload<object> & { assets?: { name: string } }) {
    const next = day(m.next_due_on);
    return {
      id: m.id,
      assetId: m.asset_id,
      assetName: m.assets?.name,
      title: m.title,
      intervalDays: m.interval_days,
      lastDoneOn: day(m.last_done_on),
      nextDueOn: next,
      overdue: next != null && next < today(),
    };
  }

  async listMaintenance(assetId: string) {
    const rows = await this.prisma.maintenance_schedules.findMany({ where: { asset_id: assetId }, orderBy: { next_due_on: 'asc' } });
    return rows.map((m) => this.maintenanceDto(m));
  }

  async createMaintenance(assetId: string, input: CreateMaintenanceInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.assets.findUnique({ where: { id: assetId }, select: { id: true } }))) throw notFound('Asset', assetId);
      const m = await tx.maintenance_schedules.create({
        data: { asset_id: assetId, title: input.title, interval_days: input.intervalDays, first_due_on: toDate(input.firstDueOn)!, notes: input.notes },
      });
      const dto = this.maintenanceDto(m);
      await this.audit.record(tx, { entity: 'maintenance', entityId: m.id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
      return dto;
    }, TX_OPTIONS);
  }

  async completeMaintenance(id: string, input: CompleteMaintenanceInput, ctx: Ctx) {
    const doneOn = input.doneOn ?? today();
    if (doneOn > today()) throw unprocessable('DATE_IN_FUTURE', 'doneOn cannot be in the future');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.maintenance_schedules.findUnique({ where: { id } });
      if (!before) throw notFound('Maintenance schedule', id);
      const m = await tx.maintenance_schedules.update({ where: { id }, data: { last_done_on: toDate(doneOn)! } });
      const dto = this.maintenanceDto(m);
      await this.audit.record(tx, { entity: 'maintenance', entityId: id, action: 'update', before: this.maintenanceDto(before), after: dto, userId: ctx.user.id, requestId: ctx.requestId });
      return dto;
    }, TX_OPTIONS);
  }

  async dueMaintenance(withinDays: number) {
    const until = new Date(Date.now() + withinDays * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.prisma.maintenance_schedules.findMany({
      where: { next_due_on: { lte: toDate(until)! } },
      include: { assets: { select: { name: true } } },
      orderBy: { next_due_on: 'asc' },
    });
    return rows.map((m) => this.maintenanceDto(m));
  }
}
