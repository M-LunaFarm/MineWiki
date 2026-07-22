import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SessionModule } from '../session/session.module';
import { ServerModule } from '../server/server.module';

@Module({
  imports: [SessionModule, ServerModule],
  providers: [DashboardService],
  controllers: [DashboardController]
})
export class DashboardModule {}
