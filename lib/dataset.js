// Copyright 2016 Luca-SAS, licensed under the Apache License 2.0

'use strict';

var fs = require('fs');
var path = require('path');
var url = require('url');
var util = require('util');
var stream = require('stream');

var thenify = require('thenify').withCallback;
var uuid = require('uuid');
var merge2 = require('merge2');
var glob = require('micromatch');
var AWS = require('aws-sdk');
var azure = require('azure-storage');

var splitLocalFile = require('./readsplit.js').splitLocalFile;
var splitHDFSFile = require('./readsplit.js').splitHDFSFile;
var parquet = require ('./parquet.js');

function Dataset(sc, dependencies) {
  this.id = sc.datasetIdCounter++;
  this.dependencies = dependencies || [];
  this.persistent = false;
  this.sc = sc;
}

Dataset.prototype.persist = function () {this.persistent = true; return this;};

Dataset.prototype.map = function (mapper, args) {return new Map(this, mapper, args);};

Dataset.prototype.flatMap = function (mapper, args) {return new FlatMap(this, mapper, args);};

Dataset.prototype.mapValues = function (mapper, args) {return new MapValues(this, mapper, args);};

Dataset.prototype.flatMapValues = function (mapper, args) {return new FlatMapValues(this, mapper, args);};

Dataset.prototype.filter = function (filter, args) {return new Filter(this, filter, args);};

Dataset.prototype.sample = function (withReplacement, frac, seed) {return new Sample(this, withReplacement, frac, seed || 1);};

Dataset.prototype.union = function (other) {return (other.id == this.id) ? this : new Union(this.sc, [this, other]);};

Dataset.prototype.aggregateByKey = function (reducer, combiner, init, args) {
  if (arguments.length < 3) throw new Error('Missing argument for function aggregateByKey().');
  return new AggregateByKey(this.sc, [this], reducer, combiner, init, args);
};

Dataset.prototype.reduceByKey = function (reducer, init, args) {
  if (arguments.length < 2) throw new Error('Missing argument for function reduceByKey().');
  return new AggregateByKey(this.sc, [this], reducer, reducer, init, args);
};

Dataset.prototype.groupByKey = function () {
  function reducer(a, b) {a.push(b); return a;}
  function combiner(a, b) {return a.concat(b);}
  return new AggregateByKey(this.sc, [this], reducer, combiner, [], {});
};

Dataset.prototype.coGroup = function (other) {
  function reducer(a, b) {a.push(b); return a;}
  function combiner(a, b) {
    for (var i = 0; i < b.length; i++) a[i] = a[i].concat(b[i]);
    return a;
  }
  return new AggregateByKey(this.sc, [this, other], reducer, combiner, [], {});
};

Dataset.prototype.cartesian = function (other) {return new Cartesian(this.sc, [this, other]);};

Dataset.prototype.sortBy = function (sorter, ascending, numPartitions) {
  return new SortBy(this.sc, this, sorter, ascending, numPartitions);
};

Dataset.prototype.partitionBy = function (partitioner) {
  return new PartitionBy(this.sc, this, partitioner);
};

Dataset.prototype.sortByKey = function (ascending, numPartitions) {
  return new SortBy(this.sc, this, function (data) {return data[0];}, ascending, numPartitions);
};

Dataset.prototype.join = function (other) {
  return this.coGroup(other).flatMapValues(function (v) {
    var res = [];
    for (var i in v[0])
      for (var j in v[1])
        res.push([v[0][i], v[1][j]]);
    return res;
  });
};

Dataset.prototype.leftOuterJoin = function (other) {
  return this.coGroup(other).flatMapValues(function (v) {
    var res = [], i, j;
    if (v[1].length == 0) {
      for (i in v[0]) res.push([v[0][i], null]);
    } else {
      for (i in v[0])
        for (j in v[1]) res.push([v[0][i], v[1][j]]);
    }
    return res;
  });
};

Dataset.prototype.rightOuterJoin = function (other) {
  return this.coGroup(other).flatMapValues(function (v) {
    var res = [], i, j;
    if (v[0].length == 0) {
      for (i in v[1]) res.push([null, v[1][i]]);
    } else {
      for (i in v[0])
        for (j in v[1]) res.push([v[0][i], v[1][j]]);
    }
    return res;
  });
};

Dataset.prototype.distinct = function () {
  return this.map(function (e) {return [e, null];})
    .reduceByKey(function (a) {return a;}, null)
    .map(function (a) {return a[0];});
};

Dataset.prototype.intersection = function (other) {
  function mapper(e) {return [e, 0];}
  function reducer(a) {return a + 1;}
  var a = this.map(mapper).reduceByKey(reducer, 0);
  var b = other.map(mapper).reduceByKey(reducer, 0);
  return a.coGroup(b).flatMap(function (a) {
    return (a[1][0].length && a[1][1].length) ? [a[0]] : [];
  });
};

Dataset.prototype.subtract = function (other) {
  function mapper(e) {return [e, 0];}
  function reducer(a) {return a + 1;}
  var a = this.map(mapper).reduceByKey(reducer, 0);
  var b = other.map(mapper).reduceByKey(reducer, 0);
  return a.coGroup(b).flatMap(function (a) {
    var res = [];
    if (a[1][0].length && (a[1][1].length == 0))
      for (var i = 0; i < a[1][0][0]; i++) res.push(a[0]);
    return res;
  });
};

Dataset.prototype.keys = function () {return this.map(function (a) {return a[0];});};

Dataset.prototype.values = function () {return this.map(function (a) {return a[1];});};

Dataset.prototype.lookup = thenify(function (key, done) {
  return this.filter(function (kv, args) {return kv[0] === args.key;}, {key: key})
    .map(function (kv) {return kv[1];}).collect(done);
});

Dataset.prototype.countByValue = thenify(function (done) {
  return this.map(function (e) {return [e, 1];})
    .reduceByKey(function (a, b) {return a + b;}, 0)
    .collect(done);
});

Dataset.prototype.countByKey = thenify(function (done) {
  return this.mapValues(function () {return 1;})
    .reduceByKey(function (a, b) {return a + b;}, 0)
    .collect(done);
});

Dataset.prototype.collect = thenify(function (done) {
  return this.aggregate(function (a, b) {a.push(b); return a;}, function (a, b) {return a.concat(b);}, [], done);
});

