import { Room, RoomEvent } from "/node_modules/livekit-client/dist/livekit-client.esm.mjs";

const participantsEl = document.querySelector("#participants");
const providerEl = document.querySelector("#provider");
const transcriptEl = document.querySelector("#transcript");
const formEl = document.querySelector("#agent-form");
const messageEl = document.querySelector("#caller-message");
const speakToggleEl = document.querySelector("#speak-toggle");
let speakReplies = true;

const clients = {
  caller: {
    identity: "caller-demo",
    name: "Caller Demo",
    room: null,
    muted: false,
    root: document.querySelector('[data-client="caller"]'),
  },
  agent: {
    identity: "aurora-agent",
    name: "Aurora Agent",
    room: null,
    muted: false,
    root: document.querySelector('[data-client="agent"]'),
  },
};

function control(client, role) {
  return client.root.querySelector(`[data-role="${role}"]`);
}

function setStatus(client, message) {
  control(client, "status").textContent = message;
}

function setControls(client, connected) {
  control(client, "join").disabled = connected;
  control(client, "mute").disabled = !connected;
  control(client, "leave").disabled = !connected;
  client.root.classList.toggle("connected", connected);
}

function participantName(participant) {
  return participant.name || participant.identity;
}

function renderParticipants() {
  const rows = [];
  for (const client of Object.values(clients)) {
    if (!client.room) continue;
    rows.push({
      name: participantName(client.room.localParticipant),
      side: client.name,
      type: "local",
    });
    for (const participant of client.room.remoteParticipants.values()) {
      rows.push({
        name: participantName(participant),
        side: client.name,
        type: "remote",
      });
    }
  }

  participantsEl.innerHTML = "";
  if (rows.length === 0) {
    participantsEl.innerHTML = '<div class="empty">Join one or both panes to see participants.</div>';
    return;
  }

  for (const row of rows) {
    const element = document.createElement("div");
    element.className = "participant";
    element.innerHTML = `
      <strong>${row.name}</strong>
      <span>${row.type} in ${row.side}</span>
    `;
    participantsEl.appendChild(element);
  }
}

function addTranscript(role, text, meta = "") {
  const empty = transcriptEl.querySelector(".empty");
  if (empty) empty.remove();

  const item = document.createElement("div");
  item.className = `bubble ${role}`;
  const label = document.createElement("div");
  label.className = "bubble-label";
  label.textContent = `${role === "caller" ? "Caller Demo" : "Aurora Agent"}${meta ? ` · ${meta}` : ""}`;
  const body = document.createElement("div");
  body.textContent = text;
  item.append(label, body);
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function speak(text) {
  if (!speakReplies || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.96;
  utterance.pitch = 1.02;
  window.speechSynthesis.speak(utterance);
}

async function loadState() {
  try {
    const response = await fetch("/state");
    const state = await response.json();
    providerEl.textContent = `Provider: ${state.agentProvider}`;
  } catch {
    providerEl.textContent = "Provider: unavailable";
  }
}

function attachRoomEvents(client) {
  client.room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== "audio") return;
    const element = track.attach();
    element.autoplay = true;
    control(client, "audio").appendChild(element);
  });
  client.room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach());
  client.room.on(RoomEvent.ParticipantConnected, renderParticipants);
  client.room.on(RoomEvent.ParticipantDisconnected, renderParticipants);
  client.room.on(RoomEvent.Disconnected, () => {
    setControls(client, false);
    setStatus(client, "Disconnected");
    renderParticipants();
  });
}

async function join(client) {
  setStatus(client, "Creating token...");
  const params = new URLSearchParams({ identity: client.identity, name: client.name });
  const response = await fetch(`/token?${params.toString()}`);
  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
  const session = await response.json();

  client.room = new Room({ adaptiveStream: true, dynacast: true });
  attachRoomEvents(client);

  setStatus(client, "Joining room...");
  await client.room.connect(session.url, session.token);
  await client.room.localParticipant.setMicrophoneEnabled(true);

  client.muted = false;
  control(client, "mute").textContent = "Mute";
  setControls(client, true);
  setStatus(client, "Connected");
  renderParticipants();
}

async function leave(client) {
  if (client.room) {
    client.room.disconnect();
    client.room = null;
  }
  control(client, "audio").innerHTML = "";
  setControls(client, false);
  setStatus(client, "Disconnected");
  renderParticipants();
}

async function toggleMute(client) {
  if (!client.room) return;
  client.muted = !client.muted;
  await client.room.localParticipant.setMicrophoneEnabled(!client.muted);
  control(client, "mute").textContent = client.muted ? "Unmute" : "Mute";
  setStatus(client, client.muted ? "Muted" : "Connected");
}

for (const client of Object.values(clients)) {
  control(client, "join").addEventListener("click", () => {
    join(client).catch((error) => setStatus(client, error.message));
  });
  control(client, "leave").addEventListener("click", () => {
    leave(client).catch((error) => setStatus(client, error.message));
  });
  control(client, "mute").addEventListener("click", () => {
    toggleMute(client).catch((error) => setStatus(client, error.message));
  });
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageEl.value.trim();
  if (!text) return;

  messageEl.value = "";
  addTranscript("caller", text);
  const pending = document.createElement("div");
  pending.className = "bubble agent pending";
  pending.textContent = "Aurora Agent is thinking...";
  transcriptEl.appendChild(pending);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  try {
    const response = await fetch("/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json();
    pending.remove();
    if (!response.ok) {
      throw new Error(payload.error || `Agent request failed: ${response.status}`);
    }
    providerEl.textContent = `Provider: ${payload.provider} · ${payload.model}`;
    addTranscript("agent", payload.reply, payload.action ? `action: ${payload.action}` : "");
    speak(payload.reply);
  } catch (error) {
    pending.remove();
    addTranscript("agent", error.message);
  }
});

speakToggleEl.addEventListener("click", () => {
  speakReplies = !speakReplies;
  speakToggleEl.textContent = speakReplies ? "Speak replies on" : "Speak replies off";
  if (!speakReplies && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
});

loadState();
