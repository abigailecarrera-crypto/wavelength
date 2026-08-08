/* The half-circle dial: target bands, the swinging screen that hides them,
   and the draggable needle. Renders into an <svg> element. */
(function (global) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var CX = 310, CY = 310, R = 290, R_IN = 58;
  var BAND_COLORS = { 1: "#3f6f5c", 2: "#3f6f5c", 3: "#57a97f", 4: "#8ce0a8" };

  function el(name, attrs) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function gradient(id, stops) {
    var g = el("linearGradient", { id: id, x1: "0", y1: "0", x2: "0", y2: "1" });
    stops.forEach(function (s) {
      g.appendChild(el("stop", { offset: s[0], "stop-color": s[1] }));
    });
    return g;
  }

  /* Dial value (0..180, left to right) -> cartesian point at radius r. */
  function pt(value, r) {
    var a = (180 - value) * Math.PI / 180;
    return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
  }

  /* Annulus sector between two dial values. */
  function wedgePath(from, to, rIn, rOut) {
    var a = pt(from, rIn), b = pt(from, rOut), c = pt(to, rOut), d = pt(to, rIn);
    var big = Math.abs(to - from) > 180 ? 1 : 0;
    return "M" + a[0] + "," + a[1] +
      "L" + b[0] + "," + b[1] +
      "A" + rOut + "," + rOut + " 0 " + big + " 1 " + c[0] + "," + c[1] +
      "L" + d[0] + "," + d[1] +
      "A" + rIn + "," + rIn + " 0 " + big + " 0 " + a[0] + "," + a[1] + "Z";
  }

  function Dial(svg) {
    this.svg = svg;
    this.value = 90;
    this.target = null;
    this.profileId = "official";
    this.coverOpen = false;
    this.interactive = false;
    this.onInput = null;
    this.onCommit = null;
    this._build();
    this._bind();
  }

  Dial.prototype._build = function () {
    var svg = this.svg;
    svg.setAttribute("viewBox", "0 0 620 340");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    clear(svg);

    var defs = el("defs");
    defs.appendChild(gradient("boardGrad", [["0%", "#1d2433"], ["100%", "#141a26"]]));
    defs.appendChild(gradient("coverGrad", [
      ["0%", "#2c3852"], ["55%", "#222c41"], ["100%", "#1a2231"]
    ]));
    var clip = el("clipPath", { id: "topHalf" });
    clip.appendChild(el("rect", { x: 0, y: 0, width: 620, height: 311 }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    var root = el("g", { "clip-path": "url(#topHalf)" });
    svg.appendChild(root);

    /* Board underneath everything. */
    root.appendChild(el("path", {
      d: wedgePath(0, 180, R_IN, R), fill: "url(#boardGrad)",
      stroke: "#39435c", "stroke-width": 2
    }));

    /* Target bands live here; repopulated whenever the target changes. */
    this.bandsG = el("g", { opacity: "0" });
    root.appendChild(this.bandsG);

    /* Tick marks around the rim. */
    var ticks = el("g", { stroke: "#4a5670", "stroke-width": 2, opacity: "0.7" });
    for (var v = 0; v <= 180; v += 7.5) {
      var major = Math.abs(v % 45) < 0.01;
      var p1 = pt(v, R - (major ? 22 : 12)), p2 = pt(v, R - 2);
      ticks.appendChild(el("line", {
        x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
        "stroke-width": major ? 3 : 1.5
      }));
    }
    root.appendChild(ticks);

    /* The screen that hides the target. Rotates away from the board to reveal. */
    this.cover = el("path", {
      d: wedgePath(0, 180, R_IN - 2, R + 3), fill: "url(#coverGrad)",
      stroke: "#4c5a7a", "stroke-width": 2, class: "cover"
    });
    root.appendChild(this.cover);

    this.coverText = el("text", {
      x: CX, y: CY - R * 0.52, "text-anchor": "middle", class: "coverText"
    });
    this.coverText.textContent = "WAVELENGTH";
    root.appendChild(this.coverText);

    /* Needle. */
    this.needle = el("g", { class: "needle" });
    this.needle.appendChild(el("line", {
      x1: CX, y1: CY, x2: CX, y2: CY - R, stroke: "#ffd166",
      "stroke-width": 5, "stroke-linecap": "round"
    }));
    this.needle.appendChild(el("circle", { cx: CX, cy: CY - R + 18, r: 9, fill: "#ffd166" }));
    root.appendChild(this.needle);

    root.appendChild(el("circle", {
      cx: CX, cy: CY, r: 26, fill: "#0f1420", stroke: "#4c5a7a", "stroke-width": 3
    }));

    this._renderNeedle();
  };

  Dial.prototype._bind = function () {
    var self = this;
    function valueFromEvent(e) {
      var rect = self.svg.getBoundingClientRect();
      /* Map client px -> viewBox units. */
      var scale = 620 / rect.width;
      var x = (e.clientX - rect.left) * scale;
      var y = (e.clientY - rect.top) * scale;
      var dx = x - CX, dy = CY - y;
      var a = Math.atan2(dy, dx) * 180 / Math.PI;
      if (a < 0) a = dx > 0 ? 0 : 180;
      return Math.min(180, Math.max(0, 180 - a));
    }

    function down(e) {
      if (!self.interactive) return;
      e.preventDefault();
      self._dragging = true;
      /* Move the needle first: capture is an optimisation for tracking the
         pointer outside the element, and some browsers throw on it. A failure
         there must not swallow the tap. */
      self.setValue(valueFromEvent(e));
      if (self.onInput) self.onInput(self.value);
      try { self.svg.setPointerCapture(e.pointerId); } catch (_) {}
    }
    function move(e) {
      if (!self.interactive || !self._dragging) return;
      self.setValue(valueFromEvent(e));
      if (self.onInput) self.onInput(self.value);
    }
    function up(e) {
      if (!self._dragging) return;
      self._dragging = false;
      try { self.svg.releasePointerCapture(e.pointerId); } catch (_) {}
      if (self.onCommit) self.onCommit(self.value);
    }

    this.svg.addEventListener("pointerdown", down);
    this.svg.addEventListener("pointermove", move);
    this.svg.addEventListener("pointerup", up);
    this.svg.addEventListener("pointercancel", up);

    /* Keyboard access: arrows nudge, shift for coarse steps. */
    this.svg.addEventListener("keydown", function (e) {
      if (!self.interactive) return;
      var step = e.shiftKey ? 5 : 1;
      if (e.key === "ArrowLeft") self.setValue(self.value - step);
      else if (e.key === "ArrowRight") self.setValue(self.value + step);
      else if (e.key === "Home") self.setValue(0);
      else if (e.key === "End") self.setValue(180);
      else return;
      e.preventDefault();
      if (self.onInput) self.onInput(self.value);
      if (self.onCommit) self.onCommit(self.value);
    });
  };

  Dial.prototype.setInteractive = function (on) {
    this.interactive = !!on;
    this.svg.classList.toggle("interactive", !!on);
    if (on) {
      this.svg.setAttribute("tabindex", "0");
      this.svg.setAttribute("role", "slider");
      this.svg.setAttribute("aria-valuemin", "0");
      this.svg.setAttribute("aria-valuemax", "180");
    } else {
      this.svg.removeAttribute("tabindex");
    }
  };

  Dial.prototype.setValue = function (v) {
    this.value = Math.min(180, Math.max(0, v));
    this._renderNeedle();
  };

  Dial.prototype._renderNeedle = function () {
    this.needle.style.transform = "rotate(" + (this.value - 90) + "deg)";
    this.svg.setAttribute("aria-valuenow", Math.round(this.value));
  };

  /* Pass null to clear the target. */
  Dial.prototype.setTarget = function (center, profileId) {
    this.target = center;
    if (profileId) this.profileId = profileId;
    clear(this.bandsG);
    if (center === null || center === undefined) {
      this.bandsG.setAttribute("opacity", "0");
      return;
    }
    var bands = global.Rules.bandsFor(center, this.profileId);
    var self = this;
    bands.forEach(function (b) {
      /* Clamp to the board; bands can hang off the rim by design. */
      var from = Math.max(0, b.from), to = Math.min(180, b.to);
      if (to <= from) return;
      self.bandsG.appendChild(el("path", {
        d: wedgePath(from, to, R_IN, R),
        fill: BAND_COLORS[b.points] || "#3f6f5c",
        stroke: "rgba(0,0,0,.35)", "stroke-width": 1
      }));
      var mid = pt((from + to) / 2, R * 0.86);
      var label = el("text", {
        x: mid[0], y: mid[1], "text-anchor": "middle",
        "dominant-baseline": "central", class: "bandLabel"
      });
      label.textContent = b.points;
      self.bandsG.appendChild(label);
    });
    this.bandsG.setAttribute("opacity", "1");
  };

  Dial.prototype.setCover = function (open, instant) {
    this.coverOpen = !!open;
    this.cover.style.transition = instant ? "none" : "";
    this.coverText.style.transition = instant ? "none" : "";
    var deg = open ? 182 : 0;
    this.cover.style.transform = "rotate(" + deg + "deg)";
    this.coverText.style.opacity = open ? "0" : "1";
    if (instant) {
      /* Force a reflow so the next transition isn't swallowed. */
      void this.cover.getBoundingClientRect();
      this.cover.style.transition = "";
      this.coverText.style.transition = "";
    }
  };

  global.Dial = Dial;
})(window);
