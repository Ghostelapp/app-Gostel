const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('../../frontend/node_modules/typescript');
const root = process.env.GHOSTEL_MLS_TEST_URL;
if (!root || !/^http:\/\/127\.0\.0\.1:\d+$/.test(root)) throw new Error('Run scripts/test-mls-integration.py; only loopback test services are accepted');
const generated = fs.readFileSync(path.join(__dirname, '../../frontend/src/mls/runtime.generated.ts'), 'utf8');
const script = JSON.parse(generated.slice(generated.indexOf(' = ') + 3).trim().replace(/;$/, ''));
function client(user, disk = { value: null }, token = user) {
  let result, request = 0;
  const sandbox = { TextEncoder, TextDecoder, Uint8Array, WebAssembly, crypto: crypto.webcrypto, atob, setTimeout, clearTimeout, postMessage: r => { result = r; }, console };
  vm.createContext(sandbox); vm.runInContext(script, sandbox);
  assert.equal(result.ready, true);
  const faults = { loseApplicationReply: false, failSave: false };
  const api = {};
  for (const method of ['get','post','delete']) api[method] = async (url, payload, config) => {
    const options = method === 'get' ? payload : config;
    const endpoint = new URL('/api' + url, root);
    for (const [k,v] of Object.entries(options?.params || {})) endpoint.searchParams.set(k, v);
    // VM/WASM initialization is synchronous in this harness. Close sockets to
    // avoid reusing a keep-alive connection expired while Node was blocked.
    const response = await fetch(endpoint, { method: method.toUpperCase(), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' }, body: method === 'post' ? JSON.stringify(payload) : undefined });
    const data = await response.json();
    if (!response.ok) { const error = new Error(JSON.stringify(data)); error.response = { status: response.status, data }; throw error; }
    if (faults.loseApplicationReply && payload?.kind === 'application') { faults.loseApplicationReply = false; throw new Error('Simulated lost response after server commit'); }
    return { data };
  };
  const modules = {
    'expo-crypto': { randomUUID: crypto.randomUUID, getRandomBytesAsync: async n => new Uint8Array(crypto.randomBytes(n)) },
    '../api': { api },
    './runtime': { invokeMLS: async input => {
      sandbox.handleMLS({ id: ++request, input: JSON.stringify(input) });
      const parsed = JSON.parse(result.result);
      if (parsed.error) throw new Error(parsed.error);
      return parsed;
    } },
    './vault': { withVault: async (_user, action) => action(structuredClone(disk.value), async value => {
      if (faults.failSave) throw new Error('Simulated durable storage failure');
      disk.value = structuredClone(value);
    }) },
  };
  function load(name) {
    if (modules[name]) return modules[name];
    const filename = name === './encoding' ? 'encoding.ts' : 'client.ts';
    const source = fs.readFileSync(path.join(__dirname,'../../frontend/src/mls',filename),'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const context = { exports: {}, require: load, Uint8Array, Date, JSON, Map, Error, console, encodeURIComponent, decodeURIComponent, escape, unescape };
    vm.runInNewContext(compiled, context, { filename });
    return modules[name] = context.exports;
  }
  return { lib: load('./client'), api, disk, faults };
}

module.exports = { client, root };
