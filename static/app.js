// Sala ao Vivo — cliente.
// Cada participante abre uma RTCPeerConnection com cada outro (malha P2P).
// A negociação usa o padrão "perfect negotiation", então qualquer lado pode
// adicionar ou remover faixas (microfone, tela) a qualquer momento.

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const COLORS = ["#5b8cff", "#8a6bff", "#e26ad0", "#ef8a5b", "#3ccf8e", "#36b8d6", "#d6b536", "#ef5b5b"];

const $ = (sel) => document.querySelector(sel);

const state = {
  ws: null,
  myId: null,
  myName: "",
  roomId: "",
  mic: null,          // MediaStream do microfone
  micOn: false,
  screen: null,       // MediaStream da tela
  peers: new Map(),   // id -> { name, muted, sharing, pc, polite, makingOffer, ignoreOffer, micSender, screenSenders, videoStream }
};

// ---------- Utilidades ----------

function colorFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ---------- Lobby ----------

const params = new URLSearchParams(location.search);
$("#name-input").value = safeGet("sala:nome") || "";
$("#room-input").value = params.get("sala") || "";
if (params.get("sala")) $("#join-btn").textContent = "Entrar na sala";

function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeSet(key, v) { try { localStorage.setItem(key, v); } catch {} }

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#lobby-error").textContent = "";
  const name = $("#name-input").value.trim();
  if (!name) return;
  let roomId = $("#room-input").value.trim().toLowerCase();
  $("#join-btn").disabled = true;
  try {
    if (!roomId) roomId = (await (await fetch("/api/nova-sala")).json()).id;
    safeSet("sala:nome", name);
    await joinRoom(roomId, name);
  } catch (err) {
    $("#lobby-error").textContent = err.message || "Não foi possível entrar na sala.";
  } finally {
    $("#join-btn").disabled = false;
  }
});

// ---------- Entrar / sair ----------

