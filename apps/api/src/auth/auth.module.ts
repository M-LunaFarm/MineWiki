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
import { DiscordMinecraftLinkRepository, GuildSettingsRepository } from '../verify/guild.repositories';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionAdminController } from './account-deletion-admin.controller';
import { AccountDeletionInternalController } from './account-deletion-internal.controller';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { AccountModerationController } from './account-moderation.controller';
import { AccountModerationService } from './account-moderation.service';

@Module({
  imports: [SessionModule, FileModule],
  providers: [
    AuthService,
    AccountConflictService,
    AccountSeparationService,
    OAuthFlowService,
    EmailService,
    DiscordMinecraftLinkRepository,
    GuildSettingsRepository,
    AccountDeletionService,
    MfaService,
    AccountModerationService
  ],
  controllers: [AuthController, MfaController, AccountConflictController, AccountDeletionController, AccountDeletionAdminController, AccountDeletionInternalController, AccountModerationController],
  exports: [AuthService, AccountSeparationService, OAuthFlowService, EmailService]
})
export class AuthModule {}
