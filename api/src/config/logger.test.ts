import { describe, it } from 'mocha';
import { expect } from 'chai';
import { serializeError } from './logger.js';

describe('config/logger', () => {
  describe('serializeError()', () => {
    it('pulls name/message/stack off a real Error into enumerable fields', () => {
      const err = new Error('boom');
      const result = serializeError(err);

      expect(result['name']).to.equal('Error');
      expect(result['message']).to.equal('boom');
      expect(result['stack']).to.be.a('string').and.include('boom');
      // The whole point: JSON.stringify(new Error(...)) alone yields "{}",
      // so the serialized form must actually round-trip through JSON.
      expect(JSON.parse(JSON.stringify(result))).to.deep.equal(result);
    });

    it('preserves a subclassed error name', () => {
      class CustomError extends Error {
        override name = 'CustomError';
      }
      const result = serializeError(new CustomError('bad things'));
      expect(result['name']).to.equal('CustomError');
      expect(result['message']).to.equal('bad things');
    });

    it('includes cause when present', () => {
      const result = serializeError(new Error('outer', { cause: 'root cause' }));
      expect(result['cause']).to.equal('root cause');
    });

    it('omits cause when not present', () => {
      const result = serializeError(new Error('plain'));
      expect(result).to.not.have.property('cause');
    });

    it('falls back to a value field for a non-Error throw', () => {
      expect(serializeError('a thrown string')).to.deep.equal({ value: 'a thrown string' });
      expect(serializeError({ code: 'ENOENT' })).to.deep.equal({ value: { code: 'ENOENT' } });
      expect(serializeError(undefined)).to.deep.equal({ value: undefined });
    });
  });
});
