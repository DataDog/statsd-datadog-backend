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
 *
 *   datadogMetricTagsByRegExp: An object of { RegExpString: [TagNameString1, TagNameString2] }
 *      where each tag name correspond to a capture group in the regular expression.
 *      NOTE the strings will be read as a RegExp object, thus backslashes must be escaped.
 *
 *      The following is are example RegExps for popular collectd plugins:
 *      interface, cpu, tcpconns, load, memory, df.
 *
 *      datadogMetricTagsByRegExp: {
 *          '^interface\\.(\\S+)\\.(?:if_packets\\.packets|if_octets\\.octets|if_errors\\.errors)\\.(?:rx|tx)$': ['interface_name'],
 *          '^cpu\\.(\\d+)\\.cpu\\.(\\w+)$': ['cpu_cpu', 'cpu_time'],
 *          '^tcpconns\\.([\\w-]+)\\.tcp_connections\\.([\\w-]+)$': ['tcpconns_port', 'tcpconns_state'],
 *          '^load\\.load\\.([\\w-]+)$': ['load_term'],
 *          '^memory\\.memory\\.([\\w-]+)$': ['memory_type'],
 *          '^df\\.([\\w-]+?)\\.(?:\\w+?\\.)+([\\w-]+)$': ['df_partition', 'df_type'],
 *      },
 *
 *      The captured groups will be extracted and truncated from the metric name and be
 *      reported as datadog tags along with the metric e.g.
 *
 *      'interface.br-e5f9ab1037e7.if_packets.packets.tx' will be transformed into
 *      'interface.if_packets.packets.tx|#interface_name:br-e5f9ab1037e7'
 *
 *      This allows for adding tag dimensions to untagged (e.g. collectd) metrics.
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
var datadogMetricTagsByRegExp;

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
   var pctThreshold = metrics.pctThreshold;

   var host = hostname || os.hostname();
   var payload = [];
   var value;

   var key;
   var metricNameAndTags;
   var metricName;
   var metricTags;

   // Send counters
   for (key in counters) {
      value = counters[key];
      var valuePerSecond = value / (flushInterval / 1000); // calculate 'per second' rate

      metricNameAndTags = get_metric_name_and_tags(key);
      metricName = metricNameAndTags[0];
      metricTags = metricNameAndTags[1];

      payload.push({
         metric: metricName,
         points: [[ts, valuePerSecond]],
         type: 'gauge',
         host: host,
         tags: datadogTags.concat(metricTags)
      });
   }

   // Send gauges
   for (key in gauges) {
      value = gauges[key];

      metricNameAndTags = get_metric_name_and_tags(key);
      metricName = metricNameAndTags[0];
      metricTags = metricNameAndTags[1];

      payload.push({
         metric: metricName,
         points: [[ts, value]],
         type: 'gauge',
         host: host,
         tags: datadogTags.concat(metricTags)
      });
   }

   // Compute timers and send
   for (key in timers) {
      if (timers[key].length > 0) {
         var values = timers[key].sort(function (a,b) { return a-b; });
         var count = values.length;
         var min = values[0];
         var max = values[count - 1];

         var mean = min;
         var maxAtThreshold = max;
         var i;

         if (count > 1) {
            var thresholdIndex = Math.round(((100 - pctThreshold) / 100) * count);
            var numInThreshold = count - thresholdIndex;
            var pctValues = values.slice(0, numInThreshold);
            maxAtThreshold = pctValues[numInThreshold - 1];

            // average the remaining timings
            var sum = 0;
            for (i = 0; i < numInThreshold; i++) {
               sum += pctValues[i];
            }

            mean = sum / numInThreshold;
         }

         metricNameAndTags = get_metric_name_and_tags(key + '.mean');
         metricName = metricNameAndTags[0];
         metricTags = metricNameAndTags[1];

         payload.push({
            metric: metricName,
            points: [[ts, mean]],
            type: 'gauge',
            host: host,
            tags: datadogTags.concat(metricTags)
         });

         metricNameAndTags = get_metric_name_and_tags(key);
         metricName = metricNameAndTags[0];
         metricTags = metricNameAndTags[1];

         payload.push({
            metric: metricName + '.upper',
            points: [[ts, max]],
            type: 'gauge',
            host: host,
            tags: datadogTags.concat(metricTags)
         });

         metricNameAndTags = get_metric_name_and_tags(key);
         metricName = metricNameAndTags[0];
         metricTags = metricNameAndTags[1];

         payload.push({
            metric: metricName + '.upper_' + pctThreshold,
            points: [[ts, maxAtThreshold]],
            type: 'gauge',
            host: host,
            tags: datadogTags.concat(metricTags)
         });

         metricNameAndTags = get_metric_name_and_tags(key);
         metricName = metricNameAndTags[0];
         metricTags = metricNameAndTags[1];

         payload.push({
            metric: metricName + '.lower',
            points: [[ts, min]],
            type: 'gauge',
            host: host,
            tags: datadogTags.concat(metricTags)
         });

         metricNameAndTags = get_metric_name_and_tags(key);
         metricName = metricNameAndTags[0];
         metricTags = metricNameAndTags[1];

         payload.push({
            metric: metricName + '.count',
            points: [[ts, count]],
            type: 'gauge',
            host: host,
            tags: datadogTags.concat(metricTags)
         });
      }
   }

   post_stats(payload);
};

