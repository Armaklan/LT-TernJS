/* If true, add many trace */
var DEBUG = true;

/* External dependencies */
var fs = require('fs'),
    tern = require('tern'),
    os = require('os');

/* Timeout gestion. Shutdown is a shared state. */
var maxIdleTime = 6e4 * 5, // Shut down after five minutes of inactivity
    shutdown = setTimeout(doShutdown, maxIdleTime);

/* Use to fix filesystem */
var isWin = os.platform() === 'win32';

var logLevel = {
  INFO : 'INFO',
  WARNING : 'WARNING',
  ERROR : 'ERROR'
};

/* Contains TernJs instance */
var server;

/* Contains last receive message. Use to return it when unknown error is throw.
  TODO - Delete shared state */
var currentmsg;

var asyncImportFiles = (function() {
  var cachedFiles = [],
      count = 0,
      nextFile;
  function next(server) {
    nextFile = cachedFiles.pop();
    if (nextFile) {
      try {
        server.addFile(nextFile);
      } catch(e) {
        _log(logLevel.ERROR, 'An error occured while loading file: ', {file: nextFile});
        send(e);
      }
      count++;
      setTimeout(function() { next(server);}, 0);
      return;
    }
    _log(logLevel.INFO, 'Finished loading files', {time: new Date(), count: count });
  }
  return function(server, files) {
    _log(logLevel.INFO, 'Start loading files: ', {startTime: new Date(), fileCount: files.length});
    cachedFiles = cachedFiles.concat(files);
    next(server);
  };
}());


function doShutdown() {
  console.log('Was idle for ' + Math.floor(maxIdleTime / 6e4) + ' minutes. Shutting down.');
  closeTernProcess();
}

function send(err, data, msg) {
  msg = msg || {};
  var result = { data: {} };
  if (msg) {
    result.cb = msg.cb;
    result.command = msg.command;
    result.data = msg.data || {};
  }
  if (err) {
    result.err = err;
    result.stack = err.stack;
    result.command  = 'error';
  }
  result.data.payload = data || null;
  process.send(result);
}

function _log(level, str, obj) {
  if (DEBUG) {
    send(null, '[' + level + '] '+ str + (obj ? ' : ' + JSON.stringify(obj) : ''), { command: 'log' });
  }
}

function loadLibs(paths) {
  return paths.map(function(x) { return JSON.parse(fs.readFileSync(x)); });
}

function loadPlugins(paths) {
  if (!paths) { _log(logLevel.INFO, 'No plugins loaded'); }
  var plugins = {};
  (paths || []).forEach(function(x) {
    require(x.path);
    plugins[x.name] = x.opts;
  });
  return plugins;
}

function getServer(msg) {
  if (server) { return server; }
  _log(logLevel.INFO, 'getServer(msg) : ', msg.command);
  if (msg.command !== 'init') {
    throw new Error('Server not started and on init message received');
  }
  _log(logLevel.INFO, 'Creating new tern server', msg);
  server = new tern.Server({
    async: true,
    defs: loadLibs(msg.data.payload.config.libs),
    plugins: loadPlugins(msg.data.payload.config.plugins),
    getFile: function(x, cb) {
      var path = x;
      if (!isWin && path && path[0] !== '/') {
        path = '/' + x;
      }
      _log(logLevel.INFO, "Attempting to load file", path);
      fs.readFile(path, {encoding: 'utf8'}, cb);
    }
  });
  return server;
}

process.on('message', processMessage);
process.on('SIGINT', closeTernProcess);
process.on('SIGTERM', closeTernProcess);
process.on('uncaughtException', function (err) {
  send(err, {}, currentmsg);
});

function processMessage(msg) {
  clearTimeout(shutdown);
  shutdown = setTimeout(doShutdown, maxIdleTime);
  currentmsg = msg;
  try {
    var srv = getServer(msg),
        data = msg.data || {};
    switch(data.type) {
      case 'request':
        processRequest(srv, msg, data);
        break;
      case 'addfiles':
        processAddFiles(srv, msg, data);
        break;
      case 'deletefiles':
        processDeleteFiles(srv, msg, data);
        break;
      case 'init':
        processInit(srv, msg, data);
        break;
    }
  } catch (e) {
    // Tern throws Syntax errors for unterminated block comments
    if (e instanceof SyntaxError) return;
    send(e, {}, currentmsg);
    doShutdown();
  }
}

function processRequest(srv, msg, data) {
  _log(logLevel.INFO, 'Received message', data.payload);
  srv.request(data.payload, function(err, out) {
    _log(logLevel.INFO, 'Sending message', out);
    send(err, out, msg);
  });
  _log(logLevel.INFO, 'Server files', srv.files.map(function(x) { return x.name; }));
}

function processAddFiles(srv, msg, data) {
  asyncImportFiles(srv, data.payload);
  send(null, {}, msg);
}

function processDeleteFiles(srv, msg, data) {
  data.payload.forEach(function(file) {
    srv.delFile(file);
  });
  send(null, {}, msg);
}

function processInit(srv, msg, data) {
  _log(logLevel.INFO, 'Init server');
  if (!data.payload.paths) { _log(logLevel.WARNING, 'No files found for loading'); }
  asyncImportFiles(srv, data.payload.paths || []);
  send(null, {}, msg);
}

function closeTernProcess() {
  process.exit();
}
