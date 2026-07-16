import { Room, RoomEvent, Track } from "/node_modules/livekit-client/dist/livekit-client.esm.mjs";

const callerRoot = document.querySelector('[data-client="caller"]');
const agentRoot = document.querySelector('[data-client="agent"]');
const callerStatus = callerRoot.querySelector('[data-role="status"]');
const agentStatus = agentRoot.querySelector('[data-role="status"]');
const startButton = document.querySelector("#start-call");
const muteButton = document.querySelector("#mute-call");
const endButton = document.querySelector("#end-call");
const participantsEl = document.querySelector("#participants");
const providerEl = document.querySelector("#provider");
const languageEl = document.querySelector("#language");
const transcriptEl = document.querySelector("#transcript");
const sourcesEl = document.querySelector("#sources");
const voiceStatusEl = document.querySelector("#voice-status");
const listeningStateEl = document.querySelector("#listening-state");
const eventsEl = document.querySelector("#events");
const pipelineEl = document.querySelector("#pipeline");
const endpointControl = document.querySelector("#endpoint-control");
const endpointValue = document.querySelector("#endpoint-value");
const sensitivityControl = document.querySelector("#sensitivity-control");
const sensitivityValue = document.querySelector("#sensitivity-value");
const vadReadout = document.querySelector("#vad-readout");

const metrics = {
  stt: document.querySelector("#metric-stt"),
  llm: document.querySelector("#metric-llm"),
  tools: document.querySelector("#metric-tools"),
  total: document.querySelector("#metric-total"),
  firstAudio: document.querySelector("#metric-first-audio"),
  barge: document.querySelector("#metric-barge"),
};

const sessionId = `browser-${crypto.randomUUID()}`;
let turnCounter = 0;
let callerRoom = null;
let agentRoom = null;
let listenStream = null;
let audioContext = null;
let analyser = null;
let vadFrame = null;
let recorder = null;
let recordedChunks = [];
let recordingStartedAt = 0;
let lastSpeechAt = 0;
let speechCandidateAt = 0;
let bargeCandidateAt = 0;
let listenCooldownUntil = 0;
let agentBusy = false;
let agentSpeaking = false;
let muted = false;
let noiseFloor = 0.008;
let smoothedLevel = 0;
let discardRecording = false;
let currentTrace = null;
let lastEndpointAt = 0;
let playbackStartedAt = 0;
let playbackEchoFloor = 0.012;
let pendingBargeInTurn = false;
let currentTurnWasBargeIn = false;

const tuning = {
  endpointSilenceMs: 650,
  sensitivity: 3.2,
  minTurnMs: 500,
  speechConfirmationMs: 110,
  bargeInConfirmationMs: 360,
  bargeInArmMs: 900,
  maxTurnMs: 20000,
};

function setCallControls(connected) {
  startButton.disabled = connected;
  muteButton.disabled = !connected;
  endButton.disabled = !connected;
  callerRoot.classList.toggle("connected", connected);
  agentRoot.classList.toggle("connected", connected);
}

function setListeningState(state, detail) {
  listeningStateEl.textContent = state;
  voiceStatusEl.textContent = detail;
}

function addTranscript(role, text, meta = "") {
  transcriptEl.querySelector(".empty")?.remove();
  const item = document.createElement("div");
  item.className = `bubble ${role}`;
  const label = document.createElement("div");
  label.className = "bubble-label";
  label.textContent = `${role === "caller" ? "Caller Demo" : "Aurora Agent"}${meta ? ` | ${meta}` : ""}`;
  const body = document.createElement("div");
  body.textContent = text;
  item.append(label, body);
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return item;
}

