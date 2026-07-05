import { forwardRef, Module } from '@nestjs/common';
import { ServerService } from './server.service';
import { ServerController } from './server.controller';
import { ServerVerificationController } from './server-verification.controller';
import { UploadModule } from '../upload/upload.module';
import { ClaimModule } from '../claim/claim.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [UploadModule, forwardRef(() => ClaimModule), TelemetryModule, SessionModule],
  providers: [ServerService],
  controllers: [ServerController, ServerVerificationController],
  exports: [ServerService]
})
export class ServerModule {}
