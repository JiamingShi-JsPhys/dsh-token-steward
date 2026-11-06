/**
 * Console stylesheet, injected as `<style data-plugin="umbra-budget">`.
 * Styled exclusively with official `--dsw-alias-*` design tokens (with safe
 * fallbacks) so dark/light themes and third-party skins apply untouched.
 *
 * @module client/console-css
 */

export const CONSOLE_CSS = `
.umbra-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #101014) 72%, transparent);
  backdrop-filter: blur(10px) saturate(140%);
  font-family: inherit;
}
.umbra-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: min(920px, 92vw);
  max-height: 86vh;
  overflow-y: auto;
  padding: 20px 24px 24px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-3, #1a1a20);
  color: var(--dsw-alias-label-primary-foreground, #f2f2f7);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
}
.umbra-header { display: flex; align-items: center; gap: 12px; }
.umbra-title-block { display: flex; flex-direction: column; margin-right: auto; }
.umbra-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.22em;
  background: linear-gradient(90deg, var(--dsw-alias-brand-primary, #4d6bfe), color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 40%, #9be8ff));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.umbra-subtitle { font-size: 11px; opacity: 0.6; }
.umbra-header-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.umbra-stat-chip {
  padding: 3px 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 999px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  white-space: nowrap;
}
.umbra-backend-chip {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 55%, transparent);
  color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.umbra-live-dot { width: 8px; height: 8px; border-radius: 50%; margin-left: 4px; }
.umbra-live-on { background: #34c77b; box-shadow: 0 0 8px rgba(52, 199, 123, 0.8); }
.umbra-live-off { background: rgba(128, 128, 128, 0.5); }
.umbra-close-button {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  background: transparent;
  color: inherit;
  border-radius: 8px;
  width: 26px;
  height: 26px;
  cursor: pointer;
}
.umbra-close-button:hover { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d6bfe)); }
.umbra-mode-bar { display: flex; gap: 8px; align-items: center; }
.umbra-mode-button {
  flex: 1;
  padding: 8px 0;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.umbra-mode-button:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.umbra-mode-active {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d6bfe));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
  font-weight: 600;
}
.umbra-verify-button {
  padding: 8px 14px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.85;
}
.umbra-error-bar {
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, #e5484d 18%, transparent);
  color: #ff8f8f;
  font-size: 12px;
}
.umbra-section { display: flex; flex-direction: column; gap: 8px; }
.umbra-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  opacity: 0.72;
  display: flex;
  align-items: center;
  gap: 8px;
}
.umbra-section-hint { font-weight: 400; letter-spacing: normal; font-size: 11px; opacity: 0.8; }
.umbra-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
.umbra-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3, #1a1a20) 70%, transparent);
}
.umbra-card-head { display: flex; align-items: center; gap: 7px; }
.umbra-status-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.umbra-status-healthy { background: #34c77b; box-shadow: 0 0 6px rgba(52, 199, 123, 0.7); }
.umbra-status-cooling { background: #f5a623; box-shadow: 0 0 6px rgba(245, 166, 35, 0.7); }
.umbra-status-disabled { background: rgba(128, 128, 128, 0.55); }
.umbra-model-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.umbra-provider-name { font-size: 10px; opacity: 0.5; margin-left: auto; }
.umbra-tag-row { display: flex; flex-wrap: wrap; gap: 4px; }
.umbra-tag {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  opacity: 0.85;
}
.umbra-cost-free { border-color: rgba(52, 199, 123, 0.6); color: #63e2a6; }
.umbra-cost-low { border-color: rgba(90, 160, 255, 0.6); color: #8fbcff; }
.umbra-cost-medium { opacity: 0.8; }
.umbra-cost-high { border-color: rgba(245, 166, 35, 0.6); color: #ffc46b; }
.umbra-card-stats { display: flex; gap: 8px; font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.8; flex-wrap: wrap; }
.umbra-note { font-size: 10px; opacity: 0.55; }
.umbra-toggle-button {
  align-self: flex-start;
  padding: 3px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font-size: 11px;
  cursor: pointer;
}
.umbra-toggle-button:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.umbra-empty {
  padding: 14px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 10px;
  font-size: 12px;
  opacity: 0.55;
  grid-column: 1 / -1;
}
.umbra-routes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 11.5px;
}
.umbra-route-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 10px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-3, #1a1a20) 55%, transparent);
}
.umbra-route-time { opacity: 0.45; font-variant-numeric: tabular-nums; flex: none; }
.umbra-route-mode { opacity: 0.55; flex: none; }
.umbra-route-flow { flex: none; }
.umbra-route-arrow { opacity: 0.4; padding: 0 2px; }
.umbra-fallback-badge {
  margin-left: 6px;
  font-style: normal;
  font-size: 10px;
  color: #ffc46b;
  border: 1px solid rgba(245, 166, 35, 0.5);
  border-radius: 999px;
  padding: 0 6px;
}
.umbra-route-reason { opacity: 0.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.umbra-agents { display: flex; flex-wrap: wrap; gap: 6px; }
.umbra-agent-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.35));
  border-radius: 999px;
  font-size: 11.5px;
}
.umbra-agent-name { font-weight: 600; }
.umbra-agent-model { opacity: 0.75; font-family: ui-monospace, 'SF Mono', Consolas, monospace; }
.umbra-footer-button {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary-foreground, inherit);
  cursor: pointer;
  font-size: 12px;
  letter-spacing: 0.08em;
  border-radius: 8px;
  padding: 4px 8px;
}
.umbra-footer-button:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 22%, transparent); }
.umbra-footer-button-active { color: var(--dsw-alias-brand-primary, #4d6bfe); }
`

/** Inject the stylesheet once; returns the removal disposer. */
export function injectConsoleStyle(): () => void {
  const existing = document.querySelector('style[data-plugin="umbra-budget"]')
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'umbra-budget'
  style.textContent = CONSOLE_CSS
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}
