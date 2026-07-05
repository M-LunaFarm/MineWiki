import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
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

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60,
        limit: 100
      }
    ]),
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
    TelemetryModule,
    AppConfigModule,
    PrismaModule
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
