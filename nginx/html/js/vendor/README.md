# Vendored browser libraries

Served locally so the app works offline and nothing runs from a third-party CDN.
Files are byte-identical to the cdnjs builds below (verified against the cdnjs SHA-512 SRI hash).

| File | Library | Version | License | Source |
|---|---|---|---|---|
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) | 2.5.1 | MIT | https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js |
| `jszip.min.js` | [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT or GPL-3.0 | https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js |
| `qrcode.min.js` | [QRCode.js](https://github.com/davidshimjs/qrcodejs) | 1.0.0 | MIT | https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js |

To update one, download the new build, check it against the SRI hash from
`https://api.cdnjs.com/libraries/<name>/<version>?fields=sri`, and update this table.
