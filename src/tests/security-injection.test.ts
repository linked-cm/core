/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {formatUri, assertSafeIri, assertSafeCallName, sanitizeVarName} from '../sparql/sparqlUtils';
import '../utils/Package';
import {NodeShape} from '../shapes/SHACL';
import {decodeValueExpr} from '../queries/DslJsonExpression';
import {decodeNodeDataToRaw} from '../queries/MutationSerialization';

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

describe('SEC3 — variable-name sanitization', () => {
  test('valid names unchanged; breakout chars neutralized', () => {
    expect(sanitizeVarName('friends_0')).toBe('friends_0');
    expect(sanitizeVarName('name')).toBe('name');
    // A crafted alias cannot escape the ?var position: no special chars survive.
    const cleaned = sanitizeVarName('x} ?s ?p ?o {');
    expect(cleaned.startsWith('x')).toBe(true);
    expect(/[^A-Za-z0-9_]/.test(cleaned)).toBe(false);
    expect(/[^A-Za-z0-9_]/.test(sanitizeVarName('a b.c-d:e'))).toBe(false);
  });
});

describe('SEC5 — decode recursion depth cap', () => {
  test('a pathologically nested S-expr is rejected, not a stack overflow', () => {
    // Build ["not", ["not", ... true ...]] far deeper than the 128 cap.
    let expr: unknown = true;
    for (let i = 0; i < 500; i++) expr = ['not', expr];
    expect(() => decodeValueExpr(expr as never, NodeShape.shape as never)).toThrow(/nested too deeply/);
  });
});

describe('SEC7 — prototype-pollution hygiene in mutation decode', () => {
  test('__proto__ / constructor keys are skipped, prototype not polluted', () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "name": "ok"}');
    const out = decodeNodeDataToRaw(payload, NodeShape.shape);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, 'polluted')).toBe(false);
  });
});
