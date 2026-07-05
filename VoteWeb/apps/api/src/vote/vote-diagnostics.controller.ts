import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { VoteDiagnosticsService, type DiagnosticsResult } from './vote-diagnostics.service';

@Controller('v1/servers/:serverId/votifier')
export class VoteDiagnosticsController {
  constructor(private readonly diagnostics: VoteDiagnosticsService) {}

  @Post('test')
  runDiagnostics(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown
  ): Promise<DiagnosticsResult> {
    return this.diagnostics.runDiagnostics(serverId, body);
  }
}
