// Voice input: Web Speech API + host/local capture paths. Listeners run on import.
// Extracted from composer.ts; composer imports this module so registration fires on load.
import { vscode } from "./vscode";
import { input, micBtn } from "./dom";
import { setStatus } from "./status";
import { showToast } from "./menus";
import { resizeInput } from "./inputSizing";

// Voice input using Web Speech API (SpeechRecognition)
let recognition: any = null;
let isRecording = false;
let recordingDotsInterval: any = null;
let recordingTextBase = '';
let recordingInterimText = '';
let recordingDotsText = '';
// Web Speech's constructor exists in Electron's bundled Chromium, but the
// actual recognition service often silently never starts there (no
// onstart/onerror at all — just nothing). Without this, clicking mic in that
// state looks like a dead button. Cleared in onstart/onerror/onend.
let webSpeechStartWatchdog: any = null;
// Which capture path is live right now, so stopVoiceRecording() (used by both
// the mic button and composer.ts's send-while-recording guard) knows which
// underlying stop function to call without re-deriving it from stale flags
// (e.g. `mediaRecorder` stays a truthy stopped instance long after a local
// recording ends, so it can't be used as an "is this the active path" check).
let activeVoicePath: 'webspeech' | 'host' | 'local' | null = null;

// --- Silence auto-segmentation (VAD) for the local/whisper paths ---
//
// whisper.cpp/faster-whisper only transcribe on stop (no incremental partial
// results like Web Speech), so without this the composer stays empty until
// the user manually clicks the mic again. Instead, when the "Continuous"
// preference is on, dictation auto-segments on a pause: stop the current
// segment (transcribes it, appends to the composer), then immediately start
// the next one, so text keeps appearing while the mic stays "recording" the
// whole time from the user's perspective.
let dictationActive = false;      // armed for the whole dictation, not just one segment
let dictationUseHost = false;     // which path to restart between segments
let vadStream: any = null;        // getUserMedia stream used ONLY to monitor level, not to record
let vadAudioCtx: any = null;
let vadAnalyser: any = null;
let vadRafId: any = null;
let vadSilenceStartedAt = 0;      // ms timestamp level first dropped below threshold; 0 = currently not silent
let vadHadSpeech = false;         // seen level above threshold since this segment started
const VAD_SILENCE_RMS = 0.02;     // 0..1 time-domain RMS threshold — tuned for typical mic gain, not a hard science
const VAD_SILENCE_MS = 900;       // sustained silence this long ends the segment

// Audio feedback functions (mimicking VSCode chat sounds)
function playStartSound() {
    const audioCtx = new (window as any).AudioContext();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    
    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.15);
}

function playStopSound() {
    const audioCtx = new (window as any).AudioContext();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.frequency.setValueAtTime(1200, audioCtx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(600, audioCtx.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
    
    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.15);
}

// Update recording dots animation
function updateRecordingDots() {
    const dots = ['', '.', '..', '...', '..', '.'];
    let index = 0;
    
    recordingDotsInterval = setInterval(() => {
        index = (index + 1) % dots.length;
        recordingDotsText = dots[index];
        renderRecordingDraft();
    }, 400);
}

function setInputValue(value: string) {
    if (input.value === value) { return; }
    input.value = value;
    resizeInput();
    setStatus();
}

function resetRecordingDraft(base = input.value) {
    recordingTextBase = base;
    recordingInterimText = '';
    recordingDotsText = '';
}

function renderRecordingDraft() {
    const draft = recordingTextBase + recordingInterimText + recordingDotsText;
    setInputValue(draft);
}

// Voice preferences (default values, updated from host)
let voicePreferences = {
    language: 'pt-BR',
    continuous: true,
    interimResults: true,
    dotsAnimation: true,
    soundFeedback: true,
    // engine: which STT engine the host is configured for ("auto" | "webspeech" | local engines).
    engine: 'auto',
    // localStt: host can transcribe captured audio locally (whisper.cpp/faster-whisper/vosk).
    localStt: true,
    // hostCapture: host records the mic natively (ffmpeg) — preferred over
    // webview getUserMedia, whose permission VS Code keeps dropping.
    hostCapture: false,
};

// Get voice preferences from host or use defaults
function getVoicePreferences() {
    const prefs = (window as any).voicePreferences;
    if (prefs) {
        voicePreferences = {
            language: prefs.language || 'pt-BR',
            continuous: prefs.continuous !== false,
            interimResults: prefs.interimResults !== false,
            dotsAnimation: prefs.dotsAnimation !== false,
            soundFeedback: prefs.soundFeedback !== false,
            engine: prefs.engine || 'auto',
            localStt: prefs.localStt !== false,
            hostCapture: prefs.hostCapture === true,
        };
    }
    return voicePreferences;
}

function applyRecognitionPreferences() {
    if (!recognition) { return; }
    const prefs = getVoicePreferences();
    recognition.lang = prefs.language;
    recognition.continuous = prefs.continuous;
    recognition.interimResults = prefs.interimResults;
}

// Listen for voice preference updates
window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'setVoicePreferences') {
        getVoicePreferences();
        applyRecognitionPreferences();
        updateMicVisibility();
    }
});

