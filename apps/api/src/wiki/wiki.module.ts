import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { CaptchaModule } from '../captcha/captcha.module';
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
import { WikiPushSubscriptionController } from './wiki-push-subscription.controller';
import { WikiPushSubscriptionService } from './wiki-push-subscription.service';
import { WikiProfileMergeController } from './wiki-profile-merge.controller';
import { WikiProfileMergeAdminController } from './wiki-profile-merge-admin.controller';
import { WikiProfileMergeService } from './wiki-profile-merge.service';
import { WikiApiTokenController } from './wiki-api-token.controller';
import { WikiApiController } from './wiki-api.controller';
import { WikiApiTokenGuard } from './wiki-api-token.guard';
import { WikiApiTokenService } from './wiki-api-token.service';
import { WikiCaptchaService } from './wiki-captcha.service';
import { WikiContributionPolicyService } from './wiki-contribution-policy.service';
import { WikiReportController } from './wiki-report.controller';
import { WikiReportService } from './wiki-report.service';
import { WikiReportModerationController } from './wiki-report-moderation.controller';
import { WikiReportModerationService } from './wiki-report-moderation.service';
import { WikiPageSwapService } from './wiki-page-swap.service';
import { WikiUsernameService } from './wiki-username.service';
import { WikiSpecialCursorCodec } from './wiki-special-cursor';

@Module({
  imports: [SessionModule, EventsModule, CaptchaModule],
  controllers: [WikiController, WikiReportController, WikiApiTokenController, WikiApiController, WikiAdminController, WikiReportModerationController, WikiProfileMergeController, WikiProfileMergeAdminController, WikiDiscussionController, WikiDiscussionLiveController, WikiWatchController, WikiEditRequestController, WikiNotificationController, WikiPushSubscriptionController, WikiPageAclController, WikiThreadAclController, WikiAclGroupAdminController, WikiAclGroupSelfController],
  providers: [WikiProfileService, WikiProfileMergeService, WikiReportService, WikiReportModerationService, WikiApiTokenService, WikiApiTokenGuard, WikiCaptchaService, WikiContributionPolicyService, WikiAdminService, WikiModerationService, WikiAclService, WikiAclGroupService, WikiPermissionService, WikiLinkIndexService, WikiIncludeService, WikiDiscussionService, WikiDiscussionLiveService, WikiWatchService, WikiNotificationService, WikiPushSubscriptionService, WikiRoutePathResolver, WikiSpecialCursorCodec, WikiReadService, WikiEditService, WikiEditRequestService, WikiPageSwapService, WikiUsernameService, WikiPageAclService, WikiThreadAclService],
  exports: [WikiProfileService, WikiProfileMergeService, WikiAdminService, WikiAclService, WikiAclGroupService, WikiPermissionService, WikiLinkIndexService, WikiIncludeService, WikiNotificationService, WikiReadService, WikiEditService]
})
export class WikiModule {}
