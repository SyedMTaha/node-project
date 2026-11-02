// Task 1.5: approximate location (country, city) of an IP from the offline DB-IP Lite file in geo/ (no network call).
// Only the result is stored, never the IP. Local / private IPs and lookup errors give nulls; it never throws.
const fs = require('fs');
const path = require('path');
const maxmind = require('maxmind');

const DIR = path.join(__dirname, '..', 'geo');
let reader = null;
const file = fs.existsSync(DIR) && fs.readdirSync(DIR).filter((f) => f.endsWith('.mmdb')).sort().pop(); // newest monthly file
const ready = file
  ? maxmind.open(path.join(DIR, file)).then((r) => { reader = r; }).catch((e) => console.log('[geo] could not open', file, e.message))
  : Promise.resolve(console.log('[geo] no .mmdb file in geo/: locations are stored as unknown'));

exports.ready = ready;

exports.lookup = (ip) => {
  try {
    const r = reader && ip && reader.get(String(ip).replace(/^::ffff:/, '')); // "::ffff:1.2.3.4" -> "1.2.3.4"
    return {
      country: (r && r.country && r.country.iso_code) || null,          // e.g. "PK"
      city: (r && r.city && r.city.names && r.city.names.en) || null,   // e.g. "Lahore"
    };
  } catch {
    return { country: null, city: null };
  }
};