// Hybrid voice input.
//
// Two paths share the one mic button:
//  1. Web Speech API — runs on Google's cloud engine, only present in real
//     Chrome/Chromium (code-server in a browser). Preferred when available.
//  2. Local capture — getUserMedia + MediaRecorder grabs audio in the webview
//     and ships it to the extension host, which transcribes offline with the
//     configured engine (whisper.cpp / faster-whisper / vosk). This is the
//     desktop/Electron path where Web Speech is absent.
//
// The host tells us via voicePreferences whether local transcription is
// available (localStt) and which engine is selected (engine).
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const webSpeechSupported = !!SpeechRecognition;

let mediaRecorder: any = null;
let mediaStream: any = null;
let audioChunks: Blob[] = [];

// Whether the mic button should be visible at all, given current prefs.
// The SpeechRecognition constructor exists in Electron's bundled Chromium,
// but the recognition service never actually starts in VS Code desktop
// (confirmed: neither onstart nor onerror ever fires — see the watchdog in
// the click handler below). `hostCapture` is the webview's own "are we on
// desktop, not a real browser" signal (mirrors isWebUi in the host-side
// diagnostic, src/voice/sttDiagnostic.ts) — reused here so the mic button's
// visibility and the diagnostic's "ready" verdict never drift apart again.
function webSpeechWorksHere(prefs: ReturnType<typeof getVoicePreferences>): boolean {
    return webSpeechSupported && !prefs.hostCapture;
}

function updateMicVisibility() {
    if (!micBtn) { return; }
    const prefs = getVoicePreferences();
    const canWebSpeech = webSpeechWorksHere(prefs) && (prefs.engine === 'webspeech' || (prefs.engine === 'auto' && !prefs.localStt));
    const canLocal = prefs.localStt && prefs.engine !== 'webspeech';
    micBtn.style.display = (canWebSpeech || canLocal) ? 'inline-flex' : 'none';
}

// Decide which path a click should use.
//
// Explicit `webspeech` keeps the browser recognizer. In `auto`, prefer the
// host/local STT path when available so the Electron desktop build does not get
// stuck on partial Web Speech support.
function chooseVoicePath(): 'webspeech' | 'local' | 'none' {
    const prefs = getVoicePreferences();
    if (prefs.localStt && prefs.engine !== 'webspeech') { return 'local'; }
    if (webSpeechWorksHere(prefs) && (prefs.engine === 'webspeech' || prefs.engine === 'auto')) { return 'webspeech'; }
    return 'none';
}

