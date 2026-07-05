import { Injectable } from '@nestjs/common';
import {
  trackEvent,
  type AnalyticsEventName,
  type AnalyticsEventPayloadMap
} from '@minewiki/analytics';

@Injectable()
export class BusinessEventService {
  async track<Name extends AnalyticsEventName>(
    name: Name,
    payload: AnalyticsEventPayloadMap[Name]
  ): Promise<void> {
    await trackEvent(name, payload);
  }
}
