import { forwardRef, Module } from '@nestjs/common';
import { VoteService } from './vote.service';
import { VoteController } from './vote.controller';
import { VoteDiagnosticsController } from './vote-diagnostics.controller';
import { ServerModule } from '../server/server.module';
import { VoteQueueService } from './vote.queue';
import { VoteDiagnosticsService } from './vote-diagnostics.service';
import { CaptchaModule } from '../captcha/captcha.module';
import { EventsModule } from '../events/events.module';
import { VoteStore } from './vote.store';
import { SessionModule } from '../session/session.module';
import { MinecraftModule } from '../minecraft/minecraft.module';
import { VoteMonitorController } from './vote-monitor.controller';
import { VoteDispatchController } from './vote-dispatch.controller';
import { ClaimModule } from '../claim/claim.module';

@Module({
  imports: [
    ServerModule,
    forwardRef(() => ClaimModule),
    CaptchaModule,
    EventsModule,
    SessionModule,
    MinecraftModule
  ],
  providers: [VoteService, VoteQueueService, VoteDiagnosticsService, VoteStore],
  controllers: [
    VoteController,
    VoteDiagnosticsController,
    VoteMonitorController,
    VoteDispatchController
  ],
  exports: [VoteStore]
})
export class VoteModule {}
