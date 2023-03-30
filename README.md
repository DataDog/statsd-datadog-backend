# statsd-datadog-backend

A plugin to connect etsy's statsD to Datadog

## Installation

    $ cd /path/to/statsd-dir
    $ npm install statsd-datadog-backend

## Configuration

```js
datadogApiKey: "your_api_key"; // You can get it from this page: https://app.datadoghq.com/account/settings#api
datadogApiHost: "https://app.datadoghq.com" // Could also be "https://app.datadoghq.eu" for Europe.
datadogPrefix: "your_prefix"; // Your metrics will be prefixed by this prefix
datadogApiHost: "https://app.datadoghq.com";
datadogTags: ["your:tag", "another:tag"]; // Your metrics will include these tags
```

## How to enable

Add statsd-datadog-backend to your list of statsd backends:

```js
backends: ["statsd-datadog-backend"];
```
