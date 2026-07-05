import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { SessionGuard } from './session.guard';
import { OptionalSessionGuard } from './optional-session.guard';

@Module({
  providers: [SessionService, SessionGuard, OptionalSessionGuard],
  exports: [SessionService, SessionGuard, OptionalSessionGuard],
  controllers: [SessionController]
})
export class SessionModule {}
