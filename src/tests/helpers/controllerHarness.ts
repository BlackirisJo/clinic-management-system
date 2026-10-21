import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middlewares/auth.middleware';

/** استجابة وهمية تلتقط ما ي-returnه الـController. */
export type CapturedResponse = { status: number; body: any };

export const createMockRes = (): { res: Response; captured: CapturedResponse } => {
  const captured: CapturedResponse = { status: 200, body: undefined };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: any) {
      captured.body = payload;
      return res;
    },
    send(payload: any) {
      captured.body = payload;
      return res;
    },
    set() {
      return res;
    },
  };
  return { res: res as Response, captured };
};

export type MockUserOptions = {
  userId: number;
  roleName: string;
  permissions?: string[];
  clinicId?: number | null;
  clinicIds?: number[];
};

export const createMockReq = (options: {
  user?: MockUserOptions;
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): AuthenticatedRequest => {
  const user = options.user;
  return {
    params: options.params ?? {},
    query: options.query ?? {},
    body: options.body ?? {},
    user: user
      ? {
          userId: user.userId,
          roleId: 0,
          clinicId: user.clinicId ?? null,
          roleName: user.roleName,
          permissions: user.permissions ?? [],
          clinicIds: user.clinicIds ?? (user.clinicId ? [user.clinicId] : []),
        }
      : undefined,
  } as unknown as AuthenticatedRequest;
};
