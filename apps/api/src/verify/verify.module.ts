import { Module } from '@nestjs/common';
import { VerifyController } from './verify.controller';
import { VerifyService } from './verify.service';
import { SessionModule } from '../session/session.module';
import { EventsModule } from '../events/events.module';
import { DiscordVerifyController } from './discord-verify.controller';
import { GuildController } from './guild.controller';

@Module({
  imports: [SessionModule, EventsModule],
  controllers: [VerifyController, DiscordVerifyController, GuildController],
  providers: [VerifyService],
  exports: [VerifyService]
})
export class VerifyModule {}
