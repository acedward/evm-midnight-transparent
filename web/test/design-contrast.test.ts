// @vitest-environment node
// Every text colour the design system (restyled in P4.4: light, one magenta accent) puts on a
// background meets WCAG 2.2 AA (4.5:1 for text; 3:1 for large text and for the parts of a control,
// 1.4.11). The pairs are read from web/src/design/tokens.css, so a colour change that breaks
// contrast fails here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/design/tokens.css', import.meta.url)), 'utf8');
const tokens = new Map<string, string>();
for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) tokens.set(m[1]!, m[2]!.toLowerCase());

const hex = (name: string): string => {
  const v = tokens.get(name);
  if (!v) throw new Error(`no colour token --${name}`);
  return v;
};

/** WCAG 2.x relative luminance of an sRGB colour. */
function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

const luminanceOf = (name: string): number => luminance(hex(name));

export function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

// [foreground, background, minimum ratio, where it is used]
const TEXT = 4.5;
const LARGE_OR_UI = 3;
export const PAIRS: ReadonlyArray<readonly [string, string, number, string]> = [
  ['ink', 'paper', TEXT, 'body text on the page'],
  ['ink', 'surface', TEXT, 'body text in cards, tables and the header'],
  ['ink', 'surface-alt', TEXT, 'text in copy fields, sub-stages, address chips'],
  ['ink', 'accent-soft', TEXT, 'body text in an info notice, a selected row'],
  ['slate', 'paper', TEXT, 'ledes'],
  ['slate', 'surface', TEXT, 'secondary text, tab labels, "no liquidity"'],
  ['slate', 'surface-alt', TEXT, 'unit suffixes, grey badges, the Sepolia chip'],
  ['muted', 'paper', TEXT, 'captions on the page'],
  ['muted', 'surface', TEXT, 'table heads, notes, hints, the tagline'],
  ['muted', 'surface-alt', TEXT, 'idle status pills, notes in quiet boxes'],
  ['muted', 'accent-soft', TEXT, 'a sub line in a selected row'],
  ['accent', 'paper', TEXT, 'links on the page'],
  ['accent', 'surface', TEXT, 'links and hashes in cards'],
  ['accent', 'surface-alt', TEXT, 'links in quiet boxes'],
  ['accent', 'warn-soft', TEXT, 'a link in a warning notice'],
  ['accent', 'danger-soft', TEXT, 'a link in a danger notice'],
  ['accent-ink', 'accent-soft', TEXT, 'the active tab, accent badges, the Midnight chip, info notice titles'],
  ['accent-ink', 'paper', TEXT, 'eyebrows'],
  ['accent-ink', 'surface', TEXT, 'the current stage, the copy action, a hovered secondary button'],
  ['on-accent', 'accent', TEXT, 'primary buttons, the logo mark'],
  ['on-accent', 'accent-hover', TEXT, 'primary buttons, hovered'],
  ['on-accent', 'danger', TEXT, 'the CLEAR ALL button'],
  ['on-accent', 'danger-hover', TEXT, 'the CLEAR ALL button, hovered'],
  ['on-accent', 'tooltip-bg', TEXT, 'a tooltip: why a button is greyed out (AA 00044)'],
  ['warn-ink', 'warn-soft', TEXT, 'warning notices, "in progress" pills'],
  ['warn-ink', 'surface', TEXT, 'warning text in a card'],
  ['positive', 'positive-soft', TEXT, 'green badges, the "Live" pill, success notices'],
  ['positive', 'surface', TEXT, 'bids, "live"'],
  ['positive', 'accent-soft', TEXT, 'a bid in a selected row'],
  ['danger', 'danger-soft', TEXT, 'danger notices, failed pills'],
  ['danger', 'surface', TEXT, 'asks, field errors, a failed stage, a danger dialog title'],
  ['danger', 'accent-soft', TEXT, 'an ask in a selected row'],
  ['ink', 'danger-soft', TEXT, 'body text in a danger notice'],
  ['ink', 'warn-soft', TEXT, 'body text in a warning notice'],
  ['ink', 'positive-soft', TEXT, 'body text in a success notice'],
  ['disabled-ink', 'disabled-bg', TEXT, 'a disabled button (exempt in WCAG; kept legible anyway)'],
  // Non-text contrast (WCAG 1.4.11): control borders, focus indicators, the tracker's markers.
  ['field-border', 'surface', LARGE_OR_UI, 'input borders'],
  ['accent', 'paper', LARGE_OR_UI, 'the focus ring on the page'],
  ['accent', 'surface', LARGE_OR_UI, 'the focus ring in cards, a focused field, done and current tracker markers'],
  ['accent', 'accent-soft', LARGE_OR_UI, 'the current tracker marker ring on its tint'],
  ['danger', 'surface', LARGE_OR_UI, 'a failed tracker marker'],
];

describe('the colour tokens (WCAG 2.2 AA)', () => {
  it('parses every token the pairs use', () => {
    for (const [fg, bg] of PAIRS) expect([hex(fg), hex(bg)]).toHaveLength(2);
  });

  it('computes contrast the WCAG way', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it.each(PAIRS.map(([fg, bg, min, use]) => ({ fg, bg, min, use })))(
    '--$fg on --$bg ≥ $min:1 ($use)',
    ({ fg, bg, min }) => {
      expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(min);
    },
  );

  it('keeps magenta the one accent: AA as text and as a filled button, and the page almost white', () => {
    // Owner, P4.4: "light colors, but modern. Magenta highlights, almost white background".
    expect(contrast(hex('accent'), hex('surface'))).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(hex('on-accent'), hex('accent'))).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(hex('ink'), hex('paper'))).toBeGreaterThanOrEqual(15);
    expect(luminanceOf('paper')).toBeGreaterThan(0.9);
    expect(luminanceOf('accent-soft')).toBeGreaterThan(0.8);
  });

  it('uses the gradient ends of the logo mark only behind the white letters, never as text', () => {
    // --accent-bright is lighter than --accent; text in magenta uses --accent or --accent-ink.
    expect(contrast(hex('accent-bright'), hex('surface'))).toBeLessThan(contrast(hex('accent'), hex('surface')));
    expect(contrast(hex('accent-ink'), hex('accent-soft'))).toBeGreaterThanOrEqual(TEXT);
  });
});
