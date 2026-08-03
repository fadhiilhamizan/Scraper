#!/usr/bin/env node
/**
 * `harvest` CLI entry point.
 *
 * Kept deliberately thin: it resolves the exit code and makes sure stdout is
 * flushed before exiting, which matters when output is piped.
 */

import { main } from '../src/cli/index.js';

process.on('unhandledRejection', (error) => {
  process.stderr.write(`\nUnhandled rejection: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

const code = await main();

// Setting exitCode rather than calling process.exit() lets pending stdout
// writes drain — otherwise piped output can be truncated.
process.exitCode = code;
