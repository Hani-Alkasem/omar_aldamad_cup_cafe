import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateAssetSchema, ListAssetsQuerySchema, UpdateAssetSchema, type CreateAssetInput, type ListAssetsQuery, type UpdateAssetInput } from '@itam/shared';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { AssetsService } from './assets.service';

const WRITERS = ['admin', 'dc_technician'] as const;

@ApiTags('assets')
@ApiBearerAuth()
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @ApiOperation({ summary: 'List assets (filter by type, status, rack; search name/tag/serial)' })
  list(@Query(new ZodPipe(ListAssetsQuerySchema)) q: ListAssetsQuery) {
    return this.assets.list(q);
  }

  @Get(':id')
  get(@Param('id', UuidPipe) id: string) {
    return this.assets.get(id);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Audit trail for one asset, newest first' })
  history(@Param('id', UuidPipe) id: string) {
    return this.assets.history(id);
  }

  @Post()
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Create an asset; rejects U-space collisions with 409 RACK_U_CONFLICT' })
  @ApiBody(zodBody(CreateAssetSchema))
  create(@Body() raw: Record<string, unknown>, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    const input: CreateAssetInput = new ZodPipe(CreateAssetSchema).transform(raw);
    return this.assets.create(input, raw ?? {}, user, requestId);
  }

  @Patch(':id')
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Update an asset (e.g. move it in a rack); re-checks U-space' })
  @ApiBody(zodBody(UpdateAssetSchema))
  update(
    @Param('id', UuidPipe) id: string,
    @Body(new ZodPipe(UpdateAssetSchema.strict())) patch: UpdateAssetInput,
    @CurrentUser() user: AuthUser,
    @RequestId() requestId?: string,
  ) {
    return this.assets.update(id, patch, user, requestId);
  }

  @Delete(':id')
  @Roles(...WRITERS)
  @HttpCode(204)
  remove(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.assets.remove(id, user, requestId);
  }
}
