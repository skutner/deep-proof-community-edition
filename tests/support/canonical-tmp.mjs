// macOS keeps temporary folders behind a system symbolic link (/var -> /private/var), and Deep Proof refuses
// every artifact path that contains a link. On macOS the tests therefore use the resolved temporary folder.
// Nothing is changed on any other system, so a temporary folder behind a link still shows there as the product
// defect it is. Loaded before the tests through --import in package.json.
import fs from 'node:fs';
import os from 'node:os';
if(process.platform==='darwin')process.env.TMPDIR=fs.realpathSync(os.tmpdir());
