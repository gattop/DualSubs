/*
 * Dual Subs - content.js (mondo ISOLATED)
 *
 * Ponte tra page.js (mondo MAIN, via window.postMessage) e popup/storage
 * (API chrome.*). Le impostazioni vivono in chrome.storage.local: il popup le
 * scrive, qui si ascoltano i cambiamenti e si inoltrano a page.js.
 */
(function initDualSubsContent() {
  'use strict';

  const MSG_SOURCE = 'dual-subs';
  const LOG_PREFIX = '[DualSubs]';
  const DEFAULT_SETTINGS = { enabled: true, language: 'en', position: 'top', scale: 1 };

  // Tracce per titolo (Netflix può caricare manifest di altri titoli in anteprima)
  const tracksByMovie = new Map();
  let lastMovieId = null;
  let status = null; // ultimo stato riportato da page.js

  function isDebug() {
    try {
      return window.localStorage.getItem('dualSubsDebug') === '1';
    } catch (_err) {
      return false;
    }
  }

  // Stato da consegnare al popup: le tracce del titolo in riproduzione
  function currentState() {
    const movieId = status ? status.movieId : lastMovieId;
    return { movieId, tracks: tracksByMovie.get(movieId) || [], status };
  }

  function postToPage(type, payload) {
    window.postMessage({ source: MSG_SOURCE, from: 'content', type, payload }, '*');
  }

  // Legge le impostazioni salvate, completate con i valori predefiniti
  async function loadSettings() {
    const stored = await chrome.storage.local.get('settings');
    return Object.assign({}, DEFAULT_SETTINGS, stored.settings);
  }

  async function sendSettingsToPage() {
    try {
      postToPage('settings', await loadSettings());
    } catch (err) {
      console.warn(LOG_PREFIX, 'impossibile leggere le impostazioni:', err);
    }
  }

  // Avvisa il popup (se aperto) che lo stato è cambiato. Se l'estensione è
  // stata ricaricata, questo script è orfano e sendMessage lancia un'eccezione.
  function notifyPopup() {
    try {
      chrome.runtime.sendMessage({ type: 'state-changed' }).catch(() => {});
    } catch (_err) {
      // estensione ricaricata: la pagina va ricaricata, niente da fare qui
    }
  }

  // Messaggi da page.js
  function onWindowMessage(event) {
    const data = event.data;
    if (event.source !== window || !data || data.source !== MSG_SOURCE) return;
    if (data.from !== 'page') return;
    if (data.type === 'page-ready') {
      sendSettingsToPage();
    } else if (data.type === 'tracks') {
      tracksByMovie.set(data.payload.movieId, data.payload.tracks);
      lastMovieId = data.payload.movieId;
      notifyPopup();
    } else if (data.type === 'status') {
      status = data.payload;
      notifyPopup();
    }
  }

  // Richieste dal popup
  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message && message.type === 'get-state') sendResponse(currentState());
  }

  // Il popup ha salvato nuove impostazioni: applicale subito
  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.settings) sendSettingsToPage();
  }

  window.addEventListener('message', onWindowMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  sendSettingsToPage();
  if (isDebug()) console.log(LOG_PREFIX, 'content.js v' + chrome.runtime.getManifest().version + ' caricato');
})();
