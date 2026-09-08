import { describe, it } from 'mocha';
import { expect } from 'chai';
import { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError } from 'openai';
import { classifyChatError } from './error-classification.js';

// Ollama's ResponseError class (dist/*.cjs's `class ResponseError extends
// Error { constructor(error, status_code) { ... this.error = error;
// this.status_code = status_code; this.name = 'ResponseError'; } }`) is not
// exported from the package's public entry point, so it can't be imported
// here — this reproduces its exact shape instead (message, status_code,
// name) for fidelity with what @langchain/ollama actually throws.
function ollamaResponseError(message: string, statusCode?: number): Error {
  const err = new Error(message);
  err.name = 'ResponseError';
  return Object.assign(err, { status_code: statusCode });
}

describe('agents/error-classification', () => {
  describe('classifyChatError — anthropic', () => {
    it('classifies a 401 authentication_error as auth', () => {
      const err = new AnthropicAPIError(
        401,
        { type: 'authentication_error' },
        'invalid x-api-key',
        new Headers(),
        'authentication_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('auth');
    });

    it('classifies a 403 permission_error as auth', () => {
      const err = new AnthropicAPIError(
        403,
        { type: 'permission_error' },
        'not permitted',
        new Headers(),
        'permission_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('auth');
    });

    it('classifies a billing_error as billing', () => {
      const err = new AnthropicAPIError(
        400,
        { type: 'billing_error' },
        'your credit balance is too low',
        new Headers(),
        'billing_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('billing');
    });

    it('classifies a rate_limit_error as rate_limit', () => {
      const err = new AnthropicAPIError(
        429,
        { type: 'rate_limit_error' },
        'rate limited',
        new Headers(),
        'rate_limit_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('rate_limit');
    });

    it('classifies an overloaded_error as unavailable', () => {
      const err = new AnthropicAPIError(
        529,
        { type: 'overloaded_error' },
        'overloaded',
        new Headers(),
        'overloaded_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('unavailable');
    });

    it('classifies a timeout_error as unavailable', () => {
      const err = new AnthropicAPIError(
        504,
        { type: 'timeout_error' },
        'gateway timeout',
        new Headers(),
        'timeout_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('unavailable');
    });

    it('classifies a not_found_error as unavailable', () => {
      const err = new AnthropicAPIError(
        404,
        { type: 'not_found_error' },
        'model not found',
        new Headers(),
        'not_found_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('unavailable');
    });

    it('classifies an invalid_request_error mentioning context length as context_length', () => {
      // AnthropicAPIError's message is built from `error.message` (the
      // response body), not the constructor's separate `message` param —
      // see @anthropic-ai/sdk's APIError.makeMessage.
      const err = new AnthropicAPIError(
        400,
        {
          type: 'invalid_request_error',
          message: 'prompt is too long: 250000 tokens > 200000 maximum',
        },
        undefined,
        new Headers(),
        'invalid_request_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('context_length');
    });

    it('classifies an invalid_request_error mentioning a content policy rejection as content_policy', () => {
      const err = new AnthropicAPIError(
        400,
        { type: 'invalid_request_error', message: 'Output blocked by content policy' },
        undefined,
        new Headers(),
        'invalid_request_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('content_policy');
    });

    it('classifies a generic invalid_request_error as unknown', () => {
      const err = new AnthropicAPIError(
        400,
        { type: 'invalid_request_error' },
        'messages: at least one message is required',
        new Headers(),
        'invalid_request_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('unknown');
    });

    it('classifies a 500 api_error as unavailable', () => {
      const err = new AnthropicAPIError(
        500,
        { type: 'api_error' },
        'internal server error',
        new Headers(),
        'api_error',
      );
      expect(classifyChatError(err, 'anthropic').category).to.equal('unavailable');
    });
  });

  describe('classifyChatError — openai', () => {
    it('classifies a 401 as auth', () => {
      const err = new OpenAIAPIError(
        401,
        { code: 'invalid_api_key' },
        'Incorrect API key',
        new Headers(),
      );
      expect(classifyChatError(err, 'openai').category).to.equal('auth');
    });

    it('classifies a 403 as auth', () => {
      const err = new OpenAIAPIError(403, {}, 'forbidden', new Headers());
      expect(classifyChatError(err, 'openai').category).to.equal('auth');
    });

    it('classifies a 429 with code insufficient_quota as billing', () => {
      const err = new OpenAIAPIError(
        429,
        { code: 'insufficient_quota' },
        'You exceeded your current quota',
        new Headers(),
      );
      expect(classifyChatError(err, 'openai').category).to.equal('billing');
    });

    it('classifies a 429 without insufficient_quota as rate_limit', () => {
      const err = new OpenAIAPIError(
        429,
        { code: 'rate_limit_exceeded' },
        'Rate limit reached',
        new Headers(),
      );
      expect(classifyChatError(err, 'openai').category).to.equal('rate_limit');
    });

    it('classifies a 400 with code context_length_exceeded as context_length', () => {
      const err = new OpenAIAPIError(
        400,
        { code: 'context_length_exceeded' },
        "This model's maximum context length is 8192 tokens",
        new Headers(),
      );
      expect(classifyChatError(err, 'openai').category).to.equal('context_length');
    });

    it('classifies a 400 with code content_policy_violation as content_policy', () => {
      const err = new OpenAIAPIError(
        400,
        { code: 'content_policy_violation' },
        'Your request was rejected by the safety system',
        new Headers(),
      );
      expect(classifyChatError(err, 'openai').category).to.equal('content_policy');
    });

    it('classifies a 404 as unavailable', () => {
      const err = new OpenAIAPIError(404, {}, 'model not found', new Headers());
      expect(classifyChatError(err, 'openai').category).to.equal('unavailable');
    });

    it('classifies a 500 as unavailable', () => {
      const err = new OpenAIAPIError(500, {}, 'internal error', new Headers());
      expect(classifyChatError(err, 'openai').category).to.equal('unavailable');
    });

    it('classifies a 400 with an unrecognized code as unknown', () => {
      const err = new OpenAIAPIError(400, { code: 'invalid_value' }, 'bad param', new Headers());
      expect(classifyChatError(err, 'openai').category).to.equal('unknown');
    });
  });

  describe('classifyChatError — ollama', () => {
    it('classifies a 404 ResponseError as unavailable', () => {
      const err = ollamaResponseError("model 'llama9' not found, try pulling it first", 404);
      expect(classifyChatError(err, 'ollama').category).to.equal('unavailable');
    });

    it('classifies a "model not found" message without a 404 status as unavailable', () => {
      const err = ollamaResponseError("model 'llama9' not found, try pulling it first");
      expect(classifyChatError(err, 'ollama').category).to.equal('unavailable');
    });

    it('classifies an unrecognized Ollama error as unknown', () => {
      const err = ollamaResponseError('something else went wrong', 500);
      expect(classifyChatError(err, 'ollama').category).to.equal('unknown');
    });
  });

  describe('classifyChatError — shared network check (runs before any provider matcher)', () => {
    it('classifies an Anthropic APIConnectionError as network', () => {
      const err = new AnthropicAPIError(undefined, undefined, 'Connection error.', undefined);
      err.name = 'APIConnectionError';
      expect(classifyChatError(err, 'anthropic').category).to.equal('network');
    });

    it('classifies an OpenAI APIConnectionError as network', () => {
      const err = new OpenAIAPIError(undefined, undefined, 'Connection error.', undefined);
      err.name = 'APIConnectionError';
      expect(classifyChatError(err, 'openai').category).to.equal('network');
    });

    it('classifies a Node ECONNREFUSED error as network for any provider (Ollama server not running)', () => {
      const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        cause: { code: 'ECONNREFUSED' },
      });
      expect(classifyChatError(err, 'ollama').category).to.equal('network');
    });

    it('classifies a "fetch failed" TypeError as network', () => {
      const err = new TypeError('fetch failed');
      expect(classifyChatError(err, 'openai').category).to.equal('network');
    });
  });

  describe('classifyChatError — fallback behavior', () => {
    it('resolves to unknown for an unrecognized error shape', () => {
      const result = classifyChatError(new Error('something odd'), 'anthropic');
      expect(result.category).to.equal('unknown');
      expect(result.message).to.equal('something odd');
    });

    it('resolves to unknown for a missing/unrecognized provider', () => {
      const result = classifyChatError(new Error('boom'), undefined);
      expect(result.category).to.equal('unknown');
    });

    it('never throws for a non-Error thrown value, and stringifies it as the message', () => {
      const result = classifyChatError('a plain string was thrown', 'anthropic');
      expect(result.category).to.equal('unknown');
      expect(result.message).to.equal('a plain string was thrown');
    });
  });
});
