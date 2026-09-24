/**
 * The Solana client libraries are written against Node's `Buffer`. This module installs the
 * polyfill on the global object and must be the first import of the entry point, because ESM
 * evaluates imported modules in order.
 */
import { Buffer } from 'buffer';

if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer: typeof Buffer }).Buffer = Buffer;
}
