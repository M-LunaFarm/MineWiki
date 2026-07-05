import { Module } from '@nestjs/common';
import { PluginSyncController } from './plugin-sync.controller';
import { PluginSyncService } from './plugin-sync.service';

@Module({
  controllers: [PluginSyncController],
  providers: [PluginSyncService],
  exports: [PluginSyncService]
})
export class PluginSyncModule {}
