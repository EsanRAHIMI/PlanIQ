import { chromium } from 'playwright';

interface FloorData {
  floor: any;
  rasterUrl: string | null;
  placements: any[];
}

/** Build a client-ready PDF: cover + one page per floor (raster + device overlay + legend) + device schedule. */
export async function renderProjectPdf(input: {
  project: any; floors: FloorData[]; devices: any[]; options: any;
}): Promise<Buffer> {
  const html = buildHtml(input);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({ format: 'A3', landscape: true, printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    return pdf;
  } finally {
    await browser.close();
  }
}

function esc(s: any) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }

function buildHtml({ project, floors, devices, options }: any): string {
  const byCode = new Map(devices.map((d: any) => [d.code, d]));
  const usedCodes = new Set<string>();
  floors.forEach((f: FloorData) => f.placements.forEach((p) => usedCodes.add(p.deviceCode)));

  const legend = [...usedCodes].map((code) => {
    const d: any = byCode.get(code) ?? { name: code, color: '#333' };
    return `<div class="lg"><span class="dot" style="background:${d.color}"></span>${esc(d.name)}</div>`;
  }).join('');

  const cover = `
    <section class="page cover">
      <div class="brand">PlanIQ</div>
      <h1>${esc(project?.name ?? 'Project')}</h1>
      <table class="meta">
        <tr><td>Project code</td><td>${esc(project?.code ?? '—')}</td></tr>
        <tr><td>Client</td><td>${esc(project?.client?.name ?? '—')}</td></tr>
        <tr><td>Contact</td><td>${esc(project?.client?.contact ?? '')} ${esc(project?.client?.phone ?? '')}</td></tr>
        <tr><td>Address</td><td>${esc(project?.client?.address ?? '—')}</td></tr>
        <tr><td>Floors</td><td>${floors.length}</td></tr>
        <tr><td>Date</td><td>${new Date().toLocaleDateString()}</td></tr>
      </table>
      ${options?.notes ? `<div class="notes"><b>Notes</b><p>${esc(options.notes)}</p></div>` : ''}
    </section>`;

  const floorPages = floors.map((f: FloorData) => {
    const markers = f.placements.filter((p) => !p.hidden).map((p) => {
      const d: any = byCode.get(p.deviceCode) ?? { color: '#E11D2A' };
      return `<div class="marker" style="left:${(p.position.x * 100).toFixed(2)}%;top:${(p.position.y * 100).toFixed(2)}%;transform:translate(-50%,-50%) rotate(${p.rotation}deg);border-color:${d.color}">
        <span style="background:${d.color}"></span>${esc(p.label ?? p.deviceCode)}</div>`;
    }).join('');
    return `
      <section class="page floor">
        <header><h2>${esc(f.floor.name)}</h2><span>${f.placements.length} devices</span></header>
        <div class="canvas">
          ${f.rasterUrl ? `<img src="${f.rasterUrl}" />` : '<div class="noimg">No plan image</div>'}
          ${markers}
        </div>
        ${options?.includeLegend !== false ? `<div class="legend">${legend}</div>` : ''}
      </section>`;
  }).join('');

  const schedule = options?.includeSchedule === false ? '' : (() => {
    const rows = [...usedCodes].map((code) => {
      const total = floors.reduce((n: number, f: FloorData) => n + f.placements.filter((p) => p.deviceCode === code).length, 0);
      const d: any = byCode.get(code) ?? { name: code };
      return `<tr><td>${esc(d.name)}</td><td>${esc(d.category ?? '')}</td><td>${total}</td></tr>`;
    }).join('');
    return `<section class="page schedule"><h2>Device Schedule</h2>
      <table><thead><tr><th>Device</th><th>Category</th><th>Qty</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  })();

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; font-family: Inter, Arial, sans-serif; }
    body { margin: 0; color: #0f172a; }
    .page { page-break-after: always; padding: 8mm; }
    .cover { display:flex; flex-direction:column; gap:16px; }
    .brand { color:#E11D2A; font-weight:800; letter-spacing:2px; }
    .cover h1 { font-size: 34px; margin: 0; }
    .meta { border-collapse: collapse; max-width: 520px; }
    .meta td { border-bottom:1px solid #e2e8f0; padding:8px 12px; }
    .meta td:first-child { color:#64748b; width:160px; }
    .notes { background:#f8fafc; border-left:4px solid #E11D2A; padding:12px 16px; max-width:640px; }
    .floor header, .schedule h2 { display:flex; justify-content:space-between; align-items:baseline; border-bottom:2px solid #0f172a; padding-bottom:6px; }
    .canvas { position:relative; margin-top:10px; border:1px solid #e2e8f0; }
    .canvas img { width:100%; display:block; }
    .noimg { padding:80px; text-align:center; color:#94a3b8; }
    .marker { position:absolute; font-size:8px; font-weight:600; white-space:nowrap; display:flex; align-items:center; gap:3px;
      background:rgba(255,255,255,.85); padding:1px 3px; border:1px solid; border-radius:3px; }
    .marker span { width:8px; height:8px; border-radius:2px; display:inline-block; }
    .legend { display:flex; flex-wrap:wrap; gap:10px 18px; margin-top:12px; padding-top:10px; border-top:1px dashed #cbd5e1; }
    .lg { display:flex; align-items:center; gap:6px; font-size:11px; }
    .dot { width:12px; height:12px; border-radius:3px; display:inline-block; }
    table { width:100%; border-collapse:collapse; margin-top:12px; }
    th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #e2e8f0; font-size:12px; }
    thead th { background:#f1f5f9; }
  </style></head><body>${cover}${floorPages}${schedule}</body></html>`;
}
