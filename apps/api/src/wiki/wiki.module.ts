import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { SessionModule } from '../session/session.module';
import { WikiAdminController } from './wiki-admin.controller';
import { WikiAdminService } from './wiki-admin.service';
import { WikiController } from './wiki.controller';
import { WikiAclService } from './wiki-acl.service';
import { WikiEditService } from './wiki-edit.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';

@Module({
  imports: [SessionModule, EventsModule],
  controllers: [WikiController, WikiAdminController],
  providers: [WikiProfileService, WikiAdminService, WikiAclService, WikiPermissionService, WikiLinkIndexService, WikiReadService, WikiEditService],
  exports: [WikiProfileService, WikiAdminService, WikiAclService, WikiPermissionService, WikiLinkIndexService, WikiReadService, WikiEditService]
})
export class WikiModule {}
