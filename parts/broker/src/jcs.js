// RFC 8785 JSON Canonicalization Scheme, written in-house.
//
// Accepts only plain JSON data: null, booleans, finite numbers, strings,
// arrays and plain objects. Anything else throws, including undefined,
// NaN, Infinity, BigInt, functions, class instances (so a Secret can never
// be canonicalized into a log line) and strings with lone surrogates.

export function canonicalize(value) {
  return serialize(value, '$');
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}

function serialize(value, path) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`jcs: non-finite number at ${path}`);
      // ECMAScript Number serialization is the one RFC 8785 section 3.2.2.3 requires.
      return JSON.stringify(value);
    case 'string':
      return serializeString(value, path);
    case 'object':
      if (Array.isArray(value)) {
        return '[' + value.map((v, i) => serialize(v, `${path}[${i}]`)).join(',') + ']';
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError(`jcs: not a plain object at ${path}`);
      }
      // Sort by UTF-16 code units (RFC 8785 section 3.2.3); the default sort does that.
      return '{' + Object.keys(value).sort().map((k) => {
        return serializeString(k, path) + ':' + serialize(value[k], `${path}.${k}`);
      }).join(',') + '}';
    default:
      throw new TypeError(`jcs: unsupported ${typeof value} at ${path}`);
  }
}

function serializeString(s, path) {
  if (!s.isWellFormed()) throw new TypeError(`jcs: lone surrogate in string at ${path}`);
  // For well-formed strings JSON.stringify escapes exactly what RFC 8785
  // section 3.2.2.2 asks: " \ and U+0000..U+001F, using \b \t \n \f \r
  // where they exist and lowercase \u00xx otherwise. Nothing else.
  return JSON.stringify(s);
}
