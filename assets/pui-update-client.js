(() => {
  "use strict";
  const SKIP_KEY = "pui.skippedVersion";
  const POLL_INTERVAL_MS = 1000;
  // A reachable Pi Web without a transaction status is not proof of progress:
  // the bridge discards a stale status and answers with plain discovery.
  const STATUS_GAP_LIMIT = 15;
  const UNREACHABLE_LIMIT_MS = 15 * 60 * 1000;
  // Every unanswered poll costs POLL_INTERVAL_MS, so the limit above is reached
  // after this many consecutive unreachable responses.
  const UNREACHABLE_POLLS = Math.ceil(UNREACHABLE_LIMIT_MS / POLL_INTERVAL_MS);
  const TERMINAL_RESULTS = ["success", "rolled-back", "recovery-required", "aborted"];
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
    const summary = status.result === "success"
      ? `PUI v${status.target} installed`
      : status.result === "rolled-back"
        ? `Update failed. PUI v${status.restored} was restored.`
        : `Update failed and needs manual recovery: ${status.error || "unknown error"}`;
    // A rolled-back update keeps the restored-version sentence and adds the
    // recorded reason, otherwise the failure stays undiagnosable from the UI.
    const reason = status.result === "rolled-back" && status.error ? `Reason: ${status.error}` : "";
    node.replaceChildren(message(summary, reason, true), closeButton());
    if (status.result !== "recovery-required") {
      const actions = actionRow();
      actions.append(button("Reload PUI", async () => {
        await fetch("/api/app-update", { method: "DELETE" }).catch(() => {});
        location.reload();
      }, "primary"));
      node.append(actions);
    }
  }

  // Replaces unbounded waiting with an explicit user decision. Resolves when the
  // user chooses to keep waiting, so polling continues from where it paused.
  function pausePolling(title, body) {
    return new Promise((resolve) => {
      const node = ensureCard();
      node.replaceChildren(message(title, body));
      const actions = actionRow();
      actions.append(button("Reload PUI", () => location.reload(), "primary"));
      actions.append(button("Keep waiting", () => {
        // Keeping waiting means watching progress again: clear the dismissed
        // flag so the next poll repaints the card, then drop the paused card.
        dismissed = false;
        if (card) { card.remove(); card = null; }
        resolve();
      }));
      node.append(actions);
    });
  }

  async function poll(target) {
    // Polling stays inside one transaction for as long as that transaction
    // reports a phase. It only ends on a terminal result, or by handing control
    // back to the user when Pi Web stops reporting progress or stops answering.
    let statusGap = 0;
    let unreachablePolls = 0;
    for (;;) {
      let phase = null;
      let reachable = false;
      try {
        const response = await fetch("/api/app-update", { cache: "no-store" });
        if (response.ok) {
          const status = await response.json();
          reachable = true;
          // A terminal result always (re)appears so the user can act (e.g. reload after success).
          if (TERMINAL_RESULTS.includes(status.result)) {
            dismissed = false;
            return showTerminal(status);
          }
          if (status.phase) phase = status.phase;
        }
      } catch {
        // Pi Web is restarting or unreachable; counted as unreachability below.
      }
      if (phase) {
        // waiting/installing/verifying/restoring may legitimately last minutes,
        // so a reported phase is never timed out.
        statusGap = 0;
        unreachablePolls = 0;
        // While dismissed, hide progress updates until a terminal result brings the card back.
        if (!dismissed) showProgress(target, phase);
      } else if (reachable) {
        unreachablePolls = 0;
        statusGap += 1;
        // Reachable without a transaction status: the bridge dropped a stale
        // status and answered with discovery only, so progress is unknown.
        // Claiming "Restarting Pi Web…" here is what used to spin forever.
        if (statusGap >= STATUS_GAP_LIMIT) {
          statusGap = 0;
          await pausePolling("PUI stopped reporting update progress", "Reload PUI to see the installed version.");
        }
      } else {
        statusGap = 0;
        unreachablePolls += 1;
        if (unreachablePolls >= UNREACHABLE_POLLS) {
          unreachablePolls = 0;
          await pausePolling("Pi Web has not responded for 15 minutes", "The update may still be running. Reload PUI to check the result.");
        } else if (!dismissed) {
          showProgress(target, "restarting");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async function install(target) {
    dismissed = false;
    showProgress(target, "preparing");
    let response;
    try {
      response = await fetch("/api/app-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
    } catch {
      // An unreachable Pi Web rejects here; without this the card would stay on
      // "Preparing update…" forever.
      const node = ensureCard();
      node.replaceChildren(message("Could not reach Pi Web", "The update was not started. Reload PUI and then try again."));
      const actions = actionRow();
      actions.append(button("Reload PUI", () => location.reload(), "primary"));
      node.append(actions);
      return;
    }
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
      if (TERMINAL_RESULTS.includes(info.result)) return showTerminal(info);
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
    let seenRestarting = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const response = await fetch("/api/app-update", { cache: "no-store" });
        if (response.ok) {
          if (seenDown) { location.reload(); return; }
          const status = await response.json().catch(() => ({}));
          if (status.phase === "restarting") {
            seenRestarting = true;
            showRestartProgress();
          } else if (status.result === "restarted") { location.reload(); return; }
          else if (status.result === "failed" && !status.target) { restartFailed(status.error); return; }
          // Completed restart status is intentionally one-shot and another tab
          // can consume it first. Once this tab observed restart progress, an
          // ordinary healthy response means the replacement server is back.
          else if (seenRestarting) { location.reload(); return; }
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
