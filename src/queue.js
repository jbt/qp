var Batch = require('batch');

var redis = require('./redis');
var Job = require('./job');
var Workers = require('./workers');

var debug = require('debug')('qp:Queue');

var Queue = module.exports = function(name, qp) {
  this.name = name;
  this.redis = redis.client();
  this.qp = qp;
  this.workers = [];
};

Queue.prototype.create = Queue.prototype.createJob = function(data) {
  var job = new Job(data, this);
  return job;
};

Queue.prototype.multiSave = function(jobs, cb) {

  var self = this;

  for (var i = 0; i < jobs.length; i++) {
    if (!(jobs[i] instanceof Job)) {
      jobs[i] = self.create(jobs[i]);
    }
  }

  var r = this.redis.multi();

  var batch = new Batch();
  batch.concurrency(3);

  jobs.forEach(function(job) {
    batch.push(function(done) {
      job._save(r, done);
    });
  });

  batch.end(function() {
    r.exec(cb);
  });

};


Queue.prototype.process = function(opts, cb) {

  // allow concurrency not to be set
  if (typeof opts == 'function' && !cb) {
    cb = opts;
    opts = {};
  }

  if (typeof opts === 'number') {
    opts = { concurrency: opts };
  }

  var workers = new Workers(this, this.redis);
  this.workers.push(workers);

  workers.process(opts, cb);

};

Queue.prototype.numJobs = function(states, cb) {
  var self = this;

  if (typeof states === 'function' && !cb) {
    cb = states;
    states = ['inactive', 'active', 'completed', 'failed', 'queued'];
  }

  if (!Array.isArray(states)) states = [states];

  var data = {};

  debug('getting number of jobs');

  var batch = new Batch();

  states.forEach(function(state) {
    batch.push(function(done) {
      if (state === 'queued') {
        self.redis.llen('qp:' + self.name + ':jobs', function(e, r) {
          data[state] = r;
          done();
        });
      } else {
        self.redis.zcard('qp:' + self.name + '.' + state, function(e, r) {
          data[state] = r;
          done();
        });
      }
    });
  });

  batch.end(function() {
    cb(null, data);
  });

};

Queue.prototype.getJobs = function(state, from, to, cb) {
  var self = this;

  self.redis.zrange('qp:' + this.name + '.' + state, from, to, function(err, jobs) {

    var batch = new Batch();
    jobs.forEach(function(id) {

      batch.push(function(done) {
        var job = self.create();
        job.id = id;
        job.getInfo(function() {
          job.toJSON(true);
          done(null, job);
        });
      });


    });
    batch.end(cb);
  });
};

Queue.prototype.flush = function(cb) {
  var r = this.redis.multi();

  debug('flushing');

  r.srem('qp:job:types', this.name);
};

Queue.prototype.clear = function(type, cb) {
  var self = this;

  debug('clearing');

  if (!cb && typeof type === 'function') {
    cb = type;
    type = 'completed';
  }
  if (!type) type = 'completed';

  var r = self.redis.multi();
  self.redis.zrange('qp:' + self.name + '.' + type, 0, -1, function(e, members){
    for (var i = 0; i < members.length; i++) {
      var job = self.create();
      job.id = members[i];
      job.state = type;
      job._remove(r);
    }
    r.exec(cb);
  });
};

Queue.prototype.stop = function(cb) {
  debug('stopping queue');

  var batch = new Batch();
  for (var i = 0; i < this.workers.length; i++) {
    var w = this.workers[i];
    batch.push(w.stop.bind(w));
  }
  batch.end(cb);
};
