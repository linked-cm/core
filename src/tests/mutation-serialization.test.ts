import {describe, expect, test} from '@jest/globals';
import {Person, Dog, queryFactories} from '../test-helpers/query-fixtures';
import {entity, sanitize} from '../test-helpers/test-utils';
import {lowerMutationJSON} from '../queries/MutationSerialization';
import {DeleteBuilder} from '../queries/DeleteBuilder';

/**
 * Round-trip proof: for every mutation feature, serializing the builder to
 * DSL-JSON, passing it "over the wire" (stringify+parse), and lowering it back
 * must reproduce the exact IR the builder's own `build()` produces.
 */
const roundTripsToSameIR = (builder: any) => {
  const wire = JSON.parse(JSON.stringify(builder.toJSON()));
  expect(sanitize(lowerMutationJSON(wire))).toEqual(sanitize(builder.build()));
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
