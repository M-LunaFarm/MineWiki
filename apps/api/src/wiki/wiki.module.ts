import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { WikiController } from './wiki.controller';
import { WikiAclService } from './wiki-acl.service';
import { WikiEditService } from './wiki-edit.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';

@Module({
  imports: [SessionModule],
  controllers: [WikiController],
  providers: [WikiProfileService, WikiAclService, WikiPermissionService, WikiReadService, WikiEditService],
  exports: [WikiProfileService, WikiAclService, WikiPermissionService, WikiReadService, WikiEditService]
})
export class WikiModule {}
