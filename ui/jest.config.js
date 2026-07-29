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
    '^react-markdown$': '<rootDir>/test/__mocks__/react-markdown.tsx',
    '^remark-gfm$': '<rootDir>/test/__mocks__/esm-plugin.tsx',
    '^rehype-highlight$': '<rootDir>/test/__mocks__/esm-plugin.tsx',
    '^@/components/markdown$': '<rootDir>/test/__mocks__/markdown.tsx',
    '^preact-iso$': '<rootDir>/test/__mocks__/preact-iso.tsx',
    '^@/pages/wiki-view$': '<rootDir>/test/__mocks__/wiki-view.tsx',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^react-dom/test-utils$': 'preact/test-utils',
    '^react-dom$': 'preact/compat',
    '^react/jsx-runtime$': 'preact/jsx-runtime',
    '^react$': 'preact/compat',
    '^lucide-react$': 'lucide-preact',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  testMatch: ['<rootDir>/test/**/*.test.tsx', '<rootDir>/test/**/*.test.ts'],
};
