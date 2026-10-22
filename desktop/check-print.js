// Checks that rawprint.js hands a job to Windows byte for byte, without printing anything:
// Windows' built-in "Generic / Text Only" printer is told to write the job to a file instead.
// Run with:  npm run check
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { printRaw } = require('./rawprint');

const PRINTER = 'Generic / Text Only';
const out = path.join(os.tmpdir(), `storekeeper-print-check-${process.pid}.bin`);
const job = crypto.randomBytes(70000); // about the size of a long receipt

let failed = false;
const ok = (c, label, extra = '') => { console.log(c ? '  ✓' : '  ✗', label, c ? '' : extra); if (!c) failed = true; };

try {
  printRaw('No Such Printer', job);
  ok(false, 'unknown printer is refused');
} catch (e) {
  ok(e.message === 'printer-missing', 'unknown printer is refused', e.message);
}

try {
  printRaw(PRINTER, job, { docName: 'Storekeeper check', outputFile: out });
} catch (e) {
  console.log(`  ✗ could not print to "${PRINTER}" (${e.message}). Add it in Windows: Settings → Printers → Add a printer manually → Generic / Text Only.`);
  process.exit(1);
}

// Windows writes the file a moment after the job is handed over.
const started = Date.now();
(function waitForFile() {
  const got = fs.existsSync(out) ? fs.readFileSync(out) : null;
  if ((!got || got.length < job.length) && Date.now() - started < 15000) return setTimeout(waitForFile, 200);
  ok(got && got.equals(job), 'job reaches Windows byte for byte', got ? `${got.length} bytes` : 'no file');
  fs.rmSync(out, { force: true });
  process.exit(failed ? 1 : 0);
})();
