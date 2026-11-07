// Decoder of js/vlc-markings.bin.gz (VLM4, written by write() in tools/build-markings.py), shared by the game
// (vlc-markings.js) and the tests. Returns { styles: [{ r, g, b, kind }], strokes: [{ style, width, period, duty,
// pts: Float32Array [x, z, ...] }], polys: [{ style, pts }] } in world metres (period 0 = a continuous line).
// Layout: 'VLM4', u32 nStyles, nStraight, nPolylines, nPolygons, f32 unit (m), u32 direction steps per turn, 19 u32
// section byte lengths, the styles (u8 r, g, b, kind), then the sections, each a column of zigzag LEB128 varints
// (coordinates in units):
//   straight strokes: style, width (cm), period (cm), duty (/255), first point as a step (along, across) from the
//     previous stroke's first point in the previous stroke's direction, length, direction step from the previous one
//   polylines: style, width (cm), point count, first point x, z (steps from the previous polyline's), then steps
//     x, z to each next point
//   polygons: style, point count, first point x, z, steps x, z
export function decodeMarkings(data) {
  if (String.fromCharCode(...data.subarray(0, 4)) !== 'VLM4') throw new Error('Invalid marking data.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const [nStyles, nTwo, nMany, nPolys] = [4, 8, 12, 16].map((o) => view.getUint32(o, true));
  const unit = Math.round(view.getFloat32(20, true) * 1e6) / 1e6;
  const dirs = view.getUint32(24, true);
  const lens = [];
  for (let i = 0; i < 19; i++) lens.push(view.getUint32(28 + i * 4, true));
  let at = 28 + 19 * 4;
  const styles = [];
  for (let i = 0; i < nStyles; i++, at += 4) styles.push({ r: data[at], g: data[at + 1], b: data[at + 2], kind: data[at + 3] });
  let sec = 0;
  // next section as an array of ints
  const column = () => {
    const end = at + lens[sec++];
    const out = [];
    let v = 0, shift = 0;
    while (at < end) {
      const b = data[at++];
      v += (b & 0x7f) * 2 ** shift;
      if (b & 0x80) { shift += 7; continue; }
      out.push(v % 2 === 1 ? -(v + 1) / 2 : v / 2);
      v = 0; shift = 0;
    }
    return out;
  };
  const cumulate = (a) => { for (let i = 1; i < a.length; i++) a[i] += a[i - 1]; return a; };

  const strokes = [];
  {
    const [style, width, period, duty] = [column(), column(), column(), column()];
    const along = column(), across = column(), len = column(), turn = column();
    let x = 0, z = 0, dir = 0;
    for (let i = 0; i < nTwo; i++) {
      const th = (dir * 2 * Math.PI) / dirs;
      const c = Math.cos(th), s = Math.sin(th);
      x += (along[i] * c - across[i] * s) * unit;
      z += (along[i] * s + across[i] * c) * unit;
      dir += turn[i];
      const a = (dir * 2 * Math.PI) / dirs;
      const L = len[i] * unit;
      strokes.push({ style: style[i], width: width[i] / 100, period: period[i] / 100, duty: duty[i] / 255,
        pts: new Float32Array([x, z, x + Math.cos(a) * L, z + Math.sin(a) * L]) });
    }
  }
  const shapes = (n, counts, x, z, steps, emit) => {
    for (let i = 0, k = 0; i < n; i++) {
      const pts = new Float32Array(counts[i] * 2);
      let px = 0, pz = 0;
      pts[0] = x[i] * unit; pts[1] = z[i] * unit;
      for (let j = 1; j < counts[i]; j++, k += 2) {
        px += steps[k]; pz += steps[k + 1];
        pts[j * 2] = (x[i] + px) * unit; pts[j * 2 + 1] = (z[i] + pz) * unit;
      }
      emit(i, pts);
    }
  };
  {
    const style = column(), width = column(), counts = column();
    const x = cumulate(column()), z = cumulate(column()), steps = column();
    shapes(nMany, counts, x, z, steps, (i, pts) => strokes.push({ style: style[i], width: width[i] / 100, period: 0, duty: 1, pts }));
  }
  const polys = [];
  {
    const style = column(), counts = column();
    const x = cumulate(column()), z = cumulate(column()), steps = column();
    shapes(nPolys, counts, x, z, steps, (i, pts) => polys.push({ style: style[i], pts }));
  }
  if (at !== data.length || strokes.length !== nTwo + nMany) throw new Error('Marking data is inconsistent.');
  return { styles, strokes, polys };
}
