import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigService } from '@minewiki/config';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ServerModule } from './server/server.module';
import { ReviewModule } from './review/review.module';
import { VoteModule } from './vote/vote.module';
import { MinecraftModule } from './minecraft/minecraft.module';
import { CaptchaModule } from './captcha/captcha.module';
import { ClaimModule } from './claim/claim.module';
import { SessionModule } from './session/session.module';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { LoggingThrottlerGuard } from './common/guards/logging-throttler.guard';
import { TelemetryModule } from './telemetry/telemetry.module';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma.module';
import { SupportModule } from './support/support.module';
import { VerifyModule } from './verify/verify.module';
import { WikiModule } from './wiki/wiki.module';
import { PluginSyncModule } from './plugin-sync/plugin-sync.module';
import { FileModule } from './file/file.module';
import { RoleModule } from './roles/role.module';
import { EventsModule } from './events/events.module';
import { RoleAdminModule } from './roles/role-admin.module';
import { BillingModule } from './billing/billing.module';
import { createRateLimitStorage } from './common/rate-limit/rate-limit-storage.factory';

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => ({
        storage: await createRateLimitStorage(config),
        throttlers: [
          {
            name: 'default',
            ttl: 60,
            limit: 100
          }
        ]
      })
    }),
    ServerModule,
    ReviewModule,
    VoteModule,
    MinecraftModule,
    CaptchaModule,
    ClaimModule,
    SessionModule,
    AuthModule,
    DashboardModule,
    SupportModule,
    VerifyModule,
    PluginSyncModule,
    FileModule,
    WikiModule,
    TelemetryModule,
    AppConfigModule,
    PrismaModule,
    RoleModule,
    RoleAdminModule,
    EventsModule,
    BillingModule
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: LoggingThrottlerGuard
    }
  ]
})
export class AppModule {}
