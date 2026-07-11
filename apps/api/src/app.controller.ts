import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }

  @Get('api/health')
  getApiHealth() {
    return this.appService.getHealth();
  }

  @Get('ready')
  async getReadiness() {
    return this.assertReady();
  }

  @Get('api/ready')
  async getApiReadiness() {
    return this.assertReady();
  }

  private async assertReady() {
    const report = await this.appService.getReadiness();
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException({
        code: 'service_not_ready',
        message: 'Service dependencies are not ready.',
        details: report,
      });
    }
    return report;
  }
}
