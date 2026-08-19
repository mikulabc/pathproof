import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { DomainResolutionError } from './domain-resolver.js';
import { TargetBlockedError } from './security.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function notFound(entity: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', `${entity} was not found.`);
}

export function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'The request was not valid.', details: error.flatten() },
    });
    return;
  }
  if (error instanceof DomainResolutionError) {
    response.status(400).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof TargetBlockedError) {
    response.status(400).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  console.error(error);
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
}
