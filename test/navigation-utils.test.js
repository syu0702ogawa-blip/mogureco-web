const test = require('node:test');
const assert = require('node:assert/strict');
const { viewFromUrl, createRouter } = require('../navigation-utils');

test('view指定なしと不正値は記録画面になる', () => {
  assert.equal(viewFromUrl('https://example.com/app/'), 'records');
  assert.equal(viewFromUrl('https://example.com/app/?view=unknown'), 'records');
});
test('mapとsettingsのviewを解決する', () => {
  assert.equal(viewFromUrl('https://example.com/?view=map'), 'map');
  assert.equal(viewFromUrl('https://example.com/?view=settings'), 'settings');
});
test('pushStateとpopstateで画面を切り替える', () => {
  const listeners = {}; const shown = [];
  const location = { href: 'https://example.com/app/' };
  const history = { pushState(_s, _t, url) { location.href = new URL(url, location.href).href; } };
  const target = { addEventListener(name, fn) { listeners[name] = fn; } };
  const router = createRouter({ location, history, render: view => shown.push(view) });
  router.start(target); router.navigate('map');
  location.href = 'https://example.com/app/?view=settings'; listeners.popstate();
  assert.deepEqual(shown, ['records', 'map', 'settings']);
});
