import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { SessionModule } from '../session/session.module';
import { WikiAdminController } from './wiki-admin.controller';
import { WikiAdminService } from './wiki-admin.service';
import { WikiController } from './wiki.controller';
import { WikiAclService } from './wiki-acl.service';
import { WikiEditService } from './wiki-edit.service';
import { WikiEditRequestController } from './wiki-edit-request.controller';
import { WikiEditRequestService } from './wiki-edit-request.service';
import { WikiDiscussionController } from './wiki-discussion.controller';
import { WikiDiscussionService } from './wiki-discussion.service';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiNotificationController } from './wiki-notification.controller';
import { WikiNotificationService } from './wiki-notification.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';
import { WikiWatchController } from './wiki-watch.controller';
import { WikiWatchService } from './wiki-watch.service';

@Module({
  imports: [SessionModule, EventsModule],
  controllers: [WikiController, WikiAdminController, WikiDiscussionController, WikiWatchController, WikiEditRequestController, WikiNotificationController],
  providers: [WikiProfileService, WikiAdminService, WikiAclService, WikiPermissionService, WikiLinkIndexService, WikiDiscussionService, WikiWatchService, WikiNotificationService, WikiReadService, WikiEditService, WikiEditRequestService],
  exports: [WikiProfileService, WikiAdminService, WikiAclService, WikiPermissionService, WikiLinkIndexService, WikiReadService, WikiEditService]
})
export class WikiModule {}
