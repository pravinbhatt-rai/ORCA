import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticationError, ConflictError, InvalidJsonError, NotFoundError, OrchestraError, PayloadTooLargeError, ProviderUnavailableError, RequestValidationError, errorEnvelope, publicError } from '../src/errors.mjs';

test('typed request errors have stable status, code, request ID, and remediation', () => {
  const fixtures = [
    [new RequestValidationError('Invalid field.'), 400, 'INVALID_REQUEST'],
    [new InvalidJsonError(), 400, 'INVALID_JSON'],
    [new PayloadTooLargeError(), 413, 'PAYLOAD_TOO_LARGE'],
    [new AuthenticationError(), 401, 'AUTHENTICATION_REQUIRED'],
    [new NotFoundError(), 404, 'NOT_FOUND'],
    [new ConflictError(), 409, 'CONFLICT'],
    [new ProviderUnavailableError(new Error('private endpoint')), 502, 'PROVIDER_UNAVAILABLE'],
  ];
  for (const [error, status, code] of fixtures) {
    const envelope = errorEnvelope(error, 'req-fixture');
    assert.equal(envelope.status, status);
    assert.equal(envelope.payload.error.code, code);
    assert.equal(envelope.payload.error.requestId, 'req-fixture');
    assert.ok(envelope.payload.error.suggestion);
  }
});

test('internal error and cause details never escape public errors', () => {
  const error = new OrchestraError('INTERNAL_ERROR', 'private path /Users/alice/secret; token sk-1234567890abcdefghijk', { cause: new Error('socket detail') });
  const envelope = errorEnvelope(error, 'req-internal');
  assert.equal(envelope.status, 500);
  assert.equal(envelope.payload.error.message, 'The local service could not complete this request.');
  assert.doesNotMatch(JSON.stringify(publicError(new Error('socket path /private/data'))), /socket path|private\/data/);
  assert.equal(publicError(new Error('socket path /private/data')).code, 'INTERNAL_ERROR');
});
