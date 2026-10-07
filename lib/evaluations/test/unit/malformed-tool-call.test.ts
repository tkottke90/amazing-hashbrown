import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  detectArgumentsOnlyToolCall,
  detectMalformedToolCall,
  detectProseQuestion,
} from '../../src/malformed-tool-call.js';

describe('detectMalformedToolCall', () => {
  it('matches a <tool_call>...</tool_call> block wrapping a <function=NAME> tag [unit]', () => {
    const result = detectMalformedToolCall(
      '<tool_call><function=wiki_search>{"query": "coffee"}</function></tool_call>',
      [],
    );
    assert.equal(result?.parsedToolName, 'wiki_search');
  });

  it('matches a <tool_call>...</tool_call> block wrapping JSON with a name + arguments key [unit]', () => {
    const result = detectMalformedToolCall(
      '<tool_call>{"name": "wiki_locate", "arguments": {"context": "coffee"}}</tool_call>',
      [],
    );
    assert.equal(result?.parsedToolName, 'wiki_locate');
    assert.ok(result?.raw.includes('wiki_locate'));
  });

  it('matches JSON using a "parameters" key instead of "arguments" [unit]', () => {
    const result = detectMalformedToolCall(
      '<tool_call>{"name": "wiki_locate", "parameters": {"context": "coffee"}}</tool_call>',
      [],
    );
    assert.equal(result?.parsedToolName, 'wiki_locate');
  });

  it('matches an unterminated <tool_call> block with no closing tag [unit]', () => {
    const result = detectMalformedToolCall('<tool_call><function=wiki_locate>', []);
    assert.equal(result?.parsedToolName, 'wiki_locate');
  });

  it('matches a bare <function=NAME> tag with no <tool_call> wrapper [unit]', () => {
    const result = detectMalformedToolCall(
      '<function=search_skills><query></query></function>',
      [],
    );
    assert.equal(result?.parsedToolName, 'search_skills');
  });

  it('matches a <|tool_call|> block [unit]', () => {
    const result = detectMalformedToolCall(
      '<|tool_call|>{"name": "ask_user", "arguments": {"question": "which one?"}}',
      [],
    );
    assert.equal(result?.parsedToolName, 'ask_user');
  });

  it('matches a bare JSON object with name + arguments and no surrounding tag [unit]', () => {
    const result = detectMalformedToolCall('{"name": "upload_image", "arguments": {}}', []);
    assert.equal(result?.parsedToolName, 'upload_image');
  });

  it('matches a bare <TOOL_NAME>...</TOOL_NAME> tag only when the name is in the known catalog [unit]', () => {
    const result = detectMalformedToolCall('<search_skills><query></query></search_skills>', [
      'search_skills',
      'wiki_search',
    ]);
    assert.equal(result?.parsedToolName, 'search_skills');
    assert.ok(result?.raw.includes('search_skills'));
  });

  it('does not match a bare tag whose name is absent from the known catalog [unit]', () => {
    const result = detectMalformedToolCall('<not_a_real_tool>content</not_a_real_tool>', [
      'wiki_search',
    ]);
    assert.equal(result, null);
  });

  it('does not match a bare tag shape against an empty known-tool catalog [unit]', () => {
    const result = detectMalformedToolCall('<search_skills></search_skills>', []);
    assert.equal(result, null);
  });

  it('does not false-positive on prose that merely mentions XML or JSON [unit]', () => {
    const result = detectMalformedToolCall(
      'You can use XML tags like <tag>value</tag> or JSON objects like {"key": "value"} to format data.',
      ['wiki_search'],
    );
    assert.equal(result, null);
  });

  it('does not false-positive on ordinary declarative prose [unit]', () => {
    const result = detectMalformedToolCall(
      'The knowledge base has three domains: personal, work, and homelab.',
      ['wiki_search'],
    );
    assert.equal(result, null);
  });

  it('falls through to null on unbalanced/truncated JSON rather than throwing [unit]', () => {
    const result = detectMalformedToolCall('{"name": "wiki_search", "arguments": {', [
      'wiki_search',
    ]);
    assert.equal(result, null);
  });
});

describe('detectProseQuestion', () => {
  it('returns true when the content ends in a question mark [unit]', () => {
    assert.equal(detectProseQuestion('Which domain did you mean, personal or work?'), true);
  });

  it('returns true when the question mark is wrapped in trailing markdown emphasis [unit]', () => {
    assert.equal(detectProseQuestion('Did you mean personal or work?**'), true);
  });

  it('returns false for a declarative statement [unit]', () => {
    assert.equal(detectProseQuestion('I searched the personal domain for you.'), false);
  });

  it('returns false for text ending in other punctuation [unit]', () => {
    assert.equal(detectProseQuestion('That is done!'), false);
  });

  it('returns false for an empty string [unit]', () => {
    assert.equal(detectProseQuestion(''), false);
  });

  it('returns false for a whitespace-only string [unit]', () => {
    assert.equal(detectProseQuestion('   \n  '), false);
  });
});

describe('detectArgumentsOnlyToolCall', () => {
  it('matches a reply that is only a JSON arguments object, with no tool name [unit]', () => {
    // The shape gpt-oss on Ollama returned as plain content for wnav-012.
    const result = detectArgumentsOnlyToolCall('{"query":"violin","limit":5}');
    assert.equal(result?.parsedToolName, null);
    assert.equal(result?.raw, '{"query":"violin","limit":5}');
  });

  it('matches when the object is surrounded by whitespace or newlines [unit]', () => {
    assert.notEqual(detectArgumentsOnlyToolCall('\n  {"query": "violin"}\n'), null);
  });

  it('matches a pretty-printed multi-line object [unit]', () => {
    assert.notEqual(detectArgumentsOnlyToolCall('{\n  "query": "violin",\n  "limit": 5\n}'), null);
  });

  it('matches an object wrapped in a json code fence [unit]', () => {
    const result = detectArgumentsOnlyToolCall('```json\n{"query": "violin"}\n```');
    assert.equal(result?.raw, '{"query": "violin"}');
  });

  it('matches an object wrapped in a bare code fence [unit]', () => {
    assert.notEqual(detectArgumentsOnlyToolCall('```\n{"query": "violin"}\n```'), null);
  });

  it('matches nested objects, since tool arguments often contain them [unit]', () => {
    assert.notEqual(
      detectArgumentsOnlyToolCall('{"title": "Violin", "corpus": {"raw": "started learning"}}'),
      null,
    );
  });

  it('does not match prose around the object [unit]', () => {
    assert.equal(detectArgumentsOnlyToolCall('Let me search: {"query": "violin"}'), null);
    assert.equal(detectArgumentsOnlyToolCall('{"query": "violin"} — searching now.'), null);
  });

  it('does not match a JSON array [unit]', () => {
    assert.equal(detectArgumentsOnlyToolCall('[{"query": "violin"}]'), null);
  });

  it('does not match braces that are not valid JSON [unit]', () => {
    assert.equal(detectArgumentsOnlyToolCall('{not json at all}'), null);
  });

  it('does not match ordinary prose, an empty reply or a bare scalar [unit]', () => {
    assert.equal(detectArgumentsOnlyToolCall('I could not find anything about that.'), null);
    assert.equal(detectArgumentsOnlyToolCall(''), null);
    assert.equal(detectArgumentsOnlyToolCall('42'), null);
  });
});