// The stream action allows the master to return a dataset as a stream
// Each worker spills its partitions to disk
// then master pipes each remote partition into output stream
Dataset.prototype.stream = function (options) {
  options = options || {};
  var self = this;
  var outStream = merge2();
  var opt = {
    gzip: options.gzip,
    _preIterate: function (opt, wc, p) {
      var suffix = opt.gzip ? '.gz' : '';
      wc.exportFile = wc.basedir + 'export/' + p + suffix;
    },
    _postIterate: function (acc, opt, wc, p, done) {
      var fs = wc.lib.fs;
      var zlib = wc.lib.zlib;
      if (opt.gzip) {
        fs.appendFileSync(wc.exportFile, zlib.gzipSync(acc, {
          chunckSize: 65536,
          level: zlib.Z_BEST_SPEED
        }));
      } else {
        fs.appendFileSync(wc.exportFile, acc);
      }
      done(wc.exportFile);
    }
  };
  var pstreams = [];

  function reducer(acc, val, opt, wc) {
    acc = acc.concat(JSON.stringify(val) + '\n');
    if (acc.length >= 65536) {
      var fs = wc.lib.fs;
      if (opt.gzip) {
        var zlib = wc.lib.zlib;
        fs.appendFileSync(wc.exportFile, zlib.gzipSync(acc, {
          chunckSize: 65536,
          level: zlib.Z_BEST_SPEED
        }));
      } else {
        fs.appendFileSync(wc.exportFile, acc);
      }
      acc = '';
    }
    return acc;
  }

  function combiner(acc1, acc2) {
    var p = acc2.path.match(/.+\/([0-9]+)/)[1];
    pstreams[p] = self.sc.getReadStreamSync(acc2);
  }

  this.aggregate(reducer, combiner, '', opt, function () {
    for (var i = 0; i < pstreams.length; i++)
      outStream.add(pstreams[i]);
  });

  if (options.end) outStream.on('end', self.sc.end);
  return outStream;
};

// In save action, each worker exports its dataset partitions to
// a destination: a directory on the master, a remote S3, a database, etc.
// The format is JSON, one per dataset entry (dataset = stream of JSON)
//
// Step 1: partition is spilled to disk (during pipelining)
// Step 2: partition file is streamed from disk to destination (at end of pipeline)
// This is necessary because all pipeline functions are synchronous
// and to avoid back pressure during streaming out.
//
Dataset.prototype.save = thenify(function (path, options, done) {
  options = options || {};
  if (arguments.length < 3) done = options;
  path = path.replace(/\/+$/, '');  // Trim trailing slashes (confusing for S3)
  var opt = {
    gzip: options.gzip,
    parquet: options.parquet,
    path: path,
    _preIterate: function (opt, wc, p) {
      var suffix = opt.gzip ? '.gz' : opt.parquet ? '.parquet' : '';
      wc.exportFile = wc.basedir + 'export/' + p + suffix;
      if (opt.parquet) {
        wc.parquetFile = new wc.lib.parquet.ParquetWriter(wc.exportFile, opt.parquet.schema, opt.parquet.compression);
      }
    },
    _postIterate: function (acc, opt, wc, p, done) {
      var suffix = opt.gzip ? '.gz' : opt.parquet ? '.parquet' : '';
      var fs = wc.lib.fs;
      var zlib = wc.lib.zlib;
      var url, readStream, writeStream;
      if (opt.parquet) {
        wc.parquetFile.write(acc);
        wc.parquetFile.close();
      } else if (opt.gzip) {
        fs.appendFileSync(wc.exportFile, zlib.gzipSync(acc, {
          chunckSize: 65536,
          level: zlib.Z_BEST_SPEED
        }));
      } else {
        fs.appendFileSync(wc.exportFile, acc);
      }
      readStream = fs.createReadStream(wc.exportFile);
      url = wc.lib.url.parse(opt.path);
      switch (url.protocol) {
      case 'wasb:':
        var az = wc.lib.azure.createBlobService();
        wc.log('upload', wc.exportFile, 'to', url.auth, url.path.slice(1) + '/' + p + suffix);
        az.createBlockBlobFromLocalFile(
          url.auth,
          url.path.slice(1) + '/' + p + suffix,
          wc.exportFile,
          { maximumExecutionTimeInMs: '3600000' },
          function (err) {
            if (err) wc.log('Azure upload error', err);
            done();
          }
        );
        break;
      case 's3:':
        var s3 = new wc.lib.AWS.S3({
          httpOptions: {timeout: 3600000},
          signatureVersion: 'v4'
        });
        s3.upload({
          Bucket: url.host,
          Key: url.path.slice(1) + '/' + p + suffix,
          Body: readStream
        }, function (err) {
          if (err) wc.log('S3 upload error', err);
          done();
        });
        break;
      case 'file:':
      case null:
        wc.lib.mkdirp.sync(opt.path);
        writeStream = fs.createWriteStream(url.path + '/' + p + suffix);
        readStream.pipe(writeStream);
        writeStream.on('close', done);
        break;
      default:
        wc.log('Error: unsupported protocol', url.protocol);
        done();
      }
    }
  };

  function reducer(acc, val, opt, wc) {
    acc = acc.concat(JSON.stringify(val) + '\n');
    if (acc.length >= 65536) {
      var fs = wc.lib.fs;
      if (opt.gzip) {
        var zlib = wc.lib.zlib;
        fs.appendFileSync(wc.exportFile, zlib.gzipSync(acc, {
          chunckSize: 65536,
          level: zlib.Z_BEST_SPEED
        }));
      } else {
        fs.appendFileSync(wc.exportFile, acc);
      }
      acc = '';
    }
    return acc;
  }

  function parquetReducer(acc, val, opt, wc) {
    if (Array.isArray(val)) acc.push(val);
    else acc.push([val]);
    if (acc.length >= 10000) {
      wc.parquetFile.write(acc);
      acc = [];
    }
    return acc;
  }

  if (opt.parquet)
    return this.aggregate(parquetReducer, function(){}, [], opt, done);
  return this.aggregate(reducer, function(){}, '', opt, done);
});

Dataset.prototype.take = thenify(function (N, done) {
  var reducer = function (a, b, opt) {if (a.length < opt._max) a.push(b); return a;};
  var combiner = function (a, b, opt) {return ((a.length < opt._max) ? a.concat(b) : a).slice(0, opt._max);};
  return this.aggregate(reducer, combiner, [], {_max: N, _maxBusy: 1}, done);
});

Dataset.prototype.top = thenify(function (N, done) {
  var reducer = function (a, b, opt) {a.push(b); return (a.length > opt._max) ? a.slice(1) : a;};
  var combiner = function (a, b, opt) {return ((a.length < opt._max) ? b.concat(a) : a).slice(-opt._max);};
  return this.aggregate(reducer, combiner, [], {_max: N, _maxBusy: 1, _lifo: true}, done);
});

Dataset.prototype.first = thenify(function (done) {
  return this.take(1, function (err, res) {
    if (res) done(err, res[0]);
    else done(err);
  });
});

