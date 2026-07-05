import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { WikiController } from './wiki.controller';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReadService } from './wiki-read.service';

@Module({
  imports: [SessionModule],
  controllers: [WikiController],
  providers: [WikiProfileService, WikiReadService],
  exports: [WikiProfileService, WikiReadService]
})
export class WikiModule {}
