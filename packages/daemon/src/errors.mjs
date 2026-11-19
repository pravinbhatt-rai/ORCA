const DEFINITIONS = Object.freeze({
  INVALID_REQUEST: { status: 400, message: 'The request is invalid.', suggestion: 'Review the request fields and try again.' },
  INVALID_JSON: { status: 400, message: 'Request body must be JSON.', suggestion: 'Send a valid JSON request body.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Request body exceeds 1 MB.', suggestion: 'Send a request body under 1 MB.' },
  AUTHENTICATION_REQUIRED: { status: 401, message: 'Authentication required.', suggestion: 'Reconnect to the local workspace.' },
  AUTHORIZATION_DENIED: { status: 403, message: 'The request is not authorized.', suggestion: 'Check the workspace session and permissions.' },
  NOT_FOUND: { status: 404, message: 'The requested resource was not found.', suggestion: 'Check the resource identifier and try again.' },
  CONFLICT: { status: 409, message: 'The request conflicts with current state.', suggestion: 'Refresh the current state and retry if appropriate.' },
  HOST_REJECTED: { status: 421, message: 'The request host was rejected.', suggestion: 'Use the local Orchestra address.' },
  PROVIDER_UNAVAILABLE: { status: 502, message: 'Provider connection failed.', suggestion: 'Check provider endpoint, credentials, and service availability.' },
  INTERNAL_ERROR: { status: 500, message: 'The local service could not complete this request.', suggestion: 'Retry the request; contact the workspace administrator if it persists.' },
});

export class OrchestraError extends Error {
  constructor(code, message, { status, suggestion, cause } = {}) {
    const definition = DEFINITIONS[code] || DEFINITIONS.INTERNAL_ERROR;
    super(message || definition.message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = DEFINITIONS[code] ? code : 'INTERNAL_ERROR';
    this.status = status ?? definition.status;
    this.suggestion = suggestion || definition.suggestion;
    this.publicMessage = message || definition.message;
  }
}

export class RequestValidationError extends OrchestraError {
  constructor(message = 'The request is invalid.', options = {}) { super('INVALID_REQUEST', message, options); }
}
export class InvalidJsonError extends OrchestraError {
  constructor() { super('INVALID_JSON'); }
}
export class PayloadTooLargeError extends OrchestraError {
  constructor() { super('PAYLOAD_TOO_LARGE'); }
}
export class AuthenticationError extends OrchestraError {
  constructor(message = 'Authentication required.') { super('AUTHENTICATION_REQUIRED', message); }
}
export class AuthorizationError extends OrchestraError {
  constructor(message = 'The request is not authorized.') { super('AUTHORIZATION_DENIED', message); }
}
export class NotFoundError extends OrchestraError {
  constructor(message = 'The requested resource was not found.') { super('NOT_FOUND', message); }
}
export class ConflictError extends OrchestraError {
  constructor(message = 'The request conflicts with current state.') { super('CONFLICT', message); }
}
export class ProviderUnavailableError extends OrchestraError {
  constructor(cause) { super('PROVIDER_UNAVAILABLE', undefined, { cause }); }
}

export function errorEnvelope(error, requestId, statusOverride) {
  const typed = error instanceof OrchestraError;
  const status = statusOverride ?? (typed ? error.status : Number.isInteger(error?.status) ? error.status : 500);
  const code = typed ? error.code : DEFINITIONS[error?.code] ? error.code : status === 401 ? 'AUTHENTICATION_REQUIRED' : status === 403 ? 'AUTHORIZATION_DENIED' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 421 ? 'HOST_REJECTED' : status === 400 ? 'INVALID_REQUEST' : status === 502 ? 'PROVIDER_UNAVAILABLE' : 'INTERNAL_ERROR';
  const definition = DEFINITIONS[code] || DEFINITIONS.INTERNAL_ERROR;
  const message = status >= 500 ? definition.message : typed ? error.publicMessage : typeof error?.message === 'string' ? error.message : definition.message;
  const suggestion = typed ? error.suggestion : typeof error?.suggestion === 'string' ? error.suggestion : definition.suggestion;
  return { status, payload: { error: { code, message, requestId, suggestion } } };
}

export function publicError(error) {
  const { payload } = errorEnvelope(error, null);
  return { code: payload.error.code, message: payload.error.message, suggestion: payload.error.suggestion };
}
