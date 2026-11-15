/*
 * Dual Subs - platforms/prime.js (mondo MAIN)
 *
 * Adattatore per Prime Video (primevideo.com e amazon.<paese>/gp/video).
 * Il player chiede le risorse di riproduzione a GetVodPlaybackResources; la
 * risposta contiene timedTextUrls.result.subtitleUrls con un file TTML per
 * lingua. Qui si legge soltanto quella risposta: nessuna richiesta modificata.
 * Le funzioni sui dati sono pure e testate in Node.
 *
 * Struttura della risposta ricavata dallo userscript "Amazon Video - subtitle
 * downloader" di Tithen-Firion (licenza MIT, vedi THIRD_PARTY_NOTICES.md).
 */
(function exportPrime(root) {
  'use strict';

  // Contenitori del web player di Prime Video (da verificare sul sito)
  const PLAYER_SELECTORS = [
    '.webPlayerSDKContainer',
    '.webPlayerContainer',
    '#dv-web-player',
    '[id^="dv-web-player"]'
  ];
  // Elemento con l'orario mostrato nei controlli (da verificare sul sito)
  const TIME_INDICATOR_SELECTOR = '.atvwebplayersdk-timeindicator-text';
  // Domini Amazon con Prime Video (devono coincidere con manifest.json)
  const AMAZON_HOST_RE = /(^|\.)amazon\.(com|co\.uk|de|it|fr|es|co\.jp|ca|com\.au|com\.br|com\.mx|in|nl|se|pl)$/;
  // Fuori da un contenitore noto, un video è "il player" se è largo almeno così
  const MIN_PLAYER_WIDTH_RATIO = 0.6;

  // ------------------------------------------- risposta delle risorse

  // Tipi Amazon: Subtitle, Sdh (per non udenti), SubtitleMachineGenerated, ForcedNarrative
  function isUsableSubtitle(sub) {
    if (!sub || typeof sub !== 'object' || !sub.languageCode) return false;
    if (sub.type === 'ForcedNarrative') return false;
    return !sub.subtype || sub.subtype === 'Dialog';
  }

  // Riduce una traccia di Prime Video al formato comune
  function normalizeTrack(sub) {
    const machine = sub.type === 'SubtitleMachineGenerated';
    const label = (sub.displayName || sub.languageCode) + (machine ? ' [auto]' : '');
    return {
      id: sub.timedTextTrackId || sub.trackGroupId || sub.url,
      language: sub.languageCode,
      label,
      isClosedCaptions: sub.type === 'Sdh',
      url: typeof sub.url === 'string' ? sub.url : null,
      format: 'ttml',
      formats: [sub.format || '?']
    };
  }

  // Parametro titleId dell'indirizzo della richiesta, se disponibile
  function titleIdFromUrl(url) {
    const m = /[?&]titleId=([^&#]+)/.exec(url || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Identificativo del titolo: dalla richiesta, dal catalogo, o dal primo URL
  function titleIdOf(value, subtitleUrls, url) {
    const fromUrl = titleIdFromUrl(url);
    if (fromUrl) return fromUrl;
    const catalog = value.catalogMetadata && value.catalogMetadata.catalog;
    if (catalog && catalog.id) return String(catalog.id);
    const first = subtitleUrls.find((s) => s && s.url);
    return first ? 'prime:' + first.url.split('?')[0].split('/').slice(-2).join('/') : 'prime:unknown';
  }

  // Se l'oggetto è la risposta delle risorse di riproduzione restituisce
  // { movieId, tracks (null se non trovate), resultKeys }, altrimenti null.
  // url: indirizzo della richiesta, quando l'hook lo conosce
  function extractPlaybackResources(value, url) {
    if (!value || typeof value !== 'object' || !('timedTextUrls' in value)) return null;
    const result = value.timedTextUrls && value.timedTextUrls.result;
    const subtitleUrls = result && Array.isArray(result.subtitleUrls) ? result.subtitleUrls : null;
    return {
      movieId: titleIdOf(value, subtitleUrls || [], url),
      tracks: subtitleUrls ? subtitleUrls.filter(isUsableSubtitle).map(normalizeTrack) : null,
      resultKeys: Object.keys(result || value.timedTextUrls || {})
    };
  }

  // ------------------------------------------- pagina

  function isVisible(video) {
    return video.isConnected && video.clientWidth > 0 && video.clientHeight > 0;
  }

  // Il video più grande tra quelli visibili dentro l'elemento indicato
  function biggestVideo(scope) {
    let best = null;
    for (const video of scope.querySelectorAll('video')) {
      if (!isVisible(video)) continue;
      if (!best || video.clientWidth * video.clientHeight > best.clientWidth * best.clientHeight) best = video;
    }
    return best;
  }

  // Il video del player: prima nei contenitori noti, poi un video molto largo
  function findVideo() {
    const doc = root.document;
    for (const selector of PLAYER_SELECTORS) {
      const container = doc.querySelector(selector);
      const video = container && biggestVideo(container);
      if (video) return video;
    }
    const video = biggestVideo(doc);
    return video && video.clientWidth >= root.innerWidth * MIN_PLAYER_WIDTH_RATIO ? video : null;
  }

  // Il player si apre sopra la pagina del titolo, senza cambiare URL: il titolo
  // corrente è l'ultimo per cui sono arrivate le risorse, se il player è visibile
  function currentTitle(context) {
    return findVideo() ? context.lastCapturedMovieId : null;
  }

  // Per i log: l'orario mostrato dal player (es. "12:34 / 1:45:00"), da
  // confrontare con il tempo del video per scoprire uno sfasamento costante
  function debugInfo() {
    const el = root.document.querySelector(TIME_INDICATOR_SELECTOR);
    const shown = el && el.textContent ? el.textContent.trim() : 'non trovato';
    return ', orario mostrato dal player: ' + shown;
  }

  const adapter = {
    name: 'prime',
    matches: (hostname) => /(^|\.)primevideo\.com$/.test(hostname) || AMAZON_HOST_RE.test(hostname),
    beforeStringify: null,
    extract: extractPlaybackResources,
    currentTitle,
    findVideo,
    debugInfo,
    containerSelectors: PLAYER_SELECTORS
  };

  const api = { extractPlaybackResources, adapter };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    (root.DualSubsPlatforms = root.DualSubsPlatforms || []).push(adapter);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
