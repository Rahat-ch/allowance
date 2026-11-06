/**
 * Node globals some wallet SDKs (Meteor's, and the older @near-js it bundles) expect in
 * the browser. Imported first by main.tsx; the wallet modules load lazily after it.
 */
import { Buffer } from "buffer";

type ProcessShim = { env: Record<string, string | undefined>; browser: boolean; nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => void };
const g = globalThis as unknown as { global?: unknown; Buffer?: typeof Buffer; process?: ProcessShim };
g.global ??= globalThis;
g.Buffer ??= Buffer;
g.process ??= { env: {}, browser: true, nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)) };
