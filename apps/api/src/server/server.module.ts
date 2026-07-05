import { forwardRef, Module } from '@nestjs/common';
import { ServerService } from './server.service';
import { ServerController } from './server.controller';
import { ServerVerificationController } from './server-verification.controller';
import { ClaimModule } from '../claim/claim.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { SessionModule } from '../session/session.module';
import { WikiModule } from '../wiki/wiki.module';
import { FileModule } from '../file/file.module';

@Module({
  imports: [FileModule, forwardRef(() => ClaimModule), TelemetryModule, SessionModule, WikiModule],
  providers: [ServerService],
  controllers: [ServerController, ServerVerificationController],
  exports: [ServerService]
})
export class ServerModule {}
