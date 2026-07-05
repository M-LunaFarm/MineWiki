import { Module } from '@nestjs/common';
import { MinecraftService } from './minecraft.service';
import { MinecraftController } from './minecraft.controller';
import { SessionModule } from '../session/session.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [EventsModule, SessionModule],
  controllers: [MinecraftController],
  providers: [MinecraftService],
  exports: [MinecraftService]
})
export class MinecraftModule {}
