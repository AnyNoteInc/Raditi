# Spike s2: raw tables

## Engines

| engine | version | os | load at start → finish |
| --- | --- | --- | --- |
| chromium-3pcb@linux | 153.0.8010.12 | linux 7.0.14-linuxkit arm64 | 1.00 1.88 1.67 → 0.92 1.85 1.66 |
| chromium-shell@linux | 153.0.8010.12 | linux 7.0.14-linuxkit arm64 | 1.16 1.86 1.18 → 2.67 2.16 1.30 |
| chromium@linux | 153.0.8010.12 | linux 7.0.14-linuxkit arm64 | 2.67 2.16 1.30 → 5.09 2.82 1.55 |
| firefox-tcp@linux | 155.0 | linux 7.0.14-linuxkit arm64 | 4.35 3.09 1.74 → 4.40 3.12 1.75 |
| firefox@linux | 155.0 | linux 7.0.14-linuxkit arm64 | 5.02 3.04 1.67 → 4.35 3.09 1.74 |
| webkit@linux | 26.6 | linux 7.0.14-linuxkit arm64 | 5.09 2.82 1.55 → 5.02 3.04 1.67 |
| chromium-shell@macos | 153.0.8010.12 | darwin 27.0.0 arm64 | 8.43 10.13 12.92 → 9.02 10.14 12.86 |
| chromium@macos | 153.0.8010.12 | darwin 27.0.0 arm64 | 9.02 10.14 12.86 → 11.78 10.65 12.93 |
| webkit@macos | 26.6 | darwin 27.0.0 arm64 | 11.78 10.65 12.93 → 10.94 10.52 12.80 |

## A1 https, sandbox art, c1: resource × headers

| engine | kind | h1 | h2 | h3 | h4 | h5 | h6 | h7 | h8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | font | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | font | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |

## A1 http, sandbox art, c1: resource × headers

| engine | kind | h1 | h2 | h3 | h4 | h5 | h6 | h7 | h8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | font | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | font | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |

## A1 https, sandbox art, c3: resource × headers

| engine | kind | h1 | h2 | h3 | h4 | h5 | h6 | h7 | h8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | font | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | font | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |

## A1 http, sandbox art, c3: resource × headers

| engine | kind | h1 | h2 | h3 | h4 | h5 | h6 | h7 | h8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| firefox@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| firefox@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | font | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@linux | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@linux | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium-shell@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium-shell@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | font | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| chromium@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| chromium@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | font | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | js | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | jsx | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | mjs | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | mji | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS | ✓ | ✗ CORS |
| webkit@macos | css | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |
| webkit@macos | img | ✓ | ✓ | ✗ CORP | ✗ CORP | ✓ | ✓ | ✗ CORP | ✗ CORP |

## A2 https, sandbox art, headers h1: CSP × kind

| engine | csp | font | js | jsx | mjs | mji | css | img | data: font | buffer font | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@linux | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@linux | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 64 |
| firefox@linux | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@linux | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@macos | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@macos | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@macos | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c5 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |

## A2 http, sandbox art, headers h1: CSP × kind

| engine | csp | font | js | jsx | mjs | mji | css | img | data: font | buffer font | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@linux | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@linux | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| firefox@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 64 |
| firefox@linux | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 64 |
| webkit@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@linux | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@macos | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@macos | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@macos | c1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |

## A2 https, sandbox art, headers h2: CSP × kind

| engine | csp | font | js | jsx | mjs | mji | css | img | data: font | buffer font | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@linux | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c4 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c5 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@linux | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c4 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c5 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 64 |
| firefox@linux | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c4 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c5 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@linux | c1 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c2 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c3 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c4 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c5 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@macos | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c4 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c5 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@macos | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c4 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c5 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@macos | c1 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c2 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c3 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c4 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c5 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |

## A2 http, sandbox art, headers h2: CSP × kind

| engine | csp | font | js | jsx | mjs | mji | css | img | data: font | buffer font | violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@linux | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@linux | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@linux | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@linux | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| firefox@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 64 |
| firefox@linux | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| firefox@linux | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 64 |
| webkit@linux | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@linux | c1 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c2 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c3 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@linux | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium-shell@macos | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium-shell@macos | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| chromium@macos | c1 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c2 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c3 | ✗ CORS | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| chromium@macos | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@macos | c0 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |
| webkit@macos | c1 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c2 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c3 | ✓ | ✓ | ✗ CORS | ✗ CORS | ✗ CORS | ✓ | ✓ | ✓ | ✓ | 0 |
| webkit@macos | c4 | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✗ CSP | ✓ | ✓ | 56 |

## A3 sandbox page vs art vs none (cells that differ from art)

