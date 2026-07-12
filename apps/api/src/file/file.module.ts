import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { SessionModule } from '../session/session.module';
import { UploadModule } from '../upload/upload.module';
import { WikiModule } from '../wiki/wiki.module';
import { FileController } from './file.controller';
import { FilePermissionService } from './file-permission.service';
import { FileService } from './file.service';

@Module({
  imports: [SessionModule, UploadModule, EventsModule, WikiModule],
  controllers: [FileController],
  providers: [FilePermissionService, FileService],
  exports: [FilePermissionService, FileService]
})
export class FileModule {}
