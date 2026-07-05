import { Module } from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewController } from './review.controller';
import { ServerModule } from '../server/server.module';
import { EventsModule } from '../events/events.module';
import { VoteModule } from '../vote/vote.module';
import { MinecraftModule } from '../minecraft/minecraft.module';
import { SessionModule } from '../session/session.module';
import { AuthModule } from '../auth/auth.module';
import { ClaimModule } from '../claim/claim.module';

@Module({
  imports: [ServerModule, EventsModule, VoteModule, MinecraftModule, SessionModule, AuthModule, ClaimModule],
  providers: [ReviewService],
  controllers: [ReviewController]
})
export class ReviewModule {}
