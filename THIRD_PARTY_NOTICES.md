# Third party notices

## Subadub

La tecnica di intercettazione (hook su `JSON.stringify` per aggiungere il
profilo `webvtt-lssdh-ios8` e hook su `JSON.parse` per leggere l'elenco delle
tracce di testo) è adattata da Subadub, file `dist/page_script.js`:
https://github.com/rsimmons/subadub

File interessati: `platforms/netflix.js`, `page.js`.

```
The MIT License (MIT)

Copyright (c) 2018 Russel Simmons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Amazon Video - subtitle downloader

La struttura della risposta di Prime Video (`GetVodPlaybackResources`,
`timedTextUrls.result.subtitleUrls` con `languageCode`, `type`, `url`) è
ricavata dallo userscript "Amazon Video - subtitle downloader" di
Tithen-Firion, dichiarato con licenza MIT nella sua intestazione:
https://github.com/Tithen-Firion/UserScripts

File interessati: `platforms/prime.js` (nessun codice copiato, solo il formato
dei dati).

```
The MIT License (MIT)

Copyright (c) Tithen-Firion

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DualSub (solo come documentazione, nessun codice copiato)

Il funzionamento di Disney+ (URL della playlist HLS in
`stream.sources[0].complete.url`, tracce in `#EXT-X-MEDIA:TYPE=SUBTITLES`,
orologio del programma in `disney-web-player-ui` → `mediaPlayerApi`, stato delle
interruzioni in `main-app-controls-overlay`) è stato ricavato leggendo il
progetto DualSub di QuellaMC: https://github.com/QuellaMC/DualSub

DualSub è distribuito con licenza Creative Commons BY-NC-SA 4.0. Da quel
progetto non è stato copiato né adattato codice: `platforms/disney.js` e
`hls.js` sono scritti da zero e usano solo informazioni sul formato dei dati
del sito.
