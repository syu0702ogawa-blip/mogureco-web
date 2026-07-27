const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleMapsLoader } = require('../google-maps-loader');

function environment(key = '') {
  const appended = [];
  const window = {};
  const document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild(script) { appended.push(script); const cb = new URL(script.src).searchParams.get('callback'); window.google = { maps: { importLibrary() {} } }; queueMicrotask(() => window[cb]()); } } };
  return { window, document, appended, loader: createGoogleMapsLoader({ window, document, getApiKey: () => key }) };
}
test('APIキー未設定時はスクリプトを読み込まない', async () => {
  const env = environment(); await assert.rejects(env.loader.load(), /未設定/); assert.equal(env.appended.length, 0);
});
test('Google Maps APIスクリプトを重複ロードしない', async () => {
  const env = environment('secret'); await Promise.all([env.loader.load(), env.loader.load()]); assert.equal(env.appended.length, 1);
});
