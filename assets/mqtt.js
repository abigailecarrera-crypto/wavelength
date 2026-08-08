/* Minimal MQTT 3.1.1 client over WebSocket — QoS 0 only.

   Just enough of the protocol to connect, subscribe to one topic, publish,
   and keep the socket alive. Written by hand so the game has no third-party
   runtime dependency; the wire format is small and fully covered by the
   round-trip tests in test/relay-test.html. */
(function (global) {
  "use strict";

  var CONNECT = 0x10, CONNACK = 0x20, PUBLISH = 0x30, SUBSCRIBE = 0x82,
      SUBACK = 0x90, PINGREQ = 0xC0, PINGRESP = 0xD0, DISCONNECT = 0xE0;

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  /* MQTT strings are length-prefixed with a 16-bit big-endian byte count. */
  function encodeString(str) {
    var b = utf8(str);
    var out = new Uint8Array(2 + b.length);
    out[0] = (b.length >> 8) & 0xff;
    out[1] = b.length & 0xff;
    out.set(b, 2);
    return out;
  }

  /* "Remaining length" is a 1-4 byte varint, 7 bits per byte, MSB = continue. */
  function encodeLength(n) {
    var bytes = [];
    do {
      var d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d = d | 0x80;
      bytes.push(d);
    } while (n > 0);
    return new Uint8Array(bytes);
  }

  /* Returns {value, bytes} or null when more data is needed. */
  function decodeLength(buf, offset) {
    var multiplier = 1, value = 0, i = offset, digit;
    do {
      if (i >= buf.length) return null;
      if (i - offset >= 4) throw new Error("malformed remaining length");
      digit = buf[i++];
      value += (digit & 127) * multiplier;
      multiplier *= 128;
    } while ((digit & 0x80) !== 0);
    return { value: value, bytes: i - offset };
  }

  function concat(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }

  function packet(header, body) {
    return concat([new Uint8Array([header]), encodeLength(body.length), body]);
  }

  /* handlers: onConnect, onMessage(topic, payloadBytes), onClose(reason), onError(msg) */
  function MqttClient(url, handlers) {
    this.url = url;
    this.h = handlers || {};
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.connected = false;
    this.closed = false;
    this.packetId = 1;
    this.keepalive = 30;
    this._pingTimer = null;
  }

  MqttClient.prototype.connect = function (clientId) {
    var self = this;
    var ws;
    try {
      ws = new global.WebSocket(this.url, "mqtt");
    } catch (e) {
      this._fail("websocket: " + e.message);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = function () {
      /* Variable header: protocol name + level 4, clean session, keepalive. */
      var body = concat([
        encodeString("MQTT"),
        new Uint8Array([0x04, 0x02, (self.keepalive >> 8) & 0xff, self.keepalive & 0xff]),
        encodeString(clientId)
      ]);
      self._send(packet(CONNECT, body));
    };

    ws.onmessage = function (ev) {
      var chunk = new Uint8Array(ev.data);
      self.buf = concat([self.buf, chunk]);
      try { self._drain(); } catch (e) { self._fail("parse: " + e.message); }
    };

    ws.onerror = function () {
      if (!self.connected) self._fail("connection failed");
    };

    ws.onclose = function (e) {
      self._stopPing();
      var was = self.connected;
      self.connected = false;
      if (self.closed) return;
      if (self.h.onClose) self.h.onClose(was ? "closed code=" + e.code : "never connected");
    };
  };

  /* Pull whole packets out of the accumulation buffer; WebSocket frames do
     not necessarily line up with MQTT packet boundaries. */
  MqttClient.prototype._drain = function () {
    for (;;) {
      if (this.buf.length < 2) return;
      var len = decodeLength(this.buf, 1);
      if (!len) return;
      var start = 1 + len.bytes;
      var total = start + len.value;
      if (this.buf.length < total) return;

      var type = this.buf[0] & 0xf0;
      var body = this.buf.subarray(start, total);
      this.buf = this.buf.slice(total);
      this._handle(type, body);
    }
  };

  MqttClient.prototype._handle = function (type, body) {
    if (type === CONNACK) {
      var code = body.length > 1 ? body[1] : 1;
      if (code !== 0) { this._fail("broker refused connection (code " + code + ")"); return; }
      this.connected = true;
      this._startPing();
      if (this.h.onConnect) this.h.onConnect();

    } else if (type === PUBLISH) {
      if (body.length < 2) return;
      var tlen = (body[0] << 8) | body[1];
      var topic = new TextDecoder().decode(body.subarray(2, 2 + tlen));
      /* QoS 0 has no packet identifier, so the payload starts right after. */
      var payload = body.slice(2 + tlen);
      if (this.h.onMessage) this.h.onMessage(topic, payload);

    } else if (type === SUBACK || type === PINGRESP) {
      /* Nothing to do; presence of the ack is enough. */
    }
  };

  MqttClient.prototype.subscribe = function (topic) {
    var id = this.packetId++ & 0xffff;
    var body = concat([
      new Uint8Array([(id >> 8) & 0xff, id & 0xff]),
      encodeString(topic),
      new Uint8Array([0x00])
    ]);
    this._send(packet(SUBSCRIBE, body));
  };

  MqttClient.prototype.publish = function (topic, payload) {
    var body = concat([encodeString(topic), payload]);
    this._send(packet(PUBLISH, body));
  };

  MqttClient.prototype._send = function (bytes) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(bytes); } catch (_) {}
    }
  };

  MqttClient.prototype._startPing = function () {
    var self = this;
    this._stopPing();
    this._pingTimer = setInterval(function () {
      self._send(new Uint8Array([PINGREQ, 0x00]));
    }, (this.keepalive - 10) * 1000);
  };

  MqttClient.prototype._stopPing = function () {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  };

  MqttClient.prototype._fail = function (msg) {
    if (this.closed) return;
    if (this.h.onError) this.h.onError(msg);
  };

  MqttClient.prototype.close = function () {
    this.closed = true;
    this._stopPing();
    try { this._send(new Uint8Array([DISCONNECT, 0x00])); } catch (_) {}
    try { if (this.ws) this.ws.close(); } catch (_) {}
    this.ws = null;
  };

  global.MqttClient = MqttClient;
  global.MqttClient._internals = {
    encodeLength: encodeLength, decodeLength: decodeLength, encodeString: encodeString
  };
})(window);
