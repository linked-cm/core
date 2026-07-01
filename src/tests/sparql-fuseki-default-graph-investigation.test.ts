import {describe, expect, test, beforeAll} from '@jest/globals';
import {
  createTestDataset,
  executeSparqlUpdate,
  FUSEKI_BASE_URL,
  isFusekiAvailable,
} from '../test-helpers/fuseki-test-store';
import {Person} from '../test-helpers/query-fixtures';
import {LinkedStorage} from '../utils/LinkedStorage';

const runInvestigation =
  process.env.RUN_FUSEKI_DEFAULT_GRAPH_INVESTIGATION === '1'
    ? describe
    : describe.skip;

const DATASET = 'nashville-test';
const GRAPH = 'https://example.test/graph';
const PERSON_ID = 'https://example.test/person/1';
const CREATED_PERSON_ID = 'https://example.test/person/create-1';
const PERSON_SHAPE = () => Person.shape.id;
const NAME_PREDICATE = () => `${Person.shape.id}/name`;

let available = false;

beforeAll(async () => {
  available = await isFusekiAvailable();
  if (!available) return;
  await createTestDataset();
});

async function queryValues(sparql: string, variable = 'name'): Promise<string[]> {
  const response = await fetch(`${FUSEKI_BASE_URL}/${DATASET}/sparql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sparql-query',
      Accept: 'application/sparql-results+json',
    },
    body: sparql,
  });
  if (!response.ok) {
    throw new Error(`SPARQL query failed: ${response.status} ${await response.text()}`);
  }
  const json = await response.json();
  return json.results.bindings.map((row: any) => row[variable]?.value);
}

async function getDefaultGraphNTriples(): Promise<string> {
  const response = await fetch(`${FUSEKI_BASE_URL}/${DATASET}/data?default`, {
    headers: {
      Accept: 'application/n-triples',
    },
  });
  if (!response.ok) {
    throw new Error(`Default graph fetch failed: ${response.status} ${await response.text()}`);
  }
  return response.text();
}

async function cleanupFixture() {
  await executeSparqlUpdate(`
DELETE WHERE {
  GRAPH <${GRAPH}> {
    <${PERSON_ID}> ?p ?o .
    <${CREATED_PERSON_ID}> ?cp ?co .
  }
}
  `);
  await executeSparqlUpdate(`
DELETE WHERE {
  <${PERSON_ID}> ?p ?o .
  <${CREATED_PERSON_ID}> ?cp ?co .
}
  `);
}

async function seedNamedGraph() {
  await executeSparqlUpdate(`
INSERT DATA {
  GRAPH <${GRAPH}> {
    <${PERSON_ID}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${PERSON_SHAPE()}> .
    <${PERSON_ID}> <${NAME_PREDICATE()}> "Before" .
  }
}
  `);
}

runInvestigation('FusekiStore defaultGraph mutation investigation', () => {
  test('generic Shape.update writes to the configured readable graph', async () => {
    if (!available) return;

    const fusekiStoreModule = '../../../fuseki/src/shapes/FusekiStore' + '.ts';
    const {FusekiStore} = await import(fusekiStoreModule);
    const store = new FusekiStore({
      endpoint: `${FUSEKI_BASE_URL}/${DATASET}`,
      defaultGraph: GRAPH,
    });
    LinkedStorage.setDefaultDataset(store as any);

    await cleanupFixture();

    try {
      await seedNamedGraph();
      await Person.update({name: 'After'}).for({id: PERSON_ID});

      const namedGraphValues = await queryValues(`
SELECT ?name WHERE {
  GRAPH <${GRAPH}> {
    <${PERSON_ID}> <${NAME_PREDICATE()}> ?name .
  }
}
      `);
      const allNamedGraphRows = await queryValues(`
SELECT ?g WHERE {
  GRAPH ?g {
    <${PERSON_ID}> <${NAME_PREDICATE()}> "After" .
  }
}
      `, 'g');
      const defaultGraphTriples = await getDefaultGraphNTriples();

      expect({
        namedGraphValues,
        allNamedGraphRows,
      }).toEqual({
        namedGraphValues: ['After'],
        allNamedGraphRows: [GRAPH],
      });
      expect(defaultGraphTriples).not.toContain(
        `<${PERSON_ID}> <${NAME_PREDICATE()}> "After" .`,
      );
    } finally {
      await cleanupFixture();
    }
  }, 30000);

  test('generic Shape.create writes to the configured readable graph', async () => {
    if (!available) return;

    const fusekiStoreModule = '../../../fuseki/src/shapes/FusekiStore' + '.ts';
    const {FusekiStore} = await import(fusekiStoreModule);
    const store = new FusekiStore({
      endpoint: `${FUSEKI_BASE_URL}/${DATASET}`,
      defaultGraph: GRAPH,
    });
    LinkedStorage.setDefaultDataset(store as any);

    await cleanupFixture();

    try {
      await Person.create({
        __id: CREATED_PERSON_ID,
        name: 'Created',
      } as any);

      const namedGraphValues = await queryValues(`
SELECT ?name WHERE {
  GRAPH <${GRAPH}> {
    <${CREATED_PERSON_ID}> <${NAME_PREDICATE()}> ?name .
  }
}
      `);
      const allNamedGraphRows = await queryValues(`
SELECT ?g WHERE {
  GRAPH ?g {
    <${CREATED_PERSON_ID}> <${NAME_PREDICATE()}> "Created" .
  }
}
      `, 'g');
      const defaultGraphTriples = await getDefaultGraphNTriples();

      expect({
        namedGraphValues,
        allNamedGraphRows,
      }).toEqual({
        namedGraphValues: ['Created'],
        allNamedGraphRows: [GRAPH],
      });
      expect(defaultGraphTriples).not.toContain(
        `<${CREATED_PERSON_ID}> <${NAME_PREDICATE()}> "Created" .`,
      );
    } finally {
      await cleanupFixture();
    }
  }, 30000);
});
