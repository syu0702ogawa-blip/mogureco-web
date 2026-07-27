(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NavigationUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const VIEWS = new Set(['records', 'map', 'settings']);

  function viewFromUrl(url, base = 'https://example.invalid/') {
    const value = new URL(url, base).searchParams.get('view');
    return VIEWS.has(value) ? value : 'records';
  }

  function urlForView(url, view, base = 'https://example.invalid/') {
    const next = new URL(url, base);
    next.searchParams.set('view', VIEWS.has(view) ? view : 'records');
    next.searchParams.delete('record');
    return `${next.pathname}${next.search}${next.hash}`;
  }

  function createRouter({ location, history, render }) {
    const show = () => render(viewFromUrl(location.href), new URL(location.href).searchParams.get('record'));
    return {
      start(target) { target.addEventListener('popstate', show); show(); },
      navigate(view) { history.pushState({}, '', urlForView(location.href, view)); show(); },
      show,
    };
  }

  return { viewFromUrl, urlForView, createRouter };
});
