// Sessions list + account footer rendering.
import { vscode, saved, saveState } from "./vscode";
import { sessionsList, root } from "./dom";
import { sessions, activeSessionId, showArchived, setActiveSessionId } from "./state";
import { setLoading } from "./status";
import { showCtx } from "./menus";
import { svgIcon } from "./icons";
import { bucket, relTime } from "./format";

let dragPinId: any = null;

const collapsedParents = new Set(saved.collapsedSubagents || []);
export function toggleCollapsed(id) {
    if (collapsedParents.has(id)) { collapsedParents.delete(id); } else { collapsedParents.add(id); }
    saveState({ collapsedSubagents: [...collapsedParents] });
    renderSessions();
}
export function groupHeader(label, count) {
    const gh = document.createElement("div"); gh.className = "groupHeader";
    const gl = document.createElement("span"); gl.textContent = label;
    const gc = document.createElement("span"); gc.className = "gcount"; gc.textContent = String(count);
    gh.appendChild(gl); gh.appendChild(gc);
    return gh;
}
export function renderAccount(profile) {
    const el = document.getElementById("accountFooter");
    if (!el) { return; }
    el.textContent = "";
    if (profile && (profile.name || profile.email)) {
        if (profile.picture) {
            const img = document.createElement("img");
            img.setAttribute("src", profile.picture); img.alt = "";
            el.appendChild(img);
        } else {
            const ic = document.createElement("div");
            ic.className = "acc-ico";
            ic.textContent = (profile.name || profile.email || "?").trim().charAt(0).toUpperCase();
            el.appendChild(ic);
        }
        const txt = document.createElement("div");
        txt.className = "acc-text";
        const nm = document.createElement("div");
        nm.className = "acc-name"; nm.textContent = profile.name || profile.email;
        txt.appendChild(nm);
        if (profile.name && profile.email) {
            const sub = document.createElement("div");
            sub.className = "acc-sub"; sub.textContent = profile.email;
            txt.appendChild(sub);
        }
        el.appendChild(txt);
        const out = document.createElement("span");
        out.className = "acc-out"; out.title = "Sair"; out.textContent = "⎋";
        out.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: "account-logout" }); };
        el.appendChild(out);
        el.onclick = null;
    } else {
        const ic = document.createElement("div");
        ic.className = "acc-ico"; ic.textContent = "↪";
        el.appendChild(ic);
        const txt = document.createElement("div");
        txt.className = "acc-text";
        const nm = document.createElement("div");
        nm.className = "acc-name"; nm.textContent = "Entrar na Sufficit";
        txt.appendChild(nm);
        el.appendChild(txt);
        el.onclick = () => vscode.postMessage({ type: "account-login" });
    }
}
export function renderSessions() {
    sessionsList.textContent = "";
    const visible = sessions.filter((s) => !s.archived || showArchived);
    // Subagents (parentId pointing at a visible session) render nested under
    // their parent — not as top-level rows — so the list stays a tidy tree.
    const byId = new Map(visible.map((s) => [s.sessionId, s]));
    const childrenOf = (id) => visible.filter((s) => s.parentId && s.parentId === id);
    const isChild = (s) => s.parentId && byId.has(s.parentId);
    const top = visible.filter((s) => !isChild(s));
    // Append a row and, when expanded, its subagent children (recursively).
    const appendTree = (s, depth) => {
        const kids = childrenOf(s.sessionId);
        sessionsList.appendChild(renderSessionItem(s, depth, kids.length));
        if (kids.length && !collapsedParents.has(s.sessionId)) {
            for (const k of kids) { appendTree(k, depth + 1); }
        }
    };
    const pinned = top.filter((s) => s.pinned).sort((a, b) => (a.pinIndex || 0) - (b.pinIndex || 0));
    const rest = top.filter((s) => !s.pinned);
    if (pinned.length) {
        sessionsList.appendChild(groupHeader("Pinned", pinned.length));
        for (const s of pinned) { appendTree(s, 0); }
    }
    let lastBucket = null;
    for (const s of rest) {
        const bk = bucket(s.updatedAt);
        if (bk !== lastBucket) {
            lastBucket = bk;
            const count = rest.filter((x) => bucket(x.updatedAt) === bk).length;
            sessionsList.appendChild(groupHeader(bk, count));
        }
        appendTree(s, 0);
    }
}
export function dropPinnedOn(targetId) {
    if (!dragPinId || dragPinId === targetId) { return; }
    const order = sessions.filter((s) => s.pinned).sort((a, b) => (a.pinIndex || 0) - (b.pinIndex || 0)).map((s) => s.sessionId);
    const from = order.indexOf(dragPinId), to = order.indexOf(targetId);
    if (from < 0 || to < 0) { return; }
    order.splice(from, 1);
    order.splice(order.indexOf(targetId), 0, dragPinId);
    // Optimistic reorder so it feels instant, then persist.
    const idx = {}; order.forEach((id, i) => idx[id] = i);
    for (const s of sessions) { if (s.pinned) { s.pinIndex = idx[s.sessionId]; } }
    renderSessions();
    vscode.postMessage({ type: "reorder-pinned", ids: order });
}
export function renderSessionItem(s, depth, childCount) {
        depth = depth || 0; childCount = childCount || 0;
        const el = document.createElement("div");
        el.className = "sessionItem" + (s.sessionId === activeSessionId ? " active" : "") + (s.archived ? " archived" : "") + (s.pinned ? " pinned" : "") + (s.deleting ? " deleting" : "") + (depth ? " subagentChild" : "");
        if (depth) { el.style.marginLeft = (depth * 16) + "px"; }
        // Caret to collapse/expand a parent's subagent children.
        let caretEl = null;
        if (childCount > 0) {
            caretEl = document.createElement("button");
            caretEl.className = "subCaret";
            caretEl.style.cssText = "background:none;border:none;cursor:pointer;padding:0 2px;display:flex;align-items:center;opacity:0.7";
            const collapsed = collapsedParents.has(s.sessionId);
            const cv = svgIcon("chevron");
            cv.style.transform = collapsed ? "rotate(-90deg)" : "rotate(0deg)";
            cv.style.transition = "transform 150ms ease";
            caretEl.appendChild(cv);
            caretEl.title = collapsed ? "Expand subagents" : "Collapse subagents";
            caretEl.setAttribute("aria-label", caretEl.title);
            caretEl.addEventListener("click", (ev) => { ev.stopPropagation(); toggleCollapsed(s.sessionId); });
        }
        el.tabIndex = 0;
        el.setAttribute("role", "option");
        el.setAttribute("aria-selected", s.sessionId === activeSessionId ? "true" : "false");
        el.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); body.click(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); const next = el.nextElementSibling; if (next && next.classList.contains("sessionItem")) { next.focus(); } else { const after = el.parentElement.querySelectorAll(".sessionItem"); const idx = Array.from(after).indexOf(el); if (idx + 1 < after.length) { after[idx + 1].focus(); } } }
            else if (e.key === "ArrowUp") { e.preventDefault(); const prev = el.previousElementSibling; if (prev && prev.classList.contains("sessionItem")) { prev.focus(); } else { const all = el.parentElement.querySelectorAll(".sessionItem"); const idx = Array.from(all).indexOf(el); if (idx > 0) { all[idx - 1].focus(); } } }
        });
        // Pinned items reorder by drag-and-drop (the up/down menu still works).
        if (s.pinned) {
            el.draggable = true;
            el.addEventListener("dragstart", (e) => { dragPinId = s.sessionId; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
            el.addEventListener("dragend", () => { dragPinId = null; el.classList.remove("dragging"); document.querySelectorAll(".sessionItem.dropTarget").forEach((x) => x.classList.remove("dropTarget")); });
            el.addEventListener("dragover", (e) => { if (dragPinId && dragPinId !== s.sessionId) { e.preventDefault(); el.classList.add("dropTarget"); } });
            el.addEventListener("dragleave", () => el.classList.remove("dropTarget"));
            el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("dropTarget"); dropPinnedOn(s.sessionId); });
        }

        // Live status indicator: spinner = working, green dot = idle/live.
        // Subagent sessions (parentId != null) show robot icon for visual distinction.
        const statusDot = document.createElement("div");
        statusDot.className = "statusDot";
        const isSubagent = !!s.parentId;
        if (s.deleting) {
            const sp = document.createElement("span"); sp.className = "spinner"; sp.title = "Deleting…"; statusDot.appendChild(sp);
        } else if (s.status === "working") {
            const w = document.createElement("span"); w.className = "work"; w.title = "Agent working…"; statusDot.appendChild(w);
        } else if (s.status === "idle") {
            const d = document.createElement("span"); d.className = "idle"; d.title = "Running session (idle)"; statusDot.appendChild(d);
        } else {
            const ic = svgIcon(isSubagent ? "robot" : "chat");
            ic.classList.add("stored");
            if (isSubagent) { ic.classList.add("subagentIcon"); }
            ic.setAttribute("aria-hidden", "true");
            statusDot.appendChild(ic);
        }

        const body = document.createElement("div");
        body.className = "body";
        const ttl = document.createElement("div");
        ttl.className = "ttl";
        if (s.pinned) { const pn = svgIcon("pin"); pn.classList.add("ttlIcon"); ttl.appendChild(pn); }
        if (s.archived) { const ar = svgIcon("archive"); ar.classList.add("ttlIcon"); ttl.appendChild(ar); }
        ttl.appendChild(document.createTextNode(s.title));
        ttl.title = s.title + "\n" + s.sessionId;
        const sub = document.createElement("span");
        sub.className = "sub";
        if (s.deleting) {
            sub.textContent = "deleting…";
        } else {
            const statusText = s.status === "working" ? "working… · " : (s.status === "idle" ? "live · " : "");
            sub.textContent = statusText + s.backend + (s.updatedAt ? " · " + relTime(s.updatedAt) : "");
        }
        sub.title = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
        body.appendChild(ttl);
        body.appendChild(sub);
        // While a delete scrub is in flight the row is inert (no open / no menu).
        if (!s.deleting) {
            body.addEventListener("click", () => {
                root.classList.remove("listOpen");
                setActiveSessionId(s.sessionId); renderSessions();
                setLoading(true, "Loading session…");
                vscode.postMessage({ type: "open-session", sessionId: s.sessionId, backend: s.backend });
            });
        }

        // One "more" button opens the same menu as right-click.
        const acts = document.createElement("div");
        acts.className = "acts";
        if (!s.deleting) {
            const more = document.createElement("button");
            more.appendChild(svgIcon("more")); more.title = "Actions"; more.setAttribute("aria-label", "Actions");
            more.addEventListener("click", (ev) => { ev.stopPropagation(); showCtx(ev, s); });
            acts.appendChild(more);
        }

        if (caretEl) { el.appendChild(caretEl); }
        el.appendChild(statusDot);
        el.appendChild(body);
        el.appendChild(acts);
        if (!s.deleting) {
            el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); showCtx(ev, s); });
        }
        return el;
}