| engine | scheme | csp | page ≠ art | none: loaded / all |
| --- | --- | --- | --- | --- |
| chromium-shell@linux | https | c0 | 0 | 0 / 56 |
| chromium-shell@linux | https | c1 | 0 | 56 / 56 |
| chromium-shell@linux | https | c2 | 0 | 56 / 56 |
| chromium-shell@linux | https | c3 | 0 | 56 / 56 |
| chromium-shell@linux | https | c4 | 0 | 56 / 56 |
| chromium-shell@linux | https | c5 | 0 | 56 / 56 |
| chromium-shell@linux | http | c0 | — | 0 / 56 |
| chromium-shell@linux | http | c1 | — | 56 / 56 |
| chromium-shell@linux | http | c2 | — | 56 / 56 |
| chromium-shell@linux | http | c3 | — | 56 / 56 |
| chromium-shell@linux | http | c4 | — | 0 / 56 |
| chromium@linux | https | c0 | 0 | 0 / 56 |
| chromium@linux | https | c1 | 0 | 56 / 56 |
| chromium@linux | https | c2 | 0 | 56 / 56 |
| chromium@linux | https | c3 | 0 | 56 / 56 |
| chromium@linux | https | c4 | 0 | 56 / 56 |
| chromium@linux | https | c5 | 0 | 56 / 56 |
| chromium@linux | http | c0 | — | 0 / 56 |
| chromium@linux | http | c1 | — | 56 / 56 |
| chromium@linux | http | c2 | — | 56 / 56 |
| chromium@linux | http | c3 | — | 56 / 56 |
| chromium@linux | http | c4 | — | 0 / 56 |
| firefox@linux | https | c0 | 0 | 0 / 56 |
| firefox@linux | https | c1 | 0 | 56 / 56 |
| firefox@linux | https | c2 | 0 | 56 / 56 |
| firefox@linux | https | c3 | 0 | 56 / 56 |
| firefox@linux | https | c4 | 0 | 56 / 56 |
| firefox@linux | https | c5 | 0 | 56 / 56 |
| firefox@linux | http | c0 | — | 0 / 56 |
| firefox@linux | http | c1 | — | 56 / 56 |
| firefox@linux | http | c2 | — | 56 / 56 |
| firefox@linux | http | c3 | — | 56 / 56 |
| firefox@linux | http | c4 | — | 0 / 56 |
| webkit@linux | https | c0 | 0 | 0 / 56 |
| webkit@linux | https | c1 | 0 | 56 / 56 |
| webkit@linux | https | c2 | 0 | 56 / 56 |
| webkit@linux | https | c3 | 0 | 56 / 56 |
| webkit@linux | https | c4 | 0 | 56 / 56 |
| webkit@linux | https | c5 | 0 | 56 / 56 |
| webkit@linux | http | c0 | — | 0 / 56 |
| webkit@linux | http | c1 | — | 56 / 56 |
| webkit@linux | http | c2 | — | 56 / 56 |
| webkit@linux | http | c3 | — | 56 / 56 |
| webkit@linux | http | c4 | — | 0 / 56 |
| chromium-shell@macos | https | c0 | 0 | 0 / 56 |
| chromium-shell@macos | https | c1 | 0 | 56 / 56 |
| chromium-shell@macos | https | c2 | 0 | 56 / 56 |
| chromium-shell@macos | https | c3 | 0 | 56 / 56 |
| chromium-shell@macos | https | c4 | 0 | 56 / 56 |
| chromium-shell@macos | https | c5 | 0 | 56 / 56 |
| chromium-shell@macos | http | c0 | — | 0 / 56 |
| chromium-shell@macos | http | c1 | — | 56 / 56 |
| chromium-shell@macos | http | c2 | — | 56 / 56 |
| chromium-shell@macos | http | c3 | — | 56 / 56 |
| chromium-shell@macos | http | c4 | — | 0 / 56 |
| chromium@macos | https | c0 | 0 | 0 / 56 |
| chromium@macos | https | c1 | 0 | 56 / 56 |
| chromium@macos | https | c2 | 0 | 56 / 56 |
| chromium@macos | https | c3 | 0 | 56 / 56 |
| chromium@macos | https | c4 | 0 | 56 / 56 |
| chromium@macos | https | c5 | 0 | 56 / 56 |
| chromium@macos | http | c0 | — | 0 / 56 |
| chromium@macos | http | c1 | — | 56 / 56 |
| chromium@macos | http | c2 | — | 56 / 56 |
| chromium@macos | http | c3 | — | 56 / 56 |
| chromium@macos | http | c4 | — | 0 / 56 |
| webkit@macos | https | c0 | 0 | 0 / 56 |
| webkit@macos | https | c1 | 0 | 56 / 56 |
| webkit@macos | https | c2 | 0 | 56 / 56 |
| webkit@macos | https | c3 | 0 | 56 / 56 |
| webkit@macos | https | c4 | 0 | 56 / 56 |
| webkit@macos | https | c5 | 0 | 56 / 56 |
| webkit@macos | http | c0 | — | 0 / 56 |
| webkit@macos | http | c1 | — | 56 / 56 |
| webkit@macos | http | c2 | — | 56 / 56 |
| webkit@macos | http | c3 | — | 56 / 56 |
| webkit@macos | http | c4 | — | 0 / 56 |

