import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';

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
