// RFC 8785 test vectors: section 3.2.2 (serialization), 3.2.3 (sorting)
// and Appendix B (number serialization from IEEE 754 bit patterns).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/jcs.js';

test('RFC 8785 3.2.2: sample input serializes as in the RFC', () => {
  // The RFC's input text, with its JSON escapes kept as JSON escapes.
  const input = JSON.parse(
    '{\n' +
    '  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n' +
    '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n' +
    '  "literals": [null, true, false]\n' +
    '}',
  );
  const want =
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
    '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
  assert.equal(canonicalize(input), want);
});

test('RFC 8785 3.2.3: properties sort by UTF-16 code units', () => {
  const input = JSON.parse(
    '{\n' +
    '  "\\u20ac": "Euro Sign",\n' +
    '  "\\r": "Carriage Return",\n' +
    '  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n' +
    '  "1": "One",\n' +
    '  "\\ud83d\\ude00": "Emoji: Grinning Face",\n' +
    '  "\\u0080": "Control",\n' +
    '  "\\u00f6": "Latin Small Letter O With Diaeresis"\n' +
    '}',
  );
  const out = canonicalize(input);
  // The RFC lists the property names' UTF-8 bytes in this order. Read the
  // names off the output text: Object.keys would put "1" first.
  const names = [...out.matchAll(/"((?:[^"\\]|\\.)*)":"/g)].map((m) => Buffer.from(m[1], 'utf8').toString('hex'));
  assert.deepEqual(names, ['5c72', '31', 'c280', 'c3b6', 'e282ac', 'f09f9880', 'efacb3']);
  assert.equal(
    out,
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
      '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
});

test('RFC 8785 3.2.3: nested objects sort too, arrays keep order', () => {
  assert.equal(canonicalize({ b: [3, 1, { z: 1, a: 2 }], a: {} }), '{"a":{},"b":[3,1,{"a":2,"z":1}]}');
});

const APPENDIX_B = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

const fromBits = (hex) => Buffer.from(hex, 'hex').readDoubleBE(0);

test('RFC 8785 Appendix B: number serialization vectors', () => {
  for (const [bits, want] of APPENDIX_B) {
    assert.equal(canonicalize(fromBits(bits)), want, `bits ${bits}`);
  }
});

test('RFC 8785 Appendix B: NaN and Infinity are errors', () => {
  assert.throws(() => canonicalize(fromBits('7fffffffffffffff')), TypeError);
  assert.throws(() => canonicalize(fromBits('7ff0000000000000')), TypeError);
  assert.throws(() => canonicalize(-Infinity), TypeError);
});

test('non-JSON data is refused', () => {
  assert.throws(() => canonicalize({ a: undefined }), TypeError);
  assert.throws(() => canonicalize(1n), TypeError);
  assert.throws(() => canonicalize(() => 1), TypeError);
  assert.throws(() => canonicalize(new Date(0)), TypeError);
  assert.throws(() => canonicalize(new (class Thing {})()), TypeError);
  assert.throws(() => canonicalize('\ud800'), TypeError);
  assert.throws(() => canonicalize({ '\udc00': 1 }), TypeError);
});

test('control characters escape as RFC 8785 asks', () => {
  assert.equal(canonicalize('\b\t\n\f\r\u0000\u001f\u007f'), '"\\b\\t\\n\\f\\r\\u0000\\u001f\u007f"');
});
