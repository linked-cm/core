import {describe, expect, test} from '@jest/globals';
import {linkedPackage} from '../utils/Package';
import {Shape} from '../shapes/Shape';
import {LinkedStorage} from '../utils/LinkedStorage';
import type {IDataset} from '../interfaces/IDataset';
import type {NodeReferenceValue} from '../utils/NodeReference';

const {linkedShape} = linkedPackage('store-routing-test');

const type = (suffix: string): NodeReferenceValue => ({
  id: `linked://tmp/types/${suffix}`,
});

@linkedShape
class RoutedPerson extends Shape {
  static targetClass = type('RoutedPerson');
}

@linkedShape
class RoutedEmployee extends RoutedPerson {
  static targetClass = type('RoutedEmployee');
}

@linkedShape
class RoutedPet extends Shape {
  static targetClass = type('RoutedPet');
}

type StoreCalls = {
  select: number;
  update: number;
  create: number;
  delete: number;
};

const createStore = () => {
  const calls: StoreCalls = {select: 0, update: 0, create: 0, delete: 0};
  const store: IDataset = {
    selectQuery: async () => {
      calls.select += 1;
      return [];
    },
    updateQuery: async () => {
      calls.update += 1;
      return {id: 'mock'};
    },
    createQuery: async () => {
      calls.create += 1;
      return {id: 'mock'};
    },
    deleteQuery: async () => {
      calls.delete += 1;
      return {deleted: [], count: 0};
    },
  };
  return {store, calls};
};

describe('LinkedStorage store routing', () => {
  test('routes select queries based on shape mapping', async () => {
    const defaultStore = createStore();
    const personStore = createStore();
    LinkedStorage.setDefaultDataset(defaultStore.store);
    LinkedStorage.setDatasetForShapes(personStore.store, RoutedPerson);

    await LinkedStorage.selectQuery(RoutedPerson.select() as any);

    expect(personStore.calls.select).toBe(1);
    expect(defaultStore.calls.select).toBe(0);
  });

  test('routes select queries to default store when no mapping exists', async () => {
    const defaultStore = createStore();
    LinkedStorage.setDefaultDataset(defaultStore.store);

    await LinkedStorage.selectQuery(RoutedPet.select() as any);

    expect(defaultStore.calls.select).toBe(1);
  });

  test('uses parent shape store for subclasses', async () => {
    const defaultStore = createStore();
    const personStore = createStore();
    LinkedStorage.setDefaultDataset(defaultStore.store);
    LinkedStorage.setDatasetForShapes(personStore.store, RoutedPerson);

    await LinkedStorage.selectQuery(RoutedEmployee.select() as any);

    expect(personStore.calls.select).toBe(1);
    expect(defaultStore.calls.select).toBe(0);
  });

  test('routes update/create/delete using node shape ids', async () => {
    const defaultStore = createStore();
    const personStore = createStore();
    LinkedStorage.setDefaultDataset(defaultStore.store);
    LinkedStorage.setDatasetForShapes(personStore.store, RoutedPerson);

    await LinkedStorage.updateQuery(RoutedPerson.update({}).for('p1') as any);
    await LinkedStorage.createQuery(RoutedPerson.create({}) as any);
    await LinkedStorage.deleteQuery(RoutedPerson.delete('p1') as any);

    expect(personStore.calls.update).toBe(1);
    expect(personStore.calls.create).toBe(1);
    expect(personStore.calls.delete).toBe(1);
    expect(defaultStore.calls.update).toBe(0);
  });
});
