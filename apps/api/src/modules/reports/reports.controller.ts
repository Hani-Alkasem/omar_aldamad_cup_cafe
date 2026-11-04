import { Body, Controller, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { unprocessable } from '../../common/errors';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { ExportService } from './export.service';
import { ImportService } from './import.service';
import { SearchService } from './search.service';
import { SummaryService } from './summary.service';

const SearchQuery = z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(100).default(25) });
const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).default('true').transform((v) => v === 'true') });

@ApiTags('reports')
@ApiBearerAuth()
@Controller()
export class ReportsController {
  constructor(
    private readonly searchSvc: SearchService,
    private readonly summarySvc: SummaryService,
    private readonly exports: ExportService,
    private readonly imports: ImportService,
  ) {}

  @Get('search')
  @ApiOperation({ summary: 'Search names, tags, serials, IPs, CIDRs, MACs and UUIDs in one box' })
  search(@Query(new ZodPipe(SearchQuery)) q: z.infer<typeof SearchQuery>) {
    return this.searchSvc.search(q.q, q.limit);
  }

  @Get('reports/summary')
  @ApiOperation({ summary: 'Dashboard: inventory, rack capacity and power, coverage, IPAM, discovery and integration health' })
  summary() {
    return this.summarySvc.summary();
  }

  @Get('export/:name.csv')
  @ApiOperation({ summary: 'Stream assets, ip-addresses, subnets or contracts as CSV (formula-safe)' })
  async export(@Param('name') name: string, @Res() res: Response) {
    if (!this.exports.has(name)) throw new NotFoundException({ code: 'NOT_FOUND', message: `No export named ${name}` });
    await this.exports.stream(name, res);
  }

  @Post('imports/assets')
  @Roles('admin', 'dc_technician')
  @ApiConsumes('text/csv')
  @ApiOperation({ summary: 'Import assets from CSV; dryRun=true (default) validates and reports without writing' })
  importAssets(@Body() body: unknown, @Query(new ZodPipe(ImportQuery)) q: z.infer<typeof ImportQuery>, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    if (typeof body !== 'string') throw unprocessable('CSV_REQUIRED', 'Send the file as text/csv');
    return this.imports.importAssets(body, { dryRun: q.dryRun, user, requestId });
  }
}
