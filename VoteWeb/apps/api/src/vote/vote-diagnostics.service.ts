import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Socket } from 'node:net';
import { z } from 'zod';
import {
  UnsafeEndpointError,
  validateOutboundTarget,
  type AddressFamily,
  type ResolvedAddress
} from '@creepervote/security';
import { ServerService } from '../server/server.service';

const diagnosticsRequestSchema = z.object({
  host: z.string().min(3).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  protocol: z.enum(['v1', 'v2']).default('v2'),
  timeoutMs: z.coerce.number().int().min(500).max(10000).optional()
});

type DiagnosticsRequest = z.infer<typeof diagnosticsRequestSchema>;

export interface DiagnosticsResult {
  readonly serverId: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: DiagnosticsRequest['protocol'];
  readonly reachable: boolean;
  readonly latencyMs: number | null;
  readonly addressTested: string | null;
  readonly testedAt: string;
  readonly resolvedAddresses: readonly string[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly note?: string;
}

@Injectable()
export class VoteDiagnosticsService {
  private readonly logger = new Logger(VoteDiagnosticsService.name);

  constructor(private readonly serverService: ServerService) {}

  async runDiagnostics(serverId: string, payload: unknown): Promise<DiagnosticsResult> {
    await this.serverService.ensureExists(serverId);

    const request = diagnosticsRequestSchema.parse(payload);
    const testedAt = new Date().toISOString();
    let normalizedHost = request.host;
    let normalizedPort = request.port;

    let resolvedAddresses: readonly ResolvedAddress[] = [];
    try {
      const target = await validateOutboundTarget(request.host, request.port, {
        label: 'Votifier diagnostics'
      });
      normalizedHost = target.host;
      normalizedPort = target.port;
      resolvedAddresses = target.addresses;
    } catch (error) {
      if (error instanceof UnsafeEndpointError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    try {
      const attempt = await attemptConnection(
        resolvedAddresses,
        normalizedPort,
        request.timeoutMs ?? 3000
      );
      this.logger.log(
        {
          serverId,
          host: normalizedHost,
          port: normalizedPort,
          protocol: request.protocol,
          latencyMs: attempt.roundTripMs,
          address: attempt.address
        },
        'Votifier diagnostics succeeded'
      );

      return {
        serverId,
        host: normalizedHost,
        port: normalizedPort,
        protocol: request.protocol,
        reachable: true,
        latencyMs: attempt.roundTripMs,
        addressTested: attempt.address,
        testedAt,
        resolvedAddresses: resolvedAddresses.map((entry) => entry.address),
        note: 'TCP connection established; protocol handshake not performed in diagnostics mode.'
      };
    } catch (error) {
      const diagnosticError = error instanceof Error ? error : new Error(String(error));
      const errorCode =
        diagnosticError && typeof diagnosticError === 'object' && 'code' in diagnosticError
          ? String(
              (diagnosticError as { code?: string | number | symbol }).code ?? 'UNKNOWN'
            )
          : 'UNKNOWN';

      this.logger.warn(
        {
          serverId,
          host: normalizedHost,
          port: normalizedPort,
          protocol: request.protocol,
          error: diagnosticError.message,
          errorCode
        },
        'Votifier diagnostics failed'
      );

      return {
        serverId,
        host: normalizedHost,
        port: normalizedPort,
        protocol: request.protocol,
        reachable: false,
        latencyMs: null,
        addressTested: null,
        testedAt,
        resolvedAddresses: resolvedAddresses.map((entry) => entry.address),
        errorCode,
        errorMessage: diagnosticError.message
      };
    }
  }
}

interface ConnectionAttemptResult {
  readonly address: string;
  readonly family: AddressFamily;
  readonly roundTripMs: number;
}

async function attemptConnection(
  addresses: readonly ResolvedAddress[],
  port: number,
  timeoutMs: number
): Promise<ConnectionAttemptResult> {
  let lastError: unknown;
  for (const address of addresses) {
    try {
      return await attemptSingleAddress(address, port, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Connection attempt failed for all resolved addresses');
}

function attemptSingleAddress(
  address: ResolvedAddress,
  port: number,
  timeoutMs: number
): Promise<ConnectionAttemptResult> {
  return new Promise<ConnectionAttemptResult>((resolve, reject) => {
    const socket = new Socket();
    const started = Date.now();

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.once('connect', () => {
      const roundTripMs = Date.now() - started;
      cleanup();
      resolve({
        address: address.address,
        family: address.family,
        roundTripMs
      });
    });

    socket.once('error', (error) => {
      cleanup();
      reject(error);
    });

    socket.once('timeout', () => {
      cleanup();
      reject(new Error('Connection timed out'));
    });

    socket.setTimeout(timeoutMs);
    socket.connect({
      host: address.address,
      port,
      family: address.family
    });
  });
}
