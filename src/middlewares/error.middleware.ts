import { ApiErrorCode } from '../utils/apiErrors';

export class AppError extends Error {
  statusCode: number;
  code: string;
  isOperational: boolean;
  errors?: unknown;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    isOperational = true,
    errors?: unknown,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.errors = errors;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const isAppError = (err: unknown): err is AppError => {
  return err instanceof AppError;
};
