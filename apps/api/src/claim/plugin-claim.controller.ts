import { Controller, GoneException, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

@Controller('plugin/claim')
export class PluginClaimController {
  @Post('complete')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  complete(): never {
    throw new GoneException(
      'Plugin ownership verification is disabled until an authenticated plugin proof is configured.',
    );
  }
}
