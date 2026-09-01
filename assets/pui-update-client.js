(() => {
  "use strict";
  const SKIP_KEY = "pui.skippedVersion";
  const phaseText = {
    waiting: "Waiting for active Pi sessions…",
    preparing: "Preparing update…",
    installing: "Installing…",
    restarting: "Restarting Pi Web…",
    verifying: "Verifying…",
    restoring: "Restoring previous version…",
  };
  let card;
  let dismissed = false;
  let restartButton;

  function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .pui-update-card {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        box-sizing: border-box;
        width: min(360px, calc(100vw - 36px));
        min-height: 112px;
        padding: 18px;
        border: 1px solid var(--border, #e0e0e0);
        border-radius: 12px;
        background: var(--bg-panel, #f5f5f5);
        color: var(--text, #1a1a1a);
        box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
        font: 14px/1.45 var(--font-sans, ui-sans-serif, system-ui, sans-serif);
      }
      .pui-update-message { min-height: 20px; overflow-wrap: anywhere; }
      .pui-update-message-with-close { padding-right: 34px; }
      .pui-update-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 14px;
      }
      .pui-update-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        height: 40px;
        padding: 0 14px;
        border: 1px solid var(--border, #e0e0e0);
        border-radius: 8px;
        background: var(--bg, #fff);
        color: var(--text, #1a1a1a);
        font: inherit;
        line-height: 1;
        cursor: pointer;
      }
      .pui-update-button:hover { background: var(--bg-hover, #eee); }
      .pui-update-button:focus-visible {
        outline: 2px solid var(--accent, #2563eb);
        outline-offset: 2px;
      }
      .pui-update-primary {
        border-color: var(--accent, #2563eb);
        background: var(--accent, #2563eb);
        color: var(--bg, #fff);
      }
      .pui-update-primary:hover { background: var(--accent-hover, #1d4ed8); }
      .pui-update-close {
        position: absolute;
        top: 12px;
        right: 12px;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--text-muted, #6b7280);
      }
      .pui-update-close::before,
      .pui-update-close::after {
        content: "";
        position: absolute;
        top: 50%;
        left: 50%;
        width: 14px;
        height: 2px;
        border-radius: 1px;
        background: currentColor;
      }
      .pui-update-close::before { transform: translate(-50%, -50%) rotate(45deg); }
      .pui-update-close::after { transform: translate(-50%, -50%) rotate(-45deg); }
      .pui-update-close:hover {
        background: var(--bg-hover, #eee);
        color: var(--text, #1a1a1a);
      }
      .pui-restart-button {
        position: fixed;
        right: 4px;
        bottom: 4px;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: rgb(128, 136, 150);
        transition: background 0.3s, color 0.3s;
      }
      .pui-restart-button:hover:not(:disabled) {
        background: var(--bg-hover, #eee);
        color: rgb(96, 106, 122);
        border: none;
      }
      .pui-restart-button--busy {
        opacity: .6;
        cursor: default;
      }
    `;
    (document.head || document.body).appendChild(style);
  }

  function ensureCard() {
    if (card) return card;
    card = document.createElement("section");
    card.className = "pui-update-card";
    card.dataset.puiUpdate = "bottom-right";
    card.setAttribute("role", "status");
    document.body.appendChild(card);
    return card;
  }

  function dismiss() {
    if (card) { card.remove(); card = null; }
    dismissed = true;
  }

  function button(label, action, variant = "") {
    const element = document.createElement("button");
    element.className = `pui-update-button${variant ? ` pui-update-${variant}` : ""}`;
    element.textContent = label;
    element.addEventListener("click", action);
    return element;
  }

  function closeButton() {
    const close = button("", dismiss);
    close.className += " pui-update-close";
    close.setAttribute("aria-label", "Close update notification");
    return close;
  }

  function message(primary, secondary = "", reserveClose = false) {
    const element = document.createElement("div");
    element.className = `pui-update-message${reserveClose ? " pui-update-message-with-close" : ""}`;
    element.append(primary);
    if (secondary) element.append(document.createElement("br"), secondary);
    return element;
  }

  function actionRow() {
    const element = document.createElement("div");
    element.className = "pui-update-actions";
    return element;
  }

  function showAvailable(info) {
    const node = ensureCard();
    node.replaceChildren();
    node.append(message(`PUI v${info.latestVersion} is available`, "", true), closeButton());
    const actions = actionRow();
    actions.append(button("Install", () => install(info.latestVersion), "primary"));
    actions.append(button("Skip version", () => {
      localStorage.setItem(SKIP_KEY, info.latestVersion);
      dismiss();
    }));
    node.append(actions);
  }

  function showProgress(target, phase) {
    const node = ensureCard();
    node.replaceChildren(message(`Updating PUI to v${target}`, phaseText[phase] || phase, true), closeButton());
  }

  function showTerminal(status) {
    const node = ensureCard();
    if (status.result === "aborted") {
      node.replaceChildren(message(`Update was not applied. PUI v${status.currentVersion || "current"} remains installed.`, "", true), closeButton());
      fetch("/api/app-update", { method: "DELETE" }).catch(() => {});
      return;
    }
    node.replaceChildren(message(status.result === "success"
      ? `PUI v${status.target} installed`
      : status.result === "rolled-back"
        ? `Update failed. PUI v${status.restored} was restored.`
        : `Update failed and needs manual recovery: ${status.error || "unknown error"}`, "", true), closeButton());
    if (status.result !== "recovery-required") {
      const actions = actionRow();
      actions.append(button("Reload PUI", async () => {
        await fetch("/api/app-update", { method: "DELETE" }).catch(() => {});
        location.reload();
      }, "primary"));
      node.append(actions);
    }
  }

  async function poll(target) {
    for (;;) {
      let phase = "restarting";
      let terminal = null;
      try {
        const response = await fetch("/api/app-update", { cache: "no-store" });
        if (response.ok) {
          const status = await response.json();
          if (["success", "rolled-back", "recovery-required", "aborted"].includes(status.result)) terminal = status;
          else phase = status.phase || "restarting";
        }
      } catch {
        phase = "restarting";
      }
      // A terminal result always (re)appears so the user can act (e.g. reload after success).
      if (terminal) {
        dismissed = false;
        return showTerminal(terminal);
      }
      // While dismissed, hide progress updates until a terminal result brings the card back.
      if (!dismissed) showProgress(target, phase);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function install(target) {
    dismissed = false;
    showProgress(target, "preparing");
    const response = await fetch("/api/app-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      ensureCard().textContent = error.error || "Update could not be started";
      return;
    }
    await poll(target);
  }

  async function checkOnce(afterRestart = false) {
    try {
      const response = await fetch("/api/app-update", { cache: "no-store" });
      if (!response.ok) return;
      const info = await response.json();
      if (["success", "rolled-back", "recovery-required", "aborted"].includes(info.result)) return showTerminal(info);
      if (info.result === "restarted" && !afterRestart) {
        await fetch("/api/app-update", { method: "DELETE" }).catch(() => {});
        return checkOnce(true);
      }
      if (!info.target && info.phase === "failed" && info.result === "failed") return restartFailed(info.error);
      if (info.phase && info.target) return poll(info.target);
      if (info.updateAvailable && localStorage.getItem(SKIP_KEY) !== info.latestVersion) showAvailable(info);
    } catch {
      // Update discovery is optional and must never prevent PUI from launching.
    }
  }

  function showRestartButton() {
    if (restartButton) return restartButton;
    restartButton = button("", restartPUI);
    restartButton.className = "pui-update-button pui-restart-button";
    // Same rotate glyph as the sidebar refresh button (stroke follows the theme via currentColor).
    restartButton.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
    restartButton.setAttribute("aria-label", "Restart PUI");
    restartButton.title = "Restart PUI";
    document.body.appendChild(restartButton);
    return restartButton;
  }

  function setRestartBusy(busy) {
    if (!restartButton) return;
    restartButton.disabled = busy;
    restartButton.className = `${restartButton.className.replace(/\s*pui-restart-button--busy/, "")}${busy ? " pui-restart-button--busy" : ""}`;
  }

  function showRestartProgress() {
    ensureCard().replaceChildren(message("Restarting Pi Web…", "The page will reload once Pi Web is healthy again.", true), closeButton());
  }

  function restartFailed(reason) {
    setRestartBusy(false);
    ensureCard().replaceChildren(message(`Pi Web restart did not complete${reason ? `: ${reason}` : ""}`, "", true), closeButton());
  }

  async function restartPUI() {
    if (typeof confirm === "function" && !confirm("Restart PUI? This restarts Pi Web and disconnects your current session.")) return;
    setRestartBusy(true);
    showRestartProgress();
    let started = false;
    try {
      const response = await fetch("/api/app-update", { method: "PUT" });
      if (response.ok) started = true;
      else {
        const error = await response.json().catch(() => ({}));
        restartFailed(error.error || "Restart could not be started");
      }
    } catch {
      restartFailed("Restart request did not reach Pi Web");
    }
    if (started) pollRestart();
  }

  // Status-driven: show progress while the restart runs, reload on completion
  // (restoring a fresh, active button), re-enable the button on failure.
  async function pollRestart() {
    let seenDown = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const response = await fetch("/api/app-update", { cache: "no-store" });
        if (response.ok) {
          if (seenDown) { location.reload(); return; }
          const status = await response.json().catch(() => ({}));
          if (status.phase === "restarting") showRestartProgress();
          else if (status.result === "restarted") { location.reload(); return; }
          else if (status.result === "failed" && !status.target) { restartFailed(status.error); return; }
        }
      } catch {
        seenDown = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    restartFailed("Pi Web did not come back within 90 seconds");
  }

  installStyles();
  function start() { showRestartButton(); checkOnce(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
