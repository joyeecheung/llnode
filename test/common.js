'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const spawn = require('child_process').spawn;
const EventEmitter = require('events').EventEmitter;

exports.fixturesDir = path.join(__dirname, 'fixtures');
exports.buildDir = path.join(__dirname, '..', 'out', 'Release');

exports.core = path.join(os.tmpdir(), 'core');

function llnodeDebug(...args) {
  console.error('[TEST]', ...args);
}

const debug = exports.debug =
  process.env.LLNODE_DEBUG ? llnodeDebug : () => { };

let pluginName;
if (process.platform === 'darwin')
  pluginName = 'llnode.dylib';
else if (process.platform === 'windows')
  pluginName = 'llnode.dll';
else
  pluginName = path.join('lib.target', 'llnode.so');

exports.llnodePath = path.join(exports.buildDir, pluginName);
exports.saveCoreTimeout = 180 * 1000;
exports.loadCoreTimeout = 20 * 1000;

function SessionOutput(session, stream, timeout) {
  EventEmitter.call(this);
  this.waiting = false;
  this.waitQueue = [];
  let buf = '';
  this.timeout = timeout || 10000;

  stream.on('data', (data) => {
    buf += data;

    for (;;) {
      let index = buf.indexOf('\n');

      if (index === -1)
        break;

      const line = buf.slice(0, index);
      buf = buf.slice(index + 1);

      if (/process \d+ exited/i.test(line))
        session.kill();
      else
        this.emit('line', line);
    }
  });

  // Ignore errors
  stream.on('error', () => {});
}
util.inherits(SessionOutput, EventEmitter);

SessionOutput.prototype._queueWait = function _queueWait(retry) {
  if (this.waiting) {
    this.waitQueue.push(retry);
    return false;
  }

  this.waiting = true;
  return true;
};

SessionOutput.prototype._unqueueWait = function _unqueueWait() {
  this.waiting = false;
  if (this.waitQueue.length > 0)
    this.waitQueue.shift()();
};

SessionOutput.prototype.timeoutAfter = function timeoutAfter(timeout) {
  this.timeout = timeout;
}

SessionOutput.prototype.wait = function wait(regexp, callback, allLines) {
  if (!this._queueWait(() => { this.wait(regexp, callback, allLines); }))
    return;

  const self = this;
  const lines = [];

  function onLine(line) {
    lines.push(line);
    debug('[LINE]', line);

    if (!regexp.test(line)) {
      return;
    }

    self.removeListener('line', onLine);
    self._unqueueWait();
    done = true;

    callback(allLines ? lines : line);
  }

  let done = false;
  let timePassed = 0;
  const interval = 100;
  const check = setInterval(() => {
    timePassed += interval;
    if (done) {
      clearInterval(check);
    }

    if (timePassed > self.timeout) {
      self.removeListener('line', onLine);
      self._unqueueWait();
      const message = `Test timeout in ${this.timeout} ` +
        `waiting for ${regexp}\n` +
        `\n${'='.repeat(10)} lldb output ${'='.repeat(10)}\n` +
        `\n${lines.join('\n')}` +
        `\n${'='.repeat(30)}\n`;
      throw new Error(message);
    }
  }, interval);

  this.on('line', onLine);
};

SessionOutput.prototype.waitBreak = function waitBreak(callback) {
  this.wait(/Process \d+ stopped/i, callback);
};

SessionOutput.prototype.linesUntil = function linesUntil(regexp, callback) {
  this.wait(regexp, callback, true);
};

function Session(options) {
  EventEmitter.call(this);
  const timeout = parseInt(process.env.TEST_TIMEOUT) || 10000;
  const lldbBin = process.env.TEST_LLDB_BINARY || 'lldb';
  const env = Object.assign({}, process.env);

  if (options.ranges) {
    env.LLNODE_RANGESFILE = options.ranges;
  }

  debug('lldb binary:', lldbBin);
  if (options.scenario) {
    this.needToKill = true;
    // lldb -- node scenario.js
    const args = [
      '--',
      process.execPath,
      '--abort_on_uncaught_exception',
      '--expose_externalize_string',
      path.join(exports.fixturesDir, options.scenario)
    ];

    debug('lldb args:', args);
    this.lldb = spawn(lldbBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env
    });
    this.lldb.stdin.write(`plugin load "${exports.llnodePath}"\n`);
    this.lldb.stdin.write('run\n');
  } else if (options.core) {
    this.needToKill = false;
    debug('loading core', options.core)
    // lldb node -c core
    this.lldb = spawn(lldbBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env
    });
    this.lldb.stdin.write(`plugin load "${exports.llnodePath}"\n`);
    this.lldb.stdin.write(`target create "${options.executable}"` +
      ` --core "${options.core}"\n`);
  }
  this.stdout = new SessionOutput(this, this.lldb.stdout, timeout);
  this.stderr = new SessionOutput(this, this.lldb.stderr, timeout);

  this.stderr.on('line', (line) => {
    debug('[stderr]', line);
  });

  // Map these methods to stdout for compatibility with legacy tests.
  this.wait = SessionOutput.prototype.wait.bind(this.stdout);
  this.waitBreak = SessionOutput.prototype.waitBreak.bind(this.stdout);
  this.linesUntil = SessionOutput.prototype.linesUntil.bind(this.stdout);
  this.timeoutAfter = SessionOutput.prototype.timeoutAfter.bind(this.stdout);
}
util.inherits(Session, EventEmitter);
exports.Session = Session;

Session.create = function create(scenario) {
  return new Session({ scenario: scenario });
};

Session.loadCore = function loadCore(executable, core, ranges) {
  return new Session({
    executable: executable,
    core: core,
    ranges: ranges
  });
}

Session.prototype.waitCoreLoad = function waitCoreLoad(callback) {
  this.wait(/Core file[^\n]+was loaded/, callback);
};

Session.prototype.kill = function kill() {
  this.lldb.kill();
  this.lldb = null;
};

Session.prototype.quit = function quit() {
  if (this.needToKill) {
    this.send('kill');
  }
  this.send('quit');
};

Session.prototype.send = function send(line, callback) {
  debug('[SEND]', line);
  this.lldb.stdin.write(line + '\n', callback);
};

exports.generateRanges = function generateRanges(core, dest, cb) {
  let script;
  if (process.platform === 'darwin')
    script = path.join(__dirname, '..', 'scripts', 'otool2segments.py');
  else
    script = path.join(__dirname, '..', 'scripts', 'readelf2segments.py');

  debug('[RANGES]', `${script}, ${core}, ${dest}`);
  const proc = spawn(script, [core], {
    stdio: [null, 'pipe', 'inherit']
  });

  proc.stdout.pipe(fs.createWriteStream(dest));

  proc.on('exit', (status) => {
    cb(status === 0 ? null : new Error('Failed to generate ranges'));
  });
};
