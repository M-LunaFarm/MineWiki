import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [SessionModule],
  providers: [DashboardService],
  controllers: [DashboardController]
})
export class DashboardModule {}