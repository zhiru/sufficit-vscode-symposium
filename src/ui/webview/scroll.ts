// Layout + scroll helpers for the chat log and sessions pane. Side effects
// (ResizeObserver, scroll/listToggle listeners, initial layout) run on import.
import { root, log, listToggle } from "./dom";
import { sideMode } from "./state";

// The sessions pane sits on the OUTER edge: docked right → sessions right;
// docked left → sessions left. With no dock-side API, infer from screen position.
export function sideIsRight(): boolean {
    if (sideMode === "left") { return false; }
    if (sideMode === "right") { return true; }
    try {
        const center = ((window as any).screenX || 0) + window.innerWidth / 2;
        return center > (window.screen.width / 2);
    } catch (e) {
        return false;
    }
}

// Responsive: wide surface shows the sessions pane beside the chat; narrow hides
// it behind the toggle (mirrors the built-in chat sessions viewer).
const NARROW = 640;
export function layout(): void {
    root.classList.toggle("narrow", document.body.clientWidth < NARROW);
    root.classList.toggle("side-right", sideIsRight());
}
new ResizeObserver(layout).observe(document.body);
layout();
listToggle.addEventListener("click", () => root.classList.toggle("listOpen"));

// Auto-scroll only when already near the bottom, so reading scrollback isn't
// yanked away mid-stream.
export function nearBottom(): boolean { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
// Timestamp of the last PROGRAMMATIC scroll, so the ctx-menu auto-close can tell
// it apart from a user scroll. Read by the document scroll handler in index.
export let lastAutoScroll = 0;
export function autoScroll(stick: boolean): void { if (stick) { lastAutoScroll = Date.now(); log.scrollTop = log.scrollHeight; } }
// Force-scroll to the very bottom, now and on the next frame (history/images can
// change height a frame later).
export function scrollToBottom(): void {
    lastAutoScroll = Date.now();
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(() => { lastAutoScroll = Date.now(); log.scrollTop = log.scrollHeight; updateScrollBtn(); });
}
// Floating "scroll to bottom" button: visible only when scrolled up.
let scrollBtn: any = null;
export function updateScrollBtn(): void {
    if (!scrollBtn) { return; }
    scrollBtn.classList.toggle("show", !nearBottom() && log.childElementCount > 0);
}
log.addEventListener("scroll", updateScrollBtn);
scrollBtn = document.getElementById("scrollBottom");
if (scrollBtn) { scrollBtn.addEventListener("click", scrollToBottom); }
// Show the empty-state placeholder when the log has no messages yet.
export function refreshEmpty(): void { root.classList.toggle("empty", log.childElementCount === 0); }
