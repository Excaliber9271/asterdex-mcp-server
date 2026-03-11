/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],

  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.mcp.json',
        isolatedModules: true,
      },
    ],
  },

  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.spec.ts',
    '**/tests/**/*.test.ts',
    '**/tests/**/*.spec.ts',
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '.*\\.mjs$',  // Ignore legacy .mjs test files
  ],

  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/mcp-server.ts',  // Too large to unit test directly - test through integrations
  ],

  coverageDirectory: 'coverage',

  coverageThreshold: {
    global: {
      branches: 30,
      functions: 30,
      lines: 30,
      statements: 30,
    },
  },

  // CI-friendly settings
  verbose: true,
  bail: false,
  passWithNoTests: true,

  // Timeout for slow tests
  testTimeout: 30000,
};
