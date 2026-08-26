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

  function button(label, action, variant = "") {
    const element = document.createElement("button");
    element.className = `pui-update-button${variant ? ` pui-update-${variant}` : ""}`;
    element.textContent = label;
    element.addEventListener("click", action);
    return element;
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
    const close = button("", () => node.remove());
    close.className += " pui-update-close";
    close.setAttribute("aria-label", "Close update notification");
    node.append(message(`PUI v${info.latestVersion} is available`, "", true), close);
    const actions = actionRow();
    actions.append(button("Install", () => install(info.latestVersion), "primary"));
    actions.append(button("Skip version", () => {
      localStorage.setItem(SKIP_KEY, info.latestVersion);
      node.remove();
    }));
    node.append(actions);
  }

  function showProgress(target, phase) {
    const node = ensureCard();
    node.replaceChildren(message(`Updating PUI to v${target}`, phaseText[phase] || phase));
  }

  function showTerminal(status) {
    const node = ensureCard();
    if (status.result === "aborted") {
      node.replaceChildren(message(`Update was not applied. PUI v${status.currentVersion || "current"} remains installed.`));
      fetch("/api/app-update", { method: "DELETE" }).catch(() => {});
      return;
    }
    node.replaceChildren(message(status.result === "success"
      ? `PUI v${status.target} installed`
      : status.result === "rolled-back"
        ? `Update failed. PUI v${status.restored} was restored.`
        : `Update failed and needs manual recovery: ${status.error || "unknown error"}`));
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
      try {
        const response = await fetch("/api/app-update", { cache: "no-store" });
        if (response.ok) {
          const status = await response.json();
          if (["success", "rolled-back", "recovery-required", "aborted"].includes(status.result)) return showTerminal(status);
          showProgress(target, status.phase || "restarting");
        }
      } catch {
        showProgress(target, "restarting");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function install(target) {
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

  async function checkOnce() {
    try {
      const response = await fetch("/api/app-update", { cache: "no-store" });
      if (!response.ok) return;
      const info = await response.json();
      if (["success", "rolled-back", "recovery-required", "aborted"].includes(info.result)) return showTerminal(info);
      if (info.phase && info.target) return poll(info.target);
      if (info.updateAvailable && localStorage.getItem(SKIP_KEY) !== info.latestVersion) showAvailable(info);
    } catch {
      // Update discovery is optional and must never prevent PUI from launching.
    }
  }

  installStyles();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", checkOnce, { once: true });
  else checkOnce();
})();
