import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { PrismaModule } from './common/prisma.module';
import { HealthController } from './health.controller';
import { AssetsModule } from './modules/assets/assets.module';
import { AuthGuard } from './modules/auth/auth.guard';
import { IpamModule } from './modules/ipam/ipam.module';
import { RacksModule } from './modules/racks/racks.module';

@Module({
  imports: [PrismaModule, AssetsModule, RacksModule, IpamModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
