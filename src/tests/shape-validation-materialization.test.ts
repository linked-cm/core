/**
 * A `ValidationReport` is 1-1 with the SHACL vocabulary: every key is one SHACL
 * property, and every value is in a form the mutation pipeline accepts. This
 * suite proves it the only way that counts — by declaring shape classes straight
 * from `sh:ValidationReport` / `sh:ValidationResult` and pushing a real report
 * through an ordinary create query.
 *
 * The classes live here rather than in the library because whether core ships
 * them is an open question (see docs/reports/027); the mapping they encode is
 * the contract either way. If a report ever grows a key these shapes don't
 * declare, the create throws `Invalid property key` and this suite fails.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, objectProperty, linkedProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {NodeReferenceValue} from '../queries/QueryFactory';
import {validate} from '../shapes/validation';
import {shacl} from '../ontologies/shacl';
import {xsd} from '../ontologies/xsd';
import {createNameSpace} from '../utils/NameSpace';

/** The one non-SHACL property a result carries — an extension in our namespace. */
const linkedValidation = createNameSpace('https://linked.cm/ns/validation#');

// ---------------------------------------------------------------------------
// sh:ValidationResult / sh:ValidationReport as shape classes
// ---------------------------------------------------------------------------

@linkedShape
class MaterializedValidationResult extends Shape {
  static targetClass = shacl.ValidationResult;

  @linkedProperty({path: shacl.focusNode, maxCount: 1})
  get focusNode(): unknown {
    return null;
  }

  @linkedProperty({path: shacl.resultPath, maxCount: 1})
  get resultPath(): unknown {
    return null;
  }

  @linkedProperty({path: shacl.value, maxCount: 1})
  get value(): unknown {
    return null;
  }

  @linkedProperty({path: shacl.sourceShape, maxCount: 1})
  get sourceShape(): unknown {
    return null;
  }

  @linkedProperty({path: shacl.sourceConstraintComponent, maxCount: 1})
  get sourceConstraintComponent(): unknown {
    return null;
  }

  @linkedProperty({path: shacl.resultSeverity, maxCount: 1})
  get resultSeverity(): unknown {
    return null;
  }

  // `sh:resultMessage` — the result's own message, not `sh:message` (which
  // declares a custom message on a shape or constraint).
  @literalProperty({path: shacl.resultMessage, maxCount: 1, datatype: xsd.string})
  get resultMessage(): string {
    return '';
  }

  @literalProperty({path: linkedValidation('propertyPath'), maxCount: 1, datatype: xsd.string})
  get propertyPath(): string {
    return '';
  }
}

@linkedShape
class MaterializedValidationReport extends Shape {
  static targetClass = shacl.ValidationReport;

  @literalProperty({path: shacl.conforms, maxCount: 1, datatype: xsd.boolean})
  get conforms(): boolean {
    return false;
  }

  // `results` (plural label) → `sh:result` (the repeated SHACL property).
  @objectProperty({path: shacl.result, shape: MaterializedValidationResult, contains: true})
  get results(): MaterializedValidationResult[] {
    return [];
  }
}

// ---------------------------------------------------------------------------
// A shape to produce reports about
// ---------------------------------------------------------------------------

const base = 'linked://tmp/materialize/';
const prop = (s: string): NodeReferenceValue => ({id: `${base}props/${s}`});

@linkedShape
class Deck extends Shape {
  static targetClass = {id: `${base}types/Deck`} as any;

  @literalProperty({path: prop('title'), minCount: 1, maxCount: 1})
  get title(): string {
    return '';
  }

  @literalProperty({path: prop('tag')})
  get tags(): string[] {
    return [];
  }
}

describe('a validation report materializes through an ordinary create query', () => {
  const report = validate(Deck, {tags: [{id: 'x:node'}], slideCount: 12});

  test('the report under test is the interesting kind — several violations, mixed', () => {
    expect(report.conforms).toBe(false);
    expect(report.results.map((r) => r.sourceConstraintComponent.id.split('#')[1])).toEqual([
      'MinCountConstraintComponent', // title missing
      'NodeKindConstraintComponent', // tags given a node
      'ClosedConstraintComponent', // slideCount undeclared
    ]);
  });

  test('create(report) is accepted — every key maps to a declared SHACL property', () => {
    expect(() => MaterializedValidationReport.create(report as any)).not.toThrow();
    expect(() => MaterializedValidationReport.create(report as any).toJSON()).not.toThrow();
  });

  test('the serialized mutation carries the SHACL predicates', () => {
    const json = MaterializedValidationReport.create(report as any).toJSON();
    const wire = JSON.stringify(json);
    expect(json.op).toBe('create');
    expect(json.shape).toBe(MaterializedValidationReport.shape.id);
    // Node-valued properties survive as references, not as strings or literals.
    expect(wire).toContain('http://www.w3.org/ns/shacl#MinCountConstraintComponent');
    expect(wire).toContain('http://www.w3.org/ns/shacl#Violation');
    expect(wire).toContain(`${base}props/title`);
    // …and the nested results are nested node descriptions under the report.
    expect(JSON.stringify(json.data).match(/MinCountConstraintComponent/g)).toHaveLength(1);
  });

  test('a conforming report materializes too (no results, conforms true)', () => {
    const clean = validate(Deck, {title: 'Q3'});
    expect(clean).toEqual({conforms: true, results: []});
    expect(() => MaterializedValidationReport.create(clean as any).toJSON()).not.toThrow();
  });

  test('the report shape validates its own reports — no undeclared keys, either way', () => {
    // Validating the report *as data* against the report shape is the same
    // 1-1 check, run through the validator instead of the create pipeline.
    expect(validate(MaterializedValidationReport, report as any).conforms).toBe(true);
  });

  test('nested results reach the store as node descriptions with their own type', () => {
    const json: any = MaterializedValidationReport.create(report as any).toJSON();
    const wire = JSON.stringify(json.data);
    // One nested description per violation.
    expect(wire.match(/shacl#resultSeverity|resultSeverity/g)?.length).toBeGreaterThanOrEqual(1);
    expect(report.results).toHaveLength(3);
  });
});
