import { vscode } from "./vscode";
import { input, micBtn } from "./dom";
import { setStatus } from "./status";
import { showToast } from "./menus";
import { resizeInput } from "./inputSizing";
import { playStartSound, playStopSound } from "./voiceSounds";
import { applyRecognitionPreferences, chooseVoicePath, getVoicePreferences, updateMicVisibility } from "./voicePrefs";

let recognition: any = null;
let isRecording = false;
let recordingDotsInterval: any = null;
let recordingTextBase = '';
let recordingInterimText = '';
let recordingDotsText = '';
let webSpeechStartWatchdog: any = null;
let activeVoicePath: 'webspeech' | 'host' | 'local' | null = null;

let dictationActive = false;
let dictationUseHost = false;
let vadStream: any = null;
let vadAudioCtx: any = null;
let vadAnalyser: any = null;
let vadRafId: any = null;
let vadSilenceStartedAt = 0;
let vadHadSpeech = false;
const VAD_SILENCE_RMS = 0.02;
const VAD_SILENCE_MS = 900;

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

window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'setVoicePreferences') {
        getVoicePreferences();
        applyRecognitionPreferences(recognition);
        updateMicVisibility(webSpeechSupported);
    }
});

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
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    applyRecognitionPreferences(recognition);

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
            recordingTextBase = recordingTextBase + finalTranscript;
            recordingInterimText = '';
            renderRecordingDraft();
            setStatus('Listening...');
        } else if (interimTranscript) {
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

let hostRecording = false;

function startHostCapture(isContinuation = false) {
    const prefs = getVoicePreferences();
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

function onSilenceDetected(): void {
    if (!dictationActive || !isRecording) { return; }
    if (activeVoicePath === 'host') { stopHostCapture(); }
    else if (activeVoicePath === 'local') { stopLocalCapture(); }
}

function maybeContinueDictation(): void {
    if (!dictationActive) { dispatchVoiceEnded(); return; }
    if (dictationUseHost) { startHostCapture(true); } else { void startLocalCapture(true); }
}

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
        if (!e.data.ok && hostRecording) {
            hostRecording = false;
            isRecording = false;
            activeVoicePath = null;
            dictationUseHost = false;
            micBtn.classList.remove('recording');
            if (recordingDotsInterval) { clearInterval(recordingDotsInterval); recordingDotsInterval = null; }
            recordingInterimText = '';
            recordingDotsText = '';
            setInputValue(recordingTextBase);
            showToast('Native mic capture failed (' + (e.data.error || 'unknown') + ') — falling back to webview mic', 'error');
            void startLocalCapture();
        }
    } else if (e.data.type === 'voice-silence') {
        onSilenceDetected();
    }
});

if (micBtn) {
    micBtn.addEventListener('click', () => {
        const prefs = getVoicePreferences();
        const path = chooseVoicePath(webSpeechSupported);
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
        if (isRecording) {
            stopVoiceRecording();
        } else if (prefs.hostCapture) {
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

updateMicVisibility(webSpeechSupported);

function dispatchVoiceEnded(): void {
    window.dispatchEvent(new Event('symposium-voice-ended'));
}

export function isVoiceRecording(): boolean { return isRecording; }

export function stopVoiceRecording(): void {
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
