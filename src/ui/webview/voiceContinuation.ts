/**
 * A continuation with no confirmed speech can be discarded only when the
 * user explicitly stops it. A VAD silence event is not proof that the segment
 * is empty: ffmpeg may miss `silence_end` when speech starts immediately.
 */
export function shouldDiscardUntouchedContinuation(
    manualStop: boolean,
    isContinuation: boolean,
    hadConfirmedSpeech: boolean,
): boolean {
    return manualStop && isContinuation && !hadConfirmedSpeech;
}
