import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ScopeService } from './scope.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/** Global: the auth guard resolves sessions, and inventory services check site scopes. */
@Global()
@Module({ imports: [AuditModule], controllers: [SessionsController], providers: [SessionsService, ScopeService], exports: [SessionsService, ScopeService] })
export class SessionsModule {}
