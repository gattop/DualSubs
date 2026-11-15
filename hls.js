/*
 * Dual Subs - hls.js (mondo MAIN)
 *
 * Sottotitoli WebVTT distribuiti in HLS (usati da Disney+): lettura delle
 * tracce dalla playlist principale, elenco dei segmenti della playlist di una
 * lingua, download con concorrenza limitata e unione delle battute.
 * Il download riceve la funzione di fetch dall'esterno, così è testabile in Node.
 */
(function exportHls(root) {
  'use strict';

  const Vtt = typeof module === 'object' && module.exports ? require('./vtt-parser.js') : root.DualSubsVtt;

  const MAX_CONCURRENCY = 6;
  const MAX_SEGMENTS = 5000;
  const CC_CHARACTERISTIC = 'public.accessibility.describes-music-and-sound';
  // Segmenti del contenuto principale: Disney+ mette nella stessa playlist anche
  // sigle e schede dei doppiatori, in cartelle con altri nomi (euristica)
  const MAIN_SEGMENT_RE = /(^|[-_/])MAIN([-_/]|$)/i;
  const TIMESTAMP_MAP_RE = /X-TIMESTAMP-MAP=([^\r\n]*)/;
  const MPEGTS_CLOCK_HZ = 90000;

  // Attributi di un tag HLS: CHIAVE=valore, CHIAVE="valore, anche con virgole"
  function parseAttributes(list) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    for (const m of list.matchAll(re)) {
      attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
    }
    return attrs;
  }

  function resolveUrl(reference, baseUrl) {
    try {
      return new URL(reference, baseUrl).href;
    } catch (_err) {
      return null;
    }
  }

  function lines(text) {
    return String(text).split(/\r?\n/).map((line) => line.trim());
  }

  // Tracce di sottotitoli dalla playlist principale, nel formato comune.
  // Le tracce forzate (solo parti in lingua straniera) vengono scartate.
  function parseMasterSubtitles(text, baseUrl) {
    const tracks = [];
    const seen = new Set();
    for (const line of lines(text)) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.TYPE !== 'SUBTITLES' || !attrs.URI || attrs.FORCED === 'YES') continue;
      const name = attrs.NAME || attrs.LANGUAGE || '?';
      if (/forced/i.test(name)) continue; // Disney+ le marca anche solo nel nome
      const url = resolveUrl(attrs.URI, baseUrl);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      tracks.push({
        id: url,
        language: attrs.LANGUAGE || '',
        label: name,
        isClosedCaptions: (attrs.CHARACTERISTICS || '').includes(CC_CHARACTERISTIC) || /\b(CC|SDH)\b/.test(name),
        url,
        format: 'hls-vtt',
        formats: [attrs['GROUP-ID'] || 'hls']
      });
    }
    return tracks;
  }

  // URL assoluti dei segmenti di una playlist media, in ordine
  function parseMediaPlaylist(text, baseUrl) {
    const segments = [];
    for (const line of lines(text)) {
      if (!line || line.startsWith('#')) continue;
      const url = resolveUrl(line, baseUrl);
      if (url) segments.push(url);
      if (segments.length > MAX_SEGMENTS) throw new Error('troppi segmenti nella playlist');
    }
    return segments;
  }

  // Se alcuni segmenti (ma non tutti) sono marcati come contenuto principale,
  // tiene solo quelli; altrimenti li tiene tutti
  function selectMainSegments(urls) {
    const main = urls.filter((url) => MAIN_SEGMENT_RE.test(url.split('?')[0]));
    return main.length > 0 && main.length < urls.length ? main : urls;
  }

  // Origine dei tempi dichiarata da un segmento (X-TIMESTAMP-MAP), in secondi:
  // istante del flusso a cui corrisponde il tempo zero delle battute. null se assente.
  function timestampOrigin(segmentText) {
    const m = TIMESTAMP_MAP_RE.exec(segmentText.slice(0, 500));
    if (!m) return null;
    const mpegts = /MPEGTS:(\d+)/.exec(m[1]);
    const local = /LOCAL:([\d:.]+)/.exec(m[1]);
    if (!mpegts || !local) return null;
    const localSeconds = Vtt.parseTimestamp(local[1]);
    return Number.isNaN(localSeconds) ? null : Number(mpegts[1]) / MPEGTS_CLOCK_HZ - localSeconds;
  }

  // Battute di ogni segmento, riportate tutte sulla stessa origine dei tempi.
  // Di norma i segmenti hanno la stessa origine e non cambia nulla; se un
  // segmento ne dichiara una diversa, le sue battute vengono spostate.
  function parseSegments(texts) {
    let firstOrigin = null;
    return texts.map((text) => {
      const cues = Vtt.parseVtt(text);
      const origin = timestampOrigin(text);
      if (origin === null) return cues;
      if (firstOrigin === null) firstOrigin = origin;
      const shift = origin - firstOrigin;
      if (Math.abs(shift) < 0.001) return cues;
      return cues.map((cue) => ({ start: cue.start + shift, end: cue.end + shift, text: cue.text }));
    });
  }

  // Unisce le battute dei segmenti: la stessa battuta può comparire in due
  // segmenti consecutivi, quindi i doppioni (stessi tempi e testo) si tolgono
  function mergeCues(cueLists) {
    const seen = new Set();
    const merged = [];
    for (const cues of cueLists) {
      for (const cue of cues) {
        const key = cue.start + '|' + cue.end + '|' + cue.text;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(cue);
      }
    }
    return merged.sort((a, b) => a.start - b.start);
  }

  // Scarica i segmenti con al massimo MAX_CONCURRENCY richieste insieme.
  // Un segmento che fallisce lascia un buco; se falliscono tutti è un errore.
  async function fetchSegments(urls, fetchText) {
    const results = new Array(urls.length).fill(null);
    let next = 0;
    async function worker() {
      while (next < urls.length) {
        const index = next++;
        try {
          results[index] = (await fetchText(urls[index])).text;
        } catch (_err) {
          results[index] = null;
        }
      }
    }
    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, urls.length) }, worker);
    await Promise.all(workers);
    if (urls.length && results.every((r) => r === null)) throw new Error('nessun segmento scaricato');
    return results.filter((r) => r !== null);
  }

  // Battute di una traccia HLS. fetchText(url) -> Promise<{ text, url }>,
  // dove url è l'indirizzo finale (dopo eventuali redirect)
  async function loadVttPlaylist(url, fetchText) {
    const playlist = await fetchText(url);
    if (/^﻿?WEBVTT/.test(playlist.text)) return Vtt.parseVtt(playlist.text);
    const segmentUrls = selectMainSegments(parseMediaPlaylist(playlist.text, playlist.url || url));
    const texts = await fetchSegments(segmentUrls, fetchText);
    return mergeCues(parseSegments(texts));
  }

  const api = {
    parseAttributes, parseMasterSubtitles, parseMediaPlaylist, selectMainSegments,
    timestampOrigin, parseSegments, mergeCues, loadVttPlaylist
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DualSubsHls = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
