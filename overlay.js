/*
 * Dual Subs - overlay.js (mondo MAIN)
 *
 * Overlay del secondo sottotitolo: trova il <video> e il contenitore del
 * player (con le regole dell'adattatore della piattaforma), inserisce il <div>
 * e lo aggiorna a ogni fotogramma, così il testo cambia nello stesso istante
 * della battuta (l'evento timeupdate da solo arriva solo ~4 volte al secondo).
 * Un MutationObserver lo riaggancia quando il sito ricrea il video o il player.
 * Espone window.DualSubsOverlay.
 */
(function exportOverlay(root) {
  'use strict';

  const OVERLAY_ID = 'dual-subs-overlay';
  const REATTACH_DELAY_MS = 50;
  // Il controllo dopo le mutazioni legge le dimensioni degli elementi: va
  // limitato, perché questi siti modificano il DOM in continuazione
  const HEALTH_CHECK_DELAY_MS = 250;

  const state = {
    active: false, // true mentre si è nel player
    video: null,
    overlay: null,
    textEl: null,
    cues: [],
    settings: null,
    lastText: null,
    lastTime: undefined,
    observer: null,
    reattachPending: false,
    checkPending: false,
    frameId: null,
    frameErrorLogged: false,
    // forniti dall'adattatore della piattaforma
    findVideo: () => null,
    // tempo (in secondi) con cui confrontare le battute; null = non mostrare nulla
    getTime: (video) => video.currentTime,
    // testo aggiuntivo per i log di diagnostica
    debugInfo: () => '',
    containerSelectors: [],
    log: () => {},
    warn: () => {}
  };

  // --------------------------------------------------------- API pubblica

  // options: { log, warn, findVideo, getTime, debugInfo, containerSelectors }
  function init(options) {
    Object.assign(state, options);
    document.addEventListener('fullscreenchange', scheduleAttach);
  }

  // Entrata nel player: osserva il DOM, aggancia l'overlay e avvia l'aggiornamento
  function start() {
    if (state.active) return;
    state.active = true;
    state.observer = state.observer || new MutationObserver(onMutations);
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    attach();
    if (state.frameId === null) state.frameId = requestAnimationFrame(onFrame);
  }

  // Uscita dal player: rimuove overlay, ascoltatori, osservatore e aggiornamento
  function stop() {
    if (!state.active) return;
    state.active = false;
    state.observer.disconnect();
    if (state.frameId !== null) cancelAnimationFrame(state.frameId);
    state.frameId = null;
    bindVideo(null);
    if (state.overlay) state.overlay.remove();
    state.cues = [];
    state.lastText = null;
    state.lastTime = undefined;
    state.log('overlay rimosso (uscita dal player)');
  }

  function setCues(cues) {
    state.cues = cues;
    render(true);
  }

  function setSettings(settings) {
    state.settings = settings;
    applyStyle();
    render(true);
  }

  // ------------------------------------------------------ elementi del DOM

  function createOverlay() {
    state.overlay = document.createElement('div');
    state.overlay.id = OVERLAY_ID;
    state.overlay.hidden = true;
    state.textEl = document.createElement('span');
    state.textEl.className = 'dual-subs-text';
    state.overlay.appendChild(state.textEl);
    applyStyle();
  }

  // Posizione e dimensione del testo prese dalle impostazioni
  function applyStyle() {
    if (!state.overlay || !state.settings) return;
    state.overlay.className = state.settings.position === 'bottom' ? 'dual-subs-bottom' : 'dual-subs-top';
    state.overlay.style.setProperty('--dual-subs-scale', String(state.settings.scale));
  }

  // Contenitore del player; a schermo intero deve stare dentro l'elemento a
  // schermo intero, altrimenti l'overlay non si vede
  function findContainer(video) {
    let container = null;
    for (const selector of state.containerSelectors) {
      container = video.closest(selector);
      if (container) break;
    }
    container = container || video.parentElement;
    const fullscreen = document.fullscreenElement;
    if (fullscreen && fullscreen.contains(video) && !fullscreen.contains(container)) {
      container = fullscreen;
    }
    return container;
  }

  function describe(el) {
    const uia = el.getAttribute('data-uia');
    const cls = el.classList[0];
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (uia ? '[data-uia="' + uia + '"]' : '');
  }

  // --------------------------------------------------- aggancio e riaggancio

  // Sposta gli ascoltatori sul <video> indicato (null = nessun video)
  function bindVideo(video) {
    if (state.video) {
      state.video.removeEventListener('timeupdate', onTimeUpdate);
      state.video.removeEventListener('seeked', onSeeked);
    }
    state.video = video;
    if (!video) return;
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onSeeked);
    state.log('agganciato al <video>');
  }

  // Inserisce l'overlay nel contenitore del player, se non c'è già
  function attach() {
    if (!state.active) return;
    const video = state.findVideo();
    if (!video) return;
    if (video !== state.video) bindVideo(video);
    if (!state.overlay) createOverlay();
    const container = findContainer(video);
    if (!container || state.overlay.parentElement === container) return;
    container.appendChild(state.overlay);
    state.log('overlay inserito in', describe(container));
    render(true);
  }

  // Tutto al suo posto: stesso video ancora nella pagina e overlay nel contenitore giusto
  function isAttached() {
    const video = state.video;
    if (!video || !video.isConnected || state.findVideo() !== video) return false;
    return Boolean(state.overlay) && state.overlay.parentElement === findContainer(video);
  }

  // Dopo una serie di mutazioni, un solo controllo ritardato
  function onMutations() {
    if (!state.active || state.checkPending) return;
    state.checkPending = true;
    setTimeout(() => {
      state.checkPending = false;
      try {
        if (state.active && !isAttached()) attach();
      } catch (err) {
        state.warn('errore nel controllo dell\'overlay:', err);
      }
    }, HEALTH_CHECK_DELAY_MS);
  }

  // Riaggancio rapido (cambio di schermo intero)
  function scheduleAttach() {
    if (!state.active || state.reattachPending) return;
    state.reattachPending = true;
    setTimeout(() => {
      state.reattachPending = false;
      try {
        attach();
      } catch (err) {
        state.warn('errore nel riaggancio dell\'overlay:', err);
      }
    }, REATTACH_DELAY_MS);
  }

  // ------------------------------------------------------------- disegno

  // Tempo con cui scegliere la battuta; null se non va mostrato nulla
  function currentTime() {
    return state.video ? state.getTime(state.video) : null;
  }

  function textAt(time) {
    const s = state.settings;
    if (time === null || !s || !s.enabled || !state.cues.length) return '';
    return root.DualSubsVtt.findActiveCues(state.cues, time)
      .map((cue) => cue.text)
      .join('\n');
  }

  // Aggiorna il testo; senza "force" non fa nulla se il tempo non è cambiato
  function render(force) {
    if (!state.overlay) return;
    const time = currentTime();
    if (!force && time === state.lastTime) return;
    state.lastTime = time;
    const text = textAt(time);
    if (!force && text === state.lastText) return;
    state.lastText = text;
    state.textEl.textContent = text;
    state.overlay.hidden = text === '';
  }

  // Un aggiornamento per fotogramma finché si è nel player
  function onFrame() {
    state.frameId = null;
    if (!state.active) return;
    try {
      render(false);
    } catch (err) {
      if (!state.frameErrorLogged) state.warn('errore nell\'aggiornamento dell\'overlay:', err);
      state.frameErrorLogged = true;
    }
    state.frameId = requestAnimationFrame(onFrame);
  }

  // Riserva per quando i fotogrammi non vengono disegnati (scheda in secondo piano)
  function onTimeUpdate() {
    try {
      render(false);
    } catch (err) {
      if (!state.frameErrorLogged) state.warn('errore nell\'aggiornamento dell\'overlay:', err);
      state.frameErrorLogged = true;
    }
  }

  // Dopo un salto: aggiorna subito e registra i tempi, per verificare il sincrono
  function onSeeked() {
    try {
      render(true);
      const video = state.video;
      const time = state.lastTime;
      state.log('salto: video ' + video.currentTime.toFixed(2) + ' s di ' + video.duration.toFixed(1) +
        ' s, tempo usato ' + (typeof time === 'number' ? time.toFixed(2) + ' s' : 'nessuno') +
        state.debugInfo() + ', battuta:', state.lastText || '(nessuna)');
    } catch (err) {
      state.warn('errore dopo il salto:', err);
    }
  }

  root.DualSubsOverlay = { init, start, stop, setCues, setSettings };
})(typeof globalThis !== 'undefined' ? globalThis : this);
