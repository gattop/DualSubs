/*
 * Dual Subs - page.js (mondo MAIN)
 *
 * Coordina il lavoro nella pagina: sceglie l'adattatore della piattaforma
 * (platforms/*.js), installa gli hook per leggere l'elenco delle tracce,
 * segue la navigazione tra titoli, scarica e analizza i sottotitoli
 * (vtt-parser.js, ttml-parser.js) e li passa all'overlay (overlay.js).
 * Non ha accesso a chrome.*: comunica con content.js tramite window.postMessage.
 *
 * La tecnica degli hook su JSON.stringify / JSON.parse è adattata da Subadub
 * (https://github.com/rsimmons/subadub, dist/page_script.js).
 * Copyright (c) 2018 Russel Simmons - licenza MIT, testo completo in
 * THIRD_PARTY_NOTICES.md.
 */
(function initDualSubsPage() {
  'use strict';

  // Deve coincidere con "version" in manifest.json: serve a capire dai log
  // se la pagina sta usando il codice aggiornato
  const BUILD_VERSION = '1.2.1';
  const MSG_SOURCE = 'dual-subs';
  const LOG_PREFIX = '[DualSubs]';
  const NO_RESPONSE_WARN_MS = 20000;
  const TICK_MS = 1000;
  // Attesa prima di usare un elenco di tracce con id diverso da quello atteso
  const FALLBACK_DELAY_MS = 8000;
  // Nuovi tentativi dopo un download fallito
  const RETRY_DELAY_MS = 5000;
  const MAX_RETRIES = 3;

  const platform = (window.DualSubsPlatforms || []).find((p) => p.matches(location.hostname));
  if (!platform) return;

  const Tracks = window.DualSubsTracks;
  const Overlay = window.DualSubsOverlay;
  // Come ottenere le battute per ogni formato di traccia
  const LOADERS = {
    vtt: async (url) => window.DualSubsVtt.parseVtt((await fetchText(url)).text),
    ttml: async (url) => window.DualSubsTtml.parseTtml((await fetchText(url)).text),
    'hls-vtt': (url) => window.DualSubsHls.loadVttPlaylist(url, fetchText)
  };
  const DEBUG = readDebugFlag();

  let settings = null; // ricevute da content.js
  const trackCache = new Map(); // movieId -> tracce normalizzate
  const cueCache = new Map(); // URL dei sottotitoli -> battute
  let lastCapturedMovieId = null;
  let lastInjectionAt = 0;
  let lastCaptureAt = 0;

  let currentTitleId = null; // titolo in riproduzione, null fuori dal player
  let titleSince = 0;
  let warnedFallbackFor = null;
  let activeKey = null; // "movieId|lingua" delle battute richieste
  let loadToken = 0; // scarta i download superati da un cambio
  let loadStatus = null; // esito dell'ultimo caricamento
  let lastStatusJson = null;
  let retryKey = null; // chiave a cui si riferisce il conteggio dei tentativi
  let retryCount = 0;
  const startedTrackLoads = new Set(); // elenchi di tracce già richiesti (Disney+)

  // ---------------------------------------------------------------- utilità

  // I log dettagliati si attivano dalla console della pagina con
  // localStorage.dualSubsDebug = '1' (e si disattivano con delete)
  function readDebugFlag() {
    try {
      return window.localStorage.getItem('dualSubsDebug') === '1';
    } catch (_err) {
      return false;
    }
  }

  function log(...args) {
    if (DEBUG) console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  // Scarica un file di testo dal contesto della pagina (stessi permessi del player)
  async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status + ' per ' + url.split('?')[0]);
    return { text: await response.text(), url: response.url || url };
  }

  function postToContent(type, payload) {
    window.postMessage({ source: MSG_SOURCE, from: 'page', type, payload }, '*');
  }

  // Comunica lo stato a content.js (e quindi al popup), solo se è cambiato
  function postStatus(movieId, state, cueCount) {
    const payload = { movieId, state, cueCount: cueCount || 0 };
    const json = JSON.stringify(payload);
    if (json === lastStatusJson) return;
    lastStatusJson = json;
    postToContent('status', payload);
  }

  // ------------------------------------------------- lettura delle tracce

  // Solo Netflix: modifica la richiesta per ottenere anche il formato WebVTT
  function onStringify(value) {
    const path = platform.beforeStringify(value);
    if (!path) return;
    lastInjectionAt = Date.now();
    log('profilo WebVTT aggiunto alla richiesta in', path);
    setTimeout(checkResponseArrived, NO_RESPONSE_WARN_MS);
  }

  // Avvisa se la richiesta è stata modificata ma nessuna risposta è mai arrivata
  function checkResponseArrived() {
    if (trackCache.size === 0 && lastCaptureAt < lastInjectionAt) {
      warn('richiesta modificata ma nessun elenco di tracce intercettato');
    }
  }

  // Esamina un oggetto JSON appena letto dalla pagina
  // url: indirizzo della richiesta, quando l'hook lo conosce
  function onParsed(value, via, url) {
    const found = platform.extract(value, url);
    if (!found) return;
    lastCaptureAt = Date.now();
    if (found.loadTracks) {
      // Disney+: le tracce sono in una playlist da scaricare (una volta sola)
      if (startedTrackLoads.has(found.loadKey)) return;
      startedTrackLoads.add(found.loadKey);
      log('risposta di riproduzione per', found.movieId, '(via ' + via + '): scarico l\'elenco delle tracce');
      found.loadTracks(fetchText).then(
        (tracks) => storeTracks(found.movieId, tracks, via),
        (err) => {
          startedTrackLoads.delete(found.loadKey); // la prossima risposta riproverà
          warn('elenco delle tracce non scaricato per', found.movieId + ':', err);
        }
      );
      return;
    }
    if (!found.tracks) {
      warn('risposta riconosciuta (id ' + found.movieId + ') ma senza tracce di testo. ' +
        'Chiavi:', found.resultKeys.join(', '));
      return;
    }
    storeTracks(found.movieId, found.tracks, via);
  }

  function storeTracks(movieId, tracks, via) {
    trackCache.set(movieId, tracks);
    lastCapturedMovieId = movieId;
    // Tracce nuove per il titolo attivo dopo un esito negativo: si riprova
    const failed = loadStatus && loadStatus.movieId === movieId &&
      (loadStatus.state === 'unavailable' || loadStatus.state === 'error');
    if (failed) {
      activeKey = null;
      retryKey = null;
    }
    logTrackTable(movieId, tracks, via);
    postToContent('tracks', { movieId, tracks: Tracks.publicTracks(tracks) });
    update();
  }

  function logTrackTable(movieId, tracks, via) {
    if (!DEBUG) return;
    log(platform.name, 'id', movieId, '-', tracks.length, 'tracce di testo (via ' + via + ')');
    console.table(tracks.map((t) => ({
      id: t.id,
      lingua: t.language,
      descrizione: t.label,
      tipo: t.isClosedCaptions ? 'CC' : 'sottotitoli',
      utilizzabile: t.url ? 'sì' : 'NO',
      formati: t.formats.join(', ')
    })));
  }

  // Diagnostica: segnala le risposte "PlaybackResources" (Prime Video), con o senza tracce
  function logResourceResponse(url, value) {
    if (!DEBUG || !url || !/PlaybackResources/i.test(url)) return;
    const keys = value && typeof value === 'object' ? Object.keys(value).join(', ') : typeof value;
    log('risposta', url.split('?')[0], '- chiavi:', keys);
  }

  // Ogni hook è in try/catch e restituisce sempre il risultato originale
  function installJsonHooks() {
    if (platform.beforeStringify) {
      const originalStringify = JSON.stringify;
      JSON.stringify = function dualSubsStringify(value) {
        try {
          onStringify(value);
        } catch (err) {
          warn('errore nell\'hook di JSON.stringify:', err);
        }
        return originalStringify.apply(this, arguments);
      };
    }

    const originalParse = JSON.parse;
    JSON.parse = function dualSubsParse() {
      const value = originalParse.apply(this, arguments);
      try {
        onParsed(value, 'JSON.parse');
      } catch (err) {
        warn('errore nell\'hook di JSON.parse:', err);
      }
      return value;
    };
  }

  // fetch(...).json() non passa da JSON.parse: qui si osserva soltanto
  function installResponseJsonHook() {
    const originalJson = Response.prototype.json;
    Response.prototype.json = function dualSubsResponseJson() {
      const url = this.url;
      const promise = originalJson.apply(this, arguments);
      promise.then((value) => {
        try {
          logResourceResponse(url, value);
          onParsed(value, 'Response.json', url);
        } catch (err) {
          warn('errore nell\'hook di Response.json:', err);
        }
      }, () => {});
      return promise;
    };
  }

  // XMLHttpRequest con responseType "json" non passa da JSON.parse: qui si
  // aggiunge solo un ascoltatore di "load", la richiesta non viene toccata
  function installXhrHook() {
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function dualSubsXhrSend() {
      try {
        this.addEventListener('load', onXhrLoad);
      } catch (err) {
        warn('errore nell\'hook di XMLHttpRequest:', err);
      }
      return originalSend.apply(this, arguments);
    };
  }

  function onXhrLoad() {
    try {
      if (this.responseType !== 'json') return;
      logResourceResponse(this.responseURL, this.response);
      onParsed(this.response, 'XMLHttpRequest', this.responseURL);
    } catch (err) {
      warn('errore nella lettura della risposta XHR:', err);
    }
  }

  // ----------------------------------------------- caricamento battute

  // Scarica (o prende dalla cache) i sottotitoli scelti per il titolo
  async function loadSubtitlesFor(movieId) {
    const key = movieId + '|' + settings.language;
    if (key !== retryKey) {
      retryKey = key;
      retryCount = 0;
    }
    activeKey = key;
    const token = ++loadToken;
    Overlay.setCues([]);
    const tracks = trackCache.get(movieId) || [];
    const track = Tracks.pickTrack(tracks, settings.language);
    if (!track) {
      log('lingua "' + settings.language + '" non disponibile per', movieId);
      return setLoadStatus(movieId, 'unavailable');
    }
    if (cueCache.has(track.url)) return applyCues(movieId, cueCache.get(track.url));
    log('scarico', track.label, '(' + track.language + ', ' + track.format + ') per', movieId);
    setLoadStatus(movieId, 'loading');
    try {
      const cues = await LOADERS[track.format](track.url);
      if (token !== loadToken) return; // nel frattempo sono cambiati titolo o lingua
      if (!cues.length) warn('sottotitoli scaricati ma 0 battute riconosciute (' + track.format + ')');
      if (cues.length) cueCache.set(track.url, cues);
      applyCues(movieId, cues);
    } catch (err) {
      if (token !== loadToken) return;
      warn('download dei sottotitoli fallito:', err);
      setLoadStatus(movieId, 'error');
      scheduleRetry(key);
    }
  }

  // Dopo un errore riprova qualche volta: gli indirizzi dei sottotitoli scadono
  // e la rete può avere un problema momentaneo
  function scheduleRetry(key) {
    if (retryCount >= MAX_RETRIES) return;
    retryCount++;
    setTimeout(() => {
      if (activeKey !== key) return; // nel frattempo sono cambiati titolo o lingua
      activeKey = null;
      tick();
    }, RETRY_DELAY_MS);
  }

  function applyCues(movieId, cues) {
    if (cues.length) {
      log(cues.length, 'battute pronte (' + settings.language + '). Prima a',
        cues[0].start.toFixed(1) + ' s:', cues[0].text);
    }
    Overlay.setCues(cues);
    setLoadStatus(movieId, 'loaded', cues.length);
  }

  function setLoadStatus(movieId, state, cueCount) {
    loadStatus = { movieId, state, cueCount };
    postStatus(movieId, state, cueCount);
  }

  // Dimentica le battute correnti (cambio titolo o uscita)
  function resetSubtitles() {
    loadToken++;
    activeKey = null;
    retryKey = null;
    loadStatus = null;
    Overlay.setCues([]);
  }

  // ------------------------------------------------------ navigazione

  // Le piattaforme sono single page app: il titolo cambia senza ricaricare
  function onTitleMaybeChanged() {
    const titleId = platform.currentTitle({ lastCapturedMovieId });
    if (titleId === currentTitleId) return;
    const previous = currentTitleId;
    currentTitleId = titleId;
    titleSince = Date.now();
    if (titleId) {
      enterTitle(titleId, previous);
    } else {
      leavePlayer();
    }
  }

  // Nuovo titolo o episodio successivo
  function enterTitle(titleId, previous) {
    log(previous ? 'cambio titolo: ' + previous + ' -> ' + titleId : 'titolo in riproduzione: ' + titleId);
    resetSubtitles();
    Overlay.start();
    postStatus(null, 'waiting');
    update();
  }

  // Uscita dal player (ritorno al catalogo)
  function leavePlayer() {
    log('uscita dal player');
    resetSubtitles();
    Overlay.stop();
    postStatus(null, 'idle');
  }

  // Tracce del titolo corrente. Se l'id non corrisponde a nessun elenco
  // intercettato, dopo un'attesa si ripiega sull'ultimo arrivato.
  function resolveMovieId() {
    if (trackCache.has(currentTitleId)) return currentTitleId;
    if (!lastCapturedMovieId || Date.now() - titleSince < FALLBACK_DELAY_MS) return null;
    if (warnedFallbackFor !== currentTitleId) {
      warnedFallbackFor = currentTitleId;
      warn('nessun elenco di tracce per l\'id ' + currentTitleId + ': uso l\'ultimo, ' + lastCapturedMovieId);
    }
    return lastCapturedMovieId;
  }

  // Porta lo stato dove deve essere in base a titolo, tracce e impostazioni
  function update() {
    onTitleMaybeChanged();
    if (!settings || !currentTitleId) return;
    const movieId = resolveMovieId();
    if (!movieId) return postStatus(null, 'waiting');
    if (!settings.enabled) return postStatus(movieId, 'disabled');
    if (movieId + '|' + settings.language !== activeKey) return loadSubtitlesFor(movieId);
    if (loadStatus) postStatus(loadStatus.movieId, loadStatus.state, loadStatus.cueCount);
  }

  // Controllo periodico di sicurezza, oltre agli eventi di navigazione
  function tick() {
    try {
      update();
    } catch (err) {
      warn('errore nel controllo periodico:', err);
    }
  }

  function installNavigationHooks() {
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      history[name] = function dualSubsHistory() {
        const result = original.apply(this, arguments);
        tick();
        return result;
      };
    }
    window.addEventListener('popstate', tick);
  }

  // -------------------------------------------- messaggi da content.js

  function onWindowMessage(event) {
    const data = event.data;
    if (event.source !== window || !data || data.source !== MSG_SOURCE) return;
    if (data.from !== 'content' || data.type !== 'settings') return;
    settings = data.payload;
    log('impostazioni:', JSON.stringify(settings));
    Overlay.setSettings(settings);
    tick();
  }

  // ---------------------------------------------------------------- avvio

  installJsonHooks();
  installResponseJsonHook();
  installXhrHook();
  installNavigationHooks();
  Overlay.init({
    log,
    warn,
    findVideo: platform.findVideo,
    getTime: platform.getTime || ((video) => video.currentTime),
    debugInfo: platform.debugInfo || (() => ''),
    containerSelectors: platform.containerSelectors
  });
  window.addEventListener('message', onWindowMessage);
  setInterval(tick, TICK_MS);
  log('page.js v' + BUILD_VERSION + ' caricato su ' + platform.name);
  postToContent('page-ready', null);
})();
