import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      status: 'ok',
      service: 'minewiki-api',
      uptime: process.uptime(),
      checkedAt: new Date().toISOString()
    };
  }
}
