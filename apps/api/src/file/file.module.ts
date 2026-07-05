import { Module } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { UploadModule } from '../upload/upload.module';
import { FileController } from './file.controller';
import { FileService } from './file.service';

@Module({
  imports: [SessionModule, UploadModule],
  controllers: [FileController],
  providers: [FileService],
  exports: [FileService]
})
export class FileModule {}