// Aggregate is the main action. All others are implemented on top of it.
// The following internal option flags drive its behaviour:
// * _max: maximum number of dataset entries to combine. Set by take and top.
//    this allows to skip useless processing once result is obtained.
// * _maxBusy: maximum number of parallel aggregate tasks. Set to 1 by take and top.
// * _lifo: enable partition processing from last to first. Set by top.
//
Dataset.prototype.aggregate = thenify(function (reducer, combiner, init, opt, done) {
  opt = opt || {};
  var action = {args: [], src: reducer, init: init, opt: opt};
  var self = this;

  if (arguments.length < 5) done = opt;

  return this.sc.runJob(opt, this, action, function (job, tasks) {
    var tmp = [];                                     // Pending tasks results waiting for combine
    var result = JSON.parse(JSON.stringify(init));    // reducer/combiner result init
    var index = opt._lifo ? tasks.length - 1 : 0;     // start from 0, or last if top action
    var lastIndex = opt._lifo ? 0 : tasks.length;     // 0 for top action
    var maxBusy = opt._maxBusy || self.sc.worker.length;  // set to 1 for take/top
    var incr = opt._lifo ? -1 : 1;
    var busy = 0;                                     // Number of busy tasks
    var complete = 0;
    var error;

    function runNext() {
      while (busy < maxBusy && index !== lastIndex) {
        self.sc.runTask(tasks[index], function (err, res, task) {
          if (err) {
            // FIXME: should handle task re-submit here for fault tolerance
            console.error('ERROR: aggregate partition', task.pid);
          }
          var i, stop = opt._max && res.data.length >= opt._max;
          var tmpIndex = opt._lifo ? tasks.length - 1 - task.pid : task.pid;
          tmp[tmpIndex] = res.data;
          complete++;
          busy--;
          self.sc.log('part', task.pid, 'from worker-' + res.workerId, '(' + complete + '/' + tasks.length + ')');
          if (!stop && complete < tasks.length) return runNext();
          for (i = 0; i < tmp.length; i++)
            result = combiner(result, tmp[i], opt);
          done(error, result);
        });
        index += incr;
        busy++;
      }
    }

    runNext();
  });
});

Dataset.prototype.reduce = thenify(function (reducer, init, opt, done) {
  opt = opt || {};
  if (arguments.length < 4) done = opt;
  return this.aggregate(reducer, reducer, init, opt, done);
});

Dataset.prototype.count = thenify(function (done) {
  return this.aggregate(function (a) {return a + 1;}, function (a, b) {return a + b;}, 0, done);
});

Dataset.prototype.forEach = thenify(function (eacher, opt, done) {
  var arg = {opt: opt, _foreach: true};
  if (arguments.length < 3) done = opt;
  return this.aggregate(eacher, function () {return null;}, null, arg, done);
});

Dataset.prototype.getPartitions = function (done) {
  if (this.partitions == undefined) {
    this.partitions = {};
    var cnt = 0;
    for (var i = 0; i < this.dependencies.length; i++) {
      for (var j = 0; j < this.dependencies[i].nPartitions; j++) {
        this.partitions[cnt] = new Partition(this.id, cnt, this.dependencies[i].id, this.dependencies[i].partitions[j].partitionIndex);
        cnt++;
      }
    }
    this.nPartitions = cnt;
  }
  done();
};

Dataset.prototype.getPreferedLocation = function () {return [];};

function Partition(datasetId, partitionIndex, parentDatasetId, parentPartitionIndex) {
  this.data = [];
  this.datasetId = datasetId;
  this.partitionIndex = partitionIndex;
  this.parentDatasetId = parentDatasetId;
  this.parentPartitionIndex = parentPartitionIndex;
  this.type = 'Partition';
  //this.count = 0;
  //this.bsize = 0;   // TODO: mv in worker only. estimated size of memory increment per period
  //this.tsize = 0;   // TODO: mv in worker only. estimated total partition size
  //this.skip = false;  // TODO: mv in worker only. true when partition is evicted due to memory shortage
}

Partition.prototype.transform = function (context, data) {
  if (this.skip) return data; // Passthrough if partition is evicted

  // Periodically check/update available memory, and evict partition
  // if necessary. In this case it will be recomputed if required by
  // a future action.
  if (this.count++ == 9999) {
    this.count = 0;
    if (this.bsize == 0) this.bsize = this.mm.sizeOf(this.data);
    this.tsize += this.bsize;
    this.mm.storageMemory += this.bsize;
    if (this.mm.storageFull()) {
      console.log('# Out of memory, evict partition', this.partitionIndex);
      this.skip = true;
      this.mm.storageMemory -= this.tsize;
      this.data = [];
      this.mm.unregister(this);
      return data;
    }
  }

  // Perform persistence of partition in memory here
  for (var i = 0; i < data.length; i++) this.data.push(data[i]);
  return data;
};

Partition.prototype.iterate = function (task, p, pipeline, done) {
  var buffer;

  for (var i = 0; i < this.data.length; i++) {
    buffer = [this.data[i]];
    for (var t = 0; t < pipeline.length; t++)
      buffer = pipeline[t].transform(pipeline[t], buffer);
  }
  done();
};

function Source(sc, N, getItem, args, npart) {
  Dataset.call(this, sc);
  this.getItem = getItem;
  this.npart = npart;
  this.N = N;
  this.args = args;
  this.type = 'Source';
}
util.inherits(Source, Dataset);

Source.prototype.iterate = function (task, p, pipeline, done) {
  var buffer, i, index = this.bases[p], n = this.sizes[p];

  for (i = 0; i < n; i++, index++) {
    buffer = [this.getItem(index, this.args, task)];
    for (var t = 0; t < pipeline.length; t++)
      buffer = pipeline[t].transform(pipeline[t], buffer);
  }
  done();
};

Source.prototype.getPartitions = function (done) {
  var P = this.npart || this.sc.worker.length;
  var N = this.N;
  var plen = Math.ceil(N / P);
  var i, max;
  this.partitions = {};
  this.sizes = {};
  this.bases = {};
  this.nPartitions = P;
  for (i = 0, max = plen; i < P; i++, max += plen) {
    this.partitions[i] = new Partition(this.id, i);
    this.sizes[i] = (max <= N) ? plen : (max - N < plen) ? N - (plen * i) : 0;
    this.bases[i] = i ? this.bases[i - 1] + this.sizes[i - 1] : 0;
  }
  done();
};

function parallelize(sc, localArray, P) {
  if (!(localArray instanceof Array))
    throw new Error('First argument of parallelize() is not an instance of Array.');

  return new Source(sc, localArray.length, function (i, a) {return a[i];}, localArray, P);
}

function range(sc, start, end, step, P) {
  if (end === undefined) { end = start; start = 0; }
  if (step === undefined) step = 1;

  return new Source(sc, Math.ceil((end - start) / step), function (i, a) {
    return i * a.step + a.start;
  }, {step: step, start: start}, P);
}

