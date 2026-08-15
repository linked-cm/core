/**
 * The value-level SHACL constraint components: `sh:datatype`, the four
 * `sh:min/maxInclusive/Exclusive` bounds, `sh:min/maxLength`, `sh:pattern` and
 * `sh:in`. These check the value in hand, so — unlike required-property presence
 * — they apply to updates as well as creates.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {NodeReferenceValue} from '../queries/QueryFactory';
import {validate} from '../shapes/validation';
import {shacl} from '../ontologies/shacl';
import {xsd} from '../ontologies/xsd';

const base = 'linked://tmp/constraints/';
const prop = (s: string): NodeReferenceValue => ({id: `${base}props/${s}`});
const term = (s: string): NodeReferenceValue => ({id: `${base}terms/${s}`});

@linkedShape
class Target extends Shape {
  static targetClass = {id: `${base}types/Target`} as any;

  @literalProperty({path: prop('name'), maxCount: 1, datatype: xsd.string})
  get name(): string {
    return '';
  }

  @literalProperty({path: prop('age'), maxCount: 1, datatype: xsd.integer})
  get age(): number {
    return 0;
  }

  @literalProperty({path: prop('active'), maxCount: 1, datatype: xsd.boolean})
  get active(): boolean {
    return false;
  }

  @literalProperty({path: prop('score'), maxCount: 1, datatype: xsd.decimal})
  get score(): number {
    return 0;
  }

  @literalProperty({path: prop('startedAt'), maxCount: 1, datatype: xsd.dateTime})
  get startedAt(): Date {
    return null;
  }

  @literalProperty({path: prop('span'), maxCount: 1, datatype: xsd.duration})
  get span(): string {
    return '';
  }

  @objectProperty({path: prop('parent'), maxCount: 1, shape: Target})
  get parent(): Target {
    return null;
  }
}

@linkedShape
class Bounded extends Shape {
  static targetClass = {id: `${base}types/Bounded`} as any;

  @literalProperty({
    path: prop('rating'),
    maxCount: 1,
    datatype: xsd.integer,
    minInclusive: 1,
    maxInclusive: 5,
  })
  get rating(): number {
    return 0;
  }

  @literalProperty({
    path: prop('ratio'),
    maxCount: 1,
    datatype: xsd.decimal,
    minExclusive: 0,
    maxExclusive: 1,
  })
  get ratio(): number {
    return 0;
  }

  @literalProperty({
    path: prop('code'),
    maxCount: 1,
    datatype: xsd.string,
    minLength: 2,
    maxLength: 4,
  })
  get code(): string {
    return '';
  }

  @literalProperty({path: prop('slug'), maxCount: 1, datatype: xsd.string, pattern: /^[a-z]+$/})
  get slug(): string {
    return '';
  }

  @literalProperty({path: prop('status'), maxCount: 1, in: ['draft', 'published']})
  get status(): string {
    return '';
  }

  @objectProperty({
    path: prop('category'),
    maxCount: 1,
    shape: Bounded,
    in: [term('a'), term('b')],
  })
  get category(): Bounded {
    return null;
  }
}

/** The constraint components a piece of data violates, in report order. */
const componentsFor = (shape: any, data: object, mode?: 'complete' | 'partial') =>
  validate(shape, data, mode ? {mode} : undefined).results.map(
    (r) => r.sourceConstraintComponent.id.split('#')[1],
  );

describe('sh:datatype', () => {
  test('a string where a whole number is declared is rejected', () => {
    expect(componentsFor(Target, {age: '42'})).toEqual(['DatatypeConstraintComponent']);
  });

  test('a string where a boolean is declared is rejected', () => {
    expect(componentsFor(Target, {active: 'true'})).toEqual(['DatatypeConstraintComponent']);
  });

  test('a number where a string is declared is rejected', () => {
    expect(componentsFor(Target, {name: 42})).toEqual(['DatatypeConstraintComponent']);
  });

  test('a decimal where an integer is declared is rejected', () => {
    expect(componentsFor(Target, {age: 4.5})).toEqual(['DatatypeConstraintComponent']);
  });

  test('matching values are accepted', () => {
    const ok = {name: 'Rene', age: 42, active: true, score: 1.5, startedAt: new Date()};
    expect(validate(Target, ok).conforms).toBe(true);
  });

  test('a decimal property accepts whole numbers too', () => {
    expect(validate(Target, {score: 2}).conforms).toBe(true);
  });

  test('dates accept a Date or a lexical string (the only way to write xsd:date)', () => {
    expect(validate(Target, {startedAt: new Date()}).conforms).toBe(true);
    expect(validate(Target, {startedAt: '2020-06-15'}).conforms).toBe(true);
    expect(componentsFor(Target, {startedAt: 42})).toEqual(['DatatypeConstraintComponent']);
  });

  test('datatypes with no JS counterpart are not checked', () => {
    expect(validate(Target, {span: 'P1Y2M'}).conforms).toBe(true);
    expect(validate(Target, {span: 12345}).conforms).toBe(true);
  });

  test('a node reference is one violation — node kind, not datatype as well', () => {
    expect(componentsFor(Target, {age: {id: 'x:1'}})).toEqual(['NodeKindConstraintComponent']);
  });

  test('the message names the datatype and what was given', () => {
    const [result] = validate(Target, {age: '42'}).results;
    expect(result.resultMessage).toBe(
      "Property 'age' expects xsd:integer (a whole number), but was given a string.",
    );
    expect(result.value).toBe('42');
    expect(result.sourceConstraintComponent).toEqual(shacl.DatatypeConstraintComponent);
  });
});

