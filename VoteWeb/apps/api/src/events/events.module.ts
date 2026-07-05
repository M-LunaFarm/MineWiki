import { Module } from '@nestjs/common';
import { BusinessEventService } from './business-event.service';

@Module({
  providers: [BusinessEventService],
  exports: [BusinessEventService]
})
export class EventsModule {}
