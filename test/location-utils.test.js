'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  coordinatesFromValues,
  googleMapsUrl,
  normalizeRecordCoordinates,
} = require('../location-utils.js');

test('null and undefined coordinates are invalid', () => {
  assert.equal(coordinatesFromValues(null, null), null);
  assert.equal(coordinatesFromValues(undefined, 141.3545), null);
});

test('empty and NaN coordinates are invalid', () => {
  assert.equal(coordinatesFromValues('', '  '), null);
  assert.equal(coordinatesFromValues(Number.NaN, 141.3545), null);
});

test('0,0 is invalid', () => {
  assert.equal(coordinatesFromValues(0, 0), null);
  assert.equal(coordinatesFromValues('0', '0'), null);
});

test('a valid Sapporo coordinate is accepted', () => {
  assert.deepEqual(coordinatesFromValues('43.0618', '141.3545'), { lat: 43.0618, lng: 141.3545 });
});

test('a map URL without coordinates searches by shop name and address', () => {
  const url = googleMapsUrl({ name: '札幌食堂', address: '北海道札幌市中央区北1条西2丁目', lat: null, lng: '' });
  const query = new URL(url).searchParams.get('query');
  assert.equal(query, '札幌食堂 北海道札幌市中央区北1条西2丁目');
  assert.equal(url.includes('null%2Cnull'), false);
  assert.equal(url.includes('0%2C0'), false);
});

test('0,0 never appears in a map URL and falls back to text search', () => {
  const url = googleMapsUrl({ name: '旧店舗', address: '札幌市', lat: 0, lng: 0 });
  assert.equal(new URL(url).searchParams.get('query'), '旧店舗 札幌市');
});

test('legacy normalization preserves name, address, memo, photos and extra fields', () => {
  const photos = [{ name: 'meal.jpg', dataUrl: 'data:image/jpeg;base64,abc' }];
  const legacy = {
    id: 'legacy-1', name: '昔の店', address: '札幌市中央区', memo: '大切なメモ',
    photos, lat: '', lng: undefined, customLegacyField: 'keep-me',
  };
  const normalized = normalizeRecordCoordinates(legacy);
  assert.equal(normalized.name, legacy.name);
  assert.equal(normalized.address, legacy.address);
  assert.equal(normalized.memo, legacy.memo);
  assert.strictEqual(normalized.photos, photos);
  assert.equal(normalized.customLegacyField, 'keep-me');
  assert.equal(normalized.lat, null);
  assert.equal(normalized.lng, null);
});
