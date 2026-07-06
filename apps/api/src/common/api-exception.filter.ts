import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

type RequestWithId = FastifyRequest & { requestId?: string };

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithId>();
    const reply = context.getResponse<FastifyReply>();
    const statusCode = statusFromException(exception);
    const response = responseFromException(exception);

    if (isPluginSyncPath(request.url) && isLegacyPluginError(response)) {
      reply.status(statusCode).send(response);
      return;
    }

    reply.status(statusCode).send({
      statusCode,
      code: codeFromException(exception, response),
      message: messageFromResponse(response, statusCode),
      details: detailsFromException(exception, response),
      requestId: request.requestId ?? request.id,
    });
  }
}

function statusFromException(exception: unknown): number {
  if (exception instanceof ZodError) {
    return HttpStatus.BAD_REQUEST;
  }
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function responseFromException(exception: unknown): unknown {
  if (exception instanceof ZodError) {
    return { message: 'Validation failed', details: exception.issues };
  }
  if (exception instanceof HttpException) {
    return exception.getResponse();
  }
  return undefined;
}

function codeFromException(exception: unknown, response: unknown): string {
  if (isObject(response) && typeof response.code === 'string') {
    return response.code;
  }
  if (isObject(response) && typeof response.error === 'string') {
    return normalizeCode(response.error);
  }
  if (exception instanceof ZodError || exception instanceof BadRequestException) {
    return 'bad_request';
  }
  if (exception instanceof UnauthorizedException) {
    return 'unauthorized';
  }
  if (exception instanceof ForbiddenException) {
    return 'forbidden';
  }
  if (exception instanceof NotFoundException) {
    return 'not_found';
  }
  if (exception instanceof ConflictException) {
    return 'conflict';
  }
  return 'internal_error';
}

function messageFromResponse(response: unknown, statusCode: number): string {
  if (typeof response === 'string') {
    return response;
  }
  if (isObject(response)) {
    if (typeof response.message === 'string') {
      return response.message;
    }
    if (Array.isArray(response.message)) {
      return response.message.join(', ');
    }
    if (typeof response.error === 'string') {
      return response.error;
    }
  }
  return statusCode >= 500 ? 'Internal server error' : 'Request failed';
}

function detailsFromException(exception: unknown, response: unknown): unknown {
  if (exception instanceof ZodError) {
    return exception.issues;
  }
  if (isObject(response)) {
    return response.details ?? response.errors ?? null;
  }
  return null;
}

function isLegacyPluginError(response: unknown): response is { error: string } {
  return isObject(response) && typeof response.error === 'string' && !('statusCode' in response);
}

function isPluginSyncPath(path: string): boolean {
  return path.includes('/plugin/sync');
}

function normalizeCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'error';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