function addInterruption() {
  transcriptEl.querySelector(".empty")?.remove();
  const item = document.createElement("div");
  item.className = "bubble interruption";
  item.textContent = "Caller interrupted agent playback";
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function formatMs(value) {
  return `${Math.round(value || 0)} ms`;
}

function eventDetail(event) {
  const attributes = event.attributes || {};
  if (attributes.tool) return `${event.name} | ${attributes.tool}`;
  if (attributes.language) return `${event.name} | ${attributes.language}`;
  if (attributes.durationMs !== undefined) return `${event.name} | ${formatMs(attributes.durationMs)}`;
  return event.name;
}

function renderTrace(trace) {
  currentTrace = trace;
  const timings = trace.timings || {};
  metrics.stt.textContent = formatMs(timings.stt);
  metrics.llm.textContent = formatMs(timings.llm);
  metrics.tools.textContent = formatMs(timings.tools);
  metrics.total.textContent = formatMs(trace.totalMs);

  for (const element of pipelineEl.querySelectorAll("[data-stage]")) {
    const stage = element.dataset.stage;
    const completed = stage === "vad" || timings[stage] !== undefined;
    element.classList.toggle("complete", completed);
  }

  eventsEl.innerHTML = "";
  for (const event of (trace.events || []).slice(-14)) {
    const row = document.createElement("div");
    row.className = "event-row";
    const time = document.createElement("time");
    time.textContent = `+${Math.round(event.offsetMs)}ms`;
    const detail = document.createElement("span");
    detail.textContent = eventDetail(event);
    row.append(time, detail);
    eventsEl.appendChild(row);
  }
}

function appendRuntimeEvent(name) {
  eventsEl.querySelector(".empty")?.remove();
  const row = document.createElement("div");
  row.className = "event-row";
  const time = document.createElement("time");
  time.textContent = "client";
  const detail = document.createElement("span");
  detail.textContent = name;
  row.append(time, detail);
  eventsEl.appendChild(row);
  eventsEl.scrollTop = eventsEl.scrollHeight;
}

function renderSources(sources) {
  sourcesEl.textContent = sources?.length
    ? sources.join(" | ")
    : "No retrieval used in the latest turn.";
}

function chooseVoice(locale) {
  if (!("speechSynthesis" in window)) return null;
  const language = locale.toLowerCase().split("-")[0];
  return window.speechSynthesis.getVoices().find(
    (voice) => voice.lang.toLowerCase().startsWith(language),
  ) || null;
}

function finishAgentPlayback() {
  agentSpeaking = false;
  agentRoot.classList.remove("speaking");
  listenCooldownUntil = Date.now() + 500;
  if (listenStream) {
    setListeningState("Listening", "Speak naturally. Aurora can be interrupted while talking.");
  }
}

function speak(text, locale = "en-US") {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = locale;
  utterance.rate = 0.98;
  utterance.pitch = 1.0;
  const voice = chooseVoice(locale);
  if (voice) utterance.voice = voice;

  utterance.onstart = () => {
    agentSpeaking = true;
    agentRoot.classList.add("speaking");
    playbackStartedAt = Date.now();
    playbackEchoFloor = Math.max(noiseFloor, 0.012);
    listenCooldownUntil = playbackStartedAt + tuning.bargeInArmMs;
    pipelineEl.querySelector('[data-stage="tts"]')?.classList.add("complete");
    appendRuntimeEvent("tts.playback_started");
    if (lastEndpointAt) {
      const firstAudioMs = Date.now() - lastEndpointAt;
      metrics.firstAudio.textContent = formatMs(firstAudioMs);
      appendRuntimeEvent(`turn.first_audio | ${formatMs(firstAudioMs)}`);
      lastEndpointAt = 0;
    }
    setListeningState("Agent speaking", "Interrupt naturally by speaking over Aurora.");
  };
  utterance.onend = finishAgentPlayback;
  utterance.onerror = finishAgentPlayback;
  window.speechSynthesis.speak(utterance);
}

function interruptAgent(detectedAt) {
  if (!agentSpeaking) return;
  window.speechSynthesis.cancel();
  agentSpeaking = false;
  agentRoot.classList.remove("speaking");
  listenCooldownUntil = Date.now() + 80;
  pendingBargeInTurn = true;
  addInterruption();
  appendRuntimeEvent("barge_in.detected");
  metrics.barge.textContent = formatMs(Date.now() - detectedAt);
  setListeningState("Interrupted", "Aurora stopped. Listening to the caller.");
}

function audioLevel() {
  if (!analyser) return 0;
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function thresholds() {
  const start = Math.min(0.09, Math.max(0.012, noiseFloor * tuning.sensitivity));
  return {
    start,
    end: Math.max(0.008, start * 0.58),
    barge: Math.min(0.18, Math.max(0.05, start * 2.1, playbackEchoFloor * 2.4)),
  };
}

function startTurnRecording() {
  if (!listenStream || recorder || agentBusy || muted) return;
  recordedChunks = [];
  discardRecording = false;
  recorder = new MediaRecorder(listenStream);
  currentTurnWasBargeIn = pendingBargeInTurn;
  pendingBargeInTurn = false;
  recordingStartedAt = Date.now();
  lastSpeechAt = recordingStartedAt;
  callerRoot.classList.add("speaking");
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  };
  recorder.onstop = () => {
    const shouldDiscard = discardRecording;
    const mimeType = recorder.mimeType || "audio/webm";
    const audioBlob = new Blob(recordedChunks, { type: mimeType });
    recorder = null;
    recordedChunks = [];
    callerRoot.classList.remove("speaking");
    if (shouldDiscard || audioBlob.size < 800) {
      setListeningState("Listening", "Speak naturally. Aurora can be interrupted while talking.");
      return;
    }
    sendAudioToAgent(audioBlob);
  };
  recorder.start(100);
  setListeningState("Caller speaking", "Listening for the end of the turn.");
}

function stopTurnRecording(discard = false) {
  if (!recorder || recorder.state === "inactive") return;
  discardRecording = discard;
  recorder.stop();
}

async function sendAudioToAgent(audioBlob) {
  agentBusy = true;
  setListeningState("Processing", "Transcribing and running the hotel agent.");
  const voicePlaceholder = addTranscript("caller", "Voice turn", "transcribing");
  const pending = addTranscript("agent", "Processing turn", "STT -> Router -> RAG -> LLM -> Tools");
  const turnId = `turn-${++turnCounter}`;
  const wasBargeIn = currentTurnWasBargeIn;
  currentTurnWasBargeIn = false;

  try {
    const response = await fetch("/voice-agent", {
      method: "POST",
      headers: {
        "Content-Type": audioBlob.type || "audio/webm",
        "X-Session-ID": sessionId,
        "X-Turn-ID": turnId,
        "X-Barge-In": String(wasBargeIn),
      },
      body: audioBlob,
    });
    const payload = await response.json();
    pending.remove();
    if (!response.ok) throw new Error(payload.error || `Voice request failed: ${response.status}`);

    if (payload.ignored) {
      voicePlaceholder.remove();
      appendRuntimeEvent(`audio.suppressed | ${payload.ignoreReason}`);
      renderTrace(payload.trace);
      renderSources([]);
      agentBusy = false;
      setListeningState("Listening", "Playback echo was suppressed. Continue speaking naturally.");
      return;
    }

    voicePlaceholder.remove();
    addTranscript("caller", payload.transcript, `STT: ${payload.sttModel}`);
    const meta = [payload.language?.toUpperCase(), payload.action ? `action: ${payload.action}` : ""]
      .filter(Boolean)
      .join(" | ");
    addTranscript("agent", payload.reply, meta);
    providerEl.textContent = `Provider: ${payload.provider} | ${payload.model}`;
    languageEl.textContent = payload.language === "es" ? "Spanish" : "English";
    renderSources(payload.sources);
    renderTrace(payload.trace);
    agentBusy = false;
    speak(payload.reply, payload.locale || "en-US");
    if (payload.action === "transfer") agentStatus.textContent = "Transferring";
    if (payload.action === "hangup") agentStatus.textContent = "Call complete";
  } catch (error) {
    pending.remove();
    voicePlaceholder.remove();
    addTranscript("agent", error.message, "error");
    agentBusy = false;
    setListeningState("Error", "The turn failed. Speak again to retry.");
  }
}

function vadLoop() {
  if (!listenStream) return;
  const now = Date.now();
  const rawLevel = audioLevel();
  smoothedLevel = (smoothedLevel * 0.72) + (rawLevel * 0.28);
  const limit = thresholds();

  if (!recorder && !agentSpeaking && !agentBusy && smoothedLevel < limit.start) {
    noiseFloor = (noiseFloor * 0.985) + (rawLevel * 0.015);
  }
  vadReadout.textContent = agentSpeaking
    ? `echo ${playbackEchoFloor.toFixed(3)} | barge ${limit.barge.toFixed(3)}`
    : `noise ${noiseFloor.toFixed(3)} | trigger ${limit.start.toFixed(3)}`;

  if (agentSpeaking && !muted) {
    const playbackAge = now - playbackStartedAt;
    if (playbackAge < tuning.bargeInArmMs) {
      playbackEchoFloor = (playbackEchoFloor * 0.88) + (smoothedLevel * 0.12);
      bargeCandidateAt = 0;
    } else if (smoothedLevel > limit.barge) {
      bargeCandidateAt = bargeCandidateAt || now;
      if (now - bargeCandidateAt >= tuning.bargeInConfirmationMs) {
        interruptAgent(bargeCandidateAt);
        startTurnRecording();
        lastSpeechAt = now;
        bargeCandidateAt = 0;
      }
    } else {
      bargeCandidateAt = 0;
      playbackEchoFloor = (playbackEchoFloor * 0.995) + (smoothedLevel * 0.005);
    }
  } else if (!agentBusy && !muted && now > listenCooldownUntil) {
    if (!recorder) {
      if (smoothedLevel > limit.start) {
        speechCandidateAt = speechCandidateAt || now;
        if (now - speechCandidateAt >= tuning.speechConfirmationMs) {
          startTurnRecording();
          speechCandidateAt = 0;
        }
      } else {
        speechCandidateAt = 0;
      }
    } else {
      if (smoothedLevel > limit.end) lastSpeechAt = now;
      const duration = now - recordingStartedAt;
      const endpointReached = duration >= tuning.minTurnMs
        && now - lastSpeechAt >= tuning.endpointSilenceMs;
      if (endpointReached || duration >= tuning.maxTurnMs) {
        lastEndpointAt = Date.now();
        appendRuntimeEvent(endpointReached ? "vad.endpoint_detected" : "vad.max_turn_reached");
        stopTurnRecording();
      }
    }
  }

  vadFrame = requestAnimationFrame(vadLoop);
}

function attachRoomEvents(room) {
  room.on(RoomEvent.ParticipantConnected, renderParticipants);
  room.on(RoomEvent.ParticipantDisconnected, renderParticipants);
  room.on(RoomEvent.TrackPublished, renderParticipants);
  room.on(RoomEvent.TrackUnpublished, renderParticipants);
  room.on(RoomEvent.Disconnected, renderParticipants);
}

async function connectParticipant(identity, name) {
  const params = new URLSearchParams({ identity, name });
  const response = await fetch(`/token?${params}`);
  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
  const session = await response.json();
  const room = new Room({ adaptiveStream: true, dynacast: true });
  attachRoomEvents(room);
  await room.connect(session.url, session.token);
  return room;
}

function renderParticipants() {
  participantsEl.innerHTML = "";
  if (!callerRoom) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Participants join when the call starts.";
    participantsEl.appendChild(empty);
    return;
  }

  const participants = [callerRoom.localParticipant, ...callerRoom.remoteParticipants.values()];
  for (const participant of participants) {
    const row = document.createElement("div");
    row.className = "participant";
    const name = document.createElement("strong");
    name.textContent = participant.name || participant.identity;
    const state = document.createElement("span");
    const audioPublished = [...participant.trackPublications.values()]
      .some((publication) => publication.kind === "audio");
    state.textContent = audioPublished ? "audio published" : "room participant";
    row.append(name, state);
    participantsEl.appendChild(row);
  }
}

