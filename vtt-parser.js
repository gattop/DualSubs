/*
 * Dual Subs - vtt-parser.js (mondo MAIN)
 *
 * Parser WebVTT puro e senza dipendenze: testo -> [{start, end, text}].
 * Funziona sia nella pagina (window.DualSubsVtt) sia in Node (per i test).
 */
(function exportVttParser(root) {
  'use strict';

  const TIMING_RE = /^\s*(\S+)\s+-->\s+(\S+)/;
  const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/;
  const TAG_RE = /<[^>]*>/g;
  const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
  const DIRECTION_MARKS_RE = /[‎‏]/g;
  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'',
    nbsp: ' ', lrm: '‎', rlm: '‏'
  };
  // Quante battute precedenti controllare per trovare battute sovrapposte
  const MAX_OVERLAP_SCAN = 20;

  // "01:02:03.456" oppure "02:03.456" -> secondi; NaN se non valido
  function parseTimestamp(str) {
    const m = TIMESTAMP_RE.exec(str);
    if (!m) return NaN;
    const hours = Number(m[1] || 0);
    const fraction = Number(m[4].padEnd(3, '0')) / 1000;
    return hours * 3600 + Number(m[2]) * 60 + Number(m[3]) + fraction;
  }

  // Decodifica le entità HTML più comuni e quelle numeriche
  function decodeEntities(str) {
    return str.replace(ENTITY_RE, (match, code) => {
      if (code[0] === '#') {
        const isHex = code[1] === 'x' || code[1] === 'X';
        const n = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
      }
      const value = NAMED_ENTITIES[code.toLowerCase()];
      return value !== undefined ? value : match;
    });
  }

  // Toglie i tag (<c.xxx>, <i>, <b>, timestamp interni...) e pulisce le righe
  function cleanCueText(raw) {
    return decodeEntities(raw.replace(TAG_RE, ''))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.replace(DIRECTION_MARKS_RE, '') !== '')
      .join('\n');
  }

  // Converte un blocco (separato da righe vuote) in una battuta, o null
  function parseBlock(block) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0 || /^NOTE\b/.test(lines[0])) return null;
    const m = TIMING_RE.exec(lines[timingIndex]);
    if (!m) return null;
    const start = parseTimestamp(m[1]);
    const end = parseTimestamp(m[2]);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    const text = cleanCueText(lines.slice(timingIndex + 1).join('\n'));
    return text ? { start, end, text } : null;
  }

  // Converte un intero file WebVTT in battute ordinate per inizio
  function parseVtt(vttText) {
    if (typeof vttText !== 'string') return [];
    const normalized = vttText.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const cues = normalized.split(/\n\s*\n/).map(parseBlock).filter(Boolean);
    return cues.sort((a, b) => a.start - b.start);
  }

  // Ricerca binaria: indice dell'ultima battuta con start <= time, o -1
  function lastCueStartingBefore(cues, time) {
    let lo = 0;
    let hi = cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  // Battute attive all'istante dato (possono essere più di una se sovrapposte)
  function findActiveCues(cues, time) {
    const active = [];
    const last = lastCueStartingBefore(cues, time);
    for (let i = last; i >= 0 && last - i < MAX_OVERLAP_SCAN; i--) {
      if (cues[i].end > time) active.unshift(cues[i]);
    }
    return active;
  }

  const api = { parseVtt, parseTimestamp, decodeEntities, cleanCueText, findActiveCues };

  // Esporta per Node (test) oppure per la pagina
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DualSubsVtt = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
