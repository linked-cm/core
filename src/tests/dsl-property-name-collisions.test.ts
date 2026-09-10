/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Property labels that collide with the query DSL surface — backlog 041.
 *
 * The query proxy answers a key from the `QueryShape` instance before it looks for a
 * property shape, so a label that names a DSL member is unreadable through the builder.
 * Two things are asserted here: the meta-model no longer names one of its own
 * constraints after a DSL member, and a shape that does is reported while its author
 * can still rename it.
 */
import {afterEach, describe, expect, jest, test} from '@jest/globals';
import '../utils/Package';
import {captureQuery} from '../test-helpers/query-capture-store';
import {NodeShape, PropertyShape, registerPropertyShape} from '../shapes/SHACL';
import {registerRuntimeShape} from '../shapes/registerRuntimeShape';
import {
  RESERVED_QUERY_DSL_NAMES,
  SET_CONTEXT_ONLY_NAMES,
  isReservedQueryDslName,
  resetReservedPropertyLabelWarnings,
  warnOnReservedPropertyLabel,
} from '../queries/reservedQueryNames';
import {QueryShape, QueryShapeSet} from '../queries/SelectQuery';
import {getPropertyShapeTerm} from '../shapes/propertyShapeTerms';

const SH = 'http://www.w3.org/ns/shacl#';

describe('the meta-model reads its own sh:equals', () => {
  test('sh:equals is selectable through the DSL as `equalsConstraint`', async () => {
    const ir = await captureQuery(() =>
      (PropertyShape as any).select((ps: any) => [ps.equalsConstraint]),
    );
    // The DSL resolves the label to the meta-model's property shape...
    expect(JSON.stringify(ir)).toContain('/PropertyShape/equalsConstraint');
    // ...whose path is still sh:equals — only the label moved.
    const ps = (PropertyShape.shape?.propertyShapes ?? []).find(
      (p) => p.label === 'equalsConstraint',
    );
    expect((ps?.path as any)?.id ?? ps?.path).toBe(`${SH}equals`);
  });

  test('no meta-model label collides with the DSL surface', () => {
    const offenders: string[] = [];
    for (const shape of [NodeShape.shape, PropertyShape.shape]) {
      for (const ps of shape?.propertyShapes ?? []) {
        if (isReservedQueryDslName(ps.label)) offenders.push(`${shape.label}.${ps.label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('a colliding label is reported at registration', () => {
  let warn: any;
  afterEach(() => {
    warn?.mockRestore();
    warn = undefined;
  });

  test('a decorated property whose label is a DSL member warns, naming shape, property and reason', () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const shape: any = {
      id: 'https://example.org/test/shapes/Box',
      label: 'Box',
      propertyShapes: [],
    };
    registerPropertyShape(shape, {
      label: 'size',
      path: {id: 'https://example.org/test/size'},
      maxCount: 1,
    } as any);

    const message = (warn.mock.calls[0]?.[0] ?? '') as string;
    expect(message).toContain('size');
    expect(message).toContain('Box');
    expect(message).toMatch(/query|DSL/i);
  });

  test('the same collision is only reported once', () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const shape: any = {
      id: 'https://example.org/test/shapes/Crate',
      label: 'Crate',
      propertyShapes: [],
    };
    const ps = {label: 'select', path: {id: 'https://example.org/test/select'}, maxCount: 1};
    registerPropertyShape(shape, {...ps} as any);
    registerPropertyShape(shape, {...ps} as any);
    expect(warn.mock.calls.length).toBe(1);
  });

  test('a non-colliding label is silent', () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const shape: any = {
      id: 'https://example.org/test/shapes/Crate2',
      label: 'Crate2',
      propertyShapes: [],
    };
    registerPropertyShape(shape, {
      label: 'width',
      path: {id: 'https://example.org/test/width'},
      maxCount: 1,
    } as any);
    expect(warn.mock.calls.length).toBe(0);
  });

  test('a data-only shape is checked too', () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    registerRuntimeShape({
      id: 'https://example.org/test/shapes/RuntimeBox',
      label: 'RuntimeBox',
      propertyShapes: [
        {
          id: 'https://example.org/test/shapes/RuntimeBox/id',
          label: 'id',
          path: {id: 'https://example.org/test/id'},
          maxCount: 1,
        },
      ],
    } as any);
    const message = (warn.mock.calls[0]?.[0] ?? '') as string;
    expect(message).toContain('RuntimeBox');
    expect(message).toContain('id');
  });
});

describe('the reserved list tracks the real DSL surface', () => {
  test('every member of the query proxies is listed', () => {
    const live = new Set<string>();
    for (const C of [QueryShape, QueryShapeSet]) {
      let proto: any = C.prototype;
      while (proto && proto !== Object.prototype) {
        Object.getOwnPropertyNames(proto).forEach((n) => live.add(n));
        proto = Object.getPrototypeOf(proto);
      }
    }
    const missing = [...live].filter((n) => !RESERVED_QUERY_DSL_NAMES.has(n));
    expect(missing).toEqual([]);
  });
});

describe('the author-facing config key survives the rename', () => {
  test("getPropertyShapeTerm('equals') still resolves to sh:equals", () => {
    // The decorator key stayed `equals` — that is what a person writes, and renaming it
    // would break every existing shape for a reason internal to the query builder. But
    // code-to-SHACL materialization looks terms up BY THAT KEY, so without an alias
    // `@literalProperty({equals: …})` silently stopped emitting `sh:equals`: no error,
    // just a constraint quietly missing from the graph.
    expect(getPropertyShapeTerm('equals')?.predicate).toBe(`${SH}equals`);
  });

  test('the meta-shape label resolves too', () => {
    expect(getPropertyShapeTerm('equalsConstraint')?.predicate).toBe(`${SH}equals`);
  });
});

describe('the two collision kinds are reported differently', () => {
  test('the set-only names are exactly those on QueryShapeSet but not QueryShape', () => {
    // Pins the split against the live prototypes, so a DSL method moving between the two
    // surfaces cannot silently change which properties are safe.
    for (const name of SET_CONTEXT_ONLY_NAMES) {
      expect(name in (QueryShapeSet as never as {prototype: object}).prototype).toBe(true);
      expect(name in (QueryShape as never as {prototype: object}).prototype).toBe(false);
    }
  });

  test('a set-only name says it is fine to read directly', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    resetReservedPropertyLabelWarnings();
    warnOnReservedPropertyLabel('size', 'Widget', 'urn:Widget');
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('multi-valued');
    expect(message).toContain('is fine');
    // …and it must NOT claim the query fails, because it does not.
    expect(message).not.toContain('the query fails');
    warn.mockRestore();
  });

  test('a single-shape name says the query fails, because it does', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    resetReservedPropertyLabelWarnings();
    warnOnReservedPropertyLabel('select', 'Widget', 'urn:Widget');
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('the query fails');
    expect(message).not.toContain('multi-valued');
    warn.mockRestore();
  });

  test('both messages name the escape hatch', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const label of ['size', 'select']) {
      resetReservedPropertyLabelWarnings();
      warn.mockClear();
      warnOnReservedPropertyLabel(label, 'Widget', 'urn:Widget');
      // A warning that does not say what to do instead is a warning people learn to skip.
      expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain(`select(['${label}'])`);
    }
    warn.mockRestore();
  });
});
