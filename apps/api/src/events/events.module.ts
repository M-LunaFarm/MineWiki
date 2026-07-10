import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { BusinessEventService } from './business-event.service';
import { SessionModule } from '../session/session.module';

@Global()
@Module({
  imports: [SessionModule],
  controllers: [AuditController],
  providers: [BusinessEventService],
  exports: [BusinessEventService]
})
export class EventsModule {}