if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    applyRecognitionPreferences();

    recognition.onstart = () => {
        if (webSpeechStartWatchdog) { clearTimeout(webSpeechStartWatchdog); webSpeechStartWatchdog = null; }
        const prefs = getVoicePreferences();
        isRecording = true;
        activeVoicePath = 'webspeech';
        micBtn.classList.add('recording');
        setStatus('Listening...');
        if (prefs.soundFeedback) playStartSound();
        resetRecordingDraft();
        if (prefs.dotsAnimation) updateRecordingDots();
    };

    recognition.onend = () => {
        if (webSpeechStartWatchdog) { clearTimeout(webSpeechStartWatchdog); webSpeechStartWatchdog = null; }
        isRecording = false;
        activeVoicePath = null;
        micBtn.classList.remove('recording');
        setStatus('Ready');
        if (recordingDotsInterval) {
            clearInterval(recordingDotsInterval);
            recordingDotsInterval = null;
        }
        recordingDotsText = '';
        renderRecordingDraft();
        dispatchVoiceEnded();
    };

    recognition.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript + ' ';
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }

        if (finalTranscript) {
            // Update base text when we get final results
            recordingTextBase = recordingTextBase + finalTranscript;
            recordingInterimText = '';
            renderRecordingDraft();
            setStatus('Listening...');
        } else if (interimTranscript) {
            // Keep interim text in state so the dots timer does not erase it
            // between recognition events.
            recordingInterimText = interimTranscript;
            renderRecordingDraft();
            setStatus('Listening...');
        }
    };

    recognition.onerror = (event: any) => {
        if (webSpeechStartWatchdog) { clearTimeout(webSpeechStartWatchdog); webSpeechStartWatchdog = null; }
        const prefs = getVoicePreferences();
        isRecording = false;
        activeVoicePath = null;
        micBtn.classList.remove('recording');
        setStatus('Error: ' + event.error);
        if (recordingDotsInterval) {
            clearInterval(recordingDotsInterval);
            recordingDotsInterval = null;
        }
        recordingDotsText = '';
        renderRecordingDraft();
        if (prefs.soundFeedback) playStopSound();
        console.error('Speech recognition error:', event.error);
        dispatchVoiceEnded();
    };
}

// --- Native capture path (host records via ffmpeg; no webview permission) ---

let hostRecording = false;

// `isContinuation`: true when this is VAD auto-restarting the next segment of
// an ongoing dictation (maybeContinueDictation) rather than a fresh user
// click — skips the start beep (a beep on every pause would be obnoxious) but
// still resets the draft base to the current (already-merged) input text.
function startHostCapture(isContinuation = false) {
    const prefs = getVoicePreferences();
    // Silence detection for THIS capture rides on the host's own ffmpeg
    // process (recorder.ts's silencedetect filter) — the webview's
    // getUserMedia-based startVadMonitor() is unreliable here for the same
    // reason host capture exists in the first place, see dictationActive
    // wiring in the click handler below.
    vscode.postMessage({ type: 'voice-start', vad: dictationActive });
    hostRecording = true;
    isRecording = true;
    activeVoicePath = 'host';
    micBtn.classList.add('recording');
    setStatus('Listening...');
    if (prefs.soundFeedback && !isContinuation) playStartSound();
    resetRecordingDraft();
    if (prefs.dotsAnimation) updateRecordingDots();
}

// dictationActive is still true here for a VAD-triggered segment boundary
// (only a real stop — mic click or Send — clears it BEFORE calling this), so
// it doubles as the "is this just a pause, not a real stop" check: skip the
// stop beep and don't drop the mic's "recording" look for a segment boundary.
function stopHostCapture() {
    const prefs = getVoicePreferences();
    if (prefs.soundFeedback && !dictationActive) playStopSound();
    isRecording = false;
    hostRecording = false;
    activeVoicePath = null;
    if (!dictationActive) { micBtn.classList.remove('recording'); }
    if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
    recordingInterimText = '';
    recordingDotsText = '';
    setInputValue(recordingTextBase);   // drop the dots animation text
    setStatus('Transcribing...');
    vscode.postMessage({ type: 'voice-stop' });
}

// --- Local capture path (MediaRecorder → host transcription) ---

async function startLocalCapture(isContinuation = false) {
    const prefs = getVoicePreferences();
    try {
        mediaStream = await (navigator as any).mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        showToast('Microphone unavailable: ' + ((err as Error).message || err), 'error');
        return;
    }
    audioChunks = [];
    try {
        mediaRecorder = new (window as any).MediaRecorder(mediaStream);
    } catch (err) {
        showToast('Recording not supported here: ' + ((err as Error).message || err), 'error');
        stopMediaStream();
        return;
    }
    mediaRecorder.ondataavailable = (e: any) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        stopMediaStream();
        if (!blob.size) { setStatus('Ready'); return; }
        setStatus('Transcribing...');
        const buf = await blob.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) { binary += String.fromCharCode(bytes[i]); }
        const base64 = btoa(binary);
        vscode.postMessage({ type: 'stt-transcribe', data: base64, mime: blob.type });
    };
    mediaRecorder.start();
    isRecording = true;
    activeVoicePath = 'local';
    micBtn.classList.add('recording');
    setStatus('Listening...');
    if (prefs.soundFeedback && !isContinuation) playStartSound();
    resetRecordingDraft();
    if (prefs.dotsAnimation) updateRecordingDots();
}

