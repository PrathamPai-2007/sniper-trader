'use strict';
const index = require('./dist/index.js');
module.exports = index;

if (require.main === module) {
  index.main().catch((e) => {
    const utils = require('./dist/core/utils.js');
    utils.log(
      index.config && index.config.logFile ? index.config.logFile : './bot-error.log',
      e.stack || e.message,
      'error'
    );
    process.exitCode = 1;
  });
}