describe('sh:minInclusive / maxInclusive / minExclusive / maxExclusive', () => {
  test('inclusive bounds accept their endpoints', () => {
    expect(validate(Bounded, {rating: 1}).conforms).toBe(true);
    expect(validate(Bounded, {rating: 5}).conforms).toBe(true);
  });

  test('inclusive bounds reject values outside them', () => {
    expect(componentsFor(Bounded, {rating: 0})).toEqual(['MinInclusiveConstraintComponent']);
    expect(componentsFor(Bounded, {rating: 6})).toEqual(['MaxInclusiveConstraintComponent']);
  });

  test('exclusive bounds reject their endpoints', () => {
    expect(componentsFor(Bounded, {ratio: 0})).toEqual(['MinExclusiveConstraintComponent']);
    expect(componentsFor(Bounded, {ratio: 1})).toEqual(['MaxExclusiveConstraintComponent']);
    expect(validate(Bounded, {ratio: 0.5}).conforms).toBe(true);
  });

  test('a non-number is a datatype violation only — bounds stay quiet', () => {
    expect(componentsFor(Bounded, {rating: 'high'})).toEqual(['DatatypeConstraintComponent']);
  });
});

describe('sh:minLength / maxLength', () => {
  test('lengths within bounds are accepted', () => {
    expect(validate(Bounded, {code: 'ab'}).conforms).toBe(true);
    expect(validate(Bounded, {code: 'abcd'}).conforms).toBe(true);
  });

  test('too short and too long are rejected', () => {
    expect(componentsFor(Bounded, {code: 'a'})).toEqual(['MinLengthConstraintComponent']);
    expect(componentsFor(Bounded, {code: 'abcde'})).toEqual(['MaxLengthConstraintComponent']);
  });
});

describe('sh:pattern', () => {
  test('matching and non-matching strings', () => {
    expect(validate(Bounded, {slug: 'hello'}).conforms).toBe(true);
    expect(componentsFor(Bounded, {slug: 'Hello1'})).toEqual(['PatternConstraintComponent']);
  });

  test('the message shows the regex and the value', () => {
    const [result] = validate(Bounded, {slug: 'Nope'}).results;
    expect(result.resultMessage).toBe(
      'Property \'slug\' must match /^[a-z]+$/, but was given "Nope".',
    );
  });
});

describe('sh:in', () => {
  test('literal membership', () => {
    expect(validate(Bounded, {status: 'draft'}).conforms).toBe(true);
    expect(componentsFor(Bounded, {status: 'archived'})).toEqual(['InConstraintComponent']);
  });

  test('node-reference membership', () => {
    expect(validate(Bounded, {category: term('a')}).conforms).toBe(true);
    expect(componentsFor(Bounded, {category: term('z')})).toEqual(['InConstraintComponent']);
  });

  test('the message lists the allowed values', () => {
    expect(validate(Bounded, {status: 'archived'}).results[0].resultMessage).toBe(
      'Property \'status\' must be one of ["draft", "published"].',
    );
  });
});

describe('which checks depend on seeing the whole node', () => {
  test('value constraints apply to updates as well as creates', () => {
    for (const mode of ['complete', 'partial'] as const) {
      expect(componentsFor(Target, {age: '42'}, mode)).toEqual(['DatatypeConstraintComponent']);
      expect(componentsFor(Bounded, {rating: 9}, mode)).toEqual([
        'MaxInclusiveConstraintComponent',
      ]);
    }
  });

  test('only required-property presence is create-only', () => {
    @linkedShape
    class Required extends Shape {
      static targetClass = {id: `${base}types/Required`} as any;

      @literalProperty({path: prop('mandatory'), minCount: 1, maxCount: 1, datatype: xsd.string})
      get mandatory(): string {
        return '';
      }
    }
    expect(componentsFor(Required, {}, 'complete')).toEqual(['MinCountConstraintComponent']);
    expect(componentsFor(Required, {}, 'partial')).toEqual([]);
    // A value that IS supplied is checked either way.
    expect(componentsFor(Required, {mandatory: 7}, 'partial')).toEqual([
      'DatatypeConstraintComponent',
    ]);
  });
});

describe('every violation at once', () => {
  test('several properties, each reported — in the order the data lists them', () => {
    expect(componentsFor(Bounded, {code: 'x', slug: 'BAD', rating: 99})).toEqual([
      'MinLengthConstraintComponent',
      'PatternConstraintComponent',
      'MaxInclusiveConstraintComponent',
    ]);
  });

  test('one value breaking two constraints reports both', () => {
    expect(componentsFor(Bounded, {code: 'X'})).toEqual([
      'MinLengthConstraintComponent',
      // `code` has no pattern; `slug` does — this is the length pair only.
    ]);
    expect(componentsFor(Bounded, {ratio: 5})).toEqual(['MaxExclusiveConstraintComponent']);
  });
});

describe('the mutation pipeline rejects mistyped literals', () => {
  test("create() throws on a string where the shape declares xsd:integer", () => {
    expect(() => Target.create({age: '42'} as any).toJSON()).toThrow(/expects xsd:integer/);
  });

  test('update() throws too — the value is just as checkable', () => {
    expect(() =>
      Target.update({active: 'yes'} as any).for({id: 'x:t1'}).toJSON(),
    ).toThrow(/expects xsd:boolean/);
  });

  test('correctly typed values pass through', () => {
    expect(() => Target.create({age: 42, active: true} as any).toJSON()).not.toThrow();
  });
});
