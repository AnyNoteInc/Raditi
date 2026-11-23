// The probe that runs inside a frame (or a published page): it waits for the document, asks every
// font, measures Cyrillic text in each family against the fallback, reads the flags the scripts
// set, the computed width the stylesheets set and the natural width of each picture, and posts
// the result to its parent. Only inline script: the policies under test allow 'unsafe-inline'.

export const TEXT = 'Съешь же ещё этих мягких французских булок, да выпей чаю'

export function probeScript(spec) {
  return `(() => {
  const spec = ${JSON.stringify({ ...spec, text: TEXT })};
  window.__ran = {};
  const events = [];
  const violations = [];
  const urlOf = (t) => t.currentSrc || t.src || t.href || '';
  addEventListener('error', (e) => { const t = e.target; if (t && t !== window && t.tagName) events.push({ type: 'error', tag: t.tagName.toLowerCase(), url: urlOf(t) }) }, true);
  addEventListener('load', (e) => { const t = e.target; if (t && t !== window && t !== document && t.tagName) events.push({ type: 'load', tag: t.tagName.toLowerCase(), url: urlOf(t) }) }, true);
  document.addEventListener('securitypolicyviolation', (e) => violations.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, disposition: e.disposition }));
  const width = (family) => {
    const s = document.createElement('span');
    s.style.cssText = 'position:absolute;left:0;top:0;white-space:nowrap;visibility:hidden;font-size:32px;font-family:' + family;
    s.textContent = spec.text;
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return Math.round(w * 100) / 100;
  };
  async function finish() {
    const loads = await Promise.allSettled(spec.fonts.map((f) => document.fonts.load('32px "' + f + '"', spec.text)));
    await document.fonts.ready;
    await new Promise((r) => setTimeout(r, spec.grace));
    const faces = {};
    for (const face of document.fonts) faces[face.family.replace(/^["']|["']$/g, '')] = face.status;
    const fallback = width('monospace');
    const fonts = {};
    spec.fonts.forEach((f, i) => {
      const w = width('"' + f + '", monospace');
      fonts[f] = {
        status: faces[f] ?? 'absent',
        load: loads[i].status === 'fulfilled' ? 'fulfilled:' + loads[i].value.length : 'rejected:' + (loads[i].reason && loads[i].reason.name),
        check: document.fonts.check('32px "' + f + '"', spec.text),
        width: w,
        fallback,
        applied: Math.abs(w - fallback) > 2,
      };
    });
    const css = {};
    for (const id of spec.css) { const el = document.getElementById(id); css[id] = el ? getComputedStyle(el).width : 'absent'; }
    const img = {};
    for (const id of spec.img) { const el = document.getElementById(id); img[id] = el ? el.naturalWidth : -1; }
    let cookie;
    try { cookie = 'readable:' + document.cookie.length; } catch (e) { cookie = 'throws:' + e.name; }
    const result = { spike: 's2', fid: spec.fid, frame: location.hash.slice(1), origin: String(self.origin), url: location.origin + location.pathname, ran: window.__ran, fonts, css, img, events, violations, cookie };
    window.__result = result;
    try { if (parent !== window) parent.postMessage(result, '*'); } catch (e) {}
  }
  addEventListener('load', () => setTimeout(finish, 50));
})();`
}

/** The FontFace made from bytes in the document itself: no fetch, so no font-src at all. */
export function bufferFontScript(family, base64) {
  return `(() => {
  try {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
    const face = new FontFace(${JSON.stringify(family)}, bytes.buffer);
    document.fonts.add(face);
    face.load().catch(() => {});
  } catch (e) { (window.__ran = window.__ran || {})['buf-error'] = String(e && e.name); }
})();`
}
