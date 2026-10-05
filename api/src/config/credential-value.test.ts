import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  isEnvRef,
  validateEnvRefName,
  describeCredential,
  validateCredentialValue,
} from './credential-value.js';

describe('config/credential-value', () => {
  describe('isEnvRef()', () => {
    it('returns the captured name for a whole-string reference [unit]', () => {
      expect(isEnvRef('${GH_TOKEN}')).to.equal('GH_TOKEN');
    });

    it('returns null for a literal string [unit]', () => {
      expect(isEnvRef('ghp_abc123')).to.equal(null);
    });

    it('returns null for a mixed value, since a secret field is either-or, never a mix [unit]', () => {
      expect(isEnvRef('${HOME}/bin')).to.equal(null);
    });

    it('returns null for a lowercase name, matching config-manager interpolation rules [unit]', () => {
      expect(isEnvRef('${gh_token}')).to.equal(null);
    });
  });

  describe('validateEnvRefName()', () => {
    afterEach(() => {
      delete process.env['CRED_VALUE_TEST_VAR'];
    });

    it('rejects a badly-shaped name [unit]', () => {
      const error = validateEnvRefName('not valid');
      expect(error).to.include('not a valid environment variable name');
    });

    it('rejects a name not set in the API environment, naming it in the message [unit]', () => {
      delete process.env['CRED_VALUE_TEST_VAR'];
      const error = validateEnvRefName('CRED_VALUE_TEST_VAR');
      expect(error).to.include('CRED_VALUE_TEST_VAR');
      expect(error).to.include("isn't set in the API's environment");
    });

    it('accepts a name that is set [unit]', () => {
      process.env['CRED_VALUE_TEST_VAR'] = 'sentinel';
      expect(validateEnvRefName('CRED_VALUE_TEST_VAR')).to.equal(null);
    });
  });

  describe('describeCredential()', () => {
    it('reports unset for undefined [unit]', () => {
      expect(describeCredential(undefined)).to.deep.equal({ mode: 'unset' });
    });

    it('reports unset for an empty string [unit]', () => {
      expect(describeCredential('')).to.deep.equal({ mode: 'unset' });
    });

    it('reports env mode with the captured name for a reference, never the secret itself [unit]', () => {
      expect(describeCredential('${GH_TOKEN}')).to.deep.equal({ mode: 'env', name: 'GH_TOKEN' });
    });

    it('reports literal mode for a plain secret [unit]', () => {
      expect(describeCredential('ghp_abc123')).to.deep.equal({ mode: 'literal' });
    });
  });

  describe('validateCredentialValue()', () => {
    afterEach(() => {
      delete process.env['CRED_VALUE_TEST_VAR'];
    });

    it('allows unset [unit]', () => {
      expect(validateCredentialValue(undefined)).to.equal(null);
    });

    it('allows a literal value without checking the environment [unit]', () => {
      expect(validateCredentialValue('ghp_abc123')).to.equal(null);
    });

    it('allows a reference to a variable that is set [unit]', () => {
      process.env['CRED_VALUE_TEST_VAR'] = 'sentinel';
      expect(validateCredentialValue('${CRED_VALUE_TEST_VAR}')).to.equal(null);
    });

    it('rejects a reference to a variable that is not set [unit]', () => {
      delete process.env['CRED_VALUE_TEST_VAR'];
      const error = validateCredentialValue('${CRED_VALUE_TEST_VAR}');
      expect(error).to.include('CRED_VALUE_TEST_VAR');
    });
  });
});
