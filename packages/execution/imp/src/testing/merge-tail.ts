export function mergeTail(ring: Uint8Array, data: Uint8Array, limit: number): Uint8Array {
  const joined = new Uint8Array(ring.length + data.length);

  joined.set(ring, 0);
  joined.set(data, ring.length);

  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}
