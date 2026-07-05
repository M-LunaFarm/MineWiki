import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { SessionGuard } from './session.guard';

@Module({
  providers: [SessionService, SessionGuard],
  exports: [SessionService, SessionGuard],
  controllers: [SessionController]
})
export class SessionModule {}