function stopLocalCapture() {
    const prefs = getVoicePreferences();
    if (prefs.soundFeedback && !dictationActive) playStopSound();
    isRecording = false;
    activeVoicePath = null;
    if (!dictationActive) { micBtn.classList.remove('recording'); }
    if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch { /* ignore */ }
}

function stopMediaStream() {
    try { if (mediaStream) { for (const t of mediaStream.getTracks()) t.stop(); } } catch { /* ignore */ }
    mediaStream = null;
}

// Monitors mic level via a SEPARATE getUserMedia stream (independent of
// whichever stream/process is actually recording the audio that gets
// transcribed — ffmpeg for host capture, MediaRecorder for local) so silence
// detection works the same for both paths. If this stream can't be acquired
// (e.g. permission denied), VAD is simply unavailable and dictation behaves
// like before: one segment, manual stop.
async function startVadMonitor(): Promise<void> {
    stopVadMonitor();
    try {
        vadStream = await (navigator as any).mediaDevices.getUserMedia({ audio: true });
    } catch {
        return;
    }
    vadAudioCtx = new (window as any).AudioContext();
    const source = vadAudioCtx.createMediaStreamSource(vadStream);
    vadAnalyser = vadAudioCtx.createAnalyser();
    vadAnalyser.fftSize = 512;
    source.connect(vadAnalyser);
    const data = new Uint8Array(vadAnalyser.fftSize);
    vadSilenceStartedAt = 0;
    vadHadSpeech = false;
    const tick = () => {
        if (!vadAnalyser) { return; }
        vadAnalyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSquares += v * v; }
        const rms = Math.sqrt(sumSquares / data.length);
        const now = Date.now();
        if (rms > VAD_SILENCE_RMS) {
            vadHadSpeech = true;
            vadSilenceStartedAt = 0;
        } else if (vadHadSpeech) {
            if (!vadSilenceStartedAt) {
                vadSilenceStartedAt = now;
            } else if (now - vadSilenceStartedAt >= VAD_SILENCE_MS) {
                vadSilenceStartedAt = 0;
                vadHadSpeech = false;
                onSilenceDetected();
            }
        }
        vadRafId = requestAnimationFrame(tick);
    };
    vadRafId = requestAnimationFrame(tick);
}

function stopVadMonitor(): void {
    if (vadRafId) { cancelAnimationFrame(vadRafId); vadRafId = null; }
    if (vadStream) { try { for (const t of vadStream.getTracks()) t.stop(); } catch { /* ignore */ } vadStream = null; }
    if (vadAudioCtx) { try { vadAudioCtx.close(); } catch { /* ignore */ } vadAudioCtx = null; }
    vadAnalyser = null;
}

// A pause was detected — end just THIS segment. Its stt-result/stt-error
// handler (maybeContinueDictation) starts the next one automatically, since
// dictationActive is still true; only a real stop (mic click / Send) turns
// it off first.
function onSilenceDetected(): void {
    if (!dictationActive || !isRecording) { return; }
    if (activeVoicePath === 'host') { stopHostCapture(); }
    else if (activeVoicePath === 'local') { stopLocalCapture(); }
}

// Called after a segment's transcript lands. Restarts the next segment while
// dictation is still armed; otherwise this really is the end of recording.
function maybeContinueDictation(): void {
    if (!dictationActive) { dispatchVoiceEnded(); return; }
    if (dictationUseHost) { startHostCapture(true); } else { void startLocalCapture(true); }
}

// Host returns the transcript (or an error) for the local path.
window.addEventListener('message', (e) => {
    if (!e.data) { return; }
    if (e.data.type === 'stt-result') {
        const text = (e.data.text || '').trim();
        if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
        recordingInterimText = '';
        recordingDotsText = '';
        setInputValue((recordingTextBase ? recordingTextBase.replace(/[.\s]*$/, ' ') : '') + text);
        input.focus();
        setStatus('Ready');
        maybeContinueDictation();
    } else if (e.data.type === 'stt-error') {
        if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
        recordingInterimText = '';
        recordingDotsText = '';
        if (recordingTextBase) { setInputValue(recordingTextBase); }
        setStatus('Ready');
        showToast('Transcription failed: ' + (e.data.error || 'unknown error'), 'error');
        maybeContinueDictation();
    } else if (e.data.type === 'voice-recording') {
        // Host couldn't open the native mic → reset the UI and fall back to
        // the webview MediaRecorder path (may still hit the permission bug).
        if (!e.data.ok && hostRecording) {
            hostRecording = false;
            isRecording = false;
            activeVoicePath = null;
            dictationUseHost = false;   // fell back to local — any further auto-segments stay local too
            micBtn.classList.remove('recording');
            if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
            recordingInterimText = '';
            recordingDotsText = '';
            setInputValue(recordingTextBase);
            showToast('Native mic capture failed (' + (e.data.error || 'unknown') + ') — falling back to webview mic', 'error');
            void startLocalCapture();
        }
    } else if (e.data.type === 'voice-silence') {
        // Host-side pause signal for the ffmpeg capture path (recorder.ts's
        // silencedetect filter) — same segment-boundary handling as the
        // webview-VAD path (startVadMonitor), just a different source.
        onSilenceDetected();
    }
});

