import {describe, expect, test} from '@jest/globals';
import {Person, Dog, queryFactories} from '../test-helpers/query-fixtures';
import {entity, sanitize} from '../test-helpers/test-utils';
import {lowerMutationJSON} from '../queries/MutationSerialization';
import {DeleteBuilder} from '../queries/DeleteBuilder';
import {CreateBuilder} from '../queries/CreateBuilder';
import {UpdateBuilder} from '../queries/UpdateBuilder';
import {lower} from '../queries/lower';
import {fromJSON} from '../queries/fromJSON';

/**
 * Round-trip proof: for every mutation feature, serializing the builder to
 * DSL-JSON, passing it "over the wire" (stringify+parse), and lowering it back
 * must reproduce the exact IR that `lower()` produces from the builder.
 */
const roundTripsToSameIR = (builder: any) => {
  const wire = JSON.parse(JSON.stringify(builder.toJSON()));
  expect(sanitize(lowerMutationJSON(wire))).toEqual(sanitize(lower(builder)));
};

const check = (label: string, makeBuilder: () => any) =>
  test(label, () => roundTripsToSameIR(makeBuilder()));

describe('mutation DSL-JSON round-trip (iteration 1)', () => {
  describe('create', () => {
    check('simple literals', queryFactories.createSimple);
    check('nested refs + creates', queryFactories.createWithFriends);
    check('fixed id + nested ref', queryFactories.createWithFixedId);
  });

  describe('update (for)', () => {
    check('simple literal', queryFactories.updateSimple);
    check('overwrite set', queryFactories.updateOverwriteSet);
    check('unset single (undefined)', queryFactories.updateUnsetSingleUndefined);
    check('unset single (null)', queryFactories.updateUnsetSingleNull);
    check('overwrite nested', queryFactories.updateOverwriteNested);
    check('pass id references', queryFactories.updatePassIdReferences);
    check('set add + remove', queryFactories.updateAddRemoveMulti);
    check('set remove only', queryFactories.updateRemoveMulti);
    check('set add + remove same', queryFactories.updateAddRemoveSame);
    check('unset multi (undefined)', queryFactories.updateUnsetMultiUndefined);
    check('nested with predefined id', queryFactories.updateNestedWithPredefinedId);
    check('birth date', queryFactories.updateBirthDate);
    check('computed expression', () =>
      Dog.update((p: any) => ({guardDogLevel: p.guardDogLevel.plus(1)})).for(
        entity('d1'),
      ),
    );
  });

  describe('update (bulk)', () => {
    check('forAll', () => Person.update({hobby: 'Gaming'}).forAll());
    check('where', () =>
      Person.update({hobby: 'Gaming'}).where((p: any) => p.name.equals('Semmy')),
    );
  });

  describe('delete', () => {
    check('single id', queryFactories.deleteSingle);
    check('multiple ids', queryFactories.deleteMultiple);
    check('all', () => DeleteBuilder.from(Person).all());
    check('where', () =>
      DeleteBuilder.from(Person).where((p: any) => p.name.equals('Obsolete')),
    );
  });

  describe('coverage hardening (iteration 2)', () => {
    // Gap 2: nested-create object inside a $add set-modification (+ ref in $remove).
    check('set add nested-create + remove ref', () =>
      Person.update({
        friends: {add: [{name: 'AddedFriend'}], remove: [entity('p2')]},
      } as any).for(entity('p1')),
    );

    // Gap 1: multi-segment computed-expression update (emits traversalPatterns).
    check('multi-segment expression update', () =>
      Person.update((p: any) => ({hobby: p.bestFriend.name.concat('!')})).for(
        entity('p1'),
      ),
    );
  });

  test('multi-segment expression update emits traversalPatterns that round-trip', () => {
    const builder = Person.update((p: any) => ({
      hobby: p.bestFriend.name.concat('!'),
    })).for(entity('p1'));
    const built: any = lower(builder);
    // Sanity: this scenario actually exercises the traversalPatterns path.
    expect(Array.isArray(built.traversalPatterns)).toBe(true);
    const lowered: any = lowerMutationJSON(
      JSON.parse(JSON.stringify(builder.toJSON())),
    );
    expect(sanitize(lowered)).toEqual(sanitize(built));
  });

  describe('builder fromJSON round-trip (phase 4)', () => {
    // lower(Builder.fromJSON(wire(b.toJSON()))) must equal lower(b) for every feature.
    const builderFor = (op: string) =>
      op === 'create'
        ? CreateBuilder
        : op === 'update'
          ? UpdateBuilder
          : DeleteBuilder;
    const rebuilds = (label: string, makeBuilder: () => any) =>
      test(label, () => {
        const b = makeBuilder();
        const wire = JSON.parse(JSON.stringify(b.toJSON()));
        const Builder = builderFor(wire.op);
        const rebuilt: any = (Builder as any).fromJSON(wire);
        expect(sanitize(lower(rebuilt))).toEqual(sanitize(lower(b)));
        // and the kind-detecting fromJSON yields the same IR
        expect(sanitize(lower(fromJSON(wire) as any))).toEqual(sanitize(lower(b)));
      });

    rebuilds('create simple', queryFactories.createSimple);
    rebuilds('create nested + fixed id', queryFactories.createWithFixedId);
    rebuilds('update for (set add/remove)', queryFactories.updateAddRemoveMulti);
    rebuilds('update for (date)', queryFactories.updateBirthDate);
    rebuilds('update for (nested with id)', queryFactories.updateNestedWithPredefinedId);
    rebuilds('update for (computed expression)', () =>
      Dog.update((p: any) => ({guardDogLevel: p.guardDogLevel.plus(1)})).for(
        entity('d1'),
      ),
    );
    rebuilds('update forAll', () => Person.update({hobby: 'Gaming'}).forAll());
    rebuilds('update where', () =>
      Person.update({hobby: 'Gaming'}).where((p: any) => p.name.equals('Semmy')),
    );
    rebuilds('delete ids', queryFactories.deleteMultiple);
    rebuilds('delete all', () => DeleteBuilder.from(Person).all());
    rebuilds('delete where', () =>
      DeleteBuilder.from(Person).where((p: any) => p.name.equals('Obsolete')),
    );
  });

  describe('query context as target subject (phase 6 — mutation parity)', () => {
    const {
      getQueryContext,
      setQueryContext,
      subscribeQueryContext,
      UnresolvedContextError,
    } = require('../queries/QueryContext');

    test('subscribeQueryContext notifies on set/clear (reactivity primitive)', () => {
      const seen: string[] = [];
      const unsub = subscribeQueryContext((name: string) => seen.push(name));
      setQueryContext('ctx-sub', {id: entity('p1').id}, Person);
      setQueryContext('ctx-sub', undefined);
      unsub();
      setQueryContext('ctx-sub', {id: entity('p2').id}, Person);
      setQueryContext('ctx-sub', undefined);
      expect(seen).toEqual(['ctx-sub', 'ctx-sub']); // only while subscribed
    });

    test('update .for(context) round-trips and resolves at lower (or throws)', () => {
      setQueryContext('ctx-x', undefined); // ensure unset
      const b = UpdateBuilder.from(Person)
        .set({hobby: 'Gaming'})
        .for(getQueryContext('ctx-x'));

      const json: any = JSON.parse(JSON.stringify(b.toJSON()));
      // Unified context reference: the target slot carries a {$ctx} marker.
      expect(json.targetId).toEqual({$ctx: 'ctx-x'});

      // unresolved → lowering throws
      expect(() => lower(b as any)).toThrow(UnresolvedContextError);
      const rebuilt: any = UpdateBuilder.fromJSON(json);
      expect(() => lower(rebuilt)).toThrow(UnresolvedContextError);

      // set the context → resolves to the concrete id
      setQueryContext('ctx-x', {id: entity('p1').id}, Person);
      expect((lower(b as any) as any).id).toBe(entity('p1').id);
      expect((lower(UpdateBuilder.fromJSON(json)) as any).id).toBe(entity('p1').id);
      setQueryContext('ctx-x', undefined);
    });

    test('inbound mutation JSON with a {$ctx} field value resolves at lower (or throws)', () => {
      setQueryContext('ctx-v', undefined); // ensure unset
      // A wire envelope (e.g. authored elsewhere, or hand-built for interop)
      // carrying a unified context reference as a node field value.
      const json: any = JSON.parse(
        JSON.stringify(
          Person.update({bestFriend: entity('p2')}).for(entity('p1')).toJSON(),
        ),
      );
      const field = json.data.fields.find((f: any) => f.prop === 'bestFriend');
      field.value = {kind: 'ctxRef', name: 'ctx-v'};

      // unresolved → lowering throws (a mutation must hit a concrete node)
      expect(() => lowerMutationJSON(json)).toThrow(UnresolvedContextError);

      // set the context → the field resolves and lowering succeeds
      setQueryContext('ctx-v', {id: entity('p2').id}, Person);
      expect(() => lowerMutationJSON(json)).not.toThrow();
      setQueryContext('ctx-v', undefined);
    });
  });

  test('wire version is stamped and an unknown major is rejected', () => {
    const json: any = queryFactories.createSimple().toJSON();
    expect(json.v).toBe('1.0');
    expect(() => fromJSON({...json, v: '2.0'})).toThrow(/wire version/i);
    // missing v is tolerated
    const {v, ...noV} = json;
    expect(() => fromJSON(noV)).not.toThrow();
  });

  test('date value survives the wire as a Date', () => {
    const ir: any = lowerMutationJSON(
      JSON.parse(JSON.stringify(queryFactories.updateBirthDate().toJSON())),
    );
    const birthDate = ir.data.fields.find((f: any) =>
      f.property.endsWith('/birthDate'),
    )?.value;
    expect(birthDate).toBeInstanceOf(Date);
    expect((birthDate as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});
