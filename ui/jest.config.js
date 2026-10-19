/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testEnvironmentOptions: {
    customExportConditions: [''],
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '\\.(css|less|scss)$': 'identity-obj-proxy',
    '^@tkottke90/llm-common-types/(.*)$': '<rootDir>/test/__mocks__/llm-common-types/$1.ts',
    '^@tkottke90/amazing-hashbrown-widgets/types$':
      '<rootDir>/test/__mocks__/amazing-hashbrown-widgets-types.ts',
    '^react-markdown$': '<rootDir>/test/__mocks__/react-markdown.tsx',
    '^remark-gfm$': '<rootDir>/test/__mocks__/esm-plugin.tsx',
    '^rehype-highlight$': '<rootDir>/test/__mocks__/esm-plugin.tsx',
    '^@/components/markdown$': '<rootDir>/test/__mocks__/markdown.tsx',
    '^preact-iso$': '<rootDir>/test/__mocks__/preact-iso.tsx',
    '^@/pages/wiki$': '<rootDir>/test/__mocks__/wiki-view.tsx',
    '^@/pages/settings$': '<rootDir>/test/__mocks__/settings-view.tsx',
    '^@tkottke90/preact-dialog$': '<rootDir>/test/__mocks__/preact-dialog.tsx',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^react-dom/test-utils$': 'preact/test-utils',
    '^react-dom$': 'preact/compat',
    '^react/jsx-runtime$': 'preact/jsx-runtime',
    '^react$': 'preact/compat',
    '^lucide-react$': 'lucide-preact',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
    // The D3 packages Line/Pie Graph widgets render with (and their own
    // dependencies) ship ESM-only, with no CJS/UMD build Jest's default
    // node_modules-is-ignored transform setup can load directly — unlike
    // d3-force/d3-selection/d3-drag/d3-zoom (the Wiki graph's D3 packages,
    // identical in that respect), which happened to never be exercised by
    // a Jest-run import path before. Transpile just these via ts-jest with
    // its own override config (not the shared tsconfig, which isn't meant
    // for third-party JS) rather than adding a Babel dependency.
    '/node_modules/(d3-[a-z-]+|internmap)/.+\\.js$': [
      'ts-jest',
      { tsconfig: { allowJs: true, module: 'commonjs', target: 'es2019' } },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!d3-[a-z-]+|internmap)'],
  testMatch: ['<rootDir>/test/**/*.test.tsx', '<rootDir>/test/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts'],
  coverageReporters: ['lcov', 'text'],
};
