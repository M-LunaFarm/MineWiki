import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { UploadModule } from '../upload/upload.module';
import { FileController } from './file.controller';
import { FilePermissionService } from './file-permission.service';
import { FileService } from './file.service';

@Module({
  imports: [SessionModule, UploadModule],
  controllers: [FileController],
  providers: [FilePermissionService, FileService],
  exports: [FilePermissionService, FileService]
})
export class FileModule {}
