import { forwardRef, Module } from '@nestjs/common';
import { ServerService } from './server.service';
import { ServerController } from './server.controller';
import { ServerVerificationController } from './server-verification.controller';
import { ClaimModule } from '../claim/claim.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { SessionModule } from '../session/session.module';
import { WikiModule } from '../wiki/wiki.module';
import { FileModule } from '../file/file.module';
import { EventsModule } from '../events/events.module';
import { PluginCredentialService } from './plugin-credential.service';
import { VerifyModule } from '../verify/verify.module';
import { ServerWikiPresentationController } from './server-wiki-presentation.controller';
import { MyServerWikiCollaboratorInvitationController, ServerWikiCollaboratorController } from './server-wiki-collaborator.controller';
import { ServerWikiCollaboratorService } from './server-wiki-collaborator.service';
import { ServerWikiLayoutEntitlementAdminController } from './server-wiki-layout-entitlement-admin.controller';
import { ServerWikiLayoutEntitlementAdminService } from './server-wiki-layout-entitlement-admin.service';
import { ServerWikiLayoutEntitlementInternalController } from './server-wiki-layout-entitlement-internal.controller';
import { ServerWikiLayoutEntitlementLifecycleService } from './server-wiki-layout-entitlement-lifecycle.service';
import { ServerWikiPublicationController } from './server-wiki-publication.controller';
import { ServerWikiPublicationService } from './server-wiki-publication.service';
import { ServerWikiTemplateController } from './server-wiki-template.controller';
import { ServerWikiTemplateService } from './server-wiki-template.service';
import { ServerWikiReleaseReviewQueueController } from './server-wiki-release-review-queue.controller';
import { ServerWikiReleaseReviewQueueService } from './server-wiki-release-review-queue.service';
import { ServerWikiReleaseManifestCursorCodec } from './server-wiki-release-manifest-cursor';
import { ServerWikiDomainController, ServerWikiDomainRouteController } from './server-wiki-domain.controller';
import { ServerWikiDomainService } from './server-wiki-domain.service';
import { ServerWikiDomainProvisioningController } from './server-wiki-domain-provisioning.controller';
import { CaptchaModule } from '../captcha/captcha.module';
import { ServerWikiProvisioningInternalController } from './server-wiki-provisioning-internal.controller';
import { AuthModule } from '../auth/auth.module';
import { MyServerOwnershipTransferController, ServerOwnershipTransferController } from './server-ownership-transfer.controller';
import { ServerOwnershipTransferService } from './server-ownership-transfer.service';

@Module({
  imports: [AuthModule, CaptchaModule, FileModule, forwardRef(() => ClaimModule), TelemetryModule, SessionModule, WikiModule, EventsModule, VerifyModule],
  providers: [ServerService, PluginCredentialService, ServerWikiCollaboratorService, ServerOwnershipTransferService, ServerWikiLayoutEntitlementAdminService, ServerWikiLayoutEntitlementLifecycleService, ServerWikiPublicationService, ServerWikiReleaseManifestCursorCodec, ServerWikiReleaseReviewQueueService, ServerWikiTemplateService, ServerWikiDomainService],
  controllers: [ServerController, ServerVerificationController, ServerWikiPresentationController, ServerWikiCollaboratorController, MyServerWikiCollaboratorInvitationController, ServerOwnershipTransferController, MyServerOwnershipTransferController, ServerWikiLayoutEntitlementAdminController, ServerWikiLayoutEntitlementInternalController, ServerWikiProvisioningInternalController, ServerWikiPublicationController, ServerWikiReleaseReviewQueueController, ServerWikiTemplateController, ServerWikiDomainController, ServerWikiDomainRouteController, ServerWikiDomainProvisioningController],
  exports: [ServerService]
})
export class ServerModule {}
