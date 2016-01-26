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
   var gauges = metrics.gauges;
   var timers = metrics.timers;
   var pctThresholds = metrics.pctThreshold;

   var host = hostname || os.hostname();
   var payload = [];
   var value;

   var key;

   // Send counters
   for (key in counters) {
      value = counters[key];
      var valuePerSecond = value / (flushInterval / 1000); // calculate 'per second' rate

      payload.push({
         metric: get_prefix(key),
         points: [[ts, valuePerSecond]],
         type: 'gauge',
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

   // Compute timers and send
   for (key in timers) {
      if (timers[key].length > 0) {
         var values = timers[key].sort(function (a,b) { return a-b; });
         var count = values.length;
         var min = values[0];
         var max = values[count - 1];

         /* per https://github.com/etsy/statsd/blob/v0.7.2/docs/metric_types.md#timing
            we should supply mean_$PCT, upper_$PCT, and sum_$PCT for each requested
            percentile. */
         var mean = {};
         var maxAtThresholds = {};
         var sum = {};
         pctThresholds.forEach(function (pctThreshold) {
           maxAtThresholds[pctThreshold] = max;
           mean[pctThreshold] = min;
           sum[pctThreshold] = 0;
         });
         var i;

         if (count > 1) {
            pctThresholds.forEach(function (pctThreshold) {
              var thresholdIndex = Math.round(((100 - pctThreshold) / 100) * count);
              var numInThreshold = count - thresholdIndex;
              var pctValues = values.slice(0, numInThreshold);
              maxAtThresholds[pctThreshold] = pctValues[numInThreshold - 1];

              for (i=0; i < numInThreshold; i++) {
                sum[pctThreshold] += pctValues[i];
              }
              mean[pctThreshold] = sum[pctThreshold] / numInThreshold;
            });
         }

         payload.push({
            metric: get_prefix(key + '.upper'),
            points: [[ts, max]],
            type: 'gauge',
            host: host,
            tags: datadogTags
         });

         pctThresholds.forEach(function (pctThreshold) {
           payload.push({
              metric: get_prefix(key + '.mean_' + pctThreshold),
              points: [[ts, mean[pctThreshold]]],
              type: 'gauge',
              host: host,
              tags: datadogTags
           });

           payload.push({
              metric: get_prefix(key + '.upper_' + pctThreshold),
              points: [[ts, maxAtThresholds[pctThreshold]]],
              type: 'gauge',
              host: host,
              tags: datadogTags
           });

           payload.push({
              metric: get_prefix(key + '.sum_' + pctThreshold),
              points: [[ts, sum[pctThreshold]]],
              type: 'gauge',
              host: host,
              tags: datadogTags
           });
         });

         payload.push({
            metric: get_prefix(key + '.lower'),
            points: [[ts, min]],
            type: 'gauge',
            host: host,
            tags: datadogTags
         });

         payload.push({
            metric: get_prefix(key + '.count'),
            points: [[ts, count]],
            type: 'gauge',
            host: host,
            tags: datadogTags
         });
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
