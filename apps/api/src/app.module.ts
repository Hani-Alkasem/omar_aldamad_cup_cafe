import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { PrismaModule } from './common/prisma.module';
import { HealthController } from './health.controller';
import { AssetsModule } from './modules/assets/assets.module';
import { CablingModule } from './modules/cabling/cabling.module';
import { ComponentsModule } from './modules/components/components.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { CmdbModule } from './modules/cmdb/cmdb.module';
import { DiscoveryModule } from './modules/discovery/discovery.module';
import { PowerModule } from './modules/power/power.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { IpamModule } from './modules/ipam/ipam.module';
import { RacksModule } from './modules/racks/racks.module';

@Module({
  imports: [PrismaModule, AssetsModule, RacksModule, IpamModule, LifecycleModule, ComponentsModule, CablingModule, PowerModule, DiscoveryModule, CmdbModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
