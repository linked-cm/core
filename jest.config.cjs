/** @type {import('ts-jest/dist/types').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src/tests'],
  testMatch: ['<rootDir>/src/tests/*.test.ts'],
  globalSetup: '<rootDir>/src/tests/global-setup.ts',
  globalTeardown: '<rootDir>/src/tests/global-teardown.ts',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  // Strip the `.js` extension from relative ESM imports so ts-jest resolves the
  // `.ts` source (NodeNext-style specifiers carry `.js`; jest maps back to src).
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
