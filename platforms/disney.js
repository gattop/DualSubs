/*
 * Dual Subs - platforms/disney.js (mondo MAIN)
 *
 * Adattatore per Disney+. La risposta di riproduzione contiene l'URL della
 * playlist HLS principale (stream.sources[0].complete.url): da lì si leggono le
 * tracce di sottotitoli (hls.js). Il tempo del programma non è
 * video.currentTime (pubblicità e sigle lo spostano): si legge dal player.
 *
 * I dettagli sul funzionamento di Disney+ (posizione dell'URL della playlist,
 * orologio del player, stato delle interruzioni) sono stati ricavati studiando
 * il progetto DualSub (https://github.com/QuellaMC/DualSub); nessun codice è
 * stato copiato.
 */
(function exportDisney(root) {
  'use strict';

  const Hls = typeof module === 'object' && module.exports ? require('../hls.js') : root.DualSubsHls;

  // Elementi personalizzati del player che espongono stato e orologio
  const PLAYER_UI_SELECTOR = 'disney-web-player-ui';
  const CONTROLS_SELECTOR = 'main-app-controls-overlay';
  const ROUTE_RE = /\/(?:video|play)\/([^/?#]+)\/?$/;
  // Oltre questa differenza i due orologi non sono più considerati d'accordo
  const CLOCK_JUMP_S = 1.5;
  // Spostamento minimo del playhead per considerarlo aggiornato dopo un salto
  const PLAYHEAD_MOVED_S = 0.5;
  const NO_PLAYHEAD_WARN_S = 5;

  // ------------------------------------------- risposta di riproduzione

  // URL della playlist principale, nella risposta o sotto "data"
  function readMasterUrl(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const container = value.data && typeof value.data === 'object' ? value.data : value;
    const stream = container.stream;
    const source = stream && Array.isArray(stream.sources) ? stream.sources[0] : null;
    const url = source && source.complete && source.complete.url;
    return typeof url === 'string' && url ? url : null;
  }

  // Id del titolo dal percorso /play/<id> o /video/<id>
  function routeId(pathname) {
    const m = ROUTE_RE.exec(pathname || '');
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (_err) {
      return m[1];
    }
  }

  // Se l'oggetto è una risposta di riproduzione: { movieId, masterUrl }, altrimenti null
  function extractPlayback(value, pathname) {
    const masterUrl = readMasterUrl(value);
    if (!masterUrl) return null;
    return { movieId: routeId(pathname) || 'disney:' + masterUrl.split('?')[0], masterUrl };
  }

  // Versione per page.js: le tracce si leggono scaricando la playlist principale
  function extract(value) {
    const found = extractPlayback(value, root.location.pathname);
    if (!found) return null;
    return {
      movieId: found.movieId,
      resultKeys: [],
      loadKey: found.movieId + '|' + found.masterUrl, // per non scaricare due volte la stessa playlist
      loadTracks: async (fetchText) => {
        const master = await fetchText(found.masterUrl);
        return Hls.parseMasterSubtitles(master.text, master.url || found.masterUrl);
      }
    };
  }

  // ------------------------------------------- pagina

  // Disney+ monta più video (anche anteprime): si sceglie quello che sta
  // davvero riproducendo, il più grande a parità di condizioni
  function videoScore(video) {
    const area = video.clientWidth * video.clientHeight;
    if (!video.isConnected || area === 0) return -1;
    let score = Math.min(area / 10000, 100);
    if (video.readyState >= 2) score += 40;
    if (!video.paused && !video.ended) score += 30;
    if (video.currentTime > 0) score += 10;
    return score;
  }

  function findVideo() {
    let best = null;
    let bestScore = -1;
    for (const video of root.document.querySelectorAll('video')) {
      const score = videoScore(video);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
  }

  function currentTitle() {
    return findVideo() ? routeId(root.location.pathname) : null;
  }

  // ------------------------------------------- orologio del programma

  // Il player pubblica la posizione nel programma (playhead) solo a intervalli,
  // mentre video.currentTime avanza in modo continuo ma ha un'altra origine
  // (pubblicità e sigle la spostano). Si tiene quindi lo scarto tra i due e si
  // restituisce tempo del video + scarto: continuo e nell'origine giusta.
  function createProgramClock() {
    let offset = null; // playhead - tempo del video
    let last = null; // ultimo campione accettato

    function accept(playhead, media) {
      offset = playhead - media;
      last = { playhead, media };
      return playhead;
    }

    // playhead: secondi nel programma o null se il player non lo espone;
    // media: video.currentTime. Restituisce il tempo da usare, o null per
    // non mostrare nulla finché i due orologi non tornano d'accordo.
    function time(playhead, media) {
      if (playhead === null) return offset === null ? media : media + offset;
      if (offset === null) return accept(playhead, media);
      const measured = playhead - media;
      if (Math.abs(measured - offset) <= CLOCK_JUMP_S) {
        // Un playhead letto "vecchio" dà uno scarto più piccolo del vero:
        // il valore corretto è il più grande visto
        if (measured > offset) offset = measured;
        last = { playhead, media };
        return media + offset;
      }
      // Disaccordo: salto o cambio di sorgente. Se il playhead non si è ancora
      // mosso è rimasto indietro rispetto al video: meglio nessuna battuta
      // che quella della scena precedente.
      if (Math.abs(playhead - last.playhead) < PLAYHEAD_MOVED_S) return null;
      return accept(playhead, media);
    }

    return { time, getOffset: () => offset };
  }

  const clock = createProgramClock();
  const hosts = {}; // elementi del player già trovati, per selettore
  let warnedNoPlayhead = false;

  // Proprietà che il player appende ai suoi elementi personalizzati
  function hostProperty(selector, property) {
    let host = hosts[selector];
    if (!host || !host.isConnected) host = hosts[selector] = root.document.querySelector(selector);
    return host ? host[property] : undefined;
  }

  function isInterstitialPlaying() {
    const store = hostProperty(CONTROLS_SELECTOR, 'store');
    return Boolean(store && store.interstitials && store.interstitials.isInterstitialPlaying);
  }

  // Posizione nel programma in secondi, o null se il player non la espone
  function readPlayhead() {
    const api = hostProperty(PLAYER_UI_SELECTOR, 'mediaPlayerApi');
    const info = api && api.timeline && api.timeline.info;
    const ms = info && info.playheadPositionMs;
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
  }

  // Tempo con cui scegliere la battuta; null durante pubblicità e interruzioni
  function getTime(video) {
    let playhead = null;
    try {
      if (isInterstitialPlaying()) return null;
      playhead = readPlayhead();
    } catch (_err) {
      playhead = null; // struttura del player cambiata
    }
    if (playhead === null && !warnedNoPlayhead && video.currentTime > NO_PLAYHEAD_WARN_S) {
      warnedNoPlayhead = true;
      console.warn('[DualSubs] Disney+: posizione del programma non trovata nel player; ' +
        'uso il tempo del video, i sottotitoli possono risultare sfasati');
    }
    return clock.time(playhead, video.currentTime);
  }

  // Per i log: scarto applicato tra tempo del video e tempo del programma
  function debugInfo() {
    const offset = clock.getOffset();
    return ', scarto programma-video ' + (offset === null ? 'ignoto' : offset.toFixed(2) + ' s');
  }

  const adapter = {
    name: 'disney',
    matches: (hostname) => /(^|\.)disneyplus\.com$/.test(hostname),
    beforeStringify: null,
    extract,
    currentTitle,
    findVideo,
    getTime,
    debugInfo,
    containerSelectors: [] // il contenitore è il genitore del video
  };

  const api = { readMasterUrl, routeId, extractPlayback, createProgramClock, adapter };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    (root.DualSubsPlatforms = root.DualSubsPlatforms || []).push(adapter);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
