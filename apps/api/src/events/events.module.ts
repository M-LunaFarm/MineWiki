import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { BusinessEventService } from './business-event.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [BusinessEventService],
  exports: [BusinessEventService]
})
export class EventsModule {}
