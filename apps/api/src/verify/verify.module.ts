import { Module } from '@nestjs/common';
import { VerifyController } from './verify.controller';
import { VerifyService } from './verify.service';
import { SessionModule } from '../session/session.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [SessionModule, EventsModule],
  controllers: [VerifyController],
  providers: [VerifyService],
  exports: [VerifyService]
})
export class VerifyModule {}
