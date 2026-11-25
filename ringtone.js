// Redpencil Phone — soft but loud incoming-call ringtone (bell chime).
// Replaces the 'ring' sound of playTone(); all other sounds stay as they were.
(function () {
  var original = window.playTone;
  var out = null;
  function output(ctx) {
    if (!out || out.context !== ctx) {
      var comp = ctx.createDynamicsCompressor(); // keeps it loud without harsh clipping
      comp.threshold.value = -12; comp.knee.value = 20; comp.ratio.value = 6;
      comp.attack.value = 0.003; comp.release.value = 0.25;
      var master = ctx.createGain(); master.gain.value = 1.0;
      comp.connect(master); master.connect(ctx.destination);
      out = comp;
    }
    return out;
  }
  // One soft bell note: sine tone + gentle overtones, quick attack, long smooth fade.
  function bell(ctx, t0, freq, vol, dur) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(output(ctx));
    [[1, 1], [2, 0.3], [3, 0.08], [4.2, 0.04]].forEach(function (p) {
      var o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * p[0];
      var a = ctx.createGain(); a.gain.value = p[1];
      o.connect(a); a.connect(g);
      o.start(t0); o.stop(t0 + dur + 0.05);
      toneNodes.push(o);
    });
  }
  window.playTone = function (kind) {
    if (kind !== 'ring') return original(kind);
    stopTone();
    try {
      var ctx = getCtx();
      var notes = [659.25, 783.99, 1046.5, 783.99]; // E5 G5 C6 G5 — a gentle rising chime
      var ring = function () {
        var t = ctx.currentTime + 0.05;
        notes.forEach(function (f, i) { bell(ctx, t + i * 0.22, f, 0.7, 1.4); });
        notes.forEach(function (f, i) { bell(ctx, t + 1.1 + i * 0.22, f, 0.6, 1.4); });
        if (navigator.vibrate) navigator.vibrate([600, 300, 600]);
      };
      ring();
      toneTimer = setInterval(ring, 3600);
    } catch (e) { try { original(kind); } catch (e2) {} }
  };
})();
