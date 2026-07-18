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
import { ServerWikiCollaboratorController } from './server-wiki-collaborator.controller';
import { ServerWikiCollaboratorService } from './server-wiki-collaborator.service';
import { ServerWikiLayoutEntitlementAdminController } from './server-wiki-layout-entitlement-admin.controller';
import { ServerWikiLayoutEntitlementAdminService } from './server-wiki-layout-entitlement-admin.service';
import { ServerWikiLayoutEntitlementInternalController } from './server-wiki-layout-entitlement-internal.controller';
import { ServerWikiLayoutEntitlementLifecycleService } from './server-wiki-layout-entitlement-lifecycle.service';
import { ServerWikiPublicationController } from './server-wiki-publication.controller';
import { ServerWikiPublicationService } from './server-wiki-publication.service';

@Module({
  imports: [FileModule, forwardRef(() => ClaimModule), TelemetryModule, SessionModule, WikiModule, EventsModule, VerifyModule],
  providers: [ServerService, PluginCredentialService, ServerWikiCollaboratorService, ServerWikiLayoutEntitlementAdminService, ServerWikiLayoutEntitlementLifecycleService, ServerWikiPublicationService],
  controllers: [ServerController, ServerVerificationController, ServerWikiPresentationController, ServerWikiCollaboratorController, ServerWikiLayoutEntitlementAdminController, ServerWikiLayoutEntitlementInternalController, ServerWikiPublicationController],
  exports: [ServerService]
})
export class ServerModule {}
