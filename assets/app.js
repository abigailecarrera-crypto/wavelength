/* Wiring: screens, host-authoritative game state, and the peer messages
   that keep the two players in step.

   Player indices: the host is 0, the joiner is 1.
   The host owns the real game state. The joiner sends intents and renders
   whatever snapshot the host sends back. Snapshots are redacted per-recipient
   so the target position is never transmitted to the guesser. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  /* ── Element refs ─────────────────────────────────── */
  var els = {
    connBadge: $("connBadge"),
    nameInput: $("nameInput"), roundsInput: $("roundsInput"), profileInput: $("profileInput"),
    hostBtn: $("hostBtn"), joinBtn: $("joinBtn"), codeInput: $("codeInput"), homeError: $("homeError"),
    roomCode: $("roomCode"), roomLink: $("roomLink"), copyCodeBtn: $("copyCodeBtn"),
    copyLinkBtn: $("copyLinkBtn"), lobbyStatus: $("lobbyStatus"), leaveLobbyBtn: $("leaveLobbyBtn"),
    roundLabel: $("roundLabel"), scoreLabel: $("scoreLabel"), roleLabel: $("roleLabel"),
    leftLabel: $("leftLabel"), rightLabel: $("rightLabel"),
    phaseTitle: $("phaseTitle"), phaseHint: $("phaseHint"),
    clueBox: $("clueBox"), peekBtn: $("peekBtn"), clueInput: $("clueInput"), sendClueBtn: $("sendClueBtn"),
    guessBox: $("guessBox"), clueText: $("clueText"), lockBtn: $("lockBtn"),
    watchBox: $("watchBox"), clueEcho: $("clueEcho"),
    revealBox: $("revealBox"), revealPoints: $("revealPoints"), revealDetail: $("revealDetail"),
    nextBtn: $("nextBtn"), netStatus: $("netStatus"),
    finalScore: $("finalScore"), finalOf: $("finalOf"), finalRating: $("finalRating"),
    playAgainBtn: $("playAgainBtn"), quitBtn: $("quitBtn"), overStatus: $("overStatus")
  };

  /* ── Local session ────────────────────────────────── */
  var net = null;
  var dial = null;
  var isHost = false;
  var me = 0;
  var view = null;          // what this client currently renders
  var host = null;          // authoritative state, host only
  var localPeek = false;    // is my screen lifted right now
  var partnerPeeking = false;
  var lastRound = null;
  var pointerSentAt = 0;

  /* ── Screens ──────────────────────────────────────── */
  function show(name) {
    ["home", "lobby", "game", "over"].forEach(function (n) {
      $("screen-" + n).classList.toggle("active", n === name);
    });
  }

  function setBadge(text, kind) {
    els.connBadge.textContent = text;
    els.connBadge.setAttribute("data-kind", kind || "idle");
  }

  function setStatus(node, text, kind) {
    node.textContent = text || "";
    node.className = "status" + (kind ? " " + kind : "");
  }

  function homeError(msg) {
    els.homeError.textContent = msg || "";
    els.homeError.hidden = !msg;
  }

  function cleanText(s, max) {
    return String(s == null ? "" : s)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function myName() {
    return cleanText(els.nameInput.value, 18) || (isHost ? "Player 1" : "Player 2");
  }

  function partnerName() {
    if (!view || !view.names) return "Your partner";
    return view.names[1 - me] || "Your partner";
  }

  /* ── Host: game state ─────────────────────────────── */
  function newGame(rounds, profileId) {
    var deck = window.Rules.shuffle(window.SPECTRUMS);
    host = {
      deck: deck,
      pos: 0,
      names: host ? host.names.slice() : ["", ""],
      s: {
        phase: "clue",
        round: 1,
        rounds: rounds || (host && host.s ? host.s.rounds : 7),
        profileId: profileId || (host && host.s ? host.s.profileId : "official"),
        psychic: 0,
        card: null,
        target: null,
        clue: "",
        guess: null,
        lastPoints: null,
        total: 0
      }
    };
    dealRound();
  }

  function dealRound() {
    if (host.pos >= host.deck.length) {
      host.deck = window.Rules.shuffle(window.SPECTRUMS);
      host.pos = 0;
    }
    host.s.card = host.deck[host.pos++];
    host.s.target = window.Rules.randomTarget();
    host.s.clue = "";
    host.s.guess = null;
    host.s.lastPoints = null;
    host.s.phase = "clue";
  }

  /* Every state change on the host funnels through here. `by` is the player
     index that asked for it, so we can reject moves that aren't theirs. */
  function applyAction(by, action) {
    if (!host) return;
    var s = host.s;

    switch (action.kind) {
      case "name":
        host.names[by] = cleanText(action.name, 18);
        break;

      case "clue":
        if (s.phase !== "clue" || by !== s.psychic) return;
        var text = cleanText(action.text, 80);
        if (!text) return;
        s.clue = text;
        s.phase = "guess";
        break;

      case "guess":
        if (s.phase !== "guess" || by === s.psychic) return;
        var v = Number(action.value);
        if (!isFinite(v)) return;
        v = Math.min(180, Math.max(0, v));
        s.guess = v;
        s.lastPoints = window.Rules.score(v, s.target, s.profileId);
        s.total += s.lastPoints;
        s.phase = "reveal";
        break;

      case "next":
        if (s.phase !== "reveal") return;
        if (s.round >= s.rounds) {
          s.phase = "over";
        } else {
          s.round += 1;
          s.psychic = 1 - s.psychic;
          dealRound();
        }
        break;

      case "restart":
        if (s.phase !== "over") return;
        newGame(s.rounds, s.profileId);
        break;

      default:
        return;
    }
    broadcast();
  }

  /* The guesser must never receive the target, so it is stripped from their
     snapshot until the round is revealed. */
  function viewFor(player) {
    var s = host.s;
    var open = s.phase === "reveal" || s.phase === "over";
    return {
      phase: s.phase, round: s.round, rounds: s.rounds, profileId: s.profileId,
      psychic: s.psychic, card: s.card, clue: s.clue, guess: s.guess,
      lastPoints: s.lastPoints, total: s.total,
      names: [host.names[0] || "Player 1", host.names[1] || "Player 2"],
      target: (open || player === s.psychic) ? s.target : null
    };
  }

  function broadcast() {
    if (!host) return;
    view = viewFor(0);
    if (net) net.send({ t: "state", state: viewFor(1) });
    render();
  }

  /* ── Sending actions (works from either side) ─────── */
  function act(action) {
    if (isHost) applyAction(0, action);
    else if (net) net.send({ t: "intent", action: action });
  }

  /* ── Rendering ────────────────────────────────────── */
  function render() {
    var s = view;
    if (!s) return;

    if (s.phase === "over") {
      var best = s.rounds * window.Rules.maxPoints(s.profileId);
      els.finalScore.textContent = s.total;
      els.finalOf.textContent = "out of a possible " + best + " across " + s.rounds + " rounds";
      els.finalRating.textContent = window.Rules.rating(s.total, s.rounds, s.profileId);
      show("over");
      return;
    }

    show("game");

    /* New round: drop stale peek/needle state. */
    if (s.round !== lastRound) {
      lastRound = s.round;
      localPeek = false;
      partnerPeeking = false;
      dial.setValue(90);
    }
    if (s.phase !== "clue") localPeek = false;

    var amPsychic = me === s.psychic;
    els.roundLabel.textContent = s.round + " / " + s.rounds;
    els.scoreLabel.textContent = s.total;
    els.roleLabel.textContent = amPsychic ? "Psychic" : "Guesser";
    els.leftLabel.textContent = s.card ? s.card[0] : "—";
    els.rightLabel.textContent = s.card ? s.card[1] : "—";

    dial.profileId = s.profileId;
    dial.setTarget(s.target == null ? null : s.target, s.profileId);

    els.clueBox.hidden = true;
    els.guessBox.hidden = true;
    els.watchBox.hidden = true;
    els.revealBox.hidden = true;

    if (s.phase === "clue") {
      dial.setInteractive(false);
      if (amPsychic) {
        dial.setCover(localPeek);
        els.clueBox.hidden = false;
        els.peekBtn.textContent = localPeek ? "Lower the screen" : "Lift the screen";
        els.phaseTitle.textContent = "You're the Psychic";
        els.phaseHint.textContent = localPeek
          ? "Remember where the target sits, then lower the screen to write your clue."
          : "Lift the screen to see the target, then lower it and give a clue that lands on that exact spot.";
        var hasClue = !!cleanText(els.clueInput.value, 80);
        els.sendClueBtn.disabled = localPeek || !hasClue;
      } else {
        dial.setCover(false);
        els.phaseTitle.textContent = partnerName() + " is the Psychic";
        els.phaseHint.textContent = partnerPeeking
          ? "They're looking at the target right now…"
          : "Waiting for their clue…";
      }

    } else if (s.phase === "guess") {
      dial.setCover(false);
      if (amPsychic) {
        dial.setInteractive(false);
        els.watchBox.hidden = false;
        els.clueEcho.textContent = s.clue;
        els.phaseTitle.textContent = "Watching " + partnerName() + " decide…";
        els.phaseHint.textContent = "You can see the dial move. No hints now — the clue has to carry it.";
      } else {
        dial.setInteractive(true);
        els.guessBox.hidden = false;
        els.clueText.textContent = s.clue;
        els.phaseTitle.textContent = "Where does it land?";
        els.phaseHint.textContent = "Drag the dial (or use the arrow keys), then lock it in.";
      }

    } else if (s.phase === "reveal") {
      dial.setInteractive(false);
      if (s.guess != null) dial.setValue(s.guess);
      dial.setCover(true);
      els.revealBox.hidden = false;
      els.phaseTitle.textContent = "The screen is open";
      els.phaseHint.textContent = amPsychic
        ? partnerName() + " locked in their guess."
        : "Here's where the target was hiding.";
      var pts = s.lastPoints || 0;
      els.revealPoints.textContent = pts > 0
        ? "+" + pts + (pts === window.Rules.maxPoints(s.profileId) ? " — bullseye!" : " points")
        : "No points this round";
      var off = (s.target != null && s.guess != null)
        ? Math.round(Math.abs(s.guess - s.target)) : null;
      els.revealDetail.textContent = (pts > 0 || off === null)
        ? "Running total: " + s.total + "."
        : "Off by " + off + "° of the dial. Running total: " + s.total + ".";
      els.nextBtn.textContent = s.round >= s.rounds ? "See final score" : "Next round";
    }
  }

  /* ── Peer message handling ────────────────────────── */
  function onData(msg) {
    if (msg.t === "state" && !isHost) {
      view = msg.state;
      render();

    } else if (msg.t === "intent" && isHost) {
      applyAction(1, msg.action || {});

    } else if (msg.t === "pointer") {
      /* Live needle from the guesser, mirrored on the psychic's dial. */
      if (view && me === view.psychic && view.phase === "guess") {
        dial.setValue(Number(msg.v) || 0);
      }

    } else if (msg.t === "peek") {
      partnerPeeking = !!msg.open;
      render();

    } else if (msg.t === "hello") {
      if (isHost) applyAction(1, { kind: "name", name: msg.name });
    }
  }

  function netHandlers(onReady) {
    return {
      onStatus: function (text, kind) {
        setBadge(kind === "ok" ? "Connected" : (kind === "warn" ? "Trouble" : "Connecting"), kind);
        setStatus(els.lobbyStatus, text, kind);
        if (kind === "warn") setStatus(els.netStatus, text, "warn");
        else setStatus(els.netStatus, "", "");
      },
      onReady: onReady,
      onConnected: function () {
        setBadge("Connected", "ok");
        setStatus(els.netStatus, "", "");
        if (isHost) {
          host.names[0] = myName();
          broadcast();
        } else {
          net.send({ t: "hello", name: myName() });
        }
      },
      onData: onData,
      onDisconnected: function () {
        setBadge("Partner left", "warn");
        setStatus(els.netStatus,
          partnerName() + " disconnected. They can rejoin with the same code.", "warn");
        setStatus(els.overStatus,
          partnerName() + " disconnected. They can rejoin with the same code.", "warn");
      },
      onFatal: function (text) {
        setBadge("Offline", "idle");
        show("home");
        homeError(text);
        if (net) { net.close(); net = null; }
      }
    };
  }

  function inviteLink(code) {
    return location.origin + location.pathname + "?room=" + code;
  }

  /* ── Actions from the UI ──────────────────────────── */
  function startHosting() {
    homeError("");
    isHost = true;
    me = 0;
    newGame(parseInt(els.roundsInput.value, 10), els.profileInput.value);
    host.names[0] = myName();

    net = new window.Net(netHandlers(function (code) {
      els.roomCode.textContent = code;
      els.roomLink.value = inviteLink(code);
      try {
        history.replaceState(null, "", "?room=" + code);
      } catch (_) {}
    }));
    net.host();
    show("lobby");
  }

  function startJoining() {
    var code = window.Net.normalize(els.codeInput.value);
    if (code.length !== window.Net.CODE_LEN) {
      homeError("Room codes are " + window.Net.CODE_LEN + " characters, letters and numbers.");
      return;
    }
    homeError("");
    isHost = false;
    me = 1;
    net = new window.Net(netHandlers(null));
    net.join(code);
    show("lobby");
    els.roomCode.textContent = code;
    els.roomLink.value = inviteLink(code);
    setStatus(els.lobbyStatus, "Connecting…", "pending");
  }

  function copyToClipboard(text, btn, label) {
    function done() {
      var old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = old; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        setStatus(els.lobbyStatus, "Couldn't copy — select the " + label + " manually.", "warn");
      });
    } else {
      els.roomLink.select();
      try { document.execCommand("copy"); done(); } catch (_) {}
    }
  }

  function leave() {
    if (net) { net.close(); net = null; }
    host = null;
    view = null;
    lastRound = null;
    isHost = false;
    setBadge("Offline", "idle");
    try { history.replaceState(null, "", location.pathname); } catch (_) {}
    show("home");
  }

  /* ── Boot ─────────────────────────────────────────── */
  function init() {
    if (!window.Peer) {
      homeError("Couldn't load the networking library. Try a hard refresh.");
      return;
    }

    dial = new window.Dial($("dial"));
    dial.setCover(false, true);

    dial.onInput = function (v) {
      /* Stream the needle to the psychic, throttled. */
      var now = Date.now();
      if (now - pointerSentAt < 45) return;
      pointerSentAt = now;
      if (net) net.send({ t: "pointer", v: v });
    };

    /* The throttle can swallow the last move of a drag, which would leave the
       psychic looking at a stale needle. Always send the final resting spot. */
    dial.onCommit = function (v) {
      pointerSentAt = Date.now();
      if (net) net.send({ t: "pointer", v: v });
    };

    els.hostBtn.addEventListener("click", startHosting);
    els.joinBtn.addEventListener("click", startJoining);
    els.codeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") startJoining();
    });

    els.copyCodeBtn.addEventListener("click", function () {
      copyToClipboard(els.roomCode.textContent, els.copyCodeBtn, "code");
    });
    els.copyLinkBtn.addEventListener("click", function () {
      copyToClipboard(els.roomLink.value, els.copyLinkBtn, "link");
    });
    els.leaveLobbyBtn.addEventListener("click", leave);
    els.quitBtn.addEventListener("click", leave);

    els.peekBtn.addEventListener("click", function () {
      localPeek = !localPeek;
      if (net) net.send({ t: "peek", open: localPeek });
      render();
    });

    els.clueInput.addEventListener("input", render);
    els.clueInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !els.sendClueBtn.disabled) submitClue();
    });
    els.sendClueBtn.addEventListener("click", submitClue);

    function submitClue() {
      var text = cleanText(els.clueInput.value, 80);
      if (!text || localPeek) return;
      els.clueInput.value = "";
      act({ kind: "clue", text: text });
    }

    els.lockBtn.addEventListener("click", function () {
      act({ kind: "guess", value: dial.value });
    });
    els.nextBtn.addEventListener("click", function () {
      act({ kind: "next" });
    });
    els.playAgainBtn.addEventListener("click", function () {
      act({ kind: "restart" });
    });

    /* Deep link: ?room=CODE prefills the join field. */
    var m = /[?&]room=([A-Za-z0-9]+)/.exec(location.search);
    if (m) {
      els.codeInput.value = window.Net.normalize(m[1]);
      els.nameInput.focus();
      els.joinBtn.classList.add("primary");
    }

    window.addEventListener("beforeunload", function () {
      if (net) net.close();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
