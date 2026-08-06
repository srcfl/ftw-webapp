// Vendored from srcfl/ftw web/components/api-fetch.js at da6a1018.
// Do not edit here — change it upstream and re-copy. The app and the
// box's own dashboard render this exact file; that is the point.
// Shared local API accessor for web components.
export function apiFetch(path, opts) {
  return fetch(path, opts);
}
