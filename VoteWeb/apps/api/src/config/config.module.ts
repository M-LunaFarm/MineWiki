import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@creepervote/config';

const configProvider = {
  provide: ConfigService,
  useFactory: () => new ConfigService()
};

@Global()
@Module({
  providers: [configProvider],
  exports: [ConfigService]
})
export class AppConfigModule {}
