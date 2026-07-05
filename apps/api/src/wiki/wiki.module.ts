import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { WikiController } from './wiki.controller';
import { WikiProfileService } from './wiki-profile.service';

@Module({
  imports: [SessionModule],
  controllers: [WikiController],
  providers: [WikiProfileService],
  exports: [WikiProfileService]
})
export class WikiModule {}
