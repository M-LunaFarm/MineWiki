import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { WikiController } from './wiki.controller';
import { WikiEditService } from './wiki-edit.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';

@Module({
  imports: [SessionModule],
  controllers: [WikiController],
  providers: [WikiProfileService, WikiPermissionService, WikiReadService, WikiEditService],
  exports: [WikiProfileService, WikiPermissionService, WikiReadService, WikiEditService]
})
export class WikiModule {}
