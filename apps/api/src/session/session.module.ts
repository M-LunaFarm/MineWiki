import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { SessionGuard } from './session.guard';
import { OptionalSessionGuard } from './optional-session.guard';
import { RoleModule } from '../roles/role.module';
import { StepUpGuard } from './step-up.guard';

@Module({
  imports: [RoleModule],
  providers: [SessionService, SessionGuard, OptionalSessionGuard, StepUpGuard],
  exports: [SessionService, SessionGuard, OptionalSessionGuard, StepUpGuard],
  controllers: [SessionController]
})
export class SessionModule {}
