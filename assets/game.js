/* Pure game rules for Wavelength. No DOM, no network.
   The dial is measured in "value" units: 0 = far left, 180 = far right. */
(function (global) {
  "use strict";

  var DIAL = 180;

  /* Scoring profiles. `bands` lists point values across the target wedge,
     left to right. Bands are equal width and share TARGET_WIDTH degrees. */
  var PROFILES = {
    official: { id: "official", label: "Official (2-3-4-3-2)", bands: [2, 3, 4, 3, 2], width: 25 },
    simple: { id: "simple", label: "Simple (1-3-1)", bands: [1, 3, 1], width: 21 }
  };

  function profile(id) {
    return PROFILES[id] || PROFILES.official;
  }

  /* Cryptographically-seeded random float in [0,1). */
  function rand() {
    var buf = new Uint32Array(1);
    global.crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }

  function randomTarget() {
    return rand() * DIAL;
  }

  /* Returns [{from, to, points}] in dial units for a target centred at `center`.
     Edges may fall outside [0,180]; that is intentional and matches the
     physical game, where a target near the rim is simply harder to score on. */
  function bandsFor(center, profileId) {
    var p = profile(profileId);
    var each = p.width / p.bands.length;
    var start = center - p.width / 2;
    return p.bands.map(function (points, i) {
      return { from: start + i * each, to: start + (i + 1) * each, points: points };
    });
  }

  /* Points earned by a guess at `value` against a target centred at `center`. */
  function score(value, center, profileId) {
    var bands = bandsFor(center, profileId);
    for (var i = 0; i < bands.length; i++) {
      if (value >= bands[i].from && value < bands[i].to) return bands[i].points;
    }
    return 0;
  }

  function maxPoints(profileId) {
    return Math.max.apply(null, profile(profileId).bands);
  }

  /* Fisher-Yates using the CSPRNG above. */
  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* End-of-game blurb, scaled to what was actually achievable. */
  function rating(total, rounds, profileId) {
    var pct = rounds ? total / (rounds * maxPoints(profileId)) : 0;
    if (pct >= 0.9) return "Telepathic. Are you sure you're two people?";
    if (pct >= 0.75) return "Seriously in sync.";
    if (pct >= 0.55) return "Solidly on the same wavelength.";
    if (pct >= 0.35) return "Getting there. Keep tuning.";
    if (pct > 0) return "Crossed wires, but you had fun.";
    return "Completely different frequencies.";
  }

  global.Rules = {
    DIAL: DIAL,
    PROFILES: PROFILES,
    profile: profile,
    randomTarget: randomTarget,
    bandsFor: bandsFor,
    score: score,
    maxPoints: maxPoints,
    shuffle: shuffle,
    rating: rating,
    rand: rand
  };
})(window);