// get_metric_name_and_tags extracts and truncates
// metric-specific tags from the metric name.
var get_metric_name_and_tags = function datadog_get_metric_name_and_tags(key) {
    var metricNameAndTags = get_metric_tags_by_regexp(key);
    var metricName = metricNameAndTags[0];
    var metricTags = metricNameAndTags[1];

    // Add prefix if given in configuration.
    metricName = get_prefix(metricName);

    return [metricName, metricTags];
}

// get_metric_tags_by_regexp attempts to match the given metric key
// with all metric RegExps given in the configuration.
//
// When a RegExp is matched, its captured groups are truncated from the metric
// name and pushed into the metric's specific datadog tags array.
//
// Returns the truncated metric key and its metric-specific tag array.
// If no match is found, the key is returned as-is with an empty tag array.
var get_metric_tags_by_regexp = function datadog_get_metric_tags_by_regexp(key) {
    var match;

    for (var i = 0; i < datadogMetricTagsByRegExp.length; i++) {
        var regExpTags = datadogMetricTagsByRegExp[i];
        var re = regExpTags['regExp'];
        // RegExp matches start from index i=1 instead of i=0,
        // so the tag names that will be matched are offset accordingly.
        var tagNames = [ null ].concat(regExpTags['tagNames']);

        // Attempt to match current RegExp with given key.
        match = re.exec(key);

        // If a match is found,
        // add the captured groups to the metric's datadog tag array,
        // and truncate them from the metric key.
        if (match && match.length > 1) {
            var mutatedKey = key;
            var metricTags = [];

            match.forEach(function(groups, j) {
                if (j === 0) {
                    return;
                }

                var tag = match[j];
                var tagName = tagNames[j];

                // Add current captured group to tag array.
                metricTags.push(tagName + ':' + tag);

                // Truncate the captured group from the metric key along with
                // it's prefixed or suffixed period character.
                mutatedKey = mutatedKey.replace(new RegExp('(' + tag + '\\.?)|(\\.' + tag + '$)'), "");
            });

            return [mutatedKey, metricTags]
        }
    }

    // If we reached this line, it means no RegExps were matched,
    // so we return the original key with no metric-specific datadog tags.
    return [key, []]
}

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
   datadogMetricTagsByRegExp = [];

    if (datadogTags === undefined || datadogTags.constructor !== Array || datadogTags.length < 1) {
        datadogTags = [];
    }

   if (!datadogApiHost) {
      datadogApiHost = 'https://app.datadoghq.com';
   }

   // Read metric regexps string into RegExp form.
   if (config.datadogMetricTagsByRegExp &&
       config.datadogMetricTagsByRegExp.constructor === Object &&
       Object.keys(config.datadogMetricTagsByRegExp).length > 0) {

       for (var re in config.datadogMetricTagsByRegExp) {
           if (config.datadogMetricTagsByRegExp.hasOwnProperty(re)) {
               datadogMetricTagsByRegExp.push(
                   {
                       'regExp': new RegExp(re),
                       'tagNames': config.datadogMetricTagsByRegExp[re]
                   }
               );
           }
       }
   }

   datadogStats.last_flush = startup_time;
   datadogStats.last_exception = startup_time;

   flushInterval = config.flushInterval;

   events.on('flush', flush_stats);
   events.on('status', backend_status);

   return true;
};
