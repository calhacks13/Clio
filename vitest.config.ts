import { defineConfig } from 'vitest/config';

// One `pnpm test` runs every package. Domain code is framework-free, so all projects run in Node.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'protocol',
          root: './packages/protocol',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'headset',
          root: './apps/headset',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          root: './apps/server',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'scripts',
          root: './scripts',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
