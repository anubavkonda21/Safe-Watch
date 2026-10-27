import axe from 'axe-core';

/**
 * Runs axe-core on a rendered tree in jsdom and returns readable violations. jsdom has no layout, so rules that need real
 * geometry or colours (colour contrast, target size) cannot run here and are disabled: they were run in a real browser instead.
 * A clean result is NOT proof of accessibility; it only means this rule set found nothing in this state.
 */
export async function axeViolations(root: Element = document.body): Promise<string[]> {
  const result = await axe.run(root, {
    rules: { 'color-contrast': { enabled: false }, 'target-size': { enabled: false }, region: { enabled: false }, 'scrollable-region-focusable': { enabled: false } },
    resultTypes: ['violations'],
  });
  return result.violations.map((v) => `${v.id} [${v.impact}] ${v.help}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}
