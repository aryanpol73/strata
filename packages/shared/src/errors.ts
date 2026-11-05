export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'SESSION_REVOKED',
  'BRANCH_NOT_OPEN',
  'BRANCH_ALREADY_MERGED',
  'BRANCH_DEPTH_EXCEEDED',
  'GUEST_LINK_INVALID',
  'GUEST_PIN_REQUIRED',
  'GUEST_PIN_LOCKED',
  'VERSION_CONFLICT',
  'BLOCK_UPDATE_REJECTED',
  'MEDIA_REJECTED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}