// Unified mic button: route to whichever path is currently usable.
if (micBtn) {
    micBtn.addEventListener('click', () => {
        const prefs = getVoicePreferences();
        const path = chooseVoicePath();
        if (path === 'none') { showToast('Voice input is not available with the current configuration.', 'error'); return; }
        if (path === 'webspeech') {
            if (!recognition) { showToast('Speech recognition not supported in this browser', 'error'); return; }
            recognition.lang = prefs.language;
            recognition.continuous = prefs.continuous;
            recognition.interimResults = prefs.interimResults;
            if (isRecording) { stopVoiceRecording(); }
            else {
                try {
                    recognition.start();
                    // The constructor existing doesn't mean the recognition
                    // service actually works here (e.g. Electron/VS Code
                    // desktop) — if neither onstart nor onerror fires within a
                    // few seconds, it silently never started at all.
                    if (webSpeechStartWatchdog) { clearTimeout(webSpeechStartWatchdog); }
                    webSpeechStartWatchdog = setTimeout(() => {
                        webSpeechStartWatchdog = null;
                        if (isRecording) { return; }
                        showToast(prefs.hostCapture
                            ? 'Web Speech API did not respond (it only works in a real browser, not VS Code desktop) — switch "Speech-to-text engine" to a local engine in Config.'
                            : 'Web Speech API did not respond. Check microphone permission for this page.', 'error');
                    }, 3000);
                } catch (err) {
                    showToast('Could not start Web Speech API: ' + ((err as Error)?.message || err), 'error');
                }
            }
            return;
        }
        // local path: prefer native host capture, webview MediaRecorder as fallback
        if (isRecording) {
            stopVoiceRecording();
        } else if (prefs.hostCapture) {
            // "Continuous" arms silence auto-segmentation: keep dictating
            // across pauses instead of stopping after one segment. Detection
            // itself rides on the host's ffmpeg process (recorder.ts), NOT
            // startVadMonitor()'s getUserMedia — see startHostCapture.
            dictationActive = prefs.continuous;
            dictationUseHost = true;
            startHostCapture();
        } else {
            dictationActive = prefs.continuous;
            dictationUseHost = false;
            void startLocalCapture();
            if (dictationActive) { void startVadMonitor(); }
        }
    });
}

updateMicVisibility();

// Lets composer.ts know a recording just ended and its final text (if any)
// landed in the input — used to auto-continue a Send that was deferred
// because the user hit Send while still recording (see stopVoiceRecording()).
function dispatchVoiceEnded(): void {
    window.dispatchEvent(new Event('symposium-voice-ended'));
}

/** Whether a voice capture is currently in progress, on any path. */
export function isVoiceRecording(): boolean { return isRecording; }

/**
 * Stops whichever voice path is currently active (mirrors the mic button's
 * own stop branch). Used by composer.ts's send() to auto-stop-and-defer when
 * the user hits Send while still recording, instead of sending empty text.
 */
export function stopVoiceRecording(): void {
    // Cleared BEFORE stopping the current segment, so stopHostCapture/
    // stopLocalCapture (which check dictationActive to tell a real stop from
    // a mid-dictation pause) correctly treat this as the real stop.
    dictationActive = false;
    stopVadMonitor();
    if (activeVoicePath === 'webspeech' && recognition) {
        const prefs = getVoicePreferences();
        if (prefs.soundFeedback) playStopSound();
        recognition.stop();
    } else if (activeVoicePath === 'host') {
        stopHostCapture();
    } else if (activeVoicePath === 'local') {
        stopLocalCapture();
    }
}
