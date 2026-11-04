import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { toDomainError } from './db-errors';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

/** One error shape for every failure: { statusCode, code, message, details }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId = req.header('x-request-id') ?? undefined;
    let body: ErrorBody;

    const domain = toDomainError(exception);
    if (domain) {
      body = { statusCode: domain.status, code: domain.code, message: domain.message, details: domain.details };
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const resp = exception.getResponse();
      const r = typeof resp === 'string' ? { message: resp } : (resp as Record<string, unknown>);
      body = {
        statusCode: status,
        code: (r.code as string) ?? HttpStatus[status] ?? 'ERROR',
        message: Array.isArray(r.message) ? r.message.join('; ') : String(r.message ?? exception.message),
        details: r.details,
      };
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
      body = { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Unexpected server error' };
    }

    res.status(body.statusCode).json({ ...body, requestId });
  }
}
