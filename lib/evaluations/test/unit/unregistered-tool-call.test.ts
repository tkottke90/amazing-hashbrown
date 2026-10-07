import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { detectUnregisteredToolCalls } from '../../src/unregistered-tool-call.js';

const CATALOG = ['wiki_locate', 'wiki_orient', 'wiki_search', 'wiki_create_page'];

describe('detectUnregisteredToolCalls', () => {
  it('flags a name that is a registered tool plus a stray trailing character [unit]', () => {
    // The observed gpt-oss/Ollama failure: `wiki_search?` where `wiki_search` was meant.
    assert.deepEqual(detectUnregisteredToolCalls(['wiki_search?'], CATALOG), ['wiki_search?']);
  });

  it('returns nothing when every called tool is registered [unit]', () => {
    assert.deepEqual(detectUnregisteredToolCalls(['wiki_locate', 'wiki_search'], CATALOG), []);
  });

  it('returns nothing when no tool was called [unit]', () => {
    assert.deepEqual(detectUnregisteredToolCalls([], CATALOG), []);
  });

  it('reports only the bad name when valid and invalid calls are mixed [unit]', () => {
    assert.deepEqual(
      detectUnregisteredToolCalls(['wiki_locate', 'wiki_serach', 'wiki_search'], CATALOG),
      ['wiki_serach'],
    );
  });

  it('reports a repeated bad name once [unit]', () => {
    assert.deepEqual(detectUnregisteredToolCalls(['wiki_search?', 'wiki_search?'], CATALOG), [
      'wiki_search?',
    ]);
  });

  it('keeps the order in which distinct bad names were first called [unit]', () => {
    assert.deepEqual(detectUnregisteredToolCalls(['b_tool', 'a_tool', 'b_tool'], CATALOG), [
      'b_tool',
      'a_tool',
    ]);
  });

  it('is case-sensitive, because the provider matches names exactly [unit]', () => {
    assert.deepEqual(detectUnregisteredToolCalls(['Wiki_Search'], CATALOG), ['Wiki_Search']);
  });

  it('flags nothing when the catalog is empty, since the harness cannot tell [unit]', () => {
    assert.deepEqual(detectUnregisteredToolCalls(['wiki_search'], []), []);
  });
});
