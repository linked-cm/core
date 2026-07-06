/**
 * G8 lock-in — the DSL-JSON system value-tags are `@`-sigiled (`@id`, `@date`,
 * `@list`, `@add`, `@remove`, `@unset`, `@path`, `@ctx`), so a user property whose
 * label collides with a former bare tag (`date`, `list`, `path`, `unset`, …) now
 * round-trips cleanly instead of being swallowed by the tag vocabulary.
 *
 * These names were previously unusable as accessors; the sigil frees them.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {xsd} from '../ontologies/xsd';
import {ShapeSet} from '../collections/ShapeSet';
import {NodeReferenceValue} from '../queries/QueryFactory';
import {CreateBuilder} from '../queries/CreateBuilder';

const base = 'linked://tmp/g8/';
const prop = (s: string): NodeReferenceValue => ({id: `${base}props/${s}`});

@linkedShape
export class Widget extends Shape {
  static targetClass = {id: `${base}types/Widget`} as any;

  // Labels that used to collide with bare DSL-JSON value-tags.
  @literalProperty({path: prop('date'), maxCount: 1})
  get date(): string {
    return '';
  }

  @literalProperty({path: prop('path'), maxCount: 1})
  get path(): string {
    return '';
  }

  @literalProperty({path: prop('list'), maxCount: 1})
  get list(): string {
    return '';
  }

  @literalProperty({path: prop('unset'), maxCount: 1})
  get unset(): string {
    return '';
  }

  @literalProperty({path: prop('add'), maxCount: 1})
  get add(): string {
    return '';
  }

  @literalProperty({path: prop('birthDate'), datatype: xsd.dateTime, maxCount: 1})
  get birthDate(): Date {
    return null;
  }

  @objectProperty({path: prop('related'), shape: Widget})
  get related(): ShapeSet<Widget> {
    return null;
  }
}

describe('G8 — user properties named after former reserved value-tags', () => {
  test('create: scalar props named date/path/list/unset/add survive the wire as their own keys', () => {
    const json: any = Widget.create({
      date: 'my-date-value',
      path: 'my-path-value',
      list: 'my-list-value',
      unset: 'my-unset-value',
      add: 'my-add-value',
    } as any).toJSON();

    // Each user label is a plain key with a bare scalar value — no `@`-tag in sight.
    expect(json.data).toEqual({
      date: 'my-date-value',
      path: 'my-path-value',
      list: 'my-list-value',
      unset: 'my-unset-value',
      add: 'my-add-value',
    });
  });

  test('the @-sigiled tags remain distinct: a Date value tags as {@date}, a relation set as {@list}', () => {
    const iso = '2021-06-15T00:00:00.000Z';
    const json: any = Widget.create({
      birthDate: new Date(iso),
      related: [{id: `${base}entities/w2`}],
      // and a user property literally named `date` alongside the real @date tag
      date: 'not-a-date',
    } as any).toJSON();

    expect(json.data.birthDate).toEqual({'@date': iso});
    expect(json.data.related).toEqual({'@list': [{'@id': `${base}entities/w2`}]});
    expect(json.data.date).toBe('not-a-date'); // user key untouched by the @date tag
  });

  test('round-trip: fromJSON recovers the colliding user labels verbatim', () => {
    const built = Widget.create({
      date: 'd',
      path: 'p',
      list: 'l',
      unset: 'u',
      add: 'a',
    } as any);
    const wire = JSON.parse(JSON.stringify(built.toJSON()));
    // Re-serializing the rebuilt builder reproduces the same wire.
    const again = CreateBuilder.fromJSON(wire).toJSON();
    expect(again.data).toEqual(wire.data);
  });
});
