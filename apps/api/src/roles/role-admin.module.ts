import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { RoleAdminController } from './role-admin.controller';
import { RoleModule } from './role.module';

@Module({
  imports: [RoleModule, SessionModule],
  controllers: [RoleAdminController],
})
export class RoleAdminModule {}
