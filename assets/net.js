/* Peer-to-peer transport. One player hosts a room, the other joins by code.
   Game data travels directly between the two browsers over an encrypted
   WebRTC data channel; the broker is only used to introduce the peers. */
(function (global) {
  "use strict";

  /* No 0/O/1/I/L to keep codes readable out loud. */
  var ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  var CODE_LEN = 6;
  var PREFIX = "wvln-v1-";

  function makeCode() {
    var buf = new Uint32Array(CODE_LEN);
    global.crypto.getRandomValues(buf);
    var out = "";
    for (var i = 0; i < CODE_LEN; i++) out += ALPHABET[buf[i] % ALPHABET.length];
    return out;
  }

  function normalize(code) {
    return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
  }

  function peerIdFor(code) {
    return PREFIX + normalize(code).toLowerCase();
  }

  function peerOptions() {
    return {
      debug: 0,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" }
        ]
      }
    };
  }

  /* handlers: onStatus(text, kind), onReady(code), onConnected(), onData(msg),
               onDisconnected(), onFatal(text) */
  function Net(handlers) {
    this.h = handlers || {};
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.code = null;
    this._closed = false;
  }

  Net.prototype._status = function (text, kind) {
    if (this.h.onStatus) this.h.onStatus(text, kind || "info");
  };

  Net.prototype.host = function (code) {
    var self = this;
    this.isHost = true;
    this.code = normalize(code) || makeCode();
    this._status("Opening room…", "pending");

    var peer = new global.Peer(peerIdFor(this.code), peerOptions());
    this.peer = peer;

    peer.on("open", function () {
      self._status("Room open. Waiting for your partner…", "pending");
      if (self.h.onReady) self.h.onReady(self.code);
    });

    peer.on("connection", function (conn) {
      if (self.conn && self.conn.open) {
        /* Room is full; turn away extra callers rather than corrupting state. */
        conn.on("open", function () {
          conn.send({ t: "full" });
          setTimeout(function () { conn.close(); }, 250);
        });
        return;
      }
      self._attach(conn);
    });

    this._peerErrors(peer, function (err) {
      if (err.type === "unavailable-id") {
        return "That room code is already in use. Start a new room.";
      }
      return null;
    });
  };

  Net.prototype.join = function (code) {
    var self = this;
    this.isHost = false;
    this.code = normalize(code);
    if (this.code.length !== CODE_LEN) {
      if (this.h.onFatal) this.h.onFatal("Room codes are " + CODE_LEN + " characters.");
      return;
    }
    this._status("Connecting…", "pending");

    var peer = new global.Peer(null, peerOptions());
    this.peer = peer;

    peer.on("open", function () {
      var conn = peer.connect(peerIdFor(self.code), { reliable: true });
      self._attach(conn);
      /* PeerJS reports a bad room code as an async peer error; guard against
         a silent hang if neither open nor error ever arrives. */
      self._joinTimer = setTimeout(function () {
        if (!self.conn || !self.conn.open) {
          if (self.h.onFatal) {
            self.h.onFatal("No room with that code. Check the code and try again.");
          }
          self.close();
        }
      }, 15000);
    });

    this._peerErrors(peer, function (err) {
      if (err.type === "peer-unavailable") {
        return "No room with that code. Check the code and try again.";
      }
      return null;
    });
  };

  Net.prototype._peerErrors = function (peer, classify) {
    var self = this;
    peer.on("error", function (err) {
      var msg = classify(err);
      if (msg) {
        if (self.h.onFatal) self.h.onFatal(msg);
        self.close();
        return;
      }
      if (err.type === "browser-incompatible") {
        if (self.h.onFatal) self.h.onFatal("This browser doesn't support WebRTC.");
        self.close();
        return;
      }
      if (err.type === "network" || err.type === "server-error" || err.type === "socket-error") {
        self._status("Trouble reaching the matchmaking server. Retrying…", "warn");
        return;
      }
      self._status("Connection error: " + err.type, "warn");
    });

    peer.on("disconnected", function () {
      if (self._closed) return;
      self._status("Reconnecting…", "warn");
      try { peer.reconnect(); } catch (_) {}
    });
  };

  Net.prototype._attach = function (conn) {
    var self = this;
    this.conn = conn;

    conn.on("open", function () {
      clearTimeout(self._joinTimer);
      self._status("Connected", "ok");
      if (self.h.onConnected) self.h.onConnected();
    });

    conn.on("data", function (msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "full") {
        if (self.h.onFatal) self.h.onFatal("That room already has two players.");
        self.close();
        return;
      }
      if (self.h.onData) self.h.onData(msg);
    });

    conn.on("close", function () {
      if (self._closed) return;
      self._status("Your partner disconnected.", "warn");
      if (self.h.onDisconnected) self.h.onDisconnected();
    });

    conn.on("error", function () {
      self._status("Data channel error.", "warn");
    });
  };

  Net.prototype.send = function (msg) {
    if (this.conn && this.conn.open) {
      try { this.conn.send(msg); } catch (_) {}
      return true;
    }
    return false;
  };

  Net.prototype.isConnected = function () {
    return !!(this.conn && this.conn.open);
  };

  Net.prototype.close = function () {
    this._closed = true;
    clearTimeout(this._joinTimer);
    try { if (this.conn) this.conn.close(); } catch (_) {}
    try { if (this.peer) this.peer.destroy(); } catch (_) {}
    this.conn = null;
    this.peer = null;
  };

  global.Net = Net;
  global.Net.makeCode = makeCode;
  global.Net.normalize = normalize;
  global.Net.CODE_LEN = CODE_LEN;
})(window);
