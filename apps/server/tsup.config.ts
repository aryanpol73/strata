import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  clean: true,
  // The shared package ships as TypeScript source, so it's compiled into the server bundle.
  noExternal: ['@strata/shared'],
});
