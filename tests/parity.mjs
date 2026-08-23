// Prints the panel's buildEngine() output for a model read from stdin, so the Python
// engine can be diffed against the JavaScript one that ships in the same release.
import fs from 'node:fs';
import path from 'node:path';

const panel = path.join(import.meta.dirname, '..', 'custom_components', 'ha_scheduler',
                        'frontend', 'ha-scheduler-panel.js');
const src = fs.readFileSync(panel, 'utf8');

// The file registers a custom element on load; stub just enough for that to succeed.
globalThis.HTMLElement = class { attachShadow() { return {}; } };
globalThis.customElements = { define() {} };
globalThis.window = { customCards: [] };
console.info = () => {};

const model = JSON.parse(fs.readFileSync(0, 'utf8'));
const out = new Function('MODEL', src + '\nreturn buildEngine(MODEL);')(model);
process.stdout.write(JSON.stringify(out));
