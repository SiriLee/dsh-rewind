/**
 * Client plugin styling: one injected `<style>` tag (scoped class names),
 * following the dsh design tokens (`--dsw-*`) so the button and popover blend
 * with the conversation chrome.
 *
 * @module dsh-rewind/client/styles
 */

/** Class names shared between the injected DOM and the stylesheet. */
export const CLASS = {
  button: 'dsh-rewind-btn',
  popover: 'dsh-rewind-popover',
  popoverTitle: 'dsh-rewind-popover-title',
  popoverTarget: 'dsh-rewind-popover-target',
  popoverOption: 'dsh-rewind-popover-option',
  popoverOptionLabel: 'dsh-rewind-popover-option-label',
  popoverOptionHint: 'dsh-rewind-popover-option-hint',
  popoverImpact: 'dsh-rewind-popover-impact',
  popoverActions: 'dsh-rewind-popover-actions',
  popoverPrimary: 'dsh-rewind-popover-primary',
  popoverGhost: 'dsh-rewind-popover-ghost',
  guardHint: 'dsh-rewind-guard-hint',
} as const

/** The ↶ glyph, drawn inline so the bundle stays dependency-free. */
export const REWIND_ICON_SVG = [
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
  '  <path d="M6.5 2.5 2.5 6.5l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  '  <path d="M2.5 6.5h7a4 4 0 0 1 4 4v1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  '</svg>',
].join('')

/** One injected stylesheet (scoped under `.dsh-rewind-*`). */
export const STYLE = `
.dsh-rewind-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-rewind-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}

.dsh-rewind-popover {
  position: fixed;
  z-index: 1000;
  width: 288px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
  box-shadow: var(--dsw-shadow-lv3);
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-popover-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.dsh-rewind-popover-target {
  margin: 4px 0 10px;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  word-break: break-all;
}
.dsh-rewind-popover-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin: 0 0 6px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-rewind-popover-option:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-rewind-popover-option:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-rewind-popover-option-label {
  font-weight: 500;
}
.dsh-rewind-popover-option-hint {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rewind-popover-impact {
  margin: 4px 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  max-height: 160px;
  overflow: auto;
}
.dsh-rewind-popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dsh-rewind-popover-primary,
.dsh-rewind-popover-ghost {
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-rewind-popover-primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsh-rewind-popover-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}
.dsh-rewind-popover-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-rewind-popover-ghost {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rewind-popover-ghost:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dsh-rewind-guard-hint {
  position: fixed;
  z-index: 1000;
  max-width: min(440px, calc(100vw - 24px));
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
  box-shadow: var(--dsw-shadow-lv3);
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  pointer-events: none;
}

/* ---- Snapshot-cleanup configuration form (mirrors the harness plugin form) ---- */
/* The Plugins page draws the bundle's title, icon, crumb, and description; this
   is the form body only. Every value mirrors ui-settings-plugins'
   PluginConfigForm.module.css / fields.module.css /
   SubagentModelSelectionFields.module.css: those components are package-internal
   (the package ships lib/** only) and cannot be imported across packages, so the
   numbers are copied rather than the components. */
.dsh-rewind-cleanup-form {
  display: flex;
  flex-direction: column;
}
.dsh-rewind-cleanup-readonly,
.dsh-rewind-cleanup-unavailable {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
/* Auto-cleanup permission block: the label + Switch row, then the hint. */
.dsh-rewind-cleanup-permission {
  display: grid;
  gap: 6px;
  padding: 12px 0;
}
.dsh-rewind-cleanup-toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-cleanup-toggle-label {
  flex: 1;
  min-width: 0;
}
.dsh-rewind-cleanup-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsh-rewind-cleanup-field + .dsh-rewind-cleanup-field {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-rewind-cleanup-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-rewind-cleanup-label-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.dsh-rewind-cleanup-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-cleanup-label-group > .dsh-rewind-cleanup-label {
  flex: 0 1 auto;
}
.dsh-rewind-cleanup-badges {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.dsh-rewind-cleanup-reset {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-rewind-cleanup-reset:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-cleanup-reset:disabled {
  cursor: default;
}
.dsh-rewind-cleanup-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rewind-cleanup-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-rewind-cleanup-input {
  box-sizing: border-box;
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-cleanup-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-rewind-cleanup-input:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.dsh-rewind-cleanup-input-invalid {
  border-color: var(--dsw-alias-state-error-primary);
}
.dsh-rewind-cleanup-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 16px;
}
.dsh-rewind-cleanup-failed {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dsh-rewind-cleanup-save {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dsh-rewind-cleanup-save:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-rewind-cleanup-save:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
`