function Obj2line() {
  stream.Transform.call(this, {objectMode: true});
}
util.inherits(Obj2line, stream.Transform);

Obj2line.prototype._transform = function (chunk, encoding, done) {
  done(null, JSON.stringify(chunk) + '\n');
};

function Stream(sc, stream, type) { // type = 'line' ou 'object'
  var id = uuid.v4();
  var tmpFile = sc.basedir + 'tmp/' + id;
  var targetFile = sc.basedir + 'stream/' + id;
  var out = fs.createWriteStream(tmpFile);
  var dataset = sc.textFile(targetFile);

  dataset.watched = true;         // notify skale to wait for file before launching
  dataset.parse = type == 'object';
  out.on('close', function () {
    fs.renameSync(tmpFile, targetFile);
    dataset.watched = false;
  });
  if (type == 'object')
    stream.pipe(new Obj2line()).pipe(out);
  else
    stream.pipe(out);
  return dataset;
}

function parquetIterate(path, pipeline, done) {
  var reader = new parquet.ParquetReader(path);
  var info = reader.info();
  var numRows = info.rows;
  var rows = reader.rows(numRows);
  var i, t;
  var buffer;

//  task.log('rows:', rows);
  for (i = 0; i < numRows; i++) {
    buffer = [rows[i]];
    for (t = 0; t < pipeline.length; t++)
      buffer = pipeline[t].transform(pipeline[t], buffer);
  }
  done();
  reader.close();
}

function ParquetFile(sc, file) {
  Dataset.call(this, sc);
  this.file = file;
  this.type = 'ParquetFile';
}

util.inherits(ParquetFile, Dataset);

ParquetFile.prototype.getPartitions = function (done) {
  this.partitions = {0: new Partition(this.id, 0)};
  this.nPartitions = 1;
  var size = fs.statSync(this.file).size;
  this.sc.log('source: 1 partition from local parquet file, total size:', (size / (1 << 20)).toFixed(3), 'MB');
  done();
};

ParquetFile.prototype.iterate = function (task, p, pipeline, done) {
  parquetIterate(this.file, pipeline, done);
};

function GzipFile(sc, file) {
  Dataset.call(this, sc);
  this.file = file;
  this.type = 'GzipFile';
}

util.inherits(GzipFile, Dataset);

GzipFile.prototype.getPartitions = function (done) {
  this.partitions = {0: new Partition(this.id, 0)};
  this.nPartitions = 1;
  var size = fs.statSync(this.file).size;
  this.sc.log('source: 1 partition from local gzip file, total size:', (size / (1 << 20)).toFixed(3), 'MB');
  done();
};

