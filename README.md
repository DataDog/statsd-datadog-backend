# statsd-datadog-backend

A plugin to connect etsy's statsD to Datadog

## Installation

    $ cd /path/to/statsd-dir
    $ npm install statsd-datadog-backend
    
## Configuration

```js
datadogApiKey: "your_api_key" // You can get it from this page: https://app.datadoghq.com/account/settings#api
datadogPrefix: "your_prefix" // Your metrics will be prefixed by this prefix
datadogTags: ["your:tag", "another:tag"]  // Your metrics will include these tags
datadogRemovePrefix: 2 // Number of period delimited prefixes to remove. If you use this option with *datadogPrefix* remove will happen prior to addition.
```
### Example:

If the metric name is called **"hosts.foo.bar.count"**, it will be rewritten to **"application.bar.count"**:
```
datadogRemovePrefix: 2
datadogPrefix: "application"
```

## How to enable
Add statsd-datadog-backend to your list of statsd backends:

```js
backends: ["statsd-datadog-backend"]
```

