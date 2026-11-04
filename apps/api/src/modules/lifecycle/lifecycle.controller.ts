import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CompleteMaintenanceSchema,
  CreateContractSchema,
  CreateMaintenanceSchema,
  CreatePurchaseOrderSchema,
  CreateVendorSchema,
  ExpiringQuerySchema,
  LinkAssetsSchema,
  UpsertFinancialsSchema,
  type CompleteMaintenanceInput,
  type CreateContractInput,
  type CreateMaintenanceInput,
  type CreatePurchaseOrderInput,
  type CreateVendorInput,
  type ExpiringQuery,
  type LinkAssetsInput,
  type UpsertFinancialsInput,
} from '@itam/shared';
import { z } from 'zod';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { LifecycleService } from './lifecycle.service';

const DueQuery = z.object({ withinDays: z.coerce.number().int().min(0).max(3650).default(30) });

@ApiTags('lifecycle')
@ApiBearerAuth()
@Controller()
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  @Get('vendors')
  vendors() {
    return this.lifecycle.listVendors();
  }

  @Post('vendors')
  @Roles('admin')
  @ApiBody(zodBody(CreateVendorSchema))
  createVendor(@Body(new ZodPipe(CreateVendorSchema)) body: CreateVendorInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.lifecycle.createVendor(body, { user, requestId });
  }

  @Post('purchase-orders')
  @Roles('admin')
  @ApiBody(zodBody(CreatePurchaseOrderSchema))
  createPo(@Body(new ZodPipe(CreatePurchaseOrderSchema)) body: CreatePurchaseOrderInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.lifecycle.createPurchaseOrder(body, { user, requestId });
  }

  @Post('contracts')
  @Roles('admin')
  @ApiOperation({ summary: 'Create a warranty, support, lease, maintenance or licence contract and attach assets' })
  @ApiBody(zodBody(CreateContractSchema))
  createContract(@Body(new ZodPipe(CreateContractSchema)) body: CreateContractInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.lifecycle.createContract(body, { user, requestId });
  }

  @Get('contracts/expiring')
  @ApiOperation({ summary: 'Contracts ending within N days (default 90), with notice-window flag' })
  expiring(@Query(new ZodPipe(ExpiringQuerySchema)) q: ExpiringQuery) {
    return this.lifecycle.expiring(q);
  }

  @Get('contracts/coverage-gaps')
  @ApiOperation({ summary: 'Active hardware with no warranty or support contract in force today' })
  coverageGaps() {
    return this.lifecycle.coverageGaps();
  }

  @Get('contracts/:id')
  contract(@Param('id', UuidPipe) id: string) {
    return this.lifecycle.getContract(id);
  }

  @Post('contracts/:id/assets')
  @Roles('admin')
  @ApiBody(zodBody(LinkAssetsSchema))
  link(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(LinkAssetsSchema)) body: LinkAssetsInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.lifecycle.linkAssets(id, body, true, { user, requestId });
  }

  @Delete('contracts/:id/assets')
  @Roles('admin')
  @ApiBody(zodBody(LinkAssetsSchema))
  unlink(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(LinkAssetsSchema)) body: LinkAssetsInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.lifecycle.linkAssets(id, body, false, { user, requestId });
  }

  @Get('assets/:id/financials')
  @ApiOperation({ summary: 'Purchase and depreciation data with current book value' })
  financials(@Param('id', UuidPipe) id: string) {
    return this.lifecycle.getFinancials(id);
  }

  @Put('assets/:id/financials')
  @Roles('admin')
  @ApiBody(zodBody(UpsertFinancialsSchema))
  upsertFinancials(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpsertFinancialsSchema)) body: UpsertFinancialsInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.lifecycle.upsertFinancials(id, body, { user, requestId });
  }

  @Get('assets/:id/maintenance')
  maintenance(@Param('id', UuidPipe) id: string) {
    return this.lifecycle.listMaintenance(id);
  }

  @Post('assets/:id/maintenance')
  @Roles('admin', 'dc_technician')
  @ApiBody(zodBody(CreateMaintenanceSchema))
  createMaintenance(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(CreateMaintenanceSchema)) body: CreateMaintenanceInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.lifecycle.createMaintenance(id, body, { user, requestId });
  }

  @Post('maintenance/:id/complete')
  @Roles('admin', 'dc_technician')
  @ApiOperation({ summary: 'Record maintenance done; the next due date moves forward by the interval' })
  @ApiBody(zodBody(CompleteMaintenanceSchema))
  complete(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(CompleteMaintenanceSchema)) body: CompleteMaintenanceInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.lifecycle.completeMaintenance(id, body, { user, requestId });
  }

  @Get('maintenance/due')
  due(@Query(new ZodPipe(DueQuery)) q: z.infer<typeof DueQuery>) {
    return this.lifecycle.dueMaintenance(q.withinDays);
  }
}
