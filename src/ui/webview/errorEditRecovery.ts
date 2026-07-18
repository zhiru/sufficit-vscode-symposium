/** Minimal DOM shape used to clear a failed attempt before editing its prompt. */
export interface FailedAttemptElement {
    nextElementSibling: FailedAttemptElement | null;
    textContent: string | null;
    classList: { contains(name: string): boolean };
    remove(): void;
}

/** Removes the error and its following duration marker, preserving the user row. */
export function clearFailedAttemptForEdit(error: FailedAttemptElement): void {
    const duration = error.nextElementSibling;
    if (duration?.classList.contains("meta") && /^—(?:\s|\$|\d)/.test(duration.textContent || "")) {
        duration.remove();
    }
    error.remove();
}
