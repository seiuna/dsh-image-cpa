import { build } from 'esbuild';

/**
 * The client half is served as one CommonJS bundle wrapped in the DSH module
 * loader envelope, exactly like the shipped client plugins: the loader hands the
 * factory a `require` that resolves React and the harness client packages.
 */
const banner = [
  'window.__ModuleLoader__.load({ id: "dsh-cpa-image", factory: (require) => {',
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n');
const footer = 'return module.exports; } });';

await build({
  entryPoints: ['src/ui/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  external: ['react', 'react-dom', '@deepseek-ai/*'],
  banner: { js: banner },
  footer: { js: footer },
  logLevel: 'info',
});
