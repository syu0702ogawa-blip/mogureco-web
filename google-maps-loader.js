(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GoogleMapsLoader = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function createGoogleMapsLoader({ window, document, getApiKey }) {
    let pending = null;
    return {
      load() {
        const key = getApiKey()?.trim();
        if (!key) return Promise.reject(new Error('Google Maps APIキーが未設定です'));
        if (window.google?.maps?.importLibrary) return Promise.resolve(window.google.maps);
        if (pending) return pending;
        pending = new Promise((resolve, reject) => {
          const callback = `__mogurecoMapsReady_${Date.now()}`;
          const script = document.createElement('script');
          const finish = (error) => {
            clearTimeout(timer);
            delete window[callback];
            if (error) { script.remove(); reject(error); } else resolve(window.google.maps);
          };
          const timer = setTimeout(() => finish(new Error('Google Maps APIの読み込みがタイムアウトしました')), 15000);
          window[callback] = () => finish();
          script.async = true;
          script.dataset.mogurecoGoogleMaps = 'true';
          script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&libraries=places,marker&language=ja&region=JP&v=weekly&callback=${callback}`;
          script.onerror = () => finish(new Error('Google Maps APIを読み込めませんでした'));
          document.head.appendChild(script);
        }).catch(error => { pending = null; throw error; });
        return pending;
      },
    };
  }
  return { createGoogleMapsLoader };
});
