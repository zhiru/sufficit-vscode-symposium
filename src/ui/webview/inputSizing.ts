import { input } from "./dom";

const MAX_INPUT_HEIGHT = 180;

export function resizeInput(): void {
    // Empty textareas can report a tall scrollHeight because the placeholder
    // wraps across multiple lines. Keep the empty composer at its CSS min-height;
    // only autosize when real user text is present.
    if (!input.value) {
        input.style.height = "";
        return;
    }
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, MAX_INPUT_HEIGHT) + "px";
}
