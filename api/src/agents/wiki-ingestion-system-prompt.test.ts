import { describe, it } from 'mocha';
import { expect } from 'chai';
import { buildWikiIngestionSystemPrompt } from './wiki-ingestion-system-prompt.js';

describe('agents/wiki-ingestion-system-prompt', () => {
  describe('buildWikiIngestionSystemPrompt()', () => {
    it('wraps each section in a well-formed, distinctly-tagged XML element', () => {
      const result = buildWikiIngestionSystemPrompt();
      for (const tag of [
        'purpose',
        'orientation_protocol',
        'page_strategy',
        'domain_management',
        'ask_user_routing',
      ]) {
        expect(result).to.include(`<${tag}>`);
        expect(result).to.include(`</${tag}>`);
      }
    });

    it('tells the model to create directly when the user already supplies a wikiId and description', () => {
      const result = buildWikiIngestionSystemPrompt();
      expect(result).to.include('call wiki_create_domain now');
      expect(result).to.include('Routing notes are optional');
    });

    it('tells the model wiki_register_domain takes no description and needs no verification first', () => {
      const result = buildWikiIngestionSystemPrompt();
      expect(result).to.include('never a description');
      expect(result).to.include(
        "don't verify the directory first (with shell_exec, wiki_lint, or otherwise)",
      );
      expect(result).to.include('sufficient grounds to call');
      expect(result).to.include('wiki_register_domain directly.');
    });
  });
});
