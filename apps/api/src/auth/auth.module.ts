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
import { AccountDataExportController } from './account-data-export.controller';
import { AccountDataExportService } from './account-data-export.service';
import { WebAuthnController } from './webauthn.controller';
import {
  DEFAULT_WEBAUTHN_SERVER,
  WEBAUTHN_SERVER,
  WebAuthnService,
} from './webauthn.service';
import { WikiModule } from '../wiki/wiki.module';

@Module({
  imports: [SessionModule, FileModule, WikiModule],
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
    WebAuthnService,
    { provide: WEBAUTHN_SERVER, useValue: DEFAULT_WEBAUTHN_SERVER },
    AccountModerationService,
    AccountDataExportService
  ],
  controllers: [
    AuthController,
    MfaController,
    WebAuthnController,
    AccountConflictController,
    AccountDeletionController,
    AccountDeletionAdminController,
    AccountDeletionInternalController,
    AccountModerationController,
    AccountDataExportController
  ],
  exports: [AuthService, AccountSeparationService, OAuthFlowService, EmailService]
})
export class AuthModule {}
