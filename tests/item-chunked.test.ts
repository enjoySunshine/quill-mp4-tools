import fs from 'fs';
import path from 'path';
import { createFile, MP4BoxBuffer, type Item } from '../entries/all';

const cacheRoot = path.join(import.meta.dirname, '..', '.cache', 'files');
const heifDirs = [
  path.join(cacheRoot, 'published', 'heif'),
  path.join(cacheRoot, 'under_consideration', 'cenc'),
];
const extraFiles = [path.join(cacheRoot, 'published', 'isobmff', '12_metas_v2.mp4')];

interface ItemReference {
  id: number;
  name?: string;
  size: number;
  /** Exact expected bytes, or undefined for items carrying no data (derived items). */
  bytes?: Uint8Array;
}

/**
 * Parses the whole file at once and establishes the reference for every item
 * listed in the 'meta' box. Items with a location ('iloc') record get their
 * exact expected bytes reconstructed by slicing the original file at the
 * item's extent offsets; derived items (no extents, no data) are expected to be
 * signaled with an empty payload.
 */
function buildItemReferences(filePath: string): Array<ItemReference> {
  const fileBytes = fs.readFileSync(filePath);
  const mp4 = createFile(true);
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(fileBytes.buffer.slice(0), 0));
  mp4.flush();

  const references: Array<ItemReference> = [];
  for (const item of mp4.items) {
    if (!item || item.id === undefined) continue;
    if (!item.extents || item.extents.length === 0 || !item.size) {
      references.push({ id: item.id, name: item.name, size: item.size ?? 0 });
      continue;
    }
    const bytes = new Uint8Array(item.size);
    let position = 0;
    for (const extent of item.extents) {
      bytes.set(fileBytes.subarray(extent.offset, extent.offset + extent.length), position);
      position += extent.length;
    }
    references.push({ id: item.id, name: item.name, size: item.size, bytes });
  }
  return references;
}

/**
 * Sorted list of disjoint [start, end[ intervals covering every byte handed
 * to the simulated downloader, used only to assert the whole file was
 * eventually requested.
 */
class CoveredRanges {
  ranges: Array<[number, number]> = [];

  add(start: number, end: number) {
    let insertAt = 0;
    while (insertAt < this.ranges.length && this.ranges[insertAt][0] < start) insertAt++;
    this.ranges.splice(insertAt, 0, [start, end]);

    const merged: Array<[number, number]> = [];
    for (const range of this.ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) {
        last[1] = Math.max(last[1], range[1]);
      } else {
        merged.push([...range] as [number, number]);
      }
    }
    this.ranges = merged;
  }

  get total() {
    return this.ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
  }
}

/**
 * Simulates a browser downloading the file in fixed-size chunks, always using
 * the position returned by appendBuffer as the start of the next range
 * request (the only contract offered to callers). The library may guide the
 * downloader backward, in particular for files whose 'meta' box is located
 * after the image data: a faithful client simply issues that earlier range
 * request again, and the library merges/ignores overlapping buffers itself.
 */
function downloadInChunks(filePath: string, chunkSize: number) {
  const fileBytes = fs.readFileSync(filePath);
  const fileLength = fileBytes.byteLength;
  const mp4 = createFile(true);

  const delivered = new Map<number, Uint8Array>();
  const callbackCounts = new Map<number, number>();
  mp4.onItem = (item: Item) => {
    if (item.id === undefined) return;
    callbackCounts.set(item.id, (callbackCounts.get(item.id) ?? 0) + 1);
    // Keep a copy of the delivered bytes: the library releases item.data after
    // the callback, so holding a reference is the only way to verify them.
    delivered.set(item.id, new Uint8Array(item.data ?? new Uint8Array(0)));
  };

  const covered = new CoveredRanges();
  const maxRequests = Math.ceil(fileLength / chunkSize) * 4 + 100;
  let nextFileStart = 0;
  let previousStart = -1;
  let repeatedStarts = 0;

  for (let request = 0; request < maxRequests; request++) {
    if (nextFileStart >= fileLength) break;

    // A range request always starts exactly at the guided position and fetches
    // a fixed-size chunk (truncated at the end of the file).
    const end = Math.min(nextFileStart + chunkSize, fileLength);
    const slice = fileBytes.subarray(nextFileStart, end);
    const chunk = MP4BoxBuffer.fromArrayBuffer(
      slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
      nextFileStart,
    );
    covered.add(nextFileStart, end);

    const guided = mp4.appendBuffer(chunk);
    expect(
      guided,
      `appendBuffer must always return a fetch position (chunk size ${chunkSize})`,
    ).not.toBeUndefined();
    nextFileStart = guided as number;

    // Detect guidance that makes no progress instead of looping forever.
    if (nextFileStart === previousStart) {
      if (++repeatedStarts > 2) {
        throw new Error(
          `chunk size ${chunkSize}: appendBuffer keeps requesting position ${nextFileStart}`,
        );
      }
    } else {
      repeatedStarts = 0;
    }
    previousStart = nextFileStart;
  }
  expect(covered.total, 'the guided download must eventually request the whole file').toBe(
    fileLength,
  );
  mp4.flush();

  return { delivered, callbackCounts, coveredCount: covered.total };
}

const corpusFiles: Array<string> = [];
for (const dir of heifDirs) {
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.heic')) corpusFiles.push(path.join(dir, name));
    }
  }
}
for (const f of extraFiles) {
  if (fs.existsSync(f)) corpusFiles.push(f);
}

const chunkSizes = [1024 * 1024, 64 * 1024, 16 * 1024, 4 * 1024, 1024, 512, 128];

describe.skipIf(corpusFiles.length === 0)('Chunked image item delivery', () => {
  test.for(corpusFiles)(
    'delivers complete item bytes for %s',
    filePath => {
      const references = buildItemReferences(filePath);
      // Some conformance files only carry timed media (no 'meta'/'iloc' items);
      // they do not exercise this code path.
      if (references.length === 0) return;

      for (const chunkSize of chunkSizes) {
        const { delivered, callbackCounts, coveredCount } = downloadInChunks(filePath, chunkSize);

        // Every item of the reference parse must be delivered exactly once.
        expect(
          delivered.size,
          `chunk size ${chunkSize}: expected ${references.length} items, got ${delivered.size}`,
        ).toBe(references.length);

        for (const reference of references) {
          expect(
            callbackCounts.get(reference.id),
            `chunk size ${chunkSize}: item ${reference.id} must be signaled exactly once`,
          ).toBe(1);

          const received = delivered.get(reference.id);
          expect(
            received,
            `chunk size ${chunkSize}: item ${reference.id} never delivered`,
          ).toBeDefined();
          if (received === undefined) continue;

          if (reference.bytes === undefined) {
            // Derived items have no location record and are signaled with no data.
            expect(
              received.byteLength,
              `chunk size ${chunkSize}: derived item ${reference.id} must carry no data`,
            ).toBe(0);
            continue;
          }

          expect(received.byteLength, `chunk size ${chunkSize}: item ${reference.id} size`).toBe(
            reference.size,
          );
          expect(
            received.every((value, index) => value === reference.bytes?.[index]),
            `chunk size ${chunkSize}: item ${reference.id} (${reference.name}) bytes differ from the full-file reference`,
          ).toBe(true);
        }

        expect(coveredCount, `chunk size ${chunkSize}: not the whole file was requested`).toBe(
          fs.statSync(filePath).size,
        );
      }
    },
    // The 128-byte chunk size makes the stream re-parse buffers on every
    // request; the largest conformance files need a few minutes for that case.
    300000,
  );
});