async function prepareListener() {
  listenStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(listenStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  setListeningState("Calibrating", "Measuring the room noise floor.");
  vadFrame = requestAnimationFrame(vadLoop);
  await new Promise((resolve) => setTimeout(resolve, 650));
  setListeningState("Listening", "Speak naturally. Aurora can be interrupted while talking.");
}

async function startCall() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("This browser does not support the required audio APIs.");
  }
  setCallControls(true);
  callerStatus.textContent = "Connecting";
  agentStatus.textContent = "Connecting";
  await fetch("/reset", { method: "POST", headers: { "X-Session-ID": sessionId } });
  agentRoom = await connectParticipant("aurora-agent", "Aurora Agent");
  agentStatus.textContent = "Connected";
  await prepareListener();
  callerRoom = await connectParticipant("caller-demo", "Caller Demo");
  await callerRoom.localParticipant.publishTrack(listenStream.getAudioTracks()[0], {
    source: Track.Source.Microphone,
    name: "caller-microphone",
  });
  callerStatus.textContent = "Connected";
  renderParticipants();
  speak("Thanks for calling Aurora Hotel reservations. How can I help?", "en-US");
}

async function endCall() {
  if (vadFrame) cancelAnimationFrame(vadFrame);
  vadFrame = null;
  stopTurnRecording(true);
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  agentSpeaking = false;
  agentBusy = false;
  listenStream?.getTracks().forEach((track) => track.stop());
  listenStream = null;
  if (audioContext) await audioContext.close();
  audioContext = null;
  analyser = null;
  callerRoom?.disconnect();
  agentRoom?.disconnect();
  callerRoom = null;
  agentRoom = null;
  callerRoot.classList.remove("speaking");
  agentRoot.classList.remove("speaking");
  callerStatus.textContent = "Ready";
  agentStatus.textContent = "Waiting";
  setListeningState("Idle", "Start the call, then speak naturally");
  setCallControls(false);
  renderParticipants();
}

async function toggleMute() {
  muted = !muted;
  listenStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  muteButton.textContent = muted ? "Unmute" : "Mute";
  callerStatus.textContent = muted ? "Muted" : "Connected";
  setListeningState(muted ? "Muted" : "Listening", muted
    ? "Microphone input is paused."
    : "Speak naturally. Aurora can be interrupted while talking.");
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

endpointControl.addEventListener("input", () => {
  tuning.endpointSilenceMs = Number(endpointControl.value);
  endpointValue.textContent = `${tuning.endpointSilenceMs} ms`;
});

sensitivityControl.addEventListener("input", () => {
  tuning.sensitivity = Number(sensitivityControl.value);
  sensitivityValue.textContent = `${tuning.sensitivity.toFixed(1)}x`;
});

startButton.addEventListener("click", () => {
  startCall().catch(async (error) => {
    setListeningState("Connection failed", error.message);
    await endCall();
  });
});
muteButton.addEventListener("click", () => toggleMute().catch((error) => {
  setListeningState("Mute failed", error.message);
}));
endButton.addEventListener("click", () => endCall());

setCallControls(false);
loadState();