async function joinRoom(roomId, name) {
  state.myName = name;
  state.mic = await getMic();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(roomId)}`);
  state.ws = ws;

  await new Promise((resolve, reject) => {
    ws.onopen = () => { ws.send(JSON.stringify({ type: "join", name })); };
    ws.onerror = () => reject(new Error("Falha ao conectar no servidor."));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "error") { reject(new Error(msg.message)); return; }
      if (msg.type === "welcome") { resolve(); onWelcome(msg); }
      ws.onmessage = (ev2) => onMessage(JSON.parse(ev2.data));
    };
  });

  ws.onclose = () => {
    if (state.ws === ws && !$("#room").hidden) {
      toast("Conexão com a sala perdida.");
      leaveRoom();
    }
  };
}

async function getMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    for (const t of stream.getAudioTracks()) t.enabled = false; // entra mutado
    return stream;
  } catch {
    toast("Microfone indisponível — você entra só ouvindo.");
    return null;
  }
}

function onWelcome(msg) {
  state.myId = msg.id;
  state.roomId = msg.room;
  history.replaceState(null, "", `?sala=${encodeURIComponent(msg.room)}`);

  $("#lobby").hidden = true;
  $("#room").hidden = false;
  $("#room-code").textContent = msg.room;
  $("#messages").replaceChildren();
  $("#mic-btn").disabled = !state.mic;
  setMicUI(false);
  setShareUI(false);

  if (state.mic) watchSpeaking(state.myId, state.mic.getAudioTracks()[0]);
  for (const p of msg.peers) addPeer(p);
  for (const m of msg.history) renderChat(m);
  renderSystem("Você entrou na sala.");
  renderPeers();
  renderTiles();
}

function leaveRoom() {
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  for (const id of [...state.peers.keys()]) removePeer(id);
  stopShare(false);
  state.mic?.getTracks().forEach((t) => t.stop());
  state.mic = null;
  state.micOn = false;
  stopWatching(state.myId);
  $("#room").hidden = true;
  $("#lobby").hidden = false;
  $("#room-input").value = state.roomId;
  $("#join-btn").textContent = "Entrar na sala";
  $("#tiles").replaceChildren();
}

// ---------- Mensagens do servidor ----------

function onMessage(msg) {
  switch (msg.type) {
    case "peer-joined":
      addPeer(msg.peer);
      renderSystem(`${msg.peer.name} entrou.`);
      renderPeers();
      break;
    case "peer-left": {
      const p = state.peers.get(msg.id);
      if (p) renderSystem(`${p.name} saiu.`);
      removePeer(msg.id);
      renderPeers();
      renderTiles();
      break;
    }
    case "state": {
      const p = state.peers.get(msg.peer.id);
      if (!p) return;
      p.muted = msg.peer.muted;
      p.sharing = msg.peer.sharing;
      renderPeers();
      renderTiles();
      break;
    }
    case "chat":
      renderChat(msg);
      break;
    case "signal":
      onSignal(msg.from, msg.data);
      break;
  }
}

// ---------- WebRTC ----------

function addPeer(info) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = {
    ...info,
    pc,
    polite: state.myId > info.id, // lado "educado" cede em colisão de ofertas
    makingOffer: false,
    ignoreOffer: false,
    micSender: null,
    screenSenders: [],
    videoStream: null,
  };
  state.peers.set(info.id, peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: "signal", to: info.id, data: { description: pc.localDescription } });
    } catch (err) {
      console.error("negociação", err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "signal", to: info.id, data: { candidate } });
  };

  pc.ontrack = ({ track, streams }) => {
    if (track.kind === "video") {
      peer.videoStream = streams[0] || new MediaStream([track]);
      renderTiles();
    } else {
      playAudio(info.id, track);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") pc.restartIce();
  };

  const micTrack = state.mic?.getAudioTracks()[0];
  if (micTrack) peer.micSender = pc.addTrack(micTrack, state.mic);
  if (state.screen) {
    peer.screenSenders = state.screen.getTracks().map((t) => pc.addTrack(t, state.screen));
  }
}

async function onSignal(fromId, { description, candidate }) {
  const peer = state.peers.get(fromId);
  if (!peer) return;
  const pc = peer.pc;
  try {
    if (description) {
      const collision = description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === "offer") {
        await pc.setLocalDescription();
        send({ type: "signal", to: fromId, data: { description: pc.localDescription } });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!peer.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error("sinal", err);
  }
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  state.peers.delete(id);
  document.querySelectorAll(`audio[data-peer="${id}"]`).forEach((a) => a.remove());
  stopWatching(id);
}

function playAudio(peerId, track) {
  const el = document.createElement("audio");
  el.autoplay = true;
  el.dataset.peer = peerId;
  el.srcObject = new MediaStream([track]);
  $("#audio-sink").append(el);
  track.addEventListener("ended", () => el.remove());
  watchSpeaking(peerId, track);
}

// ---------- Microfone ----------

$("#mic-btn").addEventListener("click", () => {
  if (!state.mic) return;
  audioCtx?.resume();
  state.micOn = !state.micOn;
  for (const t of state.mic.getAudioTracks()) t.enabled = state.micOn;
  setMicUI(state.micOn);
  send({ type: "state", muted: !state.micOn, sharing: !!state.screen });
  renderPeers();
});

function setMicUI(on) {
  const btn = $("#mic-btn");
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Desativar microfone" : "Ativar microfone";
}

// ---------- Compartilhar tela ----------

$("#share-btn").addEventListener("click", () => (state.screen ? stopShare() : startShare()));

async function startShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("Seu navegador não suporta compartilhar tela.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true, // áudio da aba/sistema, quando o navegador permitir
    });
  } catch {
    return; // usuário cancelou o seletor
  }
  const video = stream.getVideoTracks()[0];
  video.contentHint = "detail"; // prioriza nitidez de texto
  video.addEventListener("ended", () => stopShare()); // botão "parar" do próprio navegador

  state.screen = stream;
  for (const peer of state.peers.values()) {
    peer.screenSenders = stream.getTracks().map((t) => peer.pc.addTrack(t, stream));
  }
  setShareUI(true);
  send({ type: "state", muted: !state.micOn, sharing: true });
  renderPeers();
  renderTiles();
}

function stopShare(notify = true) {
  if (!state.screen) return;
  state.screen.getTracks().forEach((t) => t.stop());
  for (const peer of state.peers.values()) {
    for (const s of peer.screenSenders) {
      try { peer.pc.removeTrack(s); } catch {}
    }
    peer.screenSenders = [];
  }
  state.screen = null;
  setShareUI(false);
  if (notify) send({ type: "state", muted: !state.micOn, sharing: false });
  renderPeers();
  renderTiles();
}

function setShareUI(on) {
  const btn = $("#share-btn");
  btn.setAttribute("aria-pressed", String(on));
  btn.querySelector("span").textContent = on ? "Parar de compartilhar" : "Compartilhar tela";
}

// ---------- Indicador de fala ----------

let audioCtx;
const meters = new Map(); // peerId -> [{ analyser, buf }]

function watchSpeaking(peerId, track) {
  if (!track) return;
  audioCtx ??= new AudioContext();
  const source = audioCtx.createMediaStreamSource(new MediaStream([track]));
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const list = meters.get(peerId) || [];
  list.push({ analyser, source, buf: new Uint8Array(analyser.fftSize) });
  meters.set(peerId, list);
}

function stopWatching(peerId) {
  for (const m of meters.get(peerId) || []) m.source.disconnect();
  meters.delete(peerId);
}

function speakingLoop() {
  for (const [peerId, list] of meters) {
    let level = 0;
    for (const { analyser, buf } of list) {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += (v - 128) ** 2;
      level = Math.max(level, Math.sqrt(sum / buf.length));
    }
    const muted = peerId === state.myId ? !state.micOn : state.peers.get(peerId)?.muted;
    document.querySelector(`.peer[data-id="${peerId}"]`)?.classList.toggle("speaking", !muted && level > 6);
  }
  requestAnimationFrame(speakingLoop);
}
requestAnimationFrame(speakingLoop);

// ---------- Renderização ----------

const ICON_MIC_OFF = '<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3 M3 3l18 18"/></svg>';
const ICON_SCREEN = '<svg class="live" viewBox="0 0 24 24"><path d="M3 5h18v11H3z M8 20h8 M12 16v4"/></svg>';

function renderPeers() {
  const all = [
    { id: state.myId, name: state.myName, muted: !state.micOn, sharing: !!state.screen, me: true },
    ...state.peers.values(),
  ];
  $("#peer-count").textContent = `— ${all.length}`;
  $("#peer-list").replaceChildren(...all.map((p) => {
    const li = document.createElement("li");
    li.className = "peer";
    li.dataset.id = p.id;

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = colorFor(p.id);
    avatar.textContent = p.name.slice(0, 1).toUpperCase();

    const name = document.createElement("span");
    name.className = "peer-name";
    name.textContent = p.name;
    if (p.me) name.insertAdjacentHTML("beforeend", ' <span class="you">(você)</span>');

    const icons = document.createElement("span");
    icons.className = "peer-icons";
    icons.innerHTML = (p.sharing ? ICON_SCREEN : "") + (p.muted ? ICON_MIC_OFF : "");

    li.append(avatar, name, icons);
    return li;
  }));
}

function renderTiles() {
  const tiles = [];
  if (state.screen) tiles.push({ key: "me", name: "Você", stream: state.screen, local: true });
  for (const [id, p] of state.peers) {
    if (p.sharing && p.videoStream) tiles.push({ key: id, name: p.name, stream: p.videoStream });
  }

  const container = $("#tiles");
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  const keep = new Set(tiles.map((t) => t.key));
  for (const [key, el] of existing) if (!keep.has(key)) el.remove();

  for (const t of tiles) {
    let el = existing.get(t.key);
    if (!el) {
      el = document.createElement("div");
      el.className = "tile";
      el.dataset.key = t.key;
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true; // o áudio remoto toca pelos <audio>
      const label = document.createElement("span");
      label.className = "tile-label";
      const full = document.createElement("button");
      full.className = "tile-full";
      full.title = "Tela cheia";
      full.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"/></svg>';
      full.addEventListener("click", () => el.requestFullscreen?.());
      el.append(video, label, full);
      container.append(el);
    }
    const video = el.querySelector("video");
    if (video.srcObject !== t.stream) video.srcObject = t.stream;
    el.querySelector(".tile-label").textContent = t.local ? "Você está compartilhando" : t.name;
  }

  $("#stage-empty").hidden = tiles.length > 0;
}

function renderChat(m) {
  const li = document.createElement("li");
  const head = document.createElement("div");
  head.className = "msg-head";
  const name = document.createElement("span");
  name.className = "msg-name";
  name.style.color = colorFor(m.from);
  name.textContent = m.name;
  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(m.ts);
  head.append(name, time);
  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = m.text;
  li.append(head, text);
  appendMessage(li);
}

function renderSystem(text) {
  const li = document.createElement("li");
  li.className = "msg-system";
  li.textContent = text;
  appendMessage(li);
}

function appendMessage(li) {
  const list = $("#messages");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(li);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ---------- Chat e demais controles ----------

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  input.value = "";
});

$("#link-btn").addEventListener("click", async () => {
  const url = `${location.origin}/?sala=${encodeURIComponent(state.roomId)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copiado!");
  } catch {
    toast(url);
  }
});

$("#leave-btn").addEventListener("click", leaveRoom);
$("#chat-toggle").addEventListener("click", () => $("#chat").classList.add("open"));
$("#chat-close").addEventListener("click", () => $("#chat").classList.remove("open"));
