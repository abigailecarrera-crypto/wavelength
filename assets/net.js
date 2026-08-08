/* Transport. Both players open outbound WebSocket connections to public MQTT
   relays and exchange messages on a topic derived from the room code.

   Why not peer-to-peer: WebRTC needs a TURN relay whenever either player sits
   behind a symmetric NAT or a strict firewall, and there is no longer a free
   public TURN server to fall back on. Outbound WSS works from essentially any
   network, so this connects where WebRTC silently would not.

   Privacy is preserved by encrypting every payload with AES-GCM under a key
   derived from the room code, and by hashing the code to form the topic name.
   A relay therefore sees an opaque topic carrying opaque bytes. */
(function (global) {
  "use strict";

  /* Every client joins all of these. Two players only need to share one
     working relay, which removes the "each failed over to a different
     server" failure mode. */
  var BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://test.mosquitto.org:8081/"
  ];

  var ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  var CODE_LEN = 6;

  var PING_MS = 3000;         // how often we announce we're still here
  var PARTNER_TIMEOUT_MS = 12000;
  var BROKER_TIMEOUT_MS = 15000;
  var JOIN_TIMEOUT_MS = 22000;

  function randomBytes(n) {
    var b = new Uint8Array(n);
    global.crypto.getRandomValues(b);
    return b;
  }

  function hex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += ("0" + bytes[i].toString(16)).slice(-2);
    return s;
  }

  function makeCode() {
    var buf = randomBytes(CODE_LEN), out = "";
    for (var i = 0; i < CODE_LEN; i++) out += ALPHABET[buf[i] % ALPHABET.length];
    return out;
  }

  function normalize(code) {
    return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
  }

  /* ── Crypto ───────────────────────────────────────── */
  function deriveKey(code) {
    var enc = new TextEncoder();
    return global.crypto.subtle
      .importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return global.crypto.subtle.deriveKey(
          {
            name: "PBKDF2",
            salt: enc.encode("wavelength-v1-salt"),
            iterations: 120000,
            hash: "SHA-256"
          },
          base,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
      });
  }

  /* The topic must not leak the room code, or anyone watching the relay could
     read off live codes and walk into a game. */
  function deriveTopic(code) {
    var enc = new TextEncoder();
    return global.crypto.subtle
      .digest("SHA-256", enc.encode("wavelength-v1-topic|" + code))
      .then(function (d) { return "wvln/" + hex(new Uint8Array(d)).slice(0, 24); });
  }

  function encryptJSON(key, obj) {
    var iv = randomBytes(12);
    var data = new TextEncoder().encode(JSON.stringify(obj));
    return global.crypto.subtle
      .encrypt({ name: "AES-GCM", iv: iv }, key, data)
      .then(function (ct) {
        var out = new Uint8Array(12 + ct.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ct), 12);
        return out;
      });
  }

  function decryptJSON(key, bytes) {
    if (!bytes || bytes.length < 13) return Promise.reject(new Error("short"));
    var iv = bytes.subarray(0, 12);
    var ct = bytes.subarray(12);
    return global.crypto.subtle
      .decrypt({ name: "AES-GCM", iv: iv }, key, ct)
      .then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  /* ── Net ──────────────────────────────────────────── */
  function Net(handlers) {
    this.h = handlers || {};
    this.isHost = false;
    this.code = null;
    this.id = hex(randomBytes(8));
    this.partner = null;
    this.key = null;
    this.topic = null;
    this.clients = [];
    this.readyCount = 0;
    this._closed = false;
    this._seen = [];
    this._seenSet = Object.create(null);
    this._sendChain = Promise.resolve();
    this._recvChain = Promise.resolve();
    this._seq = 0;
    this._rx = Object.create(null);
    this._partnerVia = Object.create(null);
    this._unacked = [];
    this._retryTimer = null;
    this._ackTimer = null;
    this._lastHeard = 0;
    this._partnerUp = false;
    this._announced = false;
  }

  Net.prototype._status = function (text, kind) {
    if (this.h.onStatus) this.h.onStatus(text, kind || "info");
  };

  Net.prototype.host = function (code) {
    this.isHost = true;
    this.code = normalize(code) || makeCode();
    this._start();
  };

  Net.prototype.join = function (code) {
    this.isHost = false;
    this.code = normalize(code);
    if (this.code.length !== CODE_LEN) {
      if (this.h.onFatal) this.h.onFatal("Room codes are " + CODE_LEN + " characters.");
      return;
    }
    this._start();
  };

  Net.prototype._start = function () {
    var self = this;
    this._status("Securing the room…", "pending");

    Promise.all([deriveKey(this.code), deriveTopic(this.code)])
      .then(function (r) {
        if (self._closed) return;
        self.key = r[0];
        self.topic = r[1];
        self._connectAll();
      })
      .catch(function (e) {
        if (self.h.onFatal) self.h.onFatal("Couldn't set up encryption: " + e.message);
      });
  };

  Net.prototype._connectAll = function () {
    var self = this;
    this._status("Connecting…", "pending");

    BROKERS.forEach(function (url, index) {
      var c = new global.MqttClient(url, {
        onConnect: function () {
          c.subscribe(self.topic);
          self.readyCount++;
          self._onBrokerReady();
        },
        onMessage: function (topic, payload) {
          if (topic === self.topic) self._receive(payload, index);
        },
        onClose: function () { self._onBrokerLost(); },
        onError: function () { self._onBrokerLost(); }
      });
      c.connect("wvln-" + self.id + "-" + Math.floor(Math.random() * 100000));
      self.clients.push(c);
    });

    /* If nothing comes up at all, say so rather than spinning forever. */
    this._brokerTimer = setTimeout(function () {
      if (self._closed || self.readyCount > 0) return;
      if (self.h.onFatal) {
        self.h.onFatal("Couldn't reach any relay server. Check your connection and try again.");
      }
      self.close();
    }, BROKER_TIMEOUT_MS);
  };

  Net.prototype._onBrokerReady = function () {
    if (this._closed || this._announced) {
      this._reportRelays();
      return;
    }
    this._announced = true;
    clearTimeout(this._brokerTimer);
    this._startTimers();

    if (this.isHost) {
      this._status("Room open. Waiting for your partner…", "pending");
      if (this.h.onReady) this.h.onReady(this.code);
    } else {
      this._status("Looking for the room…", "pending");
      this._beginJoining();
    }
  };

  Net.prototype._reportRelays = function () {
    if (this._partnerUp) return;
    if (this.isHost) {
      this._status("Room open. Waiting for your partner…", "pending");
    }
  };

  Net.prototype._onBrokerLost = function () {
    if (this._closed) return;
    var live = this._liveCount();
    if (live === 0) {
      this._status("Lost the connection. Reconnecting…", "warn");
      this._reconnectAll();
    }
  };

  Net.prototype._liveCount = function () {
    var n = 0;
    for (var i = 0; i < this.clients.length; i++) if (this.clients[i].connected) n++;
    return n;
  };

  /* Rebuild every relay connection from scratch after a total outage. */
  Net.prototype._reconnectAll = function () {
    var self = this;
    if (this._closed || this._reconnecting) return;
    this._reconnecting = true;
    setTimeout(function () {
      self._reconnecting = false;
      if (self._closed || self._liveCount() > 0) return;
      self.clients.forEach(function (c) { try { c.close(); } catch (_) {} });
      self.clients = [];
      self.readyCount = 0;
      self._announced = false;
      self._connectAll();
    }, 2000);
  };

  /* The guest keeps announcing itself until the host answers; the host may
     still be connecting when the guest arrives. */
  Net.prototype._beginJoining = function () {
    var self = this;
    var attempts = 0;
    this._publish({ k: "join" });
    this._joinPoll = setInterval(function () {
      if (self._closed || self.partner) { clearInterval(self._joinPoll); return; }
      attempts++;
      self._publish({ k: "join" });
    }, 2000);

    this._joinTimer = setTimeout(function () {
      if (self._closed || self.partner) return;
      clearInterval(self._joinPoll);
      if (self.h.onFatal) {
        self.h.onFatal("No room with that code. Check the code and make sure your partner's tab is still open.");
      }
      self.close();
    }, JOIN_TIMEOUT_MS);
  };

  Net.prototype._startTimers = function () {
    var self = this;
    if (this._pingTimer) return;
    this._pingTimer = setInterval(function () {
      if (self.partner) self._publish({ k: "ping" });
    }, PING_MS);

    this._watchTimer = setInterval(function () {
      if (!self.partner || !self._partnerUp) return;
      if (Date.now() - self._lastHeard > PARTNER_TIMEOUT_MS) {
        self._partnerUp = false;
        if (self.h.onDisconnected) self.h.onDisconnected();
      }
    }, 2000);
  };

  /* ── Messaging ────────────────────────────────────── */

  /* Both players subscribe to every relay, so one relay that we know carries
     the partner's traffic is enough for game messages. Control messages still
     go everywhere: they are rare, and they are how we discover that shared
     relay in the first place. */
  Net.prototype._targets = function (kind) {
    var broadcast = (kind !== "app");
    if (broadcast) return null;

    var best = -1, now = Date.now();
    for (var i = 0; i < this.clients.length; i++) {
      if (!this.clients[i].connected) continue;
      if (this._partnerVia[i] && now - this._partnerVia[i] < 30000) { best = i; break; }
    }
    return best < 0 ? null : [best];
  };

  /* Public relays drop messages under load, so anything the game depends on is
     numbered, retransmitted until acknowledged, and delivered in order.
     Heartbeats and acks are deliberately excluded: they are idempotent, and
     acking an ack would never terminate. */
  /* Only game traffic is sequenced. The handshake is deliberately unsequenced
     and idempotent so a reconnecting player — whose counter restarts while the
     other side's has moved on — is never stuck behind a gap that can't fill.
     It gets its reliability from the join poll instead. `bye` is unsequenced
     because it is pre-encrypted and fired while the page unloads. */
  var RELIABLE = { app: 1 };

  Net.prototype._emit = function (bytes, only) {
    for (var i = 0; i < this.clients.length; i++) {
      if (!this.clients[i].connected) continue;
      if (only && only.indexOf(i) < 0) continue;
      this.clients[i].publish(this.topic, bytes);
    }
  };

  Net.prototype._publish = function (envelope) {
    var self = this;
    if (this._closed || !this.key) return false;
    var reliable = RELIABLE[envelope.k] === 1;
    envelope.from = this.id;
    envelope.id = hex(randomBytes(6));
    if (reliable) envelope.seq = ++this._seq;
    var only = this._targets(envelope.k);
    /* Chained so encryption latency can't reorder the stream. */
    this._sendChain = this._sendChain
      .then(function () { return encryptJSON(self.key, envelope); })
      .then(function (bytes) {
        self._emit(bytes, only);
        if (reliable) {
          self._unacked.push({ seq: envelope.seq, bytes: bytes, at: Date.now(), tries: 0 });
          self._startRetry();
        }
      })
      .catch(function () {});
    return true;
  };

  Net.prototype._startRetry = function () {
    var self = this;
    if (this._retryTimer) return;
    this._retryTimer = setInterval(function () {
      if (self._closed) return;
      if (!self._unacked.length) {
        clearInterval(self._retryTimer);
        self._retryTimer = null;
        return;
      }
      var now = Date.now();
      for (var i = 0; i < self._unacked.length; i++) {
        var u = self._unacked[i];
        if (now - u.at < 1100 || u.tries >= 12) continue;
        u.tries++;
        u.at = now;
        /* Retries go to every relay — if one is dropping traffic, another
           may not be. */
        self._emit(u.bytes, null);
      }
    }, 550);
  };

  Net.prototype._scheduleAck = function (from) {
    var self = this;
    if (this._ackTimer) return;
    this._ackTimer = setTimeout(function () {
      self._ackTimer = null;
      var st = self._rx[from];
      if (!st) return;
      self._publish({ k: "ack", to: from, upto: st.next - 1 });
    }, 220);
  };

  Net.prototype._receive = function (payload, brokerIndex) {
    var self = this;
    this._recvChain = this._recvChain
      .then(function () { return decryptJSON(self.key, payload); })
      .then(function (msg) {
        /* Remember which relays actually reach the partner. */
        if (msg && msg.from && msg.from !== self.id && typeof brokerIndex === "number") {
          self._partnerVia[brokerIndex] = Date.now();
        }
        self._admit(msg);
      })
      /* Undecryptable traffic is someone else's room sharing a relay, or a
         wrong code. Either way it is not ours. */
      .catch(function () {});
  };

  Net.prototype._admit = function (msg) {
    if (this._closed || !msg || typeof msg !== "object") return;
    if (msg.from === this.id) return;                 // our own fan-out
    if (msg.to && msg.to !== this.id) return;         // addressed to the other side
    if (msg.id) {
      if (this._seenSet[msg.id]) return;              // duplicate from another relay
      this._seenSet[msg.id] = 1;
      this._seen.push(msg.id);
      if (this._seen.length > 600) delete this._seenSet[this._seen.shift()];
    }

    this._lastHeard = Date.now();

    if (typeof msg.seq !== "number") { this._dispatch(msg); return; }

    var st = this._rx[msg.from];
    if (!st) st = this._rx[msg.from] = { next: 1, buf: Object.create(null), timer: null };
    /* Always re-ack duplicates: a lost ack is why the sender is repeating. */
    if (msg.seq < st.next) { this._scheduleAck(msg.from); return; }
    st.buf[msg.seq] = msg;
    this._flush(msg.from);
    this._scheduleAck(msg.from);
  };

  /* Relays run at different speeds, so a later message can overtake an earlier
     one. Hold anything that arrives early until the gap fills; if it never
     does, skip forward rather than stalling the game. */
  Net.prototype._flush = function (from) {
    var st = this._rx[from];
    if (!st) return;

    while (st.buf[st.next]) {
      var m = st.buf[st.next];
      delete st.buf[st.next];
      st.next++;
      this._dispatch(m);
    }

    var pending = Object.keys(st.buf);
    if (!pending.length) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      return;
    }

    /* Arm the skip-ahead once, when the gap first appears. Re-arming it on
       every arrival would let a steady stream hold the gap open forever. */
    if (st.timer) return;
    var self = this;
    st.timer = setTimeout(function () {
      st.timer = null;
      var ks = Object.keys(st.buf).map(Number).sort(function (a, b) { return a - b; });
      if (!ks.length) return;
      st.next = ks[0];
      self._flush(from);
    }, 9000);
  };

  Net.prototype._dispatch = function (msg) {
    if (this._closed) return;

    if (msg.k === "join") {
      if (!this.isHost) return;
      if (this.partner && this.partner !== msg.from && this._partnerUp) {
        this._publish({ k: "full", to: msg.from });
        return;
      }
      /* Only restart numbering for a genuinely new session, or duplicate
         joins still in flight would reset a game in progress. */
      if (this.partner !== msg.from || !this._partnerUp) this._resetSession(msg.from);
      this.partner = msg.from;
      this._publish({ k: "welcome", to: msg.from });
      this._markUp();

    } else if (msg.k === "welcome") {
      if (this.isHost) return;
      if (this.partner === msg.from && this._partnerUp) return;   // duplicate
      clearInterval(this._joinPoll);
      clearTimeout(this._joinTimer);
      this._resetSession(msg.from);
      this.partner = msg.from;
      this._markUp();

    } else if (msg.k === "full") {
      if (this.isHost) return;
      clearInterval(this._joinPoll);
      clearTimeout(this._joinTimer);
      if (this.h.onFatal) this.h.onFatal("That room already has two players.");
      this.close();

    } else if (msg.k === "bye") {
      if (msg.from !== this.partner) return;
      this._partnerUp = false;
      if (this.h.onDisconnected) this.h.onDisconnected();

    } else if (msg.k === "app") {
      if (msg.from !== this.partner) return;
      if (!this._partnerUp) this._markUp();
      if (this.h.onData) this.h.onData(msg.d);

    } else if (msg.k === "ping") {
      if (msg.from !== this.partner) return;
      if (!this._partnerUp) this._markUp();

    } else if (msg.k === "ack") {
      var upto = msg.upto | 0;
      this._unacked = this._unacked.filter(function (u) { return u.seq > upto; });
    }
  };

  /* Both sides restart at sequence 1 when a session begins, so a reconnecting
     player and a long-running host agree on where the stream starts. */
  Net.prototype._resetSession = function (peerId) {
    this._seq = 0;
    this._unacked = [];
    if (this._retryTimer) { clearInterval(this._retryTimer); this._retryTimer = null; }
    var old = this._rx[peerId];
    if (old && old.timer) clearTimeout(old.timer);
    this._rx[peerId] = { next: 1, buf: Object.create(null), timer: null };
  };

  Net.prototype._markUp = function () {
    var self = this;
    this._lastHeard = Date.now();
    if (this._partnerUp) return;
    this._partnerUp = true;

    /* Prepare the farewell now, while there is time to encrypt it. Closing a
       tab gives us no chance to await anything. */
    encryptJSON(this.key, { k: "bye", from: this.id, id: hex(randomBytes(6)) })
      .then(function (bytes) { self._byeBytes = bytes; })
      .catch(function () {});

    this._status("Connected", "ok");
    if (this.h.onConnected) this.h.onConnected();
  };

  /* ── Public API ───────────────────────────────────── */
  Net.prototype.send = function (msg) {
    if (!this.partner) return false;
    return this._publish({ k: "app", d: msg });
  };

  Net.prototype.isConnected = function () {
    return !!(this.partner && this._partnerUp);
  };

  Net.prototype.close = function () {
    if (this._closed) return;
    /* Synchronous, so it still goes out during page unload. */
    if (this.partner && this._byeBytes) {
      try { this._emit(this._byeBytes, null); } catch (_) {}
    }
    this._closed = true;
    clearTimeout(this._brokerTimer);
    clearTimeout(this._joinTimer);
    clearInterval(this._joinPoll);
    clearInterval(this._pingTimer);
    clearInterval(this._watchTimer);
    clearInterval(this._retryTimer);
    clearTimeout(this._ackTimer);
    this._pingTimer = null;
    this._retryTimer = null;
    this._unacked = [];
    for (var k in this._rx) {
      if (this._rx[k].timer) clearTimeout(this._rx[k].timer);
    }
    this._rx = Object.create(null);
    var cs = this.clients;
    this.clients = [];
    /* Give the farewell a moment to flush before tearing the sockets down. */
    setTimeout(function () {
      cs.forEach(function (c) { try { c.close(); } catch (_) {} });
    }, 150);
  };

  global.Net = Net;
  global.Net.makeCode = makeCode;
  global.Net.normalize = normalize;
  global.Net.CODE_LEN = CODE_LEN;
  global.Net.BROKERS = BROKERS;
})(window);
