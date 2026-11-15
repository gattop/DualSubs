/*
 * Dual Subs - platforms/netflix.js (mondo MAIN)
 *
 * Adattatore per Netflix. Aggiunge il profilo WebVTT alla richiesta del
 * manifest (hook su JSON.stringify) e legge le tracce dalla risposta.
 * Le funzioni sui dati sono pure e testate in Node.
 *
 * Il riconoscimento della lista dei profili e l'estrazione delle tracce sono
 * adattati da Subadub (https://github.com/rsimmons/subadub, dist/page_script.js).
 * Copyright (c) 2018 Russel Simmons - licenza MIT, testo completo in
 * THIRD_PARTY_NOTICES.md.
 */
(function exportNetflix(root) {
  'use strict';

  const WEBVTT_PROFILE = 'webvtt-lssdh-ios8';

  // Profili noti di Netflix: servono a riconoscere la lista dei profili per contenuto
  const KNOWN_PROFILES = [
    'heaac-2-dash', 'heaac-2hq-dash',
    'playready-h264mpl30-dash', 'playready-h264mpl31-dash',
    'playready-h264hpl30-dash', 'playready-h264hpl31-dash',
    'vp9-profile0-L30-dash-cenc', 'vp9-profile0-L31-dash-cenc',
    'dfxp-ls-sdh', 'simplesdh', 'nflx-cmisc', 'imsc1.1', 'BIF240', 'BIF320'
  ];
  // Riconoscimento di riserva, se Netflix cambia l'elenco dei profili
  const PROFILE_PATTERN = /(-dash|dfxp|simplesdh|imsc|webvtt|nflx-cmisc|^BIF\d)/i;
  const MAX_SEARCH_DEPTH = 8;

  // Possibili contenitori del player, dal più specifico al più generico
  const CONTAINER_SELECTORS = [
    '.watch-video--player-view',
    '[data-uia="player"]',
    '.watch-video'
  ];

  // ------------------------------------------- richiesta del manifest

  // Un array è la lista dei profili se contiene solo stringhe e almeno un profilo noto
  function isProfileList(value) {
    if (!Array.isArray(value) || value.length === 0) return false;
    if (!value.every((item) => typeof item === 'string')) return false;
    return value.some((item) => KNOWN_PROFILES.includes(item) || PROFILE_PATTERN.test(item));
  }

  // Ricerca ricorsiva per contenuto, non per nome della proprietà
  function searchProfileList(obj, path, depth, seen) {
    if (!obj || typeof obj !== 'object' || depth > MAX_SEARCH_DEPTH || seen.has(obj)) return null;
    seen.add(obj);
    if (isProfileList(obj)) return { list: obj, path };
    for (const key of Object.keys(obj)) {
      const found = searchProfileList(obj[key], path + '.' + key, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  // Aggiunge il profilo WebVTT in testa alla lista dei profili, se c'è e se manca.
  // Restituisce il percorso della lista modificata (per i log) oppure null.
  function injectWebvttProfile(value) {
    if (!value || typeof value !== 'object') return null;
    const found = searchProfileList(value, '$', 0, new WeakSet());
    if (!found || found.list.includes(WEBVTT_PROFILE)) return null;
    found.list.unshift(WEBVTT_PROFILE);
    return found.path;
  }

  // ------------------------------------------- risposta del manifest

  // Primo URL, sia dalla forma nuova (array di {url}) sia dalla vecchia (oggetto)
  function firstUrl(urls) {
    if (!urls) return null;
    const first = Array.isArray(urls) ? urls[0] : Object.values(urls)[0];
    if (!first) return null;
    return typeof first === 'string' ? first : first.url || null;
  }

  // Riduce una traccia di Netflix (campi nuovi o vecchi) al formato comune
  function normalizeTrack(track) {
    const downloadables = track.downloadables || track.ttDownloadables || {};
    const webvtt = downloadables[WEBVTT_PROFILE];
    return {
      id: track.id != null ? track.id : track.new_track_id,
      language: track.language || '',
      label: track.languageDescription || track.language || '?',
      isClosedCaptions: track.rawTrackType === 'closedcaptions',
      url: webvtt ? firstUrl(webvtt.urls) : null,
      format: 'vtt',
      formats: Object.keys(downloadables)
    };
  }

  function isUsableTrack(track) {
    return Boolean(track) && !track.isForcedNarrative && !track.isNoneTrack;
  }

  // Se l'oggetto è la risposta del manifest restituisce
  // { movieId, tracks (null se non trovate), resultKeys }, altrimenti null
  function extractManifest(value) {
    const result = value && value.result;
    if (!result || typeof result !== 'object' || !result.movieId) return null;
    const rawTracks = result.textTracks || result.timedtexttracks;
    return {
      movieId: String(result.movieId),
      tracks: Array.isArray(rawTracks) ? rawTracks.filter(isUsableTrack).map(normalizeTrack) : null,
      resultKeys: Object.keys(result)
    };
  }

  // ------------------------------------------- pagina

  // Id del titolo in riproduzione, dall'URL /watch/<id>; null fuori dal player
  function currentTitle() {
    const m = /\/watch\/(\d+)/.exec(root.location.pathname);
    return m ? m[1] : null;
  }

  function findVideo() {
    return root.document.querySelector('video');
  }

  const adapter = {
    name: 'netflix',
    matches: (hostname) => /(^|\.)netflix\.com$/.test(hostname),
    beforeStringify: injectWebvttProfile,
    extract: extractManifest,
    currentTitle,
    findVideo,
    containerSelectors: CONTAINER_SELECTORS
  };

  const api = { WEBVTT_PROFILE, isProfileList, injectWebvttProfile, firstUrl, extractManifest, adapter };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    (root.DualSubsPlatforms = root.DualSubsPlatforms || []).push(adapter);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
