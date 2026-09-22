import { defineConfig } from 'tsup'

// One bundle, two consumers: `dist/cli.js` is the `dsh-ppt` bin, and the same
// entry is what the DSH skill preamble invokes as `node <abs>/dist/cli.js`.
// The plugin shell (`dsh/index.js`) stays plain dependency-free JS by design and
// is therefore not a tsup entry.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  banner: { js: '#!/usr/bin/env node' },
})
