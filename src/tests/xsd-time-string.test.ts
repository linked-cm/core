import {assertValid, validate} from '../shapes/validation';
import {Shape} from '../shapes/Shape';
import {describe, expect, it} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty} from '../shapes/SHACL';
import {xsd} from '../ontologies/xsd';
import {lower} from '../queries/lower';
import {createToSparql} from '../sparql/irToAlgebra';

/**
 * `xsd:time` takes a STRING, not a Date — and that string must reach SPARQL as a TYPED literal.
 *
 * JS has no time-only type. A `Date` cannot express a time of day without inventing a date to
 * carry it: the date half is meaningless, gets discarded on serialization, and makes two
 * identical clock times on different days compare unequal. So the lexical form is the honest
 * representation — pattern-checked here, and typed from the DECLARED datatype by irToAlgebra so
 * it is not written as a plain literal that stops matching the property it was meant to fill.
 */
@linkedShape
class Appointment extends Shape {
  static targetClass = {id: 'https://example.org/vocab#Appointment'} as any;

  // `{id}` rather than a bare IRI string: on `dev` a plain absolute IRI is fed to the property
  // path PARSER and throws on the `//` in its scheme. Fixed separately in the canonicalPathKey
  // PR; using the ref form here keeps these two changes independently reviewable.
  @literalProperty({path: {id: 'https://example.org/vocab#startsAt'}, datatype: xsd.time, maxCount: 1})
  get startsAt(): string {
    return '';
  }
}

const check = (value: unknown) => validate(Appointment, {startsAt: value} as never);

describe('xsd:time accepts a pattern-checked string', () => {
  it.each([
    ['plain', '14:30:00'],
    ['with milliseconds', '14:30:00.250'],
    ['one-digit milliseconds', '14:30:00.5'],
    ['midnight', '00:00:00'],
    ['last minute of the day', '23:59:59'],
    ['UTC designator', '14:30:00Z'],
    ['positive offset', '14:30:00+02:00'],
    ['negative offset', '14:30:00-05:00'],
    ['milliseconds and offset', '14:30:00.250+02:00'],
  ])('accepts %s: %s', (_name, value) => {
    expect(check(value).conforms).toBe(true);
  });

  it.each([
    ['hour out of range', '25:00:00'],
    ['minute out of range', '14:60:00'],
    ['second out of range', '14:30:60'],
    ['missing seconds', '14:30'],
    ['single-digit hour', '4:30:00'],
    ['four-digit milliseconds', '14:30:00.2500'],
    ['a full timestamp', '2026-08-27T14:30:00Z'],
    ['empty', ''],
    ['nonsense', 'half past two'],
  ])('rejects %s: %s', (_name, value) => {
    expect(check(value).conforms).toBe(false);
  });

  it('rejects a Date, and says what it wants instead', () => {
    // The message has to name the expected form: "expects xsd:time (a Date)" was the old
    // answer and would send someone the wrong way.
    expect(() => assertValid(Appointment, {startsAt: new Date()} as never))
      .toThrow(/time string like/);
  });

  it('range-checks rather than counting digits', () => {
    // A looser `\d{2}` pattern accepts "25:00:00" and writes a malformed literal that no
    // SPARQL engine will match — the failure would surface as "the data is just missing".
    expect(check('19:59:59').conforms).toBe(true);
    expect(check('20:00:00').conforms).toBe(true);
    expect(check('24:00:00').conforms).toBe(false);
  });
});

describe('an xsd:time string is written as a TYPED literal', () => {
  /**
   * The half that matters most. Mutation literals are typed from the JAVASCRIPT type when they
   * reach SPARQL, so a plain string is written as a plain literal — for `xsd:string` that is
   * correct (RDF 1.1 makes them equivalent), but for `xsd:time` it means the value stops
   * matching the property it was meant to fill, silently. The declared datatype has to win.
   */
  const sparqlFor = (value: unknown): string =>
    createToSparql(
      lower(
        (Appointment as never as {create: (data: unknown) => unknown}).create({
          __id: 'https://example.org/id/appt-1',
          startsAt: value,
        }) as never,
      ) as never,
    );

  it('carries ^^xsd:time, not a plain literal', () => {
    // Prefixed or absolute — what matters is that a datatype is attached at all. Without it the
    // triple reads `"14:30:00"` and no longer matches an xsd:time property.
    const sparql = sparqlFor('14:30:00');
    expect(sparql).toMatch(/"14:30:00"\^\^(xsd:time|<[^>]*XMLSchema#time>)/);
  });

  it('preserves milliseconds and offset in the lexical form', () => {
    expect(sparqlFor('14:30:00.250+02:00'))
      .toMatch(/"14:30:00\.250\+02:00"\^\^(xsd:time|<[^>]*XMLSchema#time>)/);
  });
});
