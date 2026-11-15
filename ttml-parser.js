/*
 * Dual Subs - ttml-parser.js (mondo MAIN)
 *
 * Parser TTML/DFXP (XML, usato da Prime Video) senza DOMParser, così è
 * testabile in Node: testo -> [{start, end, text}], lo stesso formato di
 * vtt-parser.js. Riusa la pulizia del testo di vtt-parser.js.
 */
(function exportTtmlParser(root) {
  'use strict';

  const Vtt = typeof module === 'object' && module.exports ? require('./vtt-parser.js') : root.DualSubsVtt;

  // <p ...>...</p>, anche con prefisso di namespace (<tt:p>); esclude <p/>
  const PARAGRAPH_RE = /<((?:[\w-]+:)?p)\b([^>]*?)(?<!\/)>([\s\S]*?)<\/\1\s*>/g;
  const BR_RE = /<(?:[\w-]+:)?br\b[^>]*>/gi;
  const CLOCK_RE = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/;
  const CLOCK_FRAMES_RE = /^(\d+):(\d{2}):(\d{2}):(\d+(?:\.\d+)?)$/;
  const OFFSET_RE = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/;
  const DEFAULT_FRAME_RATE = 30;
  const DEFAULT_TICK_RATE = 10000000;

  // Valore di un attributo, con o senza prefisso di namespace
  function attr(attrs, name) {
    const m = new RegExp('(?:^|\\s)(?:[\\w-]+:)?' + name + '\\s*=\\s*"([^"]*)"').exec(attrs);
    return m ? m[1].trim() : null;
  }

  // Frequenze dichiarate nella radice <tt> (servono per le unità "f" e "t")
  function readTimeBase(xml) {
    const tt = /<(?:[\w-]+:)?tt\b([^>]*)>/.exec(xml);
    const attrs = tt ? tt[1] : '';
    // frameRateMultiplier="1000 1001" trasforma 30 in 29,97 fotogrammi al secondo:
    // ignorarlo sfaserebbe i sottotitoli di 3,6 secondi ogni ora
    const multiplier = /^(\d+)\s+(\d+)$/.exec(attr(attrs, 'frameRateMultiplier') || '');
    const ratio = multiplier && Number(multiplier[2]) > 0 ? Number(multiplier[1]) / Number(multiplier[2]) : 1;
    return {
      frameRate: (Number(attr(attrs, 'frameRate')) || DEFAULT_FRAME_RATE) * ratio,
      tickRate: Number(attr(attrs, 'tickRate')) || DEFAULT_TICK_RATE
    };
  }

  // Espressione di tempo TTML -> secondi; NaN se non valida.
  // Forme: "01:02:03.456", "01:02:03:12" (frame), "12.5s", "500ms", "3m", "1h",
  // "30f", "12345t" (tick)
  function parseTimeExpression(str, timeBase) {
    if (!str) return NaN;
    let m = CLOCK_RE.exec(str);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number('0.' + (m[4] || '0'));
    m = CLOCK_FRAMES_RE.exec(str);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / timeBase.frameRate;
    m = OFFSET_RE.exec(str);
    if (!m) return NaN;
    const value = Number(m[1]);
    const factors = { h: 3600, m: 60, s: 1, ms: 0.001, f: 1 / timeBase.frameRate, t: 1 / timeBase.tickRate };
    return value * factors[m[2]];
  }

  // Contenuto di <p>: spazi XML compattati, <br/> -> a capo, tag ed entità ripuliti
  function paragraphText(inner) {
    const collapsed = inner.replace(/\s+/g, ' ').replace(BR_RE, '\n');
    return Vtt.cleanCueText(collapsed);
  }

  // Converte un file TTML in battute ordinate per inizio
  function parseTtml(xml) {
    if (typeof xml !== 'string') return [];
    const timeBase = readTimeBase(xml);
    const cues = [];
    for (const m of xml.matchAll(PARAGRAPH_RE)) {
      const start = parseTimeExpression(attr(m[2], 'begin'), timeBase);
      let end = parseTimeExpression(attr(m[2], 'end'), timeBase);
      if (Number.isNaN(end)) end = start + parseTimeExpression(attr(m[2], 'dur'), timeBase);
      const text = paragraphText(m[3]);
      if (!Number.isNaN(start) && !Number.isNaN(end) && text) cues.push({ start, end, text });
    }
    return cues.sort((a, b) => a.start - b.start);
  }

  const api = { parseTtml, parseTimeExpression };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DualSubsTtml = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
