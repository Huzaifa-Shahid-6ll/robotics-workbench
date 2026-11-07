import assert from 'node:assert/strict';

/** Sample rendered text and one keyboard focus outline against composited ancestor backgrounds. */
export async function auditContrast(page, theme, screen) {
  const focus = page.locator('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary').first();
  await page.keyboard.press('Tab');
  await focus.focus();
  const result = await page.evaluate(({ theme, screen }) => {
    const color = text => { const n = text.match(/[\d.]+/g)?.map(Number); if (!n || n.length < 3) throw Error(`Unsupported computed color ${text}`); return [n[0], n[1], n[2], n[3] ?? 1]; };
    const blend = (front, back) => [0, 1, 2].map(i => front[i] * front[3] + back[i] * (1 - front[3])).concat(1);
    const background = element => { const ancestors = []; for (let e = element; e; e = e.parentElement) ancestors.unshift(e); return ancestors.reduce((value, e) => blend(color(getComputedStyle(e).backgroundColor), value), [255, 255, 255, 1]); };
    const luminance = rgb => rgb.slice(0, 3).map(x => { const c = x / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((s, n, i) => s + n * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const samples = [];
    for (const element of [...document.querySelectorAll('button,input,select,textarea,.meta,.status,.error,.error-text,[role=status],[role=alert]')].slice(0, 150)) {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      if (!box.width || !box.height || style.visibility !== 'visible' || style.display === 'none') continue;
      const bg = background(element), foreground = blend(color(style.color), bg), pixels = parseFloat(style.fontSize), weight = parseFloat(style.fontWeight);
      const threshold = pixels >= 24 || pixels >= 18.66 && weight >= 700 ? 3 : 4.5;
      samples.push({ selector: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : element.className ? `.${String(element.className).trim().replace(/\s+/g, '.')}` : ''), text: (element.getAttribute('aria-label') || element.textContent || element.value || '').slice(0, 100), foreground: foreground.slice(0, 3), background: bg.slice(0, 3), ratio: ratio(foreground, bg), threshold, disabled: !!element.disabled });
    }
    const element = document.activeElement, style = getComputedStyle(element), surrounding = background(element.parentElement), outline = blend(color(style.outlineColor), surrounding);
    return { screen, theme, textSamples: samples, focus: { selector: element.tagName.toLowerCase(), outline: style.outlineColor, background: surrounding.slice(0, 3), width: style.outlineWidth, style: style.outlineStyle, ratio: ratio(outline, surrounding), threshold: 3 }, limitations: ['Representative visible text/controls and one keyboard focus outline, using fixture host-theme tokens. Does not certify all states, chart pixels, external viewers or arbitrary user themes.'] };
  }, { theme, screen });
  const failures = result.textSamples.filter(item => item.ratio + .01 < item.threshold);
  if (result.focus.style === 'none' || parseFloat(result.focus.width) === 0 || result.focus.ratio + .01 < 3) failures.push({ selector: 'keyboard focus', ...result.focus });
  result.disabledTextExceptions = result.textSamples.filter(item => item.disabled && item.ratio + .01 < item.threshold);
  assert.ok(result.textSamples.length > 0);
  assert.deepEqual(failures, [], JSON.stringify({ screen, theme, failures }));
  return result;
}
