import { Module } from '@nestjs/common';
import { AccountConflictController } from './account-conflict.controller';
import { AccountConflictService } from './account-conflict.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountSeparationService } from './account-separation.service';
import { SessionModule } from '../session/session.module';
import { OAuthFlowService } from './oauth-flow.service';
import { EmailService } from './email.service';
import { FileModule } from '../file/file.module';
import { DiscordMinecraftLinkRepository } from '../verify/guild.repositories';

@Module({
  imports: [SessionModule, FileModule],
  providers: [
    AuthService,
    AccountConflictService,
    AccountSeparationService,
    OAuthFlowService,
    EmailService,
    DiscordMinecraftLinkRepository
  ],
  controllers: [AuthController, AccountConflictController],
  exports: [AuthService, AccountSeparationService, OAuthFlowService, EmailService]
})
export class AuthModule {}
