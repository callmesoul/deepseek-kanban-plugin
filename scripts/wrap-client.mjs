import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MODULE_ID = '@deepseek-kanban/plugin';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = join(root, 'lib', 'client.raw.js');
const out = join(root, 'lib', 'client.js');

if (!existsSync(raw)) {
  console.error('wrap-client: lib/client.raw.js not found — run `vite build` first');
  process.exit(1);
}

const body = readFileSync(raw, 'utf8');

// Rollup CJS output references `require` (externals), `module` and `exports`.
// We provide all three as factory-local bindings, exactly like the shipped
// DSH client bundles. The factory body contains no top-level side effects:
// CSS is injected only when `apply` materializes the module.
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(MODULE_ID)},
  factory: function(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
    return module.exports;
  }
});
`;

writeFileSync(out, wrapped);
console.log(`wrap-client: wrote ${out} (${(wrapped.length / 1024).toFixed(1)} KiB)`);
