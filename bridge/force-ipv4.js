// Force all DNS lookups to return IPv4 addresses only.
// This works around Node.js 22's autoSelectFamily issue in VPCs without IPv6.
const dns = require('dns');
const origLookup = dns.lookup;

dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof options === 'number') {
    options = { family: options };
  }
  options = Object.assign({}, options, { family: 4 });
  return origLookup.call(dns, hostname, options, callback);
};

// Also patch dns.promises.lookup — some libraries (undici, fetch) use the
// promises API which bypasses the callback-based dns.lookup override above.
if (dns.promises && dns.promises.lookup) {
  const origPromiseLookup = dns.promises.lookup.bind(dns.promises);
  dns.promises.lookup = function(hostname, options) {
    if (typeof options === 'number') {
      options = { family: options };
    }
    options = Object.assign({}, options, { family: 4 });
    return origPromiseLookup(hostname, options);
  };
}
