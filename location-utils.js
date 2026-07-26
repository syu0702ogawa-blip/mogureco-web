(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LocationUtils = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function parseCoordinate(value, min, max) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
  }

  function coordinatesFromValues(latValue, lngValue) {
    const lat = parseCoordinate(latValue, -90, 90);
    const lng = parseCoordinate(lngValue, -180, 180);
    if (lat === null || lng === null) return null;
    // Older versions could turn two empty fields into 0,0. It is never a usable restaurant location.
    if (lat === 0 && lng === 0) return null;
    return { lat, lng };
  }

  function recordCoordinates(record) {
    return coordinatesFromValues(record?.lat, record?.lng);
  }

  function googleMapsUrl(record) {
    const coords = recordCoordinates(record);
    const textQuery = [record?.name, record?.address]
      .map(value => String(value ?? '').trim())
      .filter(Boolean)
      .join(' ');
    const query = coords ? `${coords.lat},${coords.lng}` : textQuery || '飲食店';
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  }

  function normalizeRecordCoordinates(record) {
    const coords = recordCoordinates(record);
    return { ...record, lat: coords?.lat ?? null, lng: coords?.lng ?? null };
  }

  function recordsWithValidCoordinates(records) {
    return (records || []).map(record => ({ record, coords: recordCoordinates(record) })).filter(item => item.coords);
  }

  return {
    parseCoordinate,
    coordinatesFromValues,
    recordCoordinates,
    googleMapsUrl,
    normalizeRecordCoordinates,
    recordsWithValidCoordinates,
  };
}));
