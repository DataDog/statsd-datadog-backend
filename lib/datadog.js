/*jshint node:true, laxcomma:true */

/*
 * Flush stats to datadog (http://datadoghq.com/).
 *
 * To enable this backend, include 'statsd-datadog-backend' in the backends
 * configuration array:
 *
 *   backends: ['statsd-datadog-backend']
 *
 * This backend supports the following config options:
 *
 *   datadogApiKey: Your DataDog API key
 *   datadogPrefix: A global prefix for all metrics
 *   datadogTags: A global set of tags for all metrics
 */

var net = require('net'),
    os = require('os'),
    request = require('request');

var logger;
var debug;
var flushInterval;
var hostname;
var datadogApiHost;
var datadogApiKey;
var datadogStats = {};
var datadogPrefix;
var datadogTags;

var Datadog = function(api_key, options) {
    options = options || {};
    this.api_key = api_key;
    this.api_host = options.api_host || 'https://app.datadoghq.com';
    this.host_name = options.host_name || os.hostname();
    this.pending_requests = 0;
};

Datadog.prototype.metrics = function(payload) {
    var client = this;
    var message = {
        series: payload
    };
    client._post('series', message);
};

Datadog.prototype._post = function(controller, message) {
    var client = this;
    var body = JSON.stringify(message);

    if (this.api_host.indexOf('https') == -1) {
        logger.log('Warning! You are about to send unencrypted metrics.');
    }
    client.pending_requests += 1;
    request.post({
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length
        },
        url: this.api_host + '/api/v1/' + controller + '?api_key=' + client.api_key,
        body: body
    }, function(error) {
        if (error) {
            logger.log('Skipping, cannot send data to Datadog: ' + error.message);
        }
        client.pending_requests -= 1;
    });
};

var post_stats = function datadog_post_stats(payload) {
   try {
      new Datadog(datadogApiKey, { api_host: datadogApiHost }).metrics(payload);
      datadogStats.last_flush = Math.round(new Date().getTime() / 1000);
   } catch(e){
      if (debug) {
         logger.log(e);
      }
      datadogStats.last_exception = Math.round(new Date().getTime() / 1000);
   }
};

var flush_stats = function datadog_post_stats(ts, metrics) {
   var counters = metrics.counters;
   var counter_rates = metrics.counter_rates;
   var gauges = metrics.gauges;
   var timers = metrics.timer_data;
   var pctThresholds = metrics.pctThreshold;
   var statsd_metrics = metrics.statsd_metrics;

   var host = hostname || os.hostname();
   var payload = [];
   var value;

   var key;

   for (key in statsd_metrics) {
     payload.push({
        metric: get_prefix(key),
        points: [[ts, statsd_metrics[key]]],
        type: 'gauge',
        host: host,
        tags: datadogTags
     });
   }

   // Send counters
   for (key in counters) {
      value = counters[key];
      // Fetch the pre-caculated rate
      var valuePerSecond = counter_rates[key];

      payload.push({
         metric: get_prefix(key) + ".per_second",
         points: [[ts, valuePerSecond]],
         type: 'gauge',
         host: host,
         tags: datadogTags
      });

      payload.push({
         metric: get_prefix(key),
         points: [[ts, value]],
         type: 'counter',
         host: host,
         tags: datadogTags
      });
   }

   // Send gauges
   for (key in gauges) {
      value = gauges[key];

      payload.push({
         metric: get_prefix(key),
         points: [[ts, value]],
         type: 'gauge',
         host: host,
         tags: datadogTags
      });
   }

   // Send timer data
   for (key in timers) {
     for (timer_data_key in timers[key]) {

       if (typeof(timers[key][timer_data_key]) === 'number') {
        payload.push({
           metric: get_prefix(key + "." + timer_data_key),
           points: [[ts, timers[key][timer_data_key]]],
           type: 'gauge',
           host: host,
           tags: datadogTags
        });
       } else {
         for (var timer_data_sub_key in timers[key][timer_data_key]) {
           payload.push({
              metric: get_prefix(key + "." + timer_data_key + "." + timer_data_sub_key),
              points: [[ts, timers[key][timer_data_key][timer_data_sub_key]]],
              type: 'gauge',
              host: host,
              tags: datadogTags
           });
         }
       }
     }
   }

   post_stats(payload);
};

var get_prefix = function datadog_get_prefix(key) {
    if (datadogPrefix !== undefined) {
        return [datadogPrefix, key].join('.');
    } else {
        return key;
    }
}

var backend_status = function datadog_status(writeCb) {
   var stat;

   for (stat in datadogStats) {
      writeCb(null, 'datadog', stat, datadogStats[stat]);
   }
};

exports.init = function datadog_init(startup_time, config, events, log) {
   logger = log;
   debug = config.debug;
   hostname = config.hostname;

   datadogApiKey = config.datadogApiKey;
   datadogApiHost = config.datadogApiHost;
   datadogPrefix = config.datadogPrefix;
   datadogTags = config.datadogTags;

    if (datadogTags === undefined || datadogTags.constructor !== Array || datadogTags.length < 1) {
        datadogTags = [];
    }

   if (!datadogApiHost) {
      datadogApiHost = 'https://app.datadoghq.com';
   }

   datadogStats.last_flush = startup_time;
   datadogStats.last_exception = startup_time;

   flushInterval = config.flushInterval;

   events.on('flush', flush_stats);
   events.on('status', backend_status);

   return true;
};
