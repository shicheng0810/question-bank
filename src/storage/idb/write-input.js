import { APP_DATA_CONTENT_LIMITS as LIMITS } from '../../domain/app-data/constants.js';
import { validateStoreRecord } from '../../domain/app-data/index.js';
import {validateContentChunkRecordForFreshNativeRead} from '../../domain/app-data/local-records.js';
import { storageError } from './transaction.js';

const ownedBinaryCopies=new WeakSet();
const NativeUint8Array=Uint8Array,nativeSet=Uint8Array.prototype.set;
export function validateOwnedWriteRecord(store,value){
  // The input was fully validated before this private native copy was made.
  // External arrays always keep the complete strict validator.
  if(store==='content_chunks'&&ownedBinaryCopies.has(value?.bytes))return validateContentChunkRecordForFreshNativeRead(value);
  return validateStoreRecord(store,value);
}

const invalid = () => { throw storageError('INVALID_INPUT', 'Invalid or oversized write input'); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

// Count JSON string bytes without allocating an encoded string or invoking user code.
function stringBytes(value) {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n === 34 || n === 92) bytes += 2;
    else if (n < 32) bytes += [8, 9, 10, 12, 13].includes(n) ? 2 : 6;
    else if (n < 128) bytes++;
    else if (n < 2048) bytes += 2;
    else if (n >= 0xd800 && n <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += n >= 0xd800 && n <= 0xdfff ? 6 : 3;
    if (bytes > LIMITS.maxStringUtf8Bytes) invalid();
  }
  return bytes;
}

export function ownedWriteInput(input) {
  let total = 0;
  const active = new WeakSet();
  const checkedBinary = new WeakSet();
  const add = bytes => { total += bytes; if (total > LIMITS.maxCanonicalUtf8Bytes) invalid(); };
  function inspect(value, depth) {
    if (depth > LIMITS.maxDepth) invalid();
    // Optional command fields/absent-record conditions are validated by their DTO validator.
    if (value === undefined) { add(4); return; }
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { add(stringBytes(value)); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); add(String(value).length); return; }
    if (typeof value !== 'object' || active.has(value)) invalid();
    if (value instanceof Uint8Array) {
      if (Object.getPrototypeOf(value) !== Uint8Array.prototype) invalid();
      if (!checkedBinary.has(value)) {
        validateStoreRecord('content_chunks', { contentDigest: '0'.repeat(64), chunkIndex: 0, bytes: value });
        checkedBinary.add(value);
      }
      add(value.byteLength + 2); return;
    }
    active.add(value);
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) invalid();
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value > LIMITS.maxArrayItems) invalid();
      if (Reflect.ownKeys(value).length !== length.value + 1) invalid();
      add(2 + Math.max(0, length.value - 1));
      for (let i = 0; i < length.value; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
        inspect(descriptor.value, depth + 1);
      }
    } else {
      const keys = Reflect.ownKeys(value);
      if (keys.length > LIMITS.maxObjectKeys) invalid();
      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (typeof key !== 'string' || forbidden.has(key)) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !('value' in descriptor)) invalid();
        add(stringBytes(key) + 1); inspect(descriptor.value, depth + 1);
      }
    }
    active.delete(value);
  }
  inspect(input, 0); // Complete preflight before copying even the first binary chunk.
  function clone(value) {
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Uint8Array) {const copy=new NativeUint8Array(value.byteLength);nativeSet.call(copy,value);ownedBinaryCopies.add(copy);return copy;}
    if (Array.isArray(value)) return value.map(clone);
    const result = {};
    for (const key of Reflect.ownKeys(value)) result[key] = clone(Object.getOwnPropertyDescriptor(value, key).value);
    return result;
  }
  return clone(input);
}