GzipFile.prototype.iterate = function (task, p, pipeline, done) {
  var rs = task.lib.fs.createReadStream(this.file).pipe(task.lib.zlib.createGunzip({chunkSize: 65536}));
  var tail = '';

  rs.on('data', function (chunk) {
    var str = tail + chunk;
    var lines = str.split(/\r\n|\r|\n/);
    var buffer;
    tail = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      buffer = [lines[i]];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
  });

  rs.on('end', function () {
    if (tail) {
      var buffer = [tail];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
    done();
  });
};

function TextS3File(sc, file, options) {
  Dataset.call(this, sc);
  var _a = file.split('/');
  this.bucket = _a[0];
  this.path = _a.slice(1).join('/');
  this.type = 'TextS3File';
  this.options = options || {};
}

util.inherits(TextS3File, Dataset);

TextS3File.prototype.getPartitions = function (done) {
  this.partitions = {0: new Partition(this.id, 0)};
  this.nPartitions = 1;
  done();
};

TextS3File.prototype.iterate = function (task, p, pipeline, done) {
  var s3 = new task.lib.AWS.S3({signatureVersion: 'v4'});
  var rs = s3.getObject({Bucket: this.bucket, Key: this.path}).createReadStream();
  var tail = '';

  task.log('stream s3', this.bucket, this.path);
  if (this.options.parquet || this.path.slice(-8) === '.parquet')
    return parquetStream(rs, this.path, task, pipeline, done);

  if (this.path.slice(-3) === '.gz')
    rs = rs.pipe(task.lib.zlib.createGunzip({chunkSize: 65536}));

  rs.on('data', function (chunk) {
    var str = tail + chunk;
    var lines = str.split(/\r\n|\r|\n/);
    var buffer;
    tail = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      buffer = [lines[i]];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
  });

  rs.on('end', function() {
    if (tail) {
      var buffer = [tail];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
    done();
  });
};

function TextAzure(sc, dir, options) {
  Dataset.call(this, sc);
  var _a = dir.split('/');
  this.container = _a[0].replace(/@.*/, '');
  this.filematch = _a.slice(1).join('/');
  this.prefix = this.filematch.replace(/[\*\[].*/, ''); // Cut prefix before any globbing exp.
  if (this.prefix.slice(-1) === '/' && this.prefix === this.filematch)
    this.filematch += '*';
  sc.log('filematch:', this.filematch, 'prefix:', this.prefix);
  this.type = 'TextAzure';
  this.options = options || {};
  this.options.azure = this.options.azure || {};
}

util.inherits(TextAzure, Dataset);

TextAzure.prototype.getPartitions = function (done) {
  var self = this;
  var az = azure.createBlobService();

  function getList(list, token, done) {
    az.listBlobsSegmentedWithPrefix(self.container, self.prefix, token, function (err, data) {
      if (err) throw new Error('az.listBlobsSegmented failed');
      list = list.concat(data.entries);
      if (data.continuationToken)
        return getList(list, data.continuationToken, done);
      done(err, list);
    });
  }

  getList([], null, function (err, res) {
    if (err) return done(err);
    self.partitions = {};
    self.nPartitions = 0;
    var size = 0, pindex = 0;
    var isMatch = glob.matcher(self.filematch);
    for (var i = 0; i < res.length; i++) {
      if (!isMatch(res[i].name)) continue;
      self.sc.log('name:', res[i].name);
      size += Number(res[i].contentLength);
      self.partitions[pindex] = new Partition(self.id, pindex);
      self.partitions[pindex].path = res[i].name;
      pindex++;
      if (self.options.maxFiles && self.options.maxFiles === pindex) break;
    }
    self.nPartitions = pindex;
    self.sc.log('source:', self.nPartitions, 'partitions from Azure files, total size:', (size / (1 << 20)).toFixed(3), 'MB');
    done();
  });
};

TextAzure.prototype.iterate = function (task, p, pipeline, done) {
  task.log('azure options:', process.env.AZURE_STORAGE_ACCOUNT);
  var path = this.partitions[p].path;
  var tail = '';
  var az = task.lib.azure.createBlobService();
  var rs = az.createReadStream(this.container, path, null);

  task.log('stream azure', this.container, path);
  if (this.options.parquet || path.slice(-8) === '.parquet')
    return parquetStream(rs, path, task, pipeline, done);
  if (path.slice(-3) === '.gz')
    rs = rs.pipe(task.lib.zlib.createGunzip({chunkSize: 65536}));

  rs.on('data', function (chunk) {
    var str = tail + chunk;
    var lines = str.split(/\r\n|\r|\n/);
    var buffer;
    tail = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      buffer = [lines[i]];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
  });

  rs.on('end', function () {
    if (tail) {
      var buffer = [tail];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
    done();
  });
};

function TextS3Dir(sc, dir, options) {
  Dataset.call(this, sc);
  var _a = dir.split('/');
  this.bucket = _a[0];
  this.prefix = _a.slice(1).join('/');
  this.type = 'TextS3Dir';
  this.options = options || {};
  this.options.s3 = this.options.s3 || {};
  this.options.s3.signatureVersion = this.options.s3.signatureVersion || 'v4';
}

util.inherits(TextS3Dir, Dataset);

TextS3Dir.prototype.getPartitions = function (done) {
  var self = this;
  var s3 = new AWS.S3(this.options.s3);

  function getList(list, token, done) {
    s3.listObjectsV2({
      Bucket: self.bucket,
      Prefix: self.prefix,
      ContinuationToken: token
    }, function (err, data) {
      if (err) throw new Error('s3.listObjectsV2 failed');
      list = list.concat(data.Contents);
      if (data.IsTruncated)
        return getList(list, data.NextContinuationToken, done);
      done(err, list);
    });
  }

  getList([], null, function (err, res) {
    //self.sc.log('TextS3Dir list:', res.length, res[0]);
    if (err) return done(err);
    self.partitions = {};
    if (self.options.maxFiles && self.options.maxFiles < res.length)
      self.nPartitions = self.options.maxFiles;
    else
      self.nPartitions = res.length;
    var size = 0;
    for (var i = 0; i < self.nPartitions; i++) {
      size += res[i].Size;
      self.partitions[i] = new Partition(self.id, i);
      self.partitions[i].path = res[i].Key;
    }
    self.sc.log('source:', self.nPartitions, 'partitions from S3 files, total size:', (size / (1 << 20)).toFixed(3), 'MB');
    done();
  });
};

TextS3Dir.prototype.iterate = function (task, p, pipeline, done) {
  //task.log('s3options:', this.options.s3);
  var path = this.partitions[p].path;
  var tail = '';
  var s3 = new task.lib.AWS.S3(this.options.s3);
  var rs = s3.getObject({Bucket: this.bucket, Key: path}).createReadStream();

  task.log('stream s3', this.bucket, path);
  if (this.options.parquet || path.slice(-8) === '.parquet')
    return parquetStream(rs, path, task, pipeline, done);
  if (path.slice(-3) === '.gz')
    rs = rs.pipe(task.lib.zlib.createGunzip({chunkSize: 65536}));

  rs.on('data', function (chunk) {
    var str = tail + chunk;
    var lines = str.split(/\r\n|\r|\n/);
    var buffer;
    tail = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      buffer = [lines[i]];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
  });

  rs.on('end', function () {
    if (tail) {
      var buffer = [tail];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
    done();
  });
};

function parquetStream(rs, name, task, pipeline, done) {
  var filename = task.basedir + 'import/' + name.replace(/\//g, '-');
  var ws = task.lib.fs.createWriteStream(filename, {highWaterMark: 1 << 16});
  task.log('Download ', filename);
  rs.pipe(ws);

  ws.on('close', function () {
    parquetIterate(filename, pipeline, done);
  });
}

function TextDir(sc, dir, options) {
  Dataset.call(this, sc);
  this.type = 'TextDir';
  this.dir = dir;
  this.options = options || {};
}

util.inherits(TextDir, Dataset);

TextDir.prototype.getPartitions = function (done) {
  var self = this;
  fs.readdir(this.dir, function (err, res) {
    var stat, size = 0;
    if (err) return done(err);
    self.partitions = {};
    if (self.options.maxFiles && self.options.maxFiles < res.length)
      self.nPartitions = self.options.maxFiles;
    else
      self.nPartitions = res.length;
    for (var i = 0; i < self.nPartitions; i++) {
      self.partitions[i] = new Partition(self.id, i);
      self.partitions[i].path = res[i];
      stat = fs.statSync(self.dir + '/' + res[i]);
      size += stat.size;
    }
    self.sc.log('source:', self.nPartitions, 'partitions from local files, total size:', (size / (1 << 20)).toFixed(3), 'MB');
    done();
  });
};

TextDir.prototype.iterate = function (task, p, pipeline, done) {
  var path = this.dir + this.partitions[p].path;
  task.log('stream local file', path);
  if (this.options.parquet || path.slice(-8) === '.parquet')
    return parquetIterate(path, pipeline, done);
  var tail = '';
  var rs = task.lib.fs.createReadStream(path);
  if (path.slice(-3) === '.gz') rs = rs.pipe(task.lib.zlib.createGunzip({chunkSize: 65536}));

  rs.on('data', function (chunk) {
    var str = tail + chunk;
    var lines = str.split(/\r\n|\r|\n/);
    var buffer;
    tail = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      buffer = [lines[i]];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
  });

  rs.on('end', function () {
    if (tail) {
      var buffer = [tail];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
    done();
  });
};

function TextFile(sc, file, nPartitions) {
  Dataset.call(this, sc);
  this.file = file;
  this.type = 'TextFile';
  this.nSplit = nPartitions || sc.worker.length;
  this.basedir = sc.basedir;
}

util.inherits(TextFile, Dataset);

TextFile.prototype.getPartitions = function (done) {
  var self = this;

  function getSplits() {
    var u = url.parse(self.file);

    if ((u.protocol == 'hdfs:') && u.slashes && u.hostname && u.port)
      splitHDFSFile(u.path, self.nSplit, mapLogicalSplit);
    else
      splitLocalFile(u.path, self.nSplit, mapLogicalSplit);

    function mapLogicalSplit(split) {
      self.splits = split;
      self.partitions = {};
      self.nPartitions = self.splits.length;
      for (var i = 0; i < self.splits.length; i++)
        self.partitions[i] = new Partition(self.id, i);
      done();
    }
  }

  if (this.watched) {
    var watcher = fs.watch(self.basedir + 'stream', function (event, filename) {
      if ((event == 'rename') && (filename == path.basename(self.file))) {
        watcher.close();  // stop watching directory
        getSplits();
      }
    });
  } else getSplits();
};

TextFile.prototype.iterate = function (task, p, pipeline, done) {
  var buffer;

  function processLine(line) {
    if (!line) return;  // skip empty lines
    buffer = [line];
    for (var t = 0; t < pipeline.length; t++)
      buffer = pipeline[t].transform(pipeline[t], buffer);
  }

  function processLineParse(line) {
    if (!line) return;  // skip empty lines
    buffer = [JSON.parse(line)];
    for (var t = 0; t < pipeline.length; t++)
      buffer = pipeline[t].transform(pipeline[t], buffer);
  }

  task.lib.readSplit(this.splits, this.splits[p].index, this.parse ? processLineParse : processLine, done, function (part, opt) {
    return task.getReadStreamSync(part, opt);
  });
};

TextFile.prototype.getPreferedLocation = function (pid) {return this.splits[pid].ip;};

function Map(parent, mapper, args) {
  Dataset.call(this, parent.sc, [parent]);
  this.mapper = mapper;
  this.args = args;
  this.type = 'Map';
}

util.inherits(Map, Dataset);

Map.prototype.transform = function map(context, data) {
  var tmp = [];
  for (var i = 0; i < data.length; i++)
    tmp[i] = this.mapper(data[i], this.args, this.global);
  return tmp;
};

function FlatMap(parent, mapper, args) {
  Dataset.call(this, parent.sc, [parent]);
  this.mapper = mapper;
  this.args = args;
  this.type = 'FlatMap';
}

util.inherits(FlatMap, Dataset);

FlatMap.prototype.transform = function flatmap(context, data) {
  var tmp = [];
  for (var i = 0; i < data.length; i++)
    tmp = tmp.concat(this.mapper(data[i], this.args, this.global));
  return tmp;
};

function MapValues(parent, mapper, args) {
  Dataset.call(this, parent.sc, [parent]);
  this.mapper = mapper;
  this.args = args;
  this.type = 'MapValues';
}

util.inherits(MapValues, Dataset);

MapValues.prototype.transform = function (context, data) {
  var tmp = [];
  for (var i = 0; i < data.length; i++)
    tmp[i] = [data[i][0], this.mapper(data[i][1], this.args, this.global)];
  return tmp;
};

function FlatMapValues(parent, mapper, args) {
  Dataset.call(this, parent.sc, [parent]);
  this.mapper = mapper;
  this.args = args;
  this.type = 'FlatMapValues';
}

util.inherits(FlatMapValues, Dataset);

FlatMapValues.prototype.transform = function (context, data) {
  var tmp = [];
  for (var i = 0; i < data.length; i++) {
    var t0 = this.mapper(data[i][1], this.args, this.global);
    tmp = tmp.concat(t0.map(function (e) {return [data[i][0], e];}));
  }
  return tmp;
};

function Filter(parent, filter, args) {
  Dataset.call(this, parent.sc, [parent]);
  this._filter = filter;
  this.args = args;
  this.type = 'Filter';
}

util.inherits(Filter, Dataset);

Filter.prototype.transform = function (context, data) {
  var tmp = [];
  for (var i = 0; i < data.length; i++)
    if (this._filter(data[i], this.args, this.global)) tmp.push(data[i]);
  return tmp;
};

function Random(seed) {
  seed = seed || 0;
  this.x = 123456789 + seed;
  this.y = 188675123;

  // xorshift RNG producing a sequence of 2 ** 64 - 1 32 bits integers
  // See http://www.jstatsoft.org/v08/i14/paper by G. Marsaglia
  this.next = function () {
    var t = this.x, u = this.y;
    t ^= t << 8;
    this.x = u;
    return this.y = (u ^ (u >> 22)) ^ (t ^ (t >> 9));
  };

  // Return a float in range [0, 1) like Math.Random()
  this.nextDouble = function () {
    return this.next() / 4294967296.0;
  };
}

function Poisson(lambda, initSeed) {
  initSeed = initSeed || 1;

  var rng = new Random(initSeed);

  this.sample = function () {
    var L = Math.exp(-lambda), k = 0, p = 1;
    do {
      k++;
      p *= rng.nextDouble();
    } while (p > L);
    return k - 1;
  };
}

function Sample(parent, withReplacement, frac, seed) {
  Dataset.call(this, parent.sc, [parent]);
  this.withReplacement = withReplacement;
  this.frac = frac;
  this.rng = withReplacement ? new Poisson(frac, seed) : new Random(seed);
  this.type = 'Sample';
}

util.inherits(Sample, Dataset);

Sample.prototype.transform = function (context, data) {
  var tmp = [], i, j;
  if (this.withReplacement) {
    for (i = 0; i < data.length; i++)
      for (j = 0; j < this.rng.sample(); j++) tmp.push(data[i]);
  } else {
    for (i = 0; i < data.length; i++)
      if (this.rng.nextDouble() < this.frac) tmp[i] = data[i];
  }
  return tmp;
};

function Union(sc, parents) {
  Dataset.call(this, sc, parents);
  this.type = 'Union';
}

util.inherits(Union, Dataset);

Union.prototype.transform = function (context, data) {return data;};

function AggregateByKey(sc, dependencies, reducer, combiner, init, args) {
  Dataset.call(this, sc, dependencies);
  this.combiner = combiner;
  this.reducer = reducer;
  this.init = init;
  this.args = args;
  this.shuffling = true;
  this.executed = false;
  this.buffer = [];
  this.type = 'AggregateByKey';
}

util.inherits(AggregateByKey, Dataset);

AggregateByKey.prototype.getPartitions = function (done) {
  if (this.partitions == undefined) {
    var P = 0, i;
    this.partitions = {};
    for (i = 0; i < this.dependencies.length; i++)
      P = Math.max(P, this.dependencies[i].nPartitions);
    for (i = 0; i < P; i++) this.partitions[i] = new Partition(this.id, i);
    this.nPartitions = P;
    this.partitioner = new HashPartitioner(P);
  }
  done();
};

AggregateByKey.prototype.transform = function (context, data) {
  for (var i = 0; i < data.length; i++) {
    var key = data[i][0], value = data[i][1], str = JSON.stringify(key), pid = this.partitioner.getPartitionIndex(data[i][0]);
    if (this.buffer[pid] == undefined) this.buffer[pid] = {};
    if (this.buffer[pid][str] == undefined) this.buffer[pid][str] = JSON.parse(JSON.stringify(this.init));
    this.buffer[pid][str] = this.reducer(this.buffer[pid][str], value, this.args, this.global);
  }
};

AggregateByKey.prototype.spillToDisk = function (task, done) {
  var i, isLeft, str, key, data, path, size;

  if (this.dependencies.length > 1) {                 // COGROUP
    isLeft = (this.shufflePartitions[task.pid].parentDatasetId == this.dependencies[0].id);
    for (i = 0; i < this.nPartitions; i++) {
      str = '';
      path = task.basedir + 'shuffle/' + task.lib.uuid.v4();
      for (key in this.buffer[i]) {
        data = isLeft ? [JSON.parse(key), [this.buffer[i][key], []]] : [JSON.parse(key), [[], this.buffer[i][key]]];
        str += JSON.stringify(data) + '\n';
        if (str.length >= 65536) {
          task.lib.fs.appendFileSync(path, str);
          str = '';
        }
      }
      task.lib.fs.appendFileSync(path, str);
      size = task.lib.fs.statSync(path).size;
      task.files[i] = {host: task.grid.hostname, path: path, size: size};
    }
  } else {                              // AGGREGATE BY KEY
    for (i = 0; i < this.nPartitions; i++) {
      str = '';
      path = task.basedir + 'shuffle/' + task.lib.uuid.v4();
      for (key in this.buffer[i]) {
        data = [JSON.parse(key), this.buffer[i][key]];
        str += JSON.stringify(data) + '\n';
        if (str.length >= 65536) {
          task.lib.fs.appendFileSync(path, str);
          str = '';
        }
      }
      task.lib.fs.appendFileSync(path, str);
      size = task.lib.fs.statSync(path).size;
      task.files[i] = {host: task.grid.hostname, path: path, size: size};
    }
  }
  done();
};

AggregateByKey.prototype.iterate = function (task, p, pipeline, done) {
  var self = this, cbuffer = {}, cnt = 0, files = [];

  for (var i = 0; i < self.nShufflePartitions; i++)
    files.push(self.shufflePartitions[i].files[p]);

  processShuffleFile(files[cnt], processDone);

  function processShuffleFile(file, done) {
    //task.log('processShuffleFile', p, file.path);
    var lines = new task.lib.Lines();
    task.getReadStream(file, undefined, function (err, stream) {
      stream.pipe(lines);
    });
    lines.on('data', function (linev) {
      for (var i = 0; i < linev.length; i++) {
        var data = JSON.parse(linev[i]), key = JSON.stringify(data[0]);
        if (cbuffer[key] === undefined) cbuffer[key] = data[1];
        else cbuffer[key] = self.combiner(cbuffer[key], data[1], self.args, self.global);
      }
    });
    lines.on('end', done);
  }

  function processDone() {
    if (++cnt < files.length)
      return processShuffleFile(files[cnt], processDone);

    for (var key in cbuffer) {
      var buffer = [[JSON.parse(key), cbuffer[key]]];
      for (var t = 0; t < pipeline.length; t++)
        buffer = pipeline[t].transform(pipeline[t], buffer);
    }
    done();
  }
};

function Cartesian(sc, dependencies) {
  Dataset.call(this, sc, dependencies);
  this.shuffling = true;
  this.executed = false;
  this.buffer = [];
  this.type = 'Cartesian';
}

util.inherits(Cartesian, Dataset);

Cartesian.prototype.getPartitions = function (done) {
  if (this.partitions == undefined) {
    this.pleft = this.dependencies[0].nPartitions;
    this.pright =  this.dependencies[1].nPartitions;
    var P = this.pleft * this.pright;
    this.partitions = {};
    this.nPartitions = P;
    for (var i = 0; i < P; i++)
      this.partitions[i] = new Partition(this.id, i);
  }
  done();
};

Cartesian.prototype.transform = function (context, data) {
  for (var i = 0; i < data.length; i++) this.buffer.push(data[i]);
};

Cartesian.prototype.spillToDisk = function (task, done) {
  var str = '', path = task.basedir + 'shuffle/' + task.lib.uuid.v4(), size;
  for (var i = 0; i < this.buffer.length; i++) {
    str += JSON.stringify(this.buffer[i]) + '\n';
    if (str.length >= 65536) {
      task.lib.fs.appendFileSync(path, str);
      str = '';
    }
  }
  task.lib.fs.appendFileSync(path, str);
  size = task.lib.fs.statSync(path).size;
  task.files = {host: task.grid.hostname, path: path, size: size};
  task.log(task.files);
  done();
};

Cartesian.prototype.iterate = function (task, p, pipeline, done) {
  var p1 = Math.floor(p / this.pright);
  var p2 = p % this.pright + this.pleft;
  var self = this;
  var s1 = '';

  task.getReadStream(this.shufflePartitions[p1].files, undefined, function (err, stream1) {
    stream1.on('data', function (s) {s1 += s;});
    stream1.on('end', function () {
      var a1 = s1.split('\n');
      var s2 = '';
      task.getReadStream(self.shufflePartitions[p2].files, undefined, function (err, stream2) {
        stream2.on('data', function (s) {s2 += s;});
        stream2.on('end', function () {
          var a2 = s2.split('\n');
          for (var i = 0; i < a1.length; i++) {
            if (a1[i] == '') continue;
            for (var j = 0; j < a2.length; j++) {
              if (a2[j] == '') continue;
              var buffer = [[JSON.parse(a1[i]), JSON.parse(a2[j])]];
              for (var t = 0; t < pipeline.length; t++)
                buffer = pipeline[t].transform(pipeline[t], buffer);
            }
          }
          done();
        });
      });
    });
  });
};

function SortBy(sc, dependencies, keyFunc, ascending, numPartitions) {
  Dataset.call(this, sc, [dependencies]);
  this.shuffling = true;
  this.executed = false;
  this.keyFunc = keyFunc;
  this.ascending = (ascending == undefined) ? true : ascending;
  this.buffer = [];
  this.numPartitions = numPartitions;
  this.type = 'SortBy';
}

util.inherits(SortBy, Dataset);

SortBy.prototype.getPartitions = function (done) {
  if (this.partitions == undefined) {
    var P = Math.max(this.numPartitions || 1, this.dependencies[0].nPartitions);

    this.partitions = {};
    this.nPartitions = P;
    for (var p = 0; p < P; p++) this.partitions[p] = new Partition(this.id, p);
    this.partitioner = new RangePartitioner(P, this.keyFunc, this.dependencies[0]);
    this.partitioner.init(done);
  } else done();
};

SortBy.prototype.transform = function (context, data) {
  for (var i = 0; i < data.length; i++) {
    var pid = this.partitioner.getPartitionIndex(this.keyFunc(data[i]));
    if (this.buffer[pid] == undefined) this.buffer[pid] = [];
    this.buffer[pid].push(data[i]);
  }
};

SortBy.prototype.spillToDisk = function (task, done) {
  for (var i = 0; i < this.nPartitions; i++) {
    var str = '', path = task.basedir + 'shuffle/' + task.lib.uuid.v4(), size;
    if (this.buffer[i] != undefined) {
      for (var j = 0; j < this.buffer[i].length; j++) {
        str += JSON.stringify(this.buffer[i][j]) + '\n';
        if (str.length >= 65536) {
          task.lib.fs.appendFileSync(path, str);
          str = '';
        }
      }
    }
    task.lib.fs.appendFileSync(path, str);
    size = task.lib.fs.statSync(path).size;
    task.files[i] = {host: task.grid.hostname, path: path, size: size};
  }
  done();
};

SortBy.prototype.iterate = function (task, p, pipeline, done) {
  var self = this, cbuffer = [], cnt = 0, files = [];

  for (var i = 0; i < self.nShufflePartitions; i++)
    files.push(self.shufflePartitions[i].files[p]);

  processShuffleFile(files[cnt], processDone);

  function processShuffleFile(file, done) {
    var lines = new task.lib.Lines();
    task.getReadStream(file, undefined, function (err, stream) {
      stream.pipe(lines);
    });
    lines.on('data', function (linev) {
      for (var i = 0; i < linev.length; i++)
        cbuffer.push(JSON.parse(linev[i]));
    });
    lines.on('end', done);
  }

  function processDone() {
    if (++cnt == files.length) {
      cbuffer.sort(compare);
      for (var i = 0; i < cbuffer.length; i++) {
        var buffer = [cbuffer[i]];
        for (var t = 0; t < pipeline.length; t++)
          buffer = pipeline[t].transform(pipeline[t], buffer);
      }
      done();
    } else processShuffleFile(files[cnt], processDone);

    function compare(a, b) {
      if (self.keyFunc(a) < self.keyFunc(b)) return self.ascending ? -1 : 1;
      if (self.keyFunc(a) > self.keyFunc(b)) return self.ascending ? 1 : -1;
      return 0;
    }
  }
};

function PartitionBy(sc, dependencies, partitioner) {
  Dataset.call(this, sc, [dependencies]);
  this.shuffling = true;
  this.executed = false;
  this.buffer = [];
  this.partitioner = partitioner;
  this.type = 'PartitionBy';
}

util.inherits(PartitionBy, Dataset);

PartitionBy.prototype.getPartitions = function (done) {
  if (this.partitions == undefined) {
    var P = this.partitioner.numPartitions;
    this.partitions = {};
    this.nPartitions = P;
    for (var p = 0; p < P; p++) this.partitions[p] = new Partition(this.id, p);
    if (this.partitioner.init) this.partitioner.init(done);
    else done();
  } else done();
};

PartitionBy.prototype.transform = function (context, data) {
  for (var i = 0; i < data.length; i++) {
    var pid = this.partitioner.getPartitionIndex(data[i][0]);
    if (this.buffer[pid] == undefined) this.buffer[pid] = [];
    this.buffer[pid].push(data[i]);
  }
};

PartitionBy.prototype.spillToDisk = function (task, done) {
  for (var i = 0; i < this.nPartitions; i++) {
    var str = '', path = task.basedir + 'shuffle/' + task.lib.uuid.v4(), size;
    if (this.buffer[i] != undefined) {
      for (var j = 0; j < this.buffer[i].length; j++) {
        str += JSON.stringify(this.buffer[i][j]) + '\n';
        if (str.length >= 65536) {
          task.lib.fs.appendFileSync(path, str);
          str = '';
        }
      }
    }
    task.lib.fs.appendFileSync(path, str);
    size = task.lib.fs.statSync(path);
    task.files[i] = {host: task.grid.hostname, path: path, size: size};
  }
  done();
};

PartitionBy.prototype.iterate = function (task, p, pipeline, done) {
  var self = this, cbuffer = [], cnt = 0, files = [];

  for (var i = 0; i < self.nShufflePartitions; i++)
    files.push(self.shufflePartitions[i].files[p]);

  processShuffleFile(files[cnt], processDone);

  function processShuffleFile(file, done) {
    var lines = new task.lib.Lines();
    task.getReadStream(file, undefined, function (err, stream) {
      stream.pipe(lines);
    });
    lines.on('data', function (linev) {
      for (var i = 0; i < linev.length; i++)
        cbuffer.push(JSON.parse(linev[i]));
    });
    lines.on('end', done);
  }

  function processDone() {
    if (++cnt == files.length) {
      for (var i = 0; i < cbuffer.length; i++) {
        var buffer = [cbuffer[i]];
        for (var t = 0; t < pipeline.length; t++)
          buffer = pipeline[t].transform(pipeline[t], buffer);
      }
      done();
    } else processShuffleFile(files[cnt], processDone);
  }
};

function RangePartitioner(numPartitions, keyFunc, dataset) {
  this.numPartitions = numPartitions;

  this.init = function (done) {
    var self = this;
    dataset.sample(false, 0.5).collect(function (err, result) {
      function compare(a, b) {
        if (keyFunc(a) < keyFunc(b)) return -1;
        if (keyFunc(a) > keyFunc(b)) return 1;
        return 0;
      }
      result.sort(compare);
      self.upperbounds = [];
      if (result.length <= numPartitions - 1) {
        self.upperbounds = result;  // supprimer les doublons peut-etre ici
      } else {
        var s = Math.floor(result.length / numPartitions);
        for (var i = 0; i < numPartitions - 1; i++) self.upperbounds.push(result[s * (i + 1)]);
      }
      done();
    });
  };

  this.getPartitionIndex = function (data) {
    for (var i = 0; i < this.upperbounds.length; i++)
      if (data < this.upperbounds[i]) break;
    return i;
  };
}

function HashPartitioner(numPartitions) {
  this.numPartitions = numPartitions;
  this.type = 'HashPartitioner';
}

HashPartitioner.prototype.hash = function (o) {
  var i, h = 0, s = o.toString(), len = s.length;
  for (i = 0; i < len; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h = h & h;  // convert to 32 bit integer
  }
  return Math.abs(h);
};

HashPartitioner.prototype.getPartitionIndex = function (data) {
  return this.hash(data) % this.numPartitions;
};

module.exports = {
  Dataset: Dataset,
  Partition: Partition,
  parallelize: parallelize,
  range: range,
  GzipFile: GzipFile,
  ParquetFile: ParquetFile,
  TextFile: TextFile,
  TextDir: TextDir,
  TextS3Dir: TextS3Dir,
  TextS3File: TextS3File,
  TextAzure: TextAzure,
  Source: Source,
  Stream: Stream,
  Random: Random,
  Map: Map,
  FlatMap: FlatMap,
  MapValues: MapValues,
  FlatMapValues: FlatMapValues,
  Filter: Filter,
  Sample: Sample,
  Union: Union,
  AggregateByKey: AggregateByKey,
  Cartesian: Cartesian,
  SortBy: SortBy,
  PartitionBy: PartitionBy,
  RangePartitioner: RangePartitioner,
  HashPartitioner: HashPartitioner
};
