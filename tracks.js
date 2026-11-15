/*
 * Dual Subs - tracks.js (mondo MAIN)
 *
 * Funzioni comuni a tutte le piattaforme sulle tracce già normalizzate
 * dagli adattatori in platforms/. Formato di una traccia:
 *   { id, language, label, isClosedCaptions, url, format ('vtt'|'ttml'), formats }
 * Funziona nella pagina (window.DualSubsTracks) e in Node (per i test).
 */
(function exportTracks(root) {
  'use strict';

  // 2 = lingua identica, 1 = stesso prefisso ("en" ~ "en-us"), 0 = diversa
  function languageScore(trackLanguage, wanted) {
    const a = trackLanguage.toLowerCase();
    const b = wanted.toLowerCase();
    if (a === b) return 2;
    return a.split('-')[0] === b.split('-')[0] ? 1 : 0;
  }

  // Sceglie la traccia per un valore come "en" oppure "en:cc" (per non udenti):
  // prima la lingua più vicina, poi il tipo richiesto. Solo tracce utilizzabili.
  function pickTrack(tracks, choice) {
    const [wanted, kind] = String(choice).split(':');
    const wantCC = kind === 'cc';
    let best = null;
    let bestScore = 0;
    for (const track of tracks) {
      const langScore = track.url ? languageScore(track.language, wanted) : 0;
      if (langScore === 0) continue;
      const score = langScore * 2 + (track.isClosedCaptions === wantCC ? 1 : 0);
      if (score > bestScore) {
        best = track;
        bestScore = score;
      }
    }
    return best;
  }

  // Versione delle tracce senza URL, da mandare fuori dalla pagina
  function publicTracks(tracks) {
    return tracks.map((t) => ({
      id: t.id,
      language: t.language,
      label: t.label,
      isClosedCaptions: t.isClosedCaptions,
      usable: Boolean(t.url)
    }));
  }

  const api = { languageScore, pickTrack, publicTracks };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DualSubsTracks = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
