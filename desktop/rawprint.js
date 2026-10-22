// Sends bytes to a Windows printer queue as a RAW job. The printer gets the ESC/POS
// commands exactly as the app made them; the driver doesn't redraw or resize anything.
const koffi = require('koffi');

const winspool = koffi.load('winspool.drv');
const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
koffi.struct('DOC_INFO_1W', { pDocName: 'str16', pOutputFile: 'str16', pDatatype: 'str16' });
const OpenPrinter = winspool.func('bool __stdcall OpenPrinterW(str16 name, _Out_ HANDLE *printer, void *defaults)');
const ClosePrinter = winspool.func('bool __stdcall ClosePrinter(HANDLE printer)');
const StartDocPrinter = winspool.func('uint32_t __stdcall StartDocPrinterW(HANDLE printer, uint32_t level, DOC_INFO_1W *doc)');
const EndDocPrinter = winspool.func('bool __stdcall EndDocPrinter(HANDLE printer)');
const StartPagePrinter = winspool.func('bool __stdcall StartPagePrinter(HANDLE printer)');
const EndPagePrinter = winspool.func('bool __stdcall EndPagePrinter(HANDLE printer)');
const WritePrinter = winspool.func('bool __stdcall WritePrinter(HANDLE printer, const void *buf, uint32_t size, _Out_ uint32_t *written)');

// outputFile makes Windows write the job to a file instead of the printer (used by check-print.js).
function printRaw(printerName, bytes, { docName = 'Receipt', outputFile = null } = {}) {
  const out = [null];
  if (!OpenPrinter(printerName, out, null)) throw new Error('printer-missing');
  const printer = out[0];
  try {
    if (!StartDocPrinter(printer, 1, { pDocName: docName, pOutputFile: outputFile, pDatatype: 'RAW' })) throw new Error('printer-refused');
    try {
      StartPagePrinter(printer);
      const written = [0];
      if (!WritePrinter(printer, bytes, bytes.length, written) || written[0] !== bytes.length) throw new Error('printer-stuck');
      EndPagePrinter(printer);
    } finally {
      EndDocPrinter(printer);
    }
  } finally {
    ClosePrinter(printer);
  }
}

module.exports = { printRaw };
