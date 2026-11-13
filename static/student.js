// Reverie's small "sounds alike" model in the browser (2026-11-12): a ~3.8M-parameter student
// distilled from Aria (scripts/experiments/distill/), exported by export_student.py.
// On the PiJAMA same-pianist control it scores like 4-bit Aria at ~1/30 the size.
//
// Needs the global `ort` (ONNX Runtime Web). Usage:
//   const s = await Student.load({ url: "static/models/student.onnx" });
//   const vec = await s.embed(notes);  // notes: [[pitch, onset_s, duration_s, velocity], ...],
//                                      // onsets relative to the window start → Float32Array(512)

(function () {
  const MAX_NOTES = 256;

  // student.featurize, line for line: stable sort by onset, first 256 notes,
  // [log1p(gap to previous onset), log1p(duration), velocity/127, onset/20].
  function featurize(notes) {
    if (!notes.length) throw new Error("no notes");
    const sorted = notes
      .map((n, i) => ({ n, i }))
      .sort((a, b) => a.n[1] - b.n[1] || a.i - b.i)
      .slice(0, MAX_NOTES)
      .map((x) => x.n.map(Math.fround));
    const len = sorted.length;
    const pitch = new BigInt64Array(len);
    const cont = new Float32Array(len * 4);
    for (let i = 0; i < len; i++) {
      const [p, onset, dur, vel] = sorted[i];
      pitch[i] = BigInt(Math.min(127, Math.max(0, Math.trunc(p))));
      const gap = i ? onset - sorted[i - 1][1] : 0;
      cont[4 * i] = Math.log1p(Math.max(gap, 0));
      cont[4 * i + 1] = Math.log1p(Math.max(dur, 0));
      cont[4 * i + 2] = vel / 127;
      cont[4 * i + 3] = onset / 20;
    }
    return { pitch, cont, len };
  }

  async function load({ url = "static/models/student.onnx", ep = "wasm" } = {}) {
    const session = await ort.InferenceSession.create(url, { executionProviders: [ep], graphOptimizationLevel: "all" });
    async function embed(notes) {
      const { pitch, cont, len } = featurize(notes);
      const res = await session.run({
        pitch: new ort.Tensor("int64", pitch, [1, len]),
        cont: new ort.Tensor("float32", cont, [1, len, 4]),
      });
      return Float32Array.from(res.embedding.data);
    }
    return { embed, featurize };
  }

  window.Student = { load, featurize };
})();
