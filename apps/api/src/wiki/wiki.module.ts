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
import { WikiModerationService } from './wiki-moderation.service';
import { WikiIncludeService } from './wiki-include.service';
import { WikiNotificationController } from './wiki-notification.controller';
import { WikiNotificationService } from './wiki-notification.service';
import { WikiPageAclController } from './wiki-page-acl.controller';
import { WikiPageAclService } from './wiki-page-acl.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';
import { WikiWatchController } from './wiki-watch.controller';
import { WikiWatchService } from './wiki-watch.service';
import { WikiRoutePathResolver } from './wiki-route-path.resolver';
import { WikiAclGroupAdminController, WikiAclGroupSelfController } from './wiki-acl-group.controller';
import { WikiAclGroupService } from './wiki-acl-group.service';
import { WikiThreadAclController } from './wiki-thread-acl.controller';
import { WikiThreadAclService } from './wiki-thread-acl.service';
import { WikiDiscussionLiveController } from './wiki-discussion-live.controller';
import { WikiDiscussionLiveService } from './wiki-discussion-live.service';

@Module({
  imports: [SessionModule, EventsModule],
  controllers: [WikiController, WikiAdminController, WikiDiscussionController, WikiDiscussionLiveController, WikiWatchController, WikiEditRequestController, WikiNotificationController, WikiPageAclController, WikiThreadAclController, WikiAclGroupAdminController, WikiAclGroupSelfController],
  providers: [WikiProfileService, WikiAdminService, WikiModerationService, WikiAclService, WikiAclGroupService, WikiPermissionService, WikiLinkIndexService, WikiIncludeService, WikiDiscussionService, WikiDiscussionLiveService, WikiWatchService, WikiNotificationService, WikiRoutePathResolver, WikiReadService, WikiEditService, WikiEditRequestService, WikiPageAclService, WikiThreadAclService],
  exports: [WikiProfileService, WikiAdminService, WikiAclService, WikiAclGroupService, WikiPermissionService, WikiLinkIndexService, WikiIncludeService, WikiReadService, WikiEditService]
})
export class WikiModule {}
