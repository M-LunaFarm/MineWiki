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

@Module({
  imports: [FileModule, forwardRef(() => ClaimModule), TelemetryModule, SessionModule, WikiModule, EventsModule, VerifyModule],
  providers: [ServerService, PluginCredentialService],
  controllers: [ServerController, ServerVerificationController, ServerWikiPresentationController],
  exports: [ServerService]
})
export class ServerModule {}
