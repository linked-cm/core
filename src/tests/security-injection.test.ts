/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {formatUri, assertSafeIri, assertSafeCallName} from '../sparql/sparqlUtils';

// Report 021 §2 — SPARQL-injection hardening regression tests.

describe('SEC1 — IRI validation in formatUri', () => {
  test('valid IRIs pass through unchanged', () => {
    expect(formatUri('http://example.org/Person')).toBe('<http://example.org/Person>');
    expect(formatUri('urn:isbn:12345')).toBe('<urn:isbn:12345>');
    expect(formatUri('linked://tmp/x')).toBe('<linked://tmp/x>');
  });

  test('IRI-breakout payloads are rejected', () => {
    // Classic breakout: close the IRIREF and inject an UPDATE.
    expect(() =>
      formatUri('http://x/a> } ; DROP ALL ; INSERT { <http://x/b> <http://x/p> 1 } WHERE {'),
    ).toThrow(/Invalid IRI/);
    // A space alone is enough to escape the IRIREF.
    expect(() => formatUri('http://x/a b')).toThrow(/Invalid IRI/);
    // Newline / control chars.
    expect(() => formatUri('http://x/a\n?s ?p ?o')).toThrow(/Invalid IRI/);
    // Backslash, braces, quotes, pipe, caret, backtick.
    for (const bad of ['http://x/a\\b', 'http://x/{a}', 'http://x/"a"', 'http://x/a|b', 'http://x/a^b', 'http://x/a`b']) {
      expect(() => formatUri(bad)).toThrow(/Invalid IRI/);
    }
  });

  test('assertSafeIri throws on non-string / breakout, passes clean IRIs', () => {
    expect(() => assertSafeIri('http://ok/1')).not.toThrow();
    expect(() => assertSafeIri('a>b' as string)).toThrow(/Invalid IRI/);
    expect(() => assertSafeIri(undefined as unknown as string)).toThrow(/Invalid IRI/);
  });
});

describe('SEC2 — function/aggregate name allowlist', () => {
  test('all SPARQL 1.1 builtins used by the DSL are accepted (case-insensitive)', () => {
    for (const fn of ['STRLEN', 'NOW', 'CONCAT', 'REGEX', 'COALESCE', 'IF', 'ABS', 'SHA256', 'ENCODE_FOR_URI', 'isIRI']) {
      expect(() => assertSafeCallName(fn)).not.toThrow();
    }
    for (const agg of ['count', 'sum', 'avg', 'min', 'max', 'COUNT']) {
      expect(() => assertSafeCallName(agg)).not.toThrow();
    }
  });

  test('an injected S-expr head (non-builtin) is rejected', () => {
    // The fromJSON decoder turns an unknown S-expr head into a "function name"
    // that would otherwise be emitted verbatim: `a() . } ; DELETE WHERE {...}(`.
    expect(() => assertSafeCallName('a() . } ; DELETE WHERE { ?s ?p ?o } #')).toThrow(/Unsupported SPARQL/);
    expect(() => assertSafeCallName('DROP')).toThrow(/Unsupported SPARQL/);
    expect(() => assertSafeCallName('')).toThrow(/Unsupported SPARQL/);
    expect(() => assertSafeCallName(undefined as unknown as string)).toThrow(/Unsupported SPARQL/);
  });
});
