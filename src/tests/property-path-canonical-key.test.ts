import {canonicalPathKey, pathExprToSparql} from '../paths/pathExprToSparql';
import {parsePropertyPath} from '../paths/PropertyPathExpr';
import type {PathExpr} from '../paths/PropertyPathExpr';
import {Prefix} from '../utils/Prefix';

const EX = 'https://example.org/vocab#';
const a = `${EX}alpha`;
const b = `${EX}beta`;
const c = `${EX}gamma`;

const SIMPLE: {name: string; expr: PathExpr}[] = [
  {name: 'string ref', expr: a},
  {name: '{id} ref', expr: {id: a}},
];

/** Every COMPLEX variant, so a new operator cannot be added without a key for it. */
const COMPLEX: {name: string; expr: PathExpr}[] = [
  {name: 'sequence', expr: {seq: [a, b]}},
  {name: 'three-step sequence', expr: {seq: [a, b, c]}},
  {name: 'alternative', expr: {alt: [a, b]}},
  {name: 'inverse', expr: {inv: a}},
  {name: 'zeroOrMore', expr: {zeroOrMore: a}},
  {name: 'oneOrMore', expr: {oneOrMore: a}},
  {name: 'zeroOrOne', expr: {zeroOrOne: a}},
  {name: 'negated property set', expr: {negatedPropertySet: [a, {inv: b}]}},
  {name: 'inverse inside a sequence', expr: {seq: [a, {inv: b}]}},
  {name: 'alternative inside a sequence', expr: {seq: [a, {alt: [b, c]}]}},
];

const ALL = [...SIMPLE, ...COMPLEX];

describe('canonicalPathKey', () => {
  it.each(SIMPLE)('returns the bare predicate IRI for a simple path: $name', ({expr}) => {
    // The overwhelmingly common case. Widening `propertyIri` to a full path (plan-035 D13)
    // must not change the key a single-predicate property has always been identified by.
    expect(canonicalPathKey(expr)).toBe(a);
  });

  it('does NOT claim a simple key is re-parseable, and must not', () => {
    // A bare IRI is not valid path syntax — the grammar wants `<iri>` or `prefix:local`, and
    // trips over the '//' in the scheme. That is fine: a key is an IDENTITY, resolved by
    // lookup against the shape catalog, never by re-parsing. Asserted so nobody "fixes" the
    // simple case into `<iri>` and silently changes every existing property key in the process.
    expect(() => parsePropertyPath(canonicalPathKey(a))).toThrow(/parse error/);
  });

  it.each(COMPLEX)('round-trips a complex key through parsePropertyPath: $name', ({expr}) => {
    const key = canonicalPathKey(expr);
    expect(canonicalPathKey(parsePropertyPath(key))).toBe(key);
  });

  it('expands a prefixed name the SAME WAY however it is spelled', () => {
    // The shape catalog and hand-written fixtures both produce `{id: 'schema:name'}` while other
    // callers pass the bare string. Expanding only one form gives a single path two keys, which
    // is the one thing a canonical key may never do.
    Prefix.add('exv', EX);
    try {
      expect(canonicalPathKey('exv:alpha')).toBe(a);
      expect(canonicalPathKey({id: 'exv:alpha'})).toBe(a);
      expect(canonicalPathKey({seq: ['exv:alpha', {id: 'exv:beta'}]})).toBe(canonicalPathKey({seq: [a, b]}));
    } finally {
      Prefix.delete('exv');
    }
  });

  it('wraps refs in angle brackets once the path is complex', () => {
    expect(canonicalPathKey({seq: [a, b]})).toBe(`<${a}>/<${b}>`);
    expect(canonicalPathKey({inv: a})).toBe(`^<${a}>`);
  });

  it('gives distinct paths distinct keys', () => {
    const keys = ALL.map(({expr}) => canonicalPathKey(expr));
    // SIMPLE holds two spellings of the same path, so exactly one duplicate is expected.
    expect(new Set(keys).size).toBe(ALL.length - 1);
  });

  describe('is independent of registered prefixes', () => {
    // The reason this exists rather than reusing pathExprToSparql: a catalog written in one
    // process must produce the same key when read in another, whatever prefixes each happens
    // to have registered.
    const withPrefix = <T>(run: () => T): T => {
      Prefix.add('exv', EX);
      try {
        return run();
      } finally {
        Prefix.delete('exv');
      }
    };

    it.each(ALL)('$name', ({expr}) => {
      const bare = canonicalPathKey(expr);
      expect(withPrefix(() => canonicalPathKey(expr))).toBe(bare);
    });

    it('and pathExprToSparql, by contrast, is not — which is the reason for this function', () => {
      const expr: PathExpr = {seq: [a, b]};
      expect(withPrefix(() => pathExprToSparql(expr))).not.toBe(pathExprToSparql(expr));
    });
  });
});
