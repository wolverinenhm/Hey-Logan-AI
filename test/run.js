'use strict';

/**
 * Test entry point: runs every suite in a single Node process.
 *
 * Why not `node --test test/`? That runner spawns one child process per test
 * file, which some restricted environments (sandboxed agents, locked-down CI)
 * block. Running the files in-process works everywhere.
 */

require('./util.test.js');
require('./config.test.js');
require('./security.test.js');
require('./router.test.js');
require('./computer.test.js');
require('./tls.test.js');
require('./voice.test.js');
require('./ui.test.js');
require('./server.test.js');
