import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccountSeparationService } from './account-separation.service';
import { SessionModule } from '../session/session.module';
import { OAuthFlowService } from './oauth-flow.service';
import { EmailService } from './email.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [SessionModule, UploadModule],
  providers: [AuthService, AccountSeparationService, OAuthFlowService, EmailService],
  controllers: [AuthController],
  exports: [AuthService, AccountSeparationService, OAuthFlowService, EmailService]
})
export class AuthModule {}
