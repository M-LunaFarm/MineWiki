import { Module } from '@nestjs/common';
import { CaptchaModule } from '../captcha/captcha.module';
import { SessionModule } from '../session/session.module';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [SessionModule, CaptchaModule],
  providers: [SupportService],
  controllers: [SupportController],
})
export class SupportModule {}
