/*
 * Dual Subs - popup.js
 *
 * Mostra e modifica le impostazioni (chrome.storage.local). Chiede a
 * content.js, nella scheda attiva, l'elenco delle lingue del titolo corrente.
 * Le modifiche vengono applicate subito: content.js ascolta lo storage.
 */
'use strict';

const DEFAULT_SETTINGS = { enabled: true, language: 'en', position: 'top', scale: 1 };
// Pagine dove l'estensione è attiva (come i "matches" di manifest.json)
const SUPPORTED_URLS = [
  /^https?:\/\/www\.netflix\.com\//,
  /^https?:\/\/([\w-]+\.)*primevideo\.com\//,
  /^https?:\/\/([\w-]+\.)*disneyplus\.com\//,
  /^https?:\/\/www\.amazon\.[a-z.]+\/(.*\/)?gp\/video\//
];

const els = {
  enabled: document.getElementById('enabled'),
  language: document.getElementById('language'),
  scale: document.getElementById('scale'),
  scaleValue: document.getElementById('scale-value'),
  status: document.getElementById('status'),
  version: document.getElementById('version'),
  positions: document.querySelectorAll('input[name="position"]')
};

let settings = Object.assign({}, DEFAULT_SETTINGS);

// ------------------------------------------------------------ traduzioni

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// Riempie i testi marcati con data-i18n / data-i18n-title
function localizePage() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  els.version.textContent = 'v' + chrome.runtime.getManifest().version;
}

// ------------------------------------------------------------ impostazioni

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings);
}

function saveSettings(patch) {
  settings = Object.assign({}, settings, patch);
  chrome.storage.local.set({ settings });
  renderControls();
}

// -------------------------------------------------------- stato della pagina

// Chiede a content.js lo stato della scheda attiva: { reachable, isSupported, state }
async function fetchPageState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url è visibile solo per i siti dei permessi host
  const isSupported = Boolean(tab && tab.url && SUPPORTED_URLS.some((re) => re.test(tab.url)));
  if (!tab || !isSupported) return { reachable: false, isSupported, state: null };
  try {
    const state = await chrome.tabs.sendMessage(tab.id, { type: 'get-state' });
    return { reachable: Boolean(state), isSupported, state: state || null };
  } catch (_err) {
    return { reachable: false, isSupported, state: null };
  }
}

// Valore dell'opzione: codice lingua, con ":cc" per i sottotitoli per non udenti
function trackValue(track) {
  return track.language + (track.isClosedCaptions ? ':cc' : '');
}

function trackLabel(track) {
  let label = track.label;
  if (track.isClosedCaptions && !/\bCC\b/.test(label)) label += ' ' + t('trackClosedCaptions');
  if (!track.usable) label += ' ' + t('trackImageOnly');
  return label;
}

// Una voce per lingua e tipo, ordinate per nome
function uniqueTracks(tracks) {
  const byValue = new Map();
  for (const track of tracks) {
    const existing = byValue.get(trackValue(track));
    if (!existing || (!existing.usable && track.usable)) byValue.set(trackValue(track), track);
  }
  return Array.from(byValue.values()).sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- disegno

function addOption(value, label, disabled) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  option.disabled = disabled;
  els.language.appendChild(option);
}

// Riempie il menu delle lingue; la lingua salvata resta sempre selezionata
function renderLanguages(pageState) {
  els.language.textContent = '';
  const tracks = pageState ? uniqueTracks(pageState.tracks) : [];
  for (const track of tracks) addOption(trackValue(track), trackLabel(track), !track.usable);
  const saved = tracks.find((track) => trackValue(track) === settings.language && track.usable);
  if (!saved) addOption(settings.language, t('savedLanguageUnavailable', [settings.language]), false);
  els.language.value = settings.language;
}

function renderControls() {
  els.enabled.checked = settings.enabled;
  document.body.classList.toggle('disabled', !settings.enabled);
  for (const radio of els.positions) radio.checked = radio.value === settings.position;
  els.scale.value = settings.scale;
  els.scaleValue.textContent = Math.round(settings.scale * 100) + '%';
}

function setStatus(text, isWarning) {
  els.status.textContent = text;
  els.status.classList.toggle('warning', Boolean(isWarning));
}

// Messaggio di stato in base a ciò che riporta page.js
function renderStatus(result) {
  if (!result.isSupported) return setStatus(t('statusOpenTitle'), false);
  if (!result.reachable) return setStatus(t('statusNotResponding'), true);
  const s = result.state.status;
  if (!s || s.state === 'idle') return setStatus(t('statusOpenTitle'), false);
  if (!settings.enabled) return setStatus(t('statusDisabled'), false);
  const messages = {
    waiting: [t('statusWaitingTitle'), false],
    disabled: [t('statusWaitingTitle'), false], // appena riattivato: arriva lo stato nuovo
    loading: [t('statusLoading'), false],
    loaded: [t('statusLoaded', [String(s.cueCount)]), false],
    unavailable: [t('statusUnavailable'), true],
    error: [t('statusError'), true]
  };
  const [text, isWarning] = messages[s.state] || ['', false];
  setStatus(text, isWarning);
}

async function refreshFromPage() {
  const result = await fetchPageState();
  renderLanguages(result.state);
  renderStatus(result);
}

// ------------------------------------------------------------------ eventi

els.enabled.addEventListener('change', () => {
  saveSettings({ enabled: els.enabled.checked });
  refreshFromPage();
});
els.language.addEventListener('change', () => saveSettings({ language: els.language.value }));
els.scale.addEventListener('input', () => saveSettings({ scale: Number(els.scale.value) }));
for (const radio of els.positions) {
  radio.addEventListener('change', () => saveSettings({ position: radio.value }));
}

// content.js avvisa quando cambiano tracce o stato (es. lingua appena caricata)
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'state-changed') refreshFromPage();
});

(async function init() {
  localizePage();
  await loadSettings();
  renderControls();
  await refreshFromPage();
})();
