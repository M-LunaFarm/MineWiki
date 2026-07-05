import { forwardRef, Module } from '@nestjs/common';
import { ClaimController } from './claim.controller';
import { ClaimService } from './claim.service';
import { PluginClaimController } from './plugin-claim.controller';
import { ServerModule } from '../server/server.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [forwardRef(() => ServerModule), SessionModule],
  controllers: [ClaimController, PluginClaimController],
  providers: [ClaimService],
  exports: [ClaimService]
})
export class ClaimModule {}
