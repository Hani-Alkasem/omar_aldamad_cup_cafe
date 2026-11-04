import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateCredentialSchema,
  CreateJobSchema,
  FinishRunSchema,
  RotateSecretSchema,
  SubmitHostsSchema,
  UpdateJobSchema,
  type CreateCredentialInput,
  type CreateJobInput,
  type FinishRunInput,
  type RotateSecretInput,
  type SubmitHostsInput,
  type UpdateJobInput,
} from '@itam/shared';
import { z } from 'zod';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { CredentialsService } from './credentials.service';
import { JobsService } from './jobs.service';
import { RunsService } from './runs.service';

const JOB_WRITERS = ['admin', 'network_engineer'] as const;
const ResultsQuery = z.object({ outcome: z.enum(['created', 'updated', 'unchanged', 'conflict', 'auth_failed', 'error']).optional() });
const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

@ApiTags('discovery')
@ApiBearerAuth()
@Controller()
export class DiscoveryController {
  constructor(
    private readonly creds: CredentialsService,
    private readonly jobs: JobsService,
  ) {}

  /* Credentials: admin only, and never with secrets in a response. */

  @Get('credentials')
  @Roles('admin')
  listCredentials() {
    return this.creds.list();
  }

  @Post('credentials')
  @Roles('admin')
  @ApiOperation({ summary: 'Store a credential; the secret is sealed with AES-256-GCM and never returned' })
  @ApiBody(zodBody(CreateCredentialSchema))
  createCredential(@Body(new ZodPipe(CreateCredentialSchema)) body: CreateCredentialInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.creds.create(body, { user, requestId });
  }

  @Put('credentials/:id/secret')
  @Roles('admin')
  @ApiOperation({ summary: 'Rotate a secret (re-sealed with the current master key)' })
  @ApiBody(zodBody(RotateSecretSchema))
  rotate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(RotateSecretSchema)) body: RotateSecretInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.creds.rotate(id, body, { user, requestId });
  }

  @Delete('credentials/:id')
  @Roles('admin')
  @HttpCode(204)
  removeCredential(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.creds.remove(id, { user, requestId });
  }

  /* Jobs and runs */

  @Get('discovery/jobs')
  listJobs() {
    return this.jobs.list();
  }

  @Post('discovery/jobs')
  @Roles(...JOB_WRITERS)
  @ApiOperation({ summary: 'Create an SNMP or SSH sweep over one or more CIDRs, optionally on a cron schedule' })
  @ApiBody(zodBody(CreateJobSchema))
  createJob(@Body(new ZodPipe(CreateJobSchema)) body: CreateJobInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.jobs.create(body, { user, requestId });
  }

  @Get('discovery/jobs/:id')
  job(@Param('id', UuidPipe) id: string) {
    return this.jobs.get(id);
  }

  @Patch('discovery/jobs/:id')
  @Roles(...JOB_WRITERS)
  @ApiBody(zodBody(UpdateJobSchema))
  updateJob(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateJobSchema)) body: UpdateJobInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.jobs.update(id, body, { user, requestId });
  }

  @Delete('discovery/jobs/:id')
  @Roles(...JOB_WRITERS)
  @HttpCode(204)
  removeJob(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.jobs.remove(id, { user, requestId });
  }

  @Post('discovery/jobs/:id/run')
  @Roles(...JOB_WRITERS)
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue a run now; 409 RUN_IN_PROGRESS if one is already queued or running' })
  runNow(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.jobs.createRun(id, 'manual', { userId: user.id, requestId }, true);
  }

  @Get('discovery/jobs/:id/runs')
  runs(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(RunsQuery)) q: z.infer<typeof RunsQuery>) {
    return this.jobs.listRuns(id, q.limit);
  }

  @Delete('assets/:id/discovery/ssh-host-key')
  @Roles('admin', 'dc_technician')
  @ApiOperation({ summary: 'Accept a changed SSH host key after a confirmed reinstall; the next run records the new key' })
  acceptHostKey(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.jobs.acceptHostKey(id, { user, requestId });
  }

  @Get('discovery/runs/:id')
  run(@Param('id', UuidPipe) id: string) {
    return this.jobs.getRun(id);
  }

  @Get('discovery/runs/:id/results')
  @ApiOperation({ summary: 'Per-host outcome: created, updated, unchanged, conflict, auth_failed, error' })
  results(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(ResultsQuery)) q: z.infer<typeof ResultsQuery>) {
    return this.jobs.results(id, q.outcome);
  }
}

/** Worker-only routes. The guard refuses the service role everywhere else, and everyone else here. */
@ApiTags('discovery-internal')
@ApiBearerAuth()
@Controller('internal/discovery')
@Roles('discovery_service')
export class DiscoveryInternalController {
  constructor(
    private readonly jobs: JobsService,
    private readonly runsSvc: RunsService,
  ) {}

  @Post('jobs/:id/runs')
  @ApiOperation({ summary: 'Scheduler fired: open a run for this job (409 if one is active or the job is disabled)' })
  scheduled(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.jobs.createRun(id, 'schedule', { userId: user.id, requestId }, false);
  }

  @Post('runs/:id/claim')
  @HttpCode(200)
  @ApiOperation({ summary: 'Claim a run: returns targets and decrypted credentials over this connection only' })
  claim(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.runsSvc.claim(id, { userId: user.id, requestId });
  }

  @Post('runs/:id/hosts')
  @HttpCode(200)
  @ApiBody(zodBody(SubmitHostsSchema))
  hosts(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(SubmitHostsSchema)) body: SubmitHostsInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.runsSvc.submit(id, body, { userId: user.id, requestId });
  }

  @Post('runs/:id/finish')
  @HttpCode(200)
  @ApiBody(zodBody(FinishRunSchema))
  finish(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(FinishRunSchema)) body: FinishRunInput) {
    return this.runsSvc.finish(id, body);
  }
}
