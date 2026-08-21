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
  menu: 'dsh-rewind-menu',
  menuTitle: 'dsh-rewind-menu-title',
  menuHint: 'dsh-rewind-menu-hint',
  menuList: 'dsh-rewind-menu-list',
  menuRow: 'dsh-rewind-menu-row',
  menuRowActive: 'dsh-rewind-menu-row--active',
  menuRowIndex: 'dsh-rewind-menu-row-index',
  menuRowTime: 'dsh-rewind-menu-row-time',
  menuRowText: 'dsh-rewind-menu-row-text',
  menuEmpty: 'dsh-rewind-menu-empty',
  menuMore: 'dsh-rewind-menu-more',
  menuActions: 'dsh-rewind-menu-actions',
  menuPrimary: 'dsh-rewind-menu-primary',
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

.dsh-rewind-menu {
  position: fixed;
  z-index: 1000;
  width: min(440px, calc(100vw - 24px));
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3));
  box-shadow: var(--dsw-shadow-lv3);
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dsh-rewind-menu-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.dsh-rewind-menu-hint {
  margin: 2px 0 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rewind-menu-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(40vh, 320px);
  overflow: auto;
}
.dsh-rewind-menu-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}
.dsh-rewind-menu-row:hover,
.dsh-rewind-menu-row--active {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-rewind-menu-row-index {
  flex: none;
  width: 18px;
  text-align: right;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-rewind-menu-row-time {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-rewind-menu-row-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rewind-menu-empty,
.dsh-rewind-menu-more {
  padding: 6px 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rewind-menu-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.dsh-rewind-menu-primary {
  padding: 5px 12px;
  border: none;
  border-radius: 8px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-rewind-menu-primary:hover {
  background: var(--dsw-alias-button-primary-hover);
}
`