## A4 origin of the frame and request headers (https, art, c1)

| engine | self.origin | message origin | document.cookie | font: mode / Origin | mjs: mode / Origin | js: mode / Origin | Sec-Fetch-Site of resources |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | null | null | throws:SecurityError | cors / "null" | cors / "null" | no-cors / absent | cross-site |
| chromium@linux | null | null | throws:SecurityError | cors / "null" | cors / "null" | no-cors / absent | cross-site |
| firefox@linux | null | null | throws:SecurityError | cors / "null" | cors / "null" | no-cors / "null" | cross-site |
| webkit@linux | null | null | throws:SecurityError | no-cors / absent | cors / "null" | no-cors / absent | cross-site |
| chromium-shell@macos | null | null | throws:SecurityError | cors / "null" | cors / "null" | no-cors / absent | cross-site |
| chromium@macos | null | null | throws:SecurityError | cors / "null" | cors / "null" | no-cors / absent | cross-site |
| webkit@macos | null | null | throws:SecurityError | no-cors / absent | cors / "null" | no-cors / absent | cross-site |

## A5 error texts (https, art)

| engine | class | example |
| --- | --- | --- |
| chromium-shell@linux | CSP (font) | csp ‖ Loading the font '<url>' violates the following Content Security Policy directive: "font-src data: blob:". The action has been blocked. |
| chromium-shell@linux | CSP (js) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium-shell@linux | CSP (jsx) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium-shell@linux | CSP (mjs) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium-shell@linux | CSP (mji) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium-shell@linux | CSP (css) | csp ‖ Loading the stylesheet '<url>' violates the following Content Security Policy directive: "style-src 'unsafe-inline'". Note that 'style-src-elem' was not explicitly set, so 'style-src' is used as a fallback. The action has been blocked. |
| chromium-shell@linux | CSP (img) | csp ‖ Loading the image '<url>' violates the following Content Security Policy directive: "img-src data: blob:". The action has been blocked. |
| chromium-shell@linux | CORS (font) | net::ERR_FAILED ‖ Access to font at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium-shell@linux | CORP (js) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium-shell@linux | CORS (jsx) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium-shell@linux | CORS (mjs) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium-shell@linux | CORS (mji) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium-shell@linux | CORP (css) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium-shell@linux | CORP (img) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium@linux | CSP (font) | csp ‖ Loading the font '<url>' violates the following Content Security Policy directive: "font-src data: blob:". The action has been blocked. |
| chromium@linux | CSP (js) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium@linux | CSP (jsx) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium@linux | CSP (mjs) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium@linux | CSP (mji) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium@linux | CSP (css) | csp ‖ Loading the stylesheet '<url>' violates the following Content Security Policy directive: "style-src 'unsafe-inline'". Note that 'style-src-elem' was not explicitly set, so 'style-src' is used as a fallback. The action has been blocked. |
| chromium@linux | CSP (img) | csp ‖ Loading the image '<url>' violates the following Content Security Policy directive: "img-src data: blob:". The action has been blocked. |
| chromium@linux | CORS (font) | net::ERR_FAILED ‖ Access to font at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium@linux | CORP (js) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium@linux | CORS (jsx) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium@linux | CORS (mjs) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium@linux | CORS (mji) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium@linux | CORP (css) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium@linux | CORP (img) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| firefox@linux | CSP (font) | [JavaScript Error: "Content-Security-Policy: The page’s settings blocked the loading of a resource (font-src) at <url> because it violates the following directive: “font-src data: blob:”" {file: "https://pages.spike.test/v/view-art-c0-F33ydin.a1b2c3d4#0" line: 0}] ‖ [JavaScript Error: "downloadable font: failed to start download (font-family: "F-h1" style:normal weight:400 width:100 src index:0):  |
| firefox@linux | CSP (js) | [JavaScript Warning: "Loading failed for the <script> with source “<url>”." {file: "https://pages.spike.test/v/view-art-c0-F33ydin.a1b2c3d4#0" line: 100}] ‖ [JavaScript Error: "Content-Security-Policy: The page’s settings blocked a script (script-src-elem) at <url> from being executed because it violates the following directive: “script-src 'unsafe-inline'”" {file: "https://pages.spike.test/v/view |
| firefox@linux | CSP (jsx) | [JavaScript Warning: "Loading failed for the <script> with source “<url>”." {file: "https://pages.spike.test/v/view-art-c0-F33ydin.a1b2c3d4#0" line: 108}] ‖ [JavaScript Error: "Content-Security-Policy: The page’s settings blocked a script (script-src-elem) at <url> from being executed because it violates the following directive: “script-src 'unsafe-inline'”" {file: "https://pages.spike.test/v/view |
| firefox@linux | CSP (mjs) | [JavaScript Warning: "Loading failed for the module with source “<url>”." {file: "https://pages.spike.test/v/view-art-c0-F33ydin.a1b2c3d4#0" line: 116}] ‖ [JavaScript Error: "Content-Security-Policy: The page’s settings blocked a script (script-src-elem) at <url> from being executed because it violates the following directive: “script-src 'unsafe-inline'”" {file: "https://pages.spike.test/v/view-a |
| firefox@linux | CSP (mji) | [JavaScript Warning: "Loading failed for the module with source “<url>”." {file: "https://pages.spike.test/v/view-art-c0-F33ydin.a1b2c3d4#0" line: 124}] ‖ [JavaScript Error: "Content-Security-Policy: The page’s settings blocked a script (script-src-elem) at <url> from being executed because it violates the following directive: “script-src 'unsafe-inline'”" {file: "https://pages.spike.test/v/view-a |
| firefox@linux | CSP (css) | [JavaScript Error: "Content-Security-Policy: The page’s settings blocked a style (style-src-elem) at <url> from being applied because it violates the following directive: “style-src 'unsafe-inline'”" {file: "https://pages.spike.test/v/view-art-c0-F33ydin.a1b2c3d4#0" line: 0}] |
| firefox@linux | CSP (img) | [JavaScript Error: "Content-Security-Policy: The page’s settings blocked the loading of a resource (img-src) at <url> because it violates the following directive: “img-src data: blob:”" {file: "https://pages.spike.test/v/view-art-c0-F33ydin.a1b2c3d4#0" line: 0}] |
| firefox@linux | CORS (font) | [JavaScript Error: "Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at <url>. (Reason: CORS header ‘Access-Control-Allow-Origin’ missing). Status code: 200."] ‖ [JavaScript Error: "downloadable font: download failed (font-family: "F-h2" style:normal weight:400 width:100 src index:0): bad URI or cross-site access not allowed source: <url>"] |
| firefox@linux | CORP (js) | <unknown error> ‖ [JavaScript Error: "The resource at “<url>” was blocked due to its Cross-Origin-Resource-Policy header (or lack thereof). See https://developer.mozilla.org/docs/Web/HTTP/Cross-Origin_Resource_Policy_(CORP)#" {file: "https://pages.spike.test/v/view-art-c1-F34yehc.a1b2c3d4#0" line: 0}] ‖ [JavaScript Warning: "Loading failed for the <script> with source “<url>”." {file: "https://pag |
| firefox@linux | CORS (jsx) | [JavaScript Error: "Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at <url>. (Reason: CORS header ‘Access-Control-Allow-Origin’ missing). Status code: 200."] ‖ [JavaScript Warning: "<script> source URI is not allowed in this document: “<url>”." {file: "https://pages.spike.test/v/view-art-c1-F34yehc.a1b2c3d4#0" line: 109}] |
| firefox@linux | CORS (mjs) | [JavaScript Error: "Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at <url>. (Reason: CORS header ‘Access-Control-Allow-Origin’ missing). Status code: 200."] ‖ [JavaScript Warning: "Module source URI is not allowed in this document: “<url>”." {file: "https://pages.spike.test/v/view-art-c1-F34yehc.a1b2c3d4#0" line: 117}] |
| firefox@linux | CORS (mji) | [JavaScript Error: "Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at <url>. (Reason: CORS header ‘Access-Control-Allow-Origin’ missing). Status code: 200."] ‖ [JavaScript Warning: "Module source URI is not allowed in this document: “<url>”." {file: "https://pages.spike.test/v/view-art-c1-F34yehc.a1b2c3d4#0" line: 125}] |
| firefox@linux | CORP (css) | <unknown error> ‖ [JavaScript Error: "The resource at “<url>” was blocked due to its Cross-Origin-Resource-Policy header (or lack thereof). See https://developer.mozilla.org/docs/Web/HTTP/Cross-Origin_Resource_Policy_(CORP)#" {file: "https://pages.spike.test/v/view-art-c1-F34yehc.a1b2c3d4#0" line: 0}] |
| firefox@linux | CORP (img) | <unknown error> ‖ [JavaScript Error: "The resource at “<url>” was blocked due to its Cross-Origin-Resource-Policy header (or lack thereof). See https://developer.mozilla.org/docs/Web/HTTP/Cross-Origin_Resource_Policy_(CORP)#" {file: "https://pages.spike.test/v/view-art-c1-F34yehc.a1b2c3d4#0" line: 0}] |
| webkit@linux | CSP (font) | Refused to load <url> because it does not appear in the font-src directive of the Content Security Policy. |
| webkit@linux | CSP (js) | Refused to load <url> because it does not appear in the script-src directive of the Content Security Policy. |
| webkit@linux | CSP (jsx) | Refused to load <url> because it does not appear in the script-src directive of the Content Security Policy. |
| webkit@linux | CSP (mjs) | Refused to load <url> because it does not appear in the script-src directive of the Content Security Policy. |
| webkit@linux | CSP (mji) | Refused to load <url> because it does not appear in the script-src directive of the Content Security Policy. |
| webkit@linux | CSP (css) | Refused to load <url> because it does not appear in the style-src directive of the Content Security Policy. |
| webkit@linux | CSP (img) | Refused to load <url> because it does not appear in the img-src directive of the Content Security Policy. |
| webkit@linux | CORP (font) | Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. ‖ Failed to load resource: Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. |
| webkit@linux | CORP (js) | Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. ‖ Failed to load resource: Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. |
| webkit@linux | CORS (jsx) | Origin null is not allowed by Access-Control-Allow-Origin. Status code: 200 |
| webkit@linux | CORS (mjs) | Origin null is not allowed by Access-Control-Allow-Origin. Status code: 200 |
| webkit@linux | CORS (mji) | Origin null is not allowed by Access-Control-Allow-Origin. Status code: 200 |
| webkit@linux | CORP (css) | Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. ‖ Failed to load resource: Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. |
| webkit@linux | CORP (img) | Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. ‖ Cannot load image <url> due to access control checks. ‖ Failed to load resource: Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. |
| chromium-shell@macos | CSP (font) | csp ‖ Loading the font '<url>' violates the following Content Security Policy directive: "font-src data: blob:". The action has been blocked. |
| chromium-shell@macos | CSP (js) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium-shell@macos | CSP (jsx) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium-shell@macos | CSP (mjs) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium-shell@macos | CSP (mji) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium-shell@macos | CSP (css) | csp ‖ Loading the stylesheet '<url>' violates the following Content Security Policy directive: "style-src 'unsafe-inline'". Note that 'style-src-elem' was not explicitly set, so 'style-src' is used as a fallback. The action has been blocked. |
| chromium-shell@macos | CSP (img) | csp ‖ Loading the image '<url>' violates the following Content Security Policy directive: "img-src data: blob:". The action has been blocked. |
| chromium-shell@macos | CORS (font) | net::ERR_FAILED ‖ Access to font at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium-shell@macos | CORP (js) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium-shell@macos | CORS (jsx) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium-shell@macos | CORS (mjs) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium-shell@macos | CORS (mji) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium-shell@macos | CORP (css) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium-shell@macos | CORP (img) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium@macos | CSP (font) | csp ‖ Loading the font '<url>' violates the following Content Security Policy directive: "font-src data: blob:". The action has been blocked. |
| chromium@macos | CSP (js) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium@macos | CSP (jsx) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium@macos | CSP (mjs) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium@macos | CSP (mji) | csp ‖ Loading the script '<url>' violates the following Content Security Policy directive: "script-src 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked. |
| chromium@macos | CSP (css) | csp ‖ Loading the stylesheet '<url>' violates the following Content Security Policy directive: "style-src 'unsafe-inline'". Note that 'style-src-elem' was not explicitly set, so 'style-src' is used as a fallback. The action has been blocked. |
| chromium@macos | CSP (img) | csp ‖ Loading the image '<url>' violates the following Content Security Policy directive: "img-src data: blob:". The action has been blocked. |
| chromium@macos | CORS (font) | net::ERR_FAILED ‖ Access to font at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium@macos | CORP (js) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium@macos | CORS (jsx) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium@macos | CORS (mjs) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium@macos | CORS (mji) | net::ERR_FAILED ‖ Access to script at '<url>' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource. |
| chromium@macos | CORP (css) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| chromium@macos | CORP (img) | net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin |
| webkit@macos | CSP (font) | Refused to load <url> because it does not appear in the font-src directive of the Content Security Policy. |
| webkit@macos | CSP (js) | Refused to load <url> because it does not appear in the script-src directive of the Content Security Policy. |
| webkit@macos | CSP (jsx) | Refused to load <url> because it does not appear in the script-src directive of the Content Security Policy. |
| webkit@macos | CSP (mjs) | Refused to load <url> because it does not appear in the script-src directive of the Content Security Policy. |
| webkit@macos | CSP (mji) | Refused to load <url> because it does not appear in the script-src directive of the Content Security Policy. |
| webkit@macos | CSP (css) | Refused to load <url> because it does not appear in the style-src directive of the Content Security Policy. |
| webkit@macos | CSP (img) | Refused to load <url> because it does not appear in the img-src directive of the Content Security Policy. |
| webkit@macos | CORP (font) | Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. ‖ Failed to load resource: Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. |
| webkit@macos | CORP (js) | Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. ‖ Failed to load resource: Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. |
| webkit@macos | CORS (jsx) | Origin null is not allowed by Access-Control-Allow-Origin. Status code: 200 |
| webkit@macos | CORS (mjs) | Origin null is not allowed by Access-Control-Allow-Origin. Status code: 200 |
| webkit@macos | CORS (mji) | Origin null is not allowed by Access-Control-Allow-Origin. Status code: 200 |
| webkit@macos | CORP (css) | Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. ‖ Failed to load resource: Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. |
| webkit@macos | CORP (img) | Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. ‖ Cannot load image <url> due to access control checks. ‖ Failed to load resource: Cancelled load to <url> because it violates the resource's Cross-Origin-Resource-Policy response header. |

## A6 font widths (https, art, c1): loaded vs fallback

| engine | F-h1 | fallback | F-data | F-buf | check() of F-h1 / F-h2 |
| --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | 980 (loaded) | 1018.88 | 980 | 980 | true / false |
| chromium@linux | 976.33 (loaded) | 1018.88 | 976.33 | 976.33 | true / false |
| firefox@linux | 976.37 (loaded) | 1018.9 | 976.37 | 976.37 | true / false |
| webkit@linux | 976.33 (loaded) | 1018.88 | 976.33 | 976.33 | true / true |
| chromium-shell@macos | 979.53 (loaded) | 953.64 | 979.53 | 979.53 | true / false |
| chromium@macos | 979.53 (loaded) | 953.64 | 979.53 | 979.53 | true / false |
| webkit@macos | 979.59 (loaded) | 1078.88 | 979.59 | 979.59 | true / true |

## B published sites

| engine | scheme | site | first load | reload | font requests: status, mode, cookie, Origin | statuses on reload | Referer of /_files/ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-3pcb@linux | https | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-3pcb@linux | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-3pcb@linux | https | s2 (password, today) | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-3pcb@linux | https | s4 (password, ACAO *) | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-3pcb@linux | http | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 1 | absent |
| chromium-3pcb@linux | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 1 | absent |
| chromium-3pcb@linux | https | s5 (password, ACAO *) + Referrer-Policy strict-origin | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@linux | https | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@linux | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@linux | https | s2 (password, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@linux | https | s4 (password, ACAO *) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@linux | http | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200; If-None-Match 4 | absent |
| chromium-shell@linux | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304; If-None-Match 7 | absent |
| chromium@linux | https | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium@linux | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium@linux | https | s2 (password, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium@linux | https | s4 (password, ACAO *) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium@linux | http | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 1 | absent |
| chromium@linux | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 1 | absent |
| chromium@linux | https | s5 (password, ACAO *) + Referrer-Policy strict-origin | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| firefox-tcp@linux | https | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,304,404; If-None-Match 3 | absent, https://xsite.test/ |
| firefox-tcp@linux | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,404; If-None-Match 1 | absent, https://xsite.test/ |
| firefox-tcp@linux | https | s2 (password, today) | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 404; If-None-Match 1 | absent, https://xsite.test/ |
| firefox-tcp@linux | https | s4 (password, ACAO *) | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 404; If-None-Match 1 | absent, https://xsite.test/ |
| firefox-tcp@linux | http | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 3 | absent |
| firefox-tcp@linux | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 1 | absent |
| firefox-tcp@linux | https | s5 (password, ACAO *) + Referrer-Policy strict-origin | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | font ✗ · font from css ✗ · css ✗ · js ✗ · mjs ✗ · img ✗ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 404; If-None-Match 1 | https://s5.pages.spike.test/, absent, https://xsite.test/ |
| firefox@linux | https | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,304,404; If-None-Match 3 | absent, https://xsite.test/ |
| firefox@linux | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,404; If-None-Match 1 | absent, https://xsite.test/ |
| firefox@linux | https | s2 (password, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 1 | absent, https://xsite.test/ |
| firefox@linux | https | s4 (password, ACAO *) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 1 | absent, https://xsite.test/ |
| firefox@linux | http | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 2 | absent |
| firefox@linux | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 1 | absent |
| firefox@linux | https | s5 (password, ACAO *) + Referrer-Policy strict-origin | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 1 | https://s5.pages.spike.test/, absent, https://xsite.test/ |
| webkit@linux | https | s1 (public, today) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 no-cors no cookie absent; 200 no-cors no cookie absent | 200; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@linux | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 no-cors no cookie absent; 200 no-cors no cookie absent | 200; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@linux | https | s2 (password, today) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 no-cors cookie absent; 200 no-cors cookie absent | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@linux | https | s4 (password, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 no-cors cookie absent; 200 no-cors cookie absent | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@linux | http | s1 (public, today) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie absent; 200 - no cookie absent | 200,304; If-None-Match 5 | absent |
| webkit@linux | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie absent; 200 - no cookie absent | 200,304; If-None-Match 6 | absent |
| webkit@linux | https | s5 (password, ACAO *) + Referrer-Policy strict-origin | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 no-cors cookie absent; 200 no-cors cookie absent | 200,404; If-None-Match 0 | https://s5.pages.spike.test/, https://xsite.test/ |
| chromium-shell@macos | https | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@macos | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@macos | https | s2 (password, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@macos | https | s4 (password, ACAO *) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium-shell@macos | http | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200; If-None-Match 4 | absent |
| chromium-shell@macos | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304; If-None-Match 7 | absent |
| chromium@macos | https | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium@macos | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 cors no cookie "null"; 200 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium@macos | https | s2 (password, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium@macos | https | s4 (password, ACAO *) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| chromium@macos | http | s1 (public, today) | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 1 | absent |
| chromium@macos | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie "null"; 200 - no cookie "null" | 304,200,404; If-None-Match 1 | absent |
| chromium@macos | https | s5 (password, ACAO *) + Referrer-Policy strict-origin | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✗ · font from css ✗ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 404 cors no cookie "null"; 404 cors no cookie "null" | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@macos | https | s1 (public, today) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 no-cors no cookie absent; 200 no-cors no cookie absent | 200; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@macos | https | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 no-cors no cookie absent; 200 no-cors no cookie absent | 200; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@macos | https | s2 (password, today) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 no-cors cookie absent; 200 no-cors cookie absent | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@macos | https | s4 (password, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 no-cors cookie absent; 200 no-cors cookie absent | 200,404; If-None-Match 0 | absent, https://xsite.test/ |
| webkit@macos | http | s1 (public, today) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 - no cookie absent; 200 - no cookie absent | 200,304; If-None-Match 5 | absent |
| webkit@macos | http | s3 (public, ACAO *) | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✓ · img ✓ · data ✓ | 200 - no cookie absent; 200 - no cookie absent | 200,304; If-None-Match 6 | absent |
| webkit@macos | https | s5 (password, ACAO *) + Referrer-Policy strict-origin | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | font ✓ · font from css ✓ · css ✓ · js ✓ · mjs ✗ · img ✓ · data ✓ | 200 no-cors cookie absent; 200 no-cors cookie absent | 200,404; If-None-Match 0 | https://s5.pages.spike.test/, https://xsite.test/ |

## B2 another site embeds the files of a site with a password (after the password)

| engine | site | script ran there | css applied | img | fetch with credentials | fetch | requests: status, cookie |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chromium-3pcb@linux | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium-3pcb@linux | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium-3pcb@linux | s2 (password, today) | false | 1px | 0 | blocked TypeError | blocked TypeError | style.css 404 no cookie; app.js 404 no cookie; img/logo.png 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |
| chromium-3pcb@linux | s4 (password, ACAO *) | false | 1px | 0 | blocked TypeError | blocked TypeError | style.css 404 no cookie; app.js 404 no cookie; img/logo.png 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |
| chromium-3pcb@linux | s5 (password, ACAO *, strict-origin) | false | 1px | 0 | blocked TypeError | blocked TypeError | app.js 404 no cookie; img/logo.png 404 no cookie; style.css 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |
| chromium-shell@linux | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium-shell@linux | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium-shell@linux | s2 (password, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium-shell@linux | s4 (password, ACAO *) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium@linux | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium@linux | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium@linux | s2 (password, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium@linux | s4 (password, ACAO *) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium@linux | s5 (password, ACAO *, strict-origin) | true | 37px | 3 | blocked TypeError | blocked TypeError | app.js 200 cookie; img/logo.png 200 cookie; style.css 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| firefox-tcp@linux | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| firefox-tcp@linux | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| firefox-tcp@linux | s2 (password, today) | false | 1px | 0 | blocked TypeError | blocked TypeError | style.css 404 no cookie; app.js 404 no cookie; img/logo.png 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |
| firefox-tcp@linux | s4 (password, ACAO *) | false | 1px | 0 | blocked TypeError | blocked TypeError | style.css 404 no cookie; app.js 404 no cookie; img/logo.png 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |
| firefox-tcp@linux | s5 (password, ACAO *, strict-origin) | false | 1px | 0 | blocked TypeError | blocked TypeError | style.css 404 no cookie; app.js 404 no cookie; img/logo.png 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |
| firefox@linux | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| firefox@linux | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| firefox@linux | s2 (password, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| firefox@linux | s4 (password, ACAO *) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| firefox@linux | s5 (password, ACAO *, strict-origin) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| webkit@linux | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| webkit@linux | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| webkit@linux | s2 (password, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| webkit@linux | s4 (password, ACAO *) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| webkit@linux | s5 (password, ACAO *, strict-origin) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium-shell@macos | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium-shell@macos | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium-shell@macos | s2 (password, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium-shell@macos | s4 (password, ACAO *) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium@macos | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium@macos | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; app.js 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| chromium@macos | s2 (password, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium@macos | s4 (password, ACAO *) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| chromium@macos | s5 (password, ACAO *, strict-origin) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 cookie; app.js 200 cookie; img/logo.png 200 cookie; app.js 200 cookie; app.js 404 no cookie |
| webkit@macos | s1 (public, today) | true | 37px | 3 | blocked TypeError | blocked TypeError | style.css 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| webkit@macos | s3 (public, ACAO *) | true | 37px | 3 | blocked TypeError | read 200 | style.css 200 no cookie; img/logo.png 200 no cookie; app.js 200 no cookie; app.js 200 no cookie; app.js 200 no cookie |
| webkit@macos | s2 (password, today) | false | 1px | 0 | blocked TypeError | blocked TypeError | style.css 404 no cookie; img/logo.png 404 no cookie; app.js 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |
| webkit@macos | s4 (password, ACAO *) | false | 1px | 0 | blocked TypeError | blocked TypeError | style.css 404 no cookie; img/logo.png 404 no cookie; app.js 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |
| webkit@macos | s5 (password, ACAO *, strict-origin) | false | 1px | 0 | blocked TypeError | blocked TypeError | style.css 404 no cookie; img/logo.png 404 no cookie; app.js 404 no cookie; app.js 404 no cookie; app.js 404 no cookie |

## C a content-addressed library in three frames (Cache-Control immutable)

| engine | scheme | sandbox | csp | frames with font F-h1 | server hits per kind (h1) |
| --- | --- | --- | --- | --- | --- |
| chromium-shell@linux | https | art | c1 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium-shell@linux | https | art | c3 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium-shell@linux | https | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium-shell@linux | http | art | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium-shell@linux | http | art | c3 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium-shell@linux | http | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium@linux | https | art | c1 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium@linux | https | art | c3 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium@linux | https | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium@linux | http | art | c1 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium@linux | http | art | c3 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium@linux | http | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| firefox@linux | https | art | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| firefox@linux | https | art | c3 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| firefox@linux | https | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| firefox@linux | http | art | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| firefox@linux | http | art | c3 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| firefox@linux | http | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@linux | https | art | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@linux | https | art | c3 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@linux | https | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@linux | http | art | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@linux | http | art | c3 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@linux | http | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium-shell@macos | https | art | c1 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium-shell@macos | https | art | c3 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium-shell@macos | https | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium-shell@macos | http | art | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium-shell@macos | http | art | c3 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium-shell@macos | http | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium@macos | https | art | c1 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium@macos | https | art | c3 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium@macos | https | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| chromium@macos | http | art | c1 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium@macos | http | art | c3 | 3 / 3 | font 3, js 3, jsx 3, mjs 3, mji 3, css 3, img 3 |
| chromium@macos | http | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@macos | https | art | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@macos | https | art | c3 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@macos | https | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@macos | http | art | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@macos | http | art | c3 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |
| webkit@macos | http | none | c1 | 3 / 3 | font 1, js 1, jsx 1, mjs 1, mji 1, css 1, img 1 |

## D Chromium: frames in a process of their own (CDP iframe targets)

| engine | scheme | iframe targets |
| --- | --- | --- |
| chromium-shell@linux | https | [] |
| chromium-shell@linux | http | [] |
| chromium@linux | https | ["pages.spike.test/v/view-art","xsite.test/"] |
| chromium@linux | http | ["pages.spike.test/v/view-art","xsite.test/"] |
| chromium-shell@macos | https | [] |
| chromium-shell@macos | http | [] |
| chromium@macos | https | ["pages.spike.test/v/view-art","xsite.test/"] |
| chromium@macos | http | ["pages.spike.test/v/view-art","xsite.test/"] |

## E agreement within an engine family (all frame cells)

| family | builds | cells compared | differ |
| --- | --- | --- | --- |
| Chromium | chromium-shell@linux, chromium@linux, chromium-shell@macos, chromium@macos, chromium-3pcb@linux | 4704 | 0 |
| Firefox | firefox@linux, firefox-tcp@linux | 0 | 0 |
| WebKit | webkit@linux, webkit@macos | 1568 | 0 |

