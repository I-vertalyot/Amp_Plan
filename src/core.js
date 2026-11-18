/* Amp Plan: core logic. Pure functions, no DOM, so it runs in the page and in Node tests. */
(function (root) {
  'use strict';

  const SCHEMA = 1;
  const MAX_HOST = 253;          // L-Acoustics: units on .1–.253, control computer on .254
  const MAX_IP = 4294967295;
  const MAX_DEVICES = 300;       // keeps one venue document well under the 256 KiB store limit
  const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
  const STATUSES = ['planned', 'set', 'ok'];
  const STATUS_LABEL = { planned: 'Planned', set: 'Set on unit', ok: 'Online' };

  // ---------------------------------------------------------------- IPv4
  function parseIp(s) {
    if (s == null) return null;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s).trim());
    if (!m) return null;
    let n = 0;
    for (let i = 1; i <= 4; i++) {
      const o = parseInt(m[i], 10);
      if (o > 255) return null;
      n = n * 256 + o;
    }
    return n;
  }
  function ipToStr(n) {
    if (n == null || !isFinite(n) || n < 0 || n > MAX_IP) return '';
    return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
  }
  const size = (prefix) => Math.pow(2, 32 - prefix);
  const netOf = (ip, prefix) => Math.floor(ip / size(prefix)) * size(prefix);
  const maskStr = (prefix) => ipToStr(Math.pow(2, 32) - size(prefix));
  const host = (n) => n % 256;
  const blockOf = (n) => Math.floor(n / 256) * 256;
  function blockLabel(b) { const s = ipToStr(b); return s.slice(0, s.lastIndexOf('.')); }
  const inNet = (ip, net, prefix) => ip != null && net != null && netOf(ip, prefix) === net;

  function clampInt(x, lo, hi, dflt) {
    const n = typeof x === 'number' ? x : parseInt(x, 10);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  }

  // Address ranges L-Acoustics units accept (owner's manuals, IP settings chapter).
  const LA_RANGES = [
    { from: parseIp('10.0.0.1'), to: parseIp('10.255.255.254'), label: '10.x.x.x' },
    { from: parseIp('100.64.0.1'), to: parseIp('100.127.255.254'), label: '100.64–127.x.x' },
    { from: parseIp('172.16.0.1'), to: parseIp('172.31.255.254'), label: '172.16–31.x.x' },
    { from: parseIp('169.254.0.1'), to: parseIp('169.254.255.254'), label: '169.254.x.x', notRecommended: true },
    { from: parseIp('192.168.0.1'), to: parseIp('192.168.255.254'), label: '192.168.x.x' },
  ];
  const laRange = (ip) => (ip == null ? null : LA_RANGES.find((r) => ip >= r.from && ip <= r.to) || null);

  const FD_UNIT = parseIp('192.168.1.100'); // factory default: amplified controllers, P1, LC16D
  const FD_LS10 = parseIp('192.168.1.200'); // factory default: LS10 AVB switch

  // ---------------------------------------------------------------- catalog
  // red: unit has a second (secondary) address in Milan redundant mode
  // la: L-Acoustics address rules apply   unit: counts as an LA Network Manager unit
  // auto: auto-assign may number it        legacy: LA4/LA8, fixed 192.168.1.x
  const GROUPS = [
    ['amp', 'Amplified controllers'],
    ['proc', 'Processing & conversion'],
    ['net', 'Network'],
    ['other', 'Control & other'],
  ];
  const MODELS = [
    { id: 'LA12X', group: 'amp', ch: 4, red: true, la: true, unit: true, auto: true, info: '4 ch · Milan-AVB · redundancy' },
    { id: 'LA7.16', group: 'amp', ch: 16, red: true, la: true, unit: true, auto: true, info: '16 ch · Milan-AVB · redundancy' },
    { id: 'LA4X', group: 'amp', ch: 4, red: false, la: true, unit: true, auto: true, info: '4 ch · Milan-AVB · no redundancy' },
    { id: 'LA2Xi', group: 'amp', ch: 4, red: true, la: true, unit: true, auto: true, info: '4 ch install · Milan-AVB or AES67 · redundancy' },
    { id: 'LA7.16i', group: 'amp', ch: 16, red: true, la: true, unit: true, auto: true, info: '16 ch install · Milan-AVB or AES67 · redundancy' },
    { id: 'LA1.16i', group: 'amp', ch: 16, red: true, la: true, unit: true, auto: true, info: '16 ch install · Milan-AVB or AES67 · redundancy' },
    { id: 'LA8', group: 'amp', ch: 4, red: false, la: true, unit: true, auto: true, legacy: true, info: 'Legacy · 100 Mb/s · 192.168.1.x only' },
    { id: 'LA4', group: 'amp', ch: 4, red: false, la: true, unit: true, auto: true, legacy: true, info: 'Legacy · 100 Mb/s · 192.168.1.x only' },
    { id: 'P1', group: 'proc', ch: 0, red: true, la: true, unit: true, auto: true, info: 'Processor · Milan-AVB · redundancy' },
    { id: 'LC16D', group: 'proc', ch: 0, red: true, la: true, unit: true, auto: true, info: 'AES/EBU + MADI network converter · redundancy' },
    { id: 'L-ISA Processor II', group: 'proc', ch: 0, red: false, auto: false, info: 'Runs from L-ISA Controller · set its address by hand' },
    { id: 'LS10', group: 'net', ch: 0, red: false, auto: true, ls10: true, info: 'AVB switch · management address (ships at .200)' },
    { id: 'Switch', label: 'Other network switch', group: 'net', ch: 0, red: false, auto: false, info: 'Set by hand · leave empty if unmanaged' },
    { id: 'Wi-Fi', label: 'Wi-Fi router / access point', group: 'net', ch: 0, red: false, auto: false, info: 'Set by hand' },
    { id: 'Computer', label: 'Computer / laptop', group: 'other', ch: 0, red: false, auto: false, info: 'Set by hand' },
    { id: 'Console', label: 'Mixing console', group: 'other', ch: 0, red: false, auto: false, info: 'Set by hand' },
    { id: 'Other', label: 'Other device', group: 'other', ch: 0, red: false, auto: false, info: 'Set by hand' },
  ];
  MODELS.forEach((m) => { if (!m.label) m.label = m.id; });
  const MODEL_MAP = Object.fromEntries(MODELS.map((m) => [m.id, m]));
  const modelOf = (id) => MODEL_MAP[id] || MODEL_MAP.Other;

  // Touring racks: devices created by "Add rack" (L-Acoustics product pages).
  const RACKS = [
    { id: 'LA-RAK II AVB', amps: ['LA12X', 'LA12X', 'LA12X'], ls10: 2, info: '3 × LA12X + 2 × LS10' },
    { id: 'LA-RAK III', amps: ['LA7.16', 'LA7.16', 'LA7.16'], ls10: 2, info: '3 × LA7.16 + 2 × LS10' },
    { id: 'LA-RAK II', amps: ['LA12X', 'LA12X', 'LA12X'], ls10: 0, info: '3 × LA12X' },
    { id: 'LA-RAK', amps: ['LA8', 'LA8', 'LA8'], ls10: 0, info: '3 × LA8 (legacy)' },
  ];
  const RACK_MAP = Object.fromEntries(RACKS.map((r) => [r.id, r]));

  const DEFAULT_ZONES = ['Main L', 'Main R', 'Subs', 'Front fill', 'Out fill', 'Delays', 'Monitors', 'Control'];
  const DEFAULT_ZONE_COLORS = [0, 1, 3, 4, 5, 6, 2, 8];
  // two sides of the stage; older plans with a Center side are moved onto these when loaded
  const SIDES = ['L', 'R'];
  const SIDE_LABEL = { L: 'Left', C: 'Center', R: 'Right' };
  const RACK_MODEL = { 'LA-RAK II AVB': 'LA12X', 'LA-RAK II': 'LA12X', 'LA-RAK III': 'LA7.16', 'LA-RAK': 'LA8' };
  const DEFAULT_RACK_TYPE = { LA12X: 'LA-RAK II AVB', 'LA7.16': 'LA-RAK III', LA8: 'LA-RAK' };
  // Which side of the stage a zone usually sits on, from its name (English and Czech).
  function inferSide(name) {
    const words = String(name || '').toLowerCase().split(/[\s_\-\/.,()+]+/).filter(Boolean);
    const L = ['l', 'left', 'sl', 'levá', 'leva', 'levý', 'levy', 'vlevo'];
    const R = ['r', 'right', 'sr', 'pravá', 'prava', 'pravý', 'pravy', 'vpravo'];
    if (words.some((w) => L.indexOf(w) >= 0)) return 'L';
    if (words.some((w) => R.indexOf(w) >= 0)) return 'R';
    return '';
  }
  // a side for a zone whose name doesn't say: alternate Left / Right so both sides fill up
  function sideFor(name, k) { return inferSide(name) || (k % 2 ? 'R' : 'L'); }


  // Enclosure drive capacity per amplified controller, as [per output, per amp].
  // Source: L-Acoustics Amplification Reference technical bulletin v15 and Preset Guide v25.
  // LA7.16 figures assume nominal use (L-SMART); "i" install versions use the same numbers.
  const SPEAKER_SERIES = ['K Series', 'L Series', 'A Series', 'X Series', 'Subwoofers', 'Syva & Soka', 'ARCS'];
  const SPEAKERS = [
    { id: 'K1', series: 'K Series', d: { LA12X: [2, 2] } },
    { id: 'K2', series: 'K Series', d: { LA12X: [3, 3], 'LA7.16': [1, 4], LA4X: [1, 1] } },
    { id: 'K3', series: 'K Series', d: { LA12X: [3, 6], 'LA7.16': [1, 8], LA4X: [1, 2] } },
    { id: 'Kara II', series: 'K Series', d: { LA12X: [3, 6], 'LA7.16': [1, 8], LA4X: [2, 4] } },
    { id: 'Kara', series: 'K Series', d: { LA12X: [3, 6], LA4X: [2, 4] } },
    { id: 'Kiva II', series: 'K Series', d: { LA12X: [6, 24], 'LA7.16': [2, 32], LA4X: [2, 8] } },
    { id: 'L2', series: 'L Series', d: { 'LA7.16': [1, 1] } },
    { id: 'L2D', series: 'L Series', d: { 'LA7.16': [1, 1] } },
    { id: 'A10 Focus/Wide', series: 'A Series', d: { LA12X: [3, 12], 'LA7.16': [1, 16], LA4X: [2, 8] } },
    { id: 'A15 Focus/Wide', series: 'A Series', d: { LA12X: [3, 12], 'LA7.16': [1, 10], LA4X: [1, 4] } },
    { id: 'X4i', series: 'X Series', d: { LA12X: [6, 24], 'LA7.16': [4, 64], LA4X: [4, 16] } },
    { id: '5XT', series: 'X Series', d: { LA12X: [6, 24], 'LA7.16': [3, 48], LA4X: [4, 16] } },
    { id: 'X6i', series: 'X Series', d: { LA12X: [3, 12], 'LA7.16': [1, 16], LA4X: [2, 8] } },
    { id: 'X8', series: 'X Series', d: { LA12X: [3, 12], 'LA7.16': [1, 16], LA4X: [2, 8] } },
    { id: 'X12', series: 'X Series', d: { LA12X: [3, 12], 'LA7.16': [1, 14], LA4X: [1, 4] } },
    { id: 'X15 HiQ', series: 'X Series', d: { LA12X: [3, 6], 'LA7.16': [1, 8], LA4X: [1, 2] } },
    { id: 'KS28', series: 'Subwoofers', d: { LA12X: [1, 4] } },
    { id: 'KS21', series: 'Subwoofers', d: { LA12X: [2, 8], 'LA7.16': [1, 8], LA4X: [1, 4] } },
    { id: 'K1-SB', series: 'Subwoofers', d: { LA12X: [1, 4] } },
    { id: 'SB28', series: 'Subwoofers', d: { LA12X: [1, 4] } },
    { id: 'SB18', series: 'Subwoofers', d: { LA12X: [3, 12], 'LA7.16': [1, 6], LA4X: [1, 4] } },
    { id: 'SB15m', series: 'Subwoofers', d: { LA12X: [3, 12], 'LA7.16': [1, 9], LA4X: [1, 4] } },
    { id: 'SB10i', series: 'Subwoofers', d: { LA12X: [3, 12], 'LA7.16': [2, 32], LA4X: [2, 8] } },
    { id: 'SB6i', series: 'Subwoofers', d: { LA12X: [2, 8], 'LA7.16': [1, 16], LA4X: [1, 4] } },
    { id: 'Syva', series: 'Syva & Soka', d: { LA12X: [3, 12], 'LA7.16': [1, 10], LA4X: [1, 4] } },
    { id: 'Syva Low', series: 'Syva & Soka', d: { LA12X: [2, 6], 'LA7.16': [1, 8], LA4X: [1, 4] } },
    { id: 'Syva Sub', series: 'Syva & Soka', d: { LA12X: [3, 12], 'LA7.16': [1, 16], LA4X: [1, 4] } },
    { id: 'Soka', series: 'Syva & Soka', d: { LA12X: [3, 12], 'LA7.16': [1, 16], LA4X: [2, 8] } },
    { id: 'ARCS II', series: 'ARCS', d: { LA12X: [3, 6], LA4X: [1, 2] } },
    { id: 'ARCS Wide/Focus', series: 'ARCS', d: { LA12X: [3, 12], LA4X: [1, 4] } },
  ];
  const SPEAKER_MAP = Object.fromEntries(SPEAKERS.map((x) => [x.id, x]));
  const DRIVE_AMPS = ['LA12X', 'LA7.16', 'LA4X'];

  // ---------------------------------------------------------------- ids, text
  function uid(prefix) {
    return (prefix || 'x') + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 8);
  }
  function str(x, max) {
    const s = typeof x === 'string' ? x : typeof x === 'number' && isFinite(x) ? String(x) : '';
    return s.slice(0, max || 200);
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function stableStringify(x) {
    if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
    if (x && typeof x === 'object') {
      return '{' + Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
    }
    return JSON.stringify(x === undefined ? null : x);
  }

  // ---------------------------------------------------------------- venue model
  function newDevice(o) {
    o = o || {};
    return {
      id: o.id || uid('d'), name: str(o.name, 80), model: MODEL_MAP[o.model] ? o.model : 'Other', zone: o.zone || '',
      ip: str(o.ip, 40), net: o.net === 'sec' ? 'sec' : 'pri', location: str(o.location, 80), port: str(o.port, 80),
      serial: str(o.serial, 80), notes: str(o.notes, 300), status: STATUSES.includes(o.status) ? o.status : 'planned',
      rack: str(o.rack, 40), slot: clampInt(o.slot, -1, 15, -1), preset: str(o.preset, 40), drives: str(o.drives, 40),
      // side of the plan for an amp outside the racks; '' = its zone's side
      side: SIDES.indexOf(o.side) >= 0 ? o.side : '',
      pos: cleanPos(o.pos),
    };
  }

  function sanitizeVenue(id, raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const n = raw.net && typeof raw.net === 'object' ? raw.net : {};
    const a = n.assign && typeof n.assign === 'object' ? n.assign : {};
    const zones = [];
    const zids = new Set();
    let unnamed = 0;
    for (const z of Array.isArray(raw.zones) ? raw.zones.slice(0, 40) : []) {
      if (!z || typeof z !== 'object') continue;
      let zid = str(z.id, 40);
      if (!SAFE_ID.test(zid) || zids.has(zid)) zid = uid('z');
      zids.add(zid);
      const zname = str(z.name, 60) || 'Zone';
      zones.push({ id: zid, name: zname, color: clampInt(z.color, 0, 8, Math.min(zones.length, 8)), side: SIDES.indexOf(z.side) >= 0 ? z.side : inferSide(zname) || (unnamed++ % 2 ? 'R' : 'L') });
    }
    if (!zones.length) { zones.push({ id: 'z1', name: 'Main', color: 0, side: 'L' }); zids.add('z1'); }
    const zoneSide = new Map(zones.map((z) => [z.id, z.side]));
    const racks = [];
    const rids = new Set();
    for (const r of Array.isArray(raw.racks) ? raw.racks.slice(0, 120) : []) {
      if (!r || typeof r !== 'object') continue;
      let rid = str(r.id, 40);
      if (!SAFE_ID.test(rid) || rids.has(rid)) rid = uid('r');
      rids.add(rid);
      racks.push({ id: rid, name: str(r.name, 40) || 'Rack', side: SIDES.indexOf(r.side) >= 0 ? r.side : '',  size: clampInt(r.size, 1, 8, 3), type: RACK_MAP[r.type] ? r.type : '', pos: cleanPos(r.pos) });
    }
    const legacy = new Map();
    const speakers = sanitizeSpeakers(raw.speakers, zids, zones[0].id);
    const gids = new Set(speakers.map((g) => g.id));
    const devices = [];
    const dids = new Set();
    for (const d of Array.isArray(raw.devices) ? raw.devices.slice(0, MAX_DEVICES) : []) {
      if (!d || typeof d !== 'object') continue;
      let did = str(d.id, 40);
      if (!SAFE_ID.test(did) || dids.has(did)) did = uid('d');
      dids.add(did);
      const dev = newDevice(Object.assign({}, d, { id: did }));
      dev.ip = dev.ip.trim();
      // '' means "no zone" on purpose; anything else unknown falls back to the first zone
      dev.zone = d.zone === '' ? '' : zids.has(d.zone) ? d.zone : zones[0].id;
      if (!gids.has(dev.drives)) dev.drives = '';
      if (dev.rack && !rids.has(dev.rack)) {
        // older plans stored the rack name on each device: turn it into a rack
        if (!legacy.has(dev.rack) && racks.length < 120) {
          const r = { id: uid('r'), name: dev.rack.slice(0, 40), side: zoneSide.get(dev.zone) || 'L', size: 3, type: RACK_MAP[d.rackType] ? d.rackType : '', legacy: true };
          racks.push(r);
          rids.add(r.id);
          legacy.set(dev.rack, r.id);
        }
        dev.rack = legacy.get(dev.rack) || '';
        dev.slot = -1;
      }
      devices.push(dev);
    }
    for (const r of racks) {
      const inside = devices.filter((d) => d.rack === r.id && MODEL_MAP[d.model].group === 'amp');
      if (!r.side) {
        // a rack that stood in the old Center column goes to its amps' side, else to the side with fewer racks
        const zs = inside.map((d) => zoneSide.get(d.zone)).filter(Boolean);
        const nl = racks.filter((x) => x.side === 'L').length;
        const nr = racks.filter((x) => x.side === 'R').length;
        r.side = zs.length ? zs[0] : nl <= nr ? 'L' : 'R';
      }
      if (r.legacy) { r.size = Math.min(8, Math.max(r.size, inside.length)); delete r.legacy; }
      const used = new Set();
      const later = [];
      for (const d of inside) { if (d.slot >= 0 && d.slot < r.size && !used.has(d.slot)) used.add(d.slot); else later.push(d); }
      for (const d of later) {
        let k = 0;
        while (used.has(k) && k < r.size) k++;
        if (k < r.size) { d.slot = k; used.add(k); } else { d.rack = ''; d.slot = -1; }
      }
    }
    for (const d of devices) {
      if (!d.rack || !rids.has(d.rack)) { d.rack = ''; d.slot = -1; } else if (MODEL_MAP[d.model].group !== 'amp') d.slot = -1;
    }
    return {
      id,
      name: str(raw.name, 120) || 'Untitled venue',
      date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : '',
      city: str(raw.city, 120),
      notes: str(raw.notes, 2000),
      net: {
        network: str(n.network, 40).trim() || '192.168.1.0',
        prefix: clampInt(n.prefix, 8, 24, 24),
        block: str(n.block, 20).trim(),
        computer: str(n.computer, 40).trim(),
        gateway: str(n.gateway, 40).trim(),
        dhcpFrom: str(n.dhcpFrom, 40).trim(),
        dhcpTo: str(n.dhcpTo, 40).trim(),
        redundancy: !!n.redundancy,
        assign: {
          scheme: a.scheme === 'sequential' ? 'sequential' : 'zones',
          start: clampInt(a.start, 1, MAX_HOST, 11),
          size: clampInt(a.size, 2, 100, 10),
          avoidDefaults: a.avoidDefaults !== false,
        },
      },
      zones,
      speakers,
      racks,
      devices,
      // drawing order of racks and single amps in the plan, as keys "r:<rack id>" / "d:<device id>"
      planOrder: (racks.concat(devices).forEach(migratePos), Array.isArray(raw.planOrder) ? raw.planOrder : []).filter((k) => typeof k === 'string' && /^[rd]:/.test(k) && SAFE_ID.test(k.slice(2))).slice(0, 2000),
      rackSize: sanitizeRackSize(raw.rackSize),
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
  }

  function sanitizeSpeakers(list, zids, firstZone) {
    const out = [];
    const ids = new Set();
    for (const g of Array.isArray(list) ? list.slice(0, 80) : []) {
      if (!g || typeof g !== 'object') continue;
      let id = str(g.id, 40);
      if (!SAFE_ID.test(id) || ids.has(id)) id = uid('s');
      ids.add(id);
      const known = !!SPEAKER_MAP[g.model];
      const model = known ? g.model : 'Custom';
      const opts = driveOptions(model);
      out.push({
        id, model, custom: known ? '' : str(g.custom || (g.model !== 'Custom' ? g.model : ''), 40),
        qty: clampInt(g.qty, 0, 999, 0), zone: zids.has(g.zone) ? g.zone : firstZone,
        amp: opts.indexOf(g.amp) >= 0 ? g.amp : opts[0], per: clampInt(g.per, 0, 64, 0),
      });
    }
    return out;
  }
  function sanitizeRackSize(rs) {
    const out = {};
    if (rs && typeof rs === 'object') {
      for (const k of Object.keys(rs)) if (MODEL_MAP[k] && MODEL_MAP[k].group === 'amp') out[k] = clampInt(rs[k], 0, 12, 0);
    }
    return out;
  }

  // Document body as stored (no id: the document id is the venue id).
  function serialize(v) {
    return {
      schema: SCHEMA, name: v.name, date: v.date, city: v.city, notes: v.notes,
      net: {
        network: v.net.network, prefix: v.net.prefix, block: v.net.block, computer: v.net.computer, gateway: v.net.gateway,
        dhcpFrom: v.net.dhcpFrom, dhcpTo: v.net.dhcpTo, redundancy: !!v.net.redundancy,
        assign: { scheme: v.net.assign.scheme, start: v.net.assign.start, size: v.net.assign.size, avoidDefaults: !!v.net.assign.avoidDefaults },
      },
      zones: v.zones.map((z) => ({ id: z.id, name: z.name, color: z.color, side: z.side || 'L' })),
      racks: (v.racks || []).map((r) => ({ id: r.id, name: r.name, side: r.side, size: r.size, type: r.type || '', pos: r.pos ? { c: r.pos.c, r: r.pos.r, v: POS_V } : null })),
      planOrder: (v.planOrder || []).slice(),
      speakers: (v.speakers || []).map((g) => ({ id: g.id, model: g.model, custom: g.custom || '', qty: g.qty, zone: g.zone, amp: g.amp, per: g.per || 0 })),
      devices: v.devices.map((d) => ({
        id: d.id, name: d.name, model: d.model, zone: d.zone, ip: d.ip, net: d.net, location: d.location,
        port: d.port, serial: d.serial, notes: d.notes, status: d.status, rack: d.rack || '', slot: typeof d.slot === 'number' ? d.slot : -1, preset: d.preset || '', drives: d.drives || '', side: d.side || '', pos: d.pos ? { c: d.pos.c, r: d.pos.r, v: POS_V } : null,
      })),
      rackSize: Object.assign({}, v.rackSize || {}),
      createdAt: v.createdAt || 0, updatedAt: v.updatedAt || 0,
    };
  }

  function makeVenue(o) {
    o = o || {};
    const now = Date.now();
    return sanitizeVenue(uid('v'), {
      name: o.name || 'New venue', date: o.date || '', city: o.city || '',
      net: { network: '192.168.1.0', prefix: 24, computer: '192.168.1.254', redundancy: false, assign: { scheme: 'zones', start: 11, size: 10, avoidDefaults: true } },
      zones: (o.zones || DEFAULT_ZONES).map((name, i) => ({ id: 'z' + (i + 1), name, color: o.colors ? o.colors[i] : DEFAULT_ZONE_COLORS[i] != null ? DEFAULT_ZONE_COLORS[i] : Math.min(i, 8) })),
      devices: [], createdAt: now, updatedAt: now,
    });
  }

  function cloneVenue(v, name) {
    const body = JSON.parse(JSON.stringify(serialize(v)));
    body.name = name || v.name + ' (copy)';
    body.devices.forEach((d) => { d.status = 'planned'; });
    body.createdAt = body.updatedAt = Date.now();
    return sanitizeVenue(uid('v'), body);
  }

  function rackDevices(rackId, rackName, zoneId, opts) {
    opts = opts || {};
    const r = RACK_MAP[rackId];
    if (!r) return [];
    const loc = opts.location || rackName;
    const out = r.amps.map((m, i) => newDevice({ name: rackName + ' ' + 'ABC'[i], model: m, zone: zoneId, location: loc }));
    if (opts.ls10 !== false) {
      if (r.ls10 >= 1) out.push(newDevice({ name: rackName + ' LS10 PRI', model: 'LS10', zone: zoneId, location: loc, net: 'pri' }));
      if (r.ls10 >= 2) out.push(newDevice({ name: rackName + ' LS10 SEC', model: 'LS10', zone: zoneId, location: loc, net: 'sec' }));
    }
    return out;
  }

  // ---------------------------------------------------------------- physical racks
  const isAmpModel = (id) => modelOf(id).group === 'amp';
  const rackById = (v, id) => (id ? (v.racks || []).find((r) => r.id === id) || null : null);
  function rackSlots(v, r) {
    const out = new Array(r.size).fill(null);
    for (const d of v.devices) if (d.rack === r.id && d.slot >= 0 && d.slot < r.size && isAmpModel(d.model)) out[d.slot] = d;
    return out;
  }
  function rackModel(v, r) {
    if (RACK_MODEL[r.type]) return RACK_MODEL[r.type];
    const d = v.devices.find((x) => x.rack === r.id && isAmpModel(x.model));
    return d ? d.model : null;
  }
  function nextRackName(v) {
    let max = 0;
    for (const r of v.racks || []) { const m = /^RAK (\d+)$/.exec(r.name); if (m) max = Math.max(max, +m[1]); }
    return 'RAK ' + (max + 1);
  }
  function addRack(v, o) {
    o = o || {};
    const r = { id: uid('r'), name: str(o.name, 40) || nextRackName(v), side: SIDES.indexOf(o.side) >= 0 ? o.side : 'L', size: clampInt(o.size, 1, 8, 3), type: RACK_MAP[o.type] ? o.type : '' };
    if (!v.racks) v.racks = [];
    v.racks.push(r);
    return r;
  }
  function addRackWithDevices(v, type, name, zoneId, opts) {
    const spec = RACK_MAP[type];
    if (!spec) return null;
    const z = v.zones.find((x) => x.id === zoneId);
    const r = addRack(v, { name, side: z ? z.side : 'L', size: spec.amps.length, type });
    const devs = rackDevices(type, r.name, zoneId, opts);
    let k = 0;
    for (const d of devs) { d.rack = r.id; d.slot = isAmpModel(d.model) ? k++ : -1; }
    v.devices.push(...devs);
    return { rack: r, devices: devs };
  }
  // Put an amp in a rack slot (swapping with whoever is there), or take it out with rackId ''.
  function placeDevice(v, devId, rackId, slot) {
    const d = v.devices.find((x) => x.id === devId);
    if (!d) return false;
    const fromRack = rackById(v, d.rack) ? d.rack : '';
    const fromSlot = fromRack ? d.slot : -1;
    if (!rackId) { d.rack = ''; d.slot = -1; return true; }
    const r = rackById(v, rackId);
    if (!r || slot < 0 || slot >= r.size) return false;
    const other = v.devices.find((x) => x.id !== d.id && x.rack === r.id && x.slot === slot && isAmpModel(x.model));
    if (other) {
      if (fromRack && fromSlot >= 0) { other.rack = fromRack; other.slot = fromSlot; } else { other.rack = ''; other.slot = -1; }
    }
    d.rack = r.id;
    d.slot = slot;
    return true;
  }
  // ---- the plan grid: one cell = one amp (a rack's width, one slot's height). A position is counted
  // from its side's outer edge: Left racks from the left edge, Right racks from the right edge, so when
  // the plan is zoomed out the extra columns open up in the middle and nothing jumps sides.
  // A rack is size + 2 cells tall (its name on top), a single amp 3.
  const GRID_COLS = 8;
  // Columns are a third of a rack wide, so racks can sit a third of a rack apart. A rack or single amp
  // takes GRID_SPAN columns. Positions saved as v:3 count these small columns; v:2 counted whole racks.
  const GRID_SPAN = 3;
  const POS_V = 3;
  function cleanPos(p) {
    if (!p || typeof p !== 'object') return null;
    const c = Number(p.c);
    const r = Number(p.r);
    if (!Number.isFinite(c) || !Number.isFinite(r)) return null;
    const ver = p.v === 3 ? 3 : p.v === 2 ? 2 : 1;
    return { c: Math.max(0, Math.min(ver === 3 ? 200 : 63, Math.round(c))), r: Math.max(0, Math.min(400, Math.round(r))), v: ver };
  }
  // v1: columns 0–7 of one 8-column grid; v2: whole racks from the side's outer edge; v3: thirds of a rack
  function migratePos(obj) {
    if (!obj.pos || obj.pos.v === POS_V) return;
    if (obj.pos.v !== 2) {
      const side = obj.pos.c < 4 ? 'L' : 'R';
      obj.side = side;
      obj.pos = { c: side === 'L' ? obj.pos.c : 7 - Math.min(7, obj.pos.c), r: obj.pos.r, v: 2 };
    }
    obj.pos = { c: obj.pos.c * GRID_SPAN, r: obj.pos.r, v: POS_V };
  }
  const itemRows = (it) => (it.rack ? it.rack.size + 2 : 3);
  const overlaps = (a, c, r, h) => a.c < c + GRID_SPAN && c < a.c + GRID_SPAN && r < a.r + a.h && a.r < r + h;
  const halfOf = (half) => Math.max(GRID_SPAN, half || (GRID_COLS / 2) * GRID_SPAN);
  const clampC = (c, half) => Math.max(0, Math.min(half - GRID_SPAN, Math.round(c)));
  // where everything sits on each side, with `half` small columns per side: [{ key, rack|dev, side, c, r, h }]
  function gridLayout(v, half) {
    half = halfOf(half);
    const out = [];
    for (const side of SIDES) {
      const all = planItems(v, side);
      const placed = [];
      const free = (c, r, h) => !placed.some((p) => overlaps(p, c, r, h));
      for (const it of all) {
        const pos = (it.rack || it.dev).pos;
        if (!pos) continue;
        const h = itemRows(it);
        const c = clampC(pos.c, half);
        let r = pos.r;
        while (!free(c, r, h)) r++;
        placed.push(Object.assign(it, { side, c, r, h }));
      }
      // items with no place yet: whole-rack columns, the two outer ones first, the one that ends highest
      const slots = [];
      for (let c = 0; c + GRID_SPAN <= half; c += GRID_SPAN) slots.push(c);
      const bottom = (c) => placed.filter((p) => p.c < c + GRID_SPAN && c < p.c + GRID_SPAN).reduce((m, p) => Math.max(m, p.r + p.h + 1), 0);
      for (const it of all) {
        if (it.c != null) continue;
        const h = itemRows(it);
        const near = slots.slice(0, 2);
        let pick = near.reduce((a, b) => (bottom(b) < bottom(a) ? b : a));
        if (bottom(pick) > 20) pick = slots.reduce((a, b) => (bottom(b) < bottom(a) ? b : a));
        let r = bottom(pick);
        while (!free(pick, r, h)) r++;
        placed.push(Object.assign(it, { side, c: pick, r, h }));
      }
      out.push(...placed);
    }
    return out;
  }
  // Put a rack ("r:id") or single amp ("d:id") on a side at a cell (c counted from that side's edge).
  // Everything else keeps the place it has now; a taken cell slides the item down to the first gap.
  function placeOnGrid(v, key, side, c, r, half) {
    if (SIDES.indexOf(side) < 0) return false;
    half = halfOf(half);
    const lay = gridLayout(v, half);
    for (const it of lay) (it.rack || it.dev).pos = { c: it.c, r: it.r, v: POS_V };
    const me = lay.find((it) => it.key === key);
    const obj = me ? me.rack || me.dev : key[0] === 'r' ? rackById(v, key.slice(2)) : v.devices.find((d) => d.id === key.slice(2));
    if (!obj) return false;
    const h = me ? me.h : key[0] === 'r' ? obj.size + 2 : 3;
    c = clampC(c, half);
    r = Math.max(0, Math.round(r));
    const others = lay.filter((it) => it.key !== key && it.side === side);
    while (others.some((p) => overlaps(p, c, r, h))) r++;
    obj.pos = { c, r, v: POS_V };
    obj.side = side;
    return true;
  }
  // Move several racks / single amps at once: moves = [{ key, side, c, r }]. The group keeps its shape;
  // if any of it would land on something that stays put, the whole group slides down until it fits.
  function placeGroup(v, moves, half) {
    half = halfOf(half);
    const lay = gridLayout(v, half);
    for (const it of lay) (it.rack || it.dev).pos = { c: it.c, r: it.r, v: POS_V };
    const keys = new Set(moves.map((m) => m.key));
    const items = [];
    for (const m of moves) {
      if (SIDES.indexOf(m.side) < 0) continue;
      const me = lay.find((it) => it.key === m.key);
      if (!me) continue;
      items.push({ obj: me.rack || me.dev, side: m.side, c: clampC(m.c, half), r: Math.max(0, Math.round(m.r)), h: me.h });
    }
    if (!items.length) return false;
    // squeezed against an edge, two of the group can land on each other: stack them
    items.sort((a, b) => a.r - b.r);
    items.forEach((a, i) => { while (items.slice(0, i).some((b) => b.side === a.side && overlaps(b, a.c, a.r, a.h))) a.r++; });
    const others = lay.filter((it) => !keys.has(it.key));
    const hit = (dr) => items.some((a) => others.some((p) => p.side === a.side && overlaps(p, a.c, a.r + dr, a.h)));
    let dr = 0;
    while (hit(dr) && dr < 2000) dr++;
    for (const a of items) { a.obj.pos = { c: a.c, r: a.r + dr, v: POS_V }; a.obj.side = a.side; }
    return true;
  }

  // ---- the plan's drawing order: racks and single amps (amps outside racks) share one order per side
  function singleSide(v, d) {
    if (SIDES.indexOf(d.side) >= 0) return d.side;
    const z = v.zones.find((x) => x.id === d.zone);
    return z && SIDES.indexOf(z.side) >= 0 ? z.side : 'L';
  }
  // everything drawn on one side, in order: [{ key, rack } | { key, dev }]
  function planItems(v, side) {
    const order = new Map((v.planOrder || []).map((k, i) => [k, i]));
    const items = [];
    (v.racks || []).forEach((r, i) => { if (r.side === side) items.push({ key: 'r:' + r.id, rack: r, n: order.has('r:' + r.id) ? order.get('r:' + r.id) : 100000 + i }); });
    v.devices.forEach((d, i) => {
      if (isAmpModel(d.model) && !rackById(v, d.rack) && singleSide(v, d) === side) items.push({ key: 'd:' + d.id, dev: d, n: order.has('d:' + d.id) ? order.get('d:' + d.id) : 200000 + i });
    });
    return items.sort((a, b) => a.n - b.n);
  }
  // Move a rack ("r:id") or a single amp ("d:id") before or after another item, or to the end of a side.
  // Items always sit in the grid in this order, so the plan stays tidy wherever one is dropped.
  function moveItem(v, key, side, targetKey, after) {
    if (SIDES.indexOf(side) < 0 || key === targetKey) return false;
    const isRack = key.indexOf('r:') === 0;
    const obj = isRack ? rackById(v, key.slice(2)) : v.devices.find((d) => d.id === key.slice(2));
    if (!obj) return false;
    const full = [].concat(...SIDES.map((sd) => planItems(v, sd).map((x) => x.key)));
    const before = full.join() + '|' + (isRack ? obj.side : singleSide(v, obj));
    if (isRack) obj.side = side; else obj.side = side;
    const list = full.filter((k) => k !== key);
    let at = targetKey ? list.indexOf(targetKey) : -1;
    if (at >= 0) at += after ? 1 : 0;
    else {
      const onSide = planItems(v, side).map((x) => x.key).filter((k) => k !== key);
      at = onSide.length ? list.indexOf(onSide[onSide.length - 1]) + 1 : list.length;
    }
    list.splice(at, 0, key);
    v.planOrder = list;
    // keep the rack array in the same order (the picture export draws from it)
    const pos = new Map(list.map((k, i) => [k, i]));
    v.racks.sort((a, b) => (pos.has('r:' + a.id) ? pos.get('r:' + a.id) : 1e9) - (pos.has('r:' + b.id) ? pos.get('r:' + b.id) : 1e9));
    return list.join() + '|' + side !== before;
  }
  function moveRack(v, rackId, side, targetId, after) { return moveItem(v, 'r:' + rackId, side, targetId ? 'r:' + targetId : '', after); }
  function removeRack(v, rackId) {
    const out = [];
    for (const d of v.devices) if (d.rack === rackId) { d.rack = ''; d.slot = -1; if (isAmpModel(d.model)) out.push(d); }
    v.racks = (v.racks || []).filter((r) => r.id !== rackId);
    return out;
  }
  function resizeRack(v, r, sizeN) {
    r.size = clampInt(sizeN, 1, 8, r.size);
    const out = [];
    for (const d of v.devices) if (d.rack === r.id && d.slot >= r.size) { d.rack = ''; d.slot = -1; out.push(d); }
    return out;
  }
  // Place amps that are not in a rack: same side as their zone, same amp model per rack, new racks when full.
  function packRacks(v, opts) {
    opts = opts || {};
    const only = opts.onlyIds ? new Set(opts.onlyIds) : null;
    const zi = new Map(v.zones.map((z, i) => [z.id, i]));
    const sideOf = (d) => { const z = v.zones.find((x) => x.id === d.zone); return z ? z.side : 'L'; };
    const loose = v.devices.map((d, i) => ({ d, i }))
      .filter((x) => isAmpModel(x.d.model) && !rackById(v, x.d.rack) && (!only || only.has(x.d.id)))
      .sort((a, b) => ((zi.has(a.d.zone) ? zi.get(a.d.zone) : 99) - (zi.has(b.d.zone) ? zi.get(b.d.zone) : 99)) || a.i - b.i)
      .map((x) => x.d);
    const created = [];
    let placed = 0;
    for (const d of loose) {
      const side = sideOf(d);
      let target = null;
      let slot = -1;
      for (const r of v.racks || []) {
        if (r.side !== side) continue;
        const m = rackModel(v, r);
        if (m && m !== d.model) continue;
        const free = rackSlots(v, r).indexOf(null);
        if (free < 0) continue;
        target = r;
        slot = free;
        break;
      }
      if (!target) {
        if ((v.racks || []).length >= 120) break;
        target = addRack(v, { side, size: rackSizeOf(v, d.model) || 3, type: DEFAULT_RACK_TYPE[d.model] || '' });
        created.push(target);
        slot = 0;
      }
      d.rack = target.id;
      d.slot = slot;
      placed++;
    }
    return { placed, created };
  }
  // Line arrays that always end with a different bottom box: an L2 hang is L2 modules with one L2D at
  // the bottom, however long it is. The group stays "L2"; its last amp runs the L2D preset.
  const ARRAY_BOTTOM = { L2: 'L2D' };
  function arrayBottomAmp(v, g) {
    if (!ARRAY_BOTTOM[g.model]) return null;
    const linked = v.devices.filter((x) => x.drives === g.id);
    return linked.length ? linked[linked.length - 1] : null;
  }
  // "3 × L2 + 1 × L2D" for an L2 hang of 4, "12 × K2" otherwise
  function arrayText(g) {
    const bot = ARRAY_BOTTOM[g.model];
    if (!bot) return g.qty + ' × ' + speakerLabel(g);
    return g.qty > 1 ? (g.qty - 1) + ' × ' + g.model + ' + 1 × ' + bot : '1 × ' + bot;
  }
  function presetOf(v, d) {
    if (d.drives) {
      const g = (v.speakers || []).find((x) => x.id === d.drives);
      if (g) return ARRAY_BOTTOM[g.model] && arrayBottomAmp(v, g) === d ? ARRAY_BOTTOM[g.model] : speakerLabel(g);
    }
    return d.preset || '';
  }
  // What a rack slot shows: "K2 - 11" (preset and the last number of the IP).
  function slotLabel(v, d, info) {
    const p = presetOf(v, d) || modelOf(d.model).label;
    const ip = parseIp(d.ip);
    if (ip == null) return p;
    return p + ' - ' + (info && info.block != null && blockOf(ip) === info.block ? host(ip) : ipToStr(ip));
  }

  // ---------------------------------------------------------------- speakers -> amps
  const AMP_IDS = MODELS.filter((m) => m.group === 'amp').map((m) => m.id);
  function driveOptions(speakerId) {
    const sp = SPEAKER_MAP[speakerId];
    return sp ? DRIVE_AMPS.filter((a) => sp.d[a]) : AMP_IDS.slice();
  }
  function driveMax(speakerId, amp) {
    const sp = SPEAKER_MAP[speakerId];
    return sp && sp.d[amp] ? sp.d[amp][1] : 0;
  }
  function drivePerOutput(speakerId, amp) {
    const sp = SPEAKER_MAP[speakerId];
    return sp && sp.d[amp] ? sp.d[amp][0] : 0;
  }
  const speakerLabel = (g) => (g.model === 'Custom' || !SPEAKER_MAP[g.model] ? g.custom || 'Custom speaker' : g.model);
  function perAmp(g) {
    if (!SPEAKER_MAP[g.model]) return Math.max(1, g.per || 1);
    const max = driveMax(g.model, g.amp);
    return g.per ? Math.min(g.per, max) : max;
  }
  function ampsNeeded(g) {
    const p = perAmp(g);
    return p > 0 && g.qty > 0 ? Math.ceil(g.qty / p) : 0;
  }
  function nextIndex(v, prefix) {
    const re = new RegExp('^' + String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (\\d+)$');
    let max = 0;
    for (const d of v.devices) { const m = re.exec(d.name || ''); if (m) max = Math.max(max, +m[1]); }
    return max + 1;
  }
  // Make the amps linked to a speaker group match what it needs. Returns the devices added and removed.
  function syncGroup(v, g) {
    const need = ampsNeeded(g);
    const zone = v.zones.find((z) => z.id === g.zone);
    const linked = v.devices.filter((d) => d.drives === g.id);
    const unracked = [];
    for (const d of linked) {
      if (d.model !== g.amp) {
        d.model = g.amp;
        const r = rackById(v, d.rack);
        if (r && RACK_MODEL[r.type] && RACK_MODEL[r.type] !== g.amp) { d.rack = ''; d.slot = -1; unracked.push(d); }
      }
      d.zone = g.zone;
    }
    const added = [];
    const removed = [];
    if (linked.length > need) {
      const rank = (d) => (d.status === 'planned' ? 0 : 2) + (String(d.ip || '').trim() ? 1 : 0);
      const drop = new Set(linked.map((d) => ({ d, i: v.devices.indexOf(d) }))
        .sort((a, b) => rank(a.d) - rank(b.d) || b.i - a.i).slice(0, linked.length - need).map((x) => x.d.id));
      v.devices = v.devices.filter((d) => { if (drop.has(d.id)) { removed.push(d); return false; } return true; });
    } else if (linked.length < need) {
      const base = (zone ? zone.name + ' ' : '') + speakerLabel(g);
      let n = nextIndex(v, base);
      for (let k = linked.length; k < need; k++) added.push(newDevice({ name: base + ' ' + n++, model: g.amp, zone: g.zone, drives: g.id }));
      const last = linked.length ? v.devices.indexOf(linked[linked.length - 1]) : -1;
      if (last >= 0) v.devices.splice(last + 1, 0, ...added); else v.devices.push(...added);
    }
    return { added, removed, unracked: unracked.filter((d) => removed.indexOf(d) < 0) };
  }
  function removeGroup(v, gid) {
    v.speakers = (v.speakers || []).filter((g) => g.id !== gid);
    const removed = v.devices.filter((d) => d.drives === gid);
    v.devices = v.devices.filter((d) => d.drives !== gid);
    return removed;
  }

  // ---------------------------------------------------------------- counting amps as racks
  const DEFAULT_RACK_SIZE = { LA12X: 3, 'LA7.16': 3, LA8: 3 };
  const RACK_FOR = { LA12X: 'LA-RAK II AVB', 'LA7.16': 'LA-RAK III', LA8: 'LA-RAK' };
  function rackSizeOf(v, model) {
    const rs = v.rackSize || {};
    if (Object.prototype.hasOwnProperty.call(rs, model)) return rs[model] || 0;
    return DEFAULT_RACK_SIZE[model] || 0;
  }
  function rackEquivalent(total, sizeN) {
    if (!sizeN || !total) return null;
    const full = Math.floor(total / sizeN);
    const rem = total % sizeN;
    return { full, rem, needed: full + (rem ? 1 : 0), freeSlots: rem ? sizeN - rem : 0 };
  }
  function rackText(e, sizeN) {
    if (!e) return '';
    if (!e.rem) return plural(e.full, 'rack') + ' of ' + sizeN;
    if (!e.full) return '1 rack, ' + plural(e.freeSlots, 'slot') + ' free';
    return plural(e.full, 'full rack') + ' + ' + plural(e.rem, 'amp') + ' = ' + e.needed + ' racks, ' + plural(e.freeSlots, 'slot') + ' free';
  }
  function countPlan(v) {
    const amps = MODELS.filter((m) => m.group === 'amp').map((m) => m.id);
    const rows = v.zones.map((z) => ({ zone: z, counts: {}, amps: 0, channels: 0 }));
    const zi = new Map(v.zones.map((z, i) => [z.id, i]));
    if (v.devices.some((d) => !zi.has(d.zone))) { zi.set('__none', rows.length); rows.push({ zone: { id: '', name: 'No zone', color: 8 }, counts: {}, amps: 0, channels: 0 }); }
    const totals = {};
    const inRacks = {};
    const racks = new Map((v.racks || []).map((r) => [r.id, { id: r.id, name: r.name, type: r.type, side: r.side, size: r.size, models: {}, amps: 0 }]));
    let ampTotal = 0;
    let channels = 0;
    for (const d of v.devices) {
      const m = modelOf(d.model);
      const row = rows[zi.has(d.zone) ? zi.get(d.zone) : zi.get('__none')];
      if (row) row.counts[d.model] = (row.counts[d.model] || 0) + 1;
      totals[d.model] = (totals[d.model] || 0) + 1;
      if (m.group === 'amp') {
        ampTotal++;
        channels += m.ch;
        if (row) { row.amps++; row.channels += m.ch; }
      }
      if (d.rack && racks.has(d.rack)) {
        inRacks[d.model] = (inRacks[d.model] || 0) + 1;
        const r = racks.get(d.rack);
        r.models[d.model] = (r.models[d.model] || 0) + 1;
        if (m.group === 'amp') r.amps++;
      }
    }
    const equiv = {};
    let racksNeeded = 0;
    let loose = 0;
    for (const id of amps) {
      const t = totals[id] || 0;
      if (!t) continue;
      const e = rackEquivalent(t, rackSizeOf(v, id));
      equiv[id] = e;
      if (e) racksNeeded += e.needed; else loose += t;
    }
    const unracked = v.devices.filter((d) => modelOf(d.model).group === 'amp' && !racks.has(d.rack)).length;
    return { amps, rows, totals, inRacks, racks: Array.from(racks.values()), ampTotal, channels, equiv, racksNeeded, loose, unracked };
  }
  function speakerPlan(v) {
    const zi = new Map(v.zones.map((z, i) => [z.id, i]));
    const order = (v.speakers || []).map((g, i) => ({ g, i })).sort((a, b) => ((zi.has(a.g.zone) ? zi.get(a.g.zone) : 99) - (zi.has(b.g.zone) ? zi.get(b.g.zone) : 99)) || a.i - b.i).map((x) => x.g);
    const groups = order.map((g) => {
      const need = ampsNeeded(g);
      return {
        g, label: speakerLabel(g), per: perAmp(g), max: driveMax(g.model, g.amp), perOut: drivePerOutput(g.model, g.amp),
        need, linked: v.devices.filter((d) => d.drives === g.id).length, e: rackEquivalent(need, rackSizeOf(v, g.amp)),
      };
    });
    const typeMap = new Map();
    for (const x of groups) {
      const key = x.label + '|' + x.g.amp;
      if (!typeMap.has(key)) typeMap.set(key, { key, label: x.label, amp: x.g.amp, qty: 0, amps: 0, zones: [] });
      const t = typeMap.get(key);
      t.qty += x.g.qty;
      t.amps += x.need;
      if (t.zones.indexOf(x.g.zone) < 0) t.zones.push(x.g.zone);
    }
    const types = Array.from(typeMap.values());
    types.forEach((t, i) => { t.color = Math.min(i, 8); t.e = rackEquivalent(t.amps, rackSizeOf(v, t.amp)); });
    // amps of each model in the plan: linked to a speaker type, or other (spares, racks added by hand...)
    const ampModels = [];
    for (const id of AMP_IDS) {
      const all = v.devices.filter((d) => d.model === id);
      if (!all.length) continue;
      const slots = [];
      for (const t of types) if (t.amp === id) {
        const keyGroups = new Set(groups.filter((x) => x.label + '|' + x.g.amp === t.key).map((x) => x.g.id));
        for (const d of all.filter((x) => keyGroups.has(x.drives))) slots.push({ type: t, dev: d });
      }
      const used = new Set(slots.map((x) => x.dev));
      const rest = all.filter((d) => !used.has(d));
      const other = rest.length;
      for (const d of rest) slots.push({ type: null, dev: d });
      const size = rackSizeOf(v, id);
      const racks = [];
      if (size) for (let k = 0; k < slots.length; k += size) racks.push(slots.slice(k, k + size));
      ampModels.push({ id, total: all.length, other, size, racks, slots, e: rackEquivalent(all.length, size) });
    }
    const enclosures = groups.reduce((a, x) => a + x.g.qty, 0);
    return { groups, types, ampModels, enclosures };
  }
  // with racks on the plan: what the plan holds; without: what the amps would fill
  function rackSummary(cp) {
    if (cp.racks.length) return plural(cp.racks.length, 'rack') + (cp.unracked ? ' + ' + cp.unracked + ' not in a rack' : '');
    const parts = [];
    if (cp.racksNeeded) parts.push('fills ' + plural(cp.racksNeeded, 'rack'));
    if (cp.loose) parts.push(cp.loose + ' without a rack size');
    return parts.join(' + ');
  }
  function equipmentLine(v) {
    const cp = countPlan(v);
    return MODELS.filter((m) => cp.totals[m.id]).map((m) => {
      const e = cp.equiv[m.id];
      return cp.totals[m.id] + ' × ' + m.label + (e ? ' (' + (e.rem ? e.full + ' racks + ' + e.rem : plural(e.full, 'rack')) + ')' : '');
    }).join(' · ');
  }

  // ---------------------------------------------------------------- derived network
  function netInfo(v) {
    const n = v.net || {};
    const prefix = clampInt(n.prefix, 8, 24, 24);
    const out = {
      ok: false, prefix, mask: maskStr(prefix), network: null, broadcast: null, block: null, blockStr: '',
      redundancy: !!n.redundancy, secOffset: null, secNetwork: null, secBroadcast: null, secBlock: null, secBlockStr: '', secOk: false,
      computer: parseIp(n.computer), gatewayRaw: String(n.gateway || '').trim(), gateway: null,
      dhcpFrom: parseIp(n.dhcpFrom), dhcpTo: parseIp(n.dhcpTo),
    };
    if (out.gatewayRaw && out.gatewayRaw !== '0.0.0.0') out.gateway = parseIp(out.gatewayRaw);
    const base = parseIp(n.network);
    if (base == null) return out;
    out.ok = true;
    out.network = netOf(base, prefix);
    out.broadcast = out.network + size(prefix) - 1;
    let blk = null;
    if (prefix < 24 && n.block) {
      const b = parseIp(String(n.block).trim().replace(/\.$/, '') + '.0');
      if (b != null && inNet(b, out.network, prefix)) blk = b;
    }
    out.block = blk != null ? blk : blockOf(out.network);
    out.blockStr = blockLabel(out.block);
    if (out.redundancy) {
      const off = size(prefix);
      if (out.network + 2 * off - 1 <= MAX_IP) {
        out.secOffset = off;
        out.secNetwork = out.network + off;
        out.secBroadcast = out.secNetwork + off - 1;
        out.secBlock = out.block + off;
        out.secBlockStr = blockLabel(out.secBlock);
        out.secOk = !!(laRange(out.secNetwork + 1) && laRange(out.secBroadcast - 1));
      }
    }
    return out;
  }

  // Which addresses a device occupies.
  function devNets(v, d, info) {
    const m = modelOf(d.model);
    const red = !!(v.net && v.net.redundancy);
    const dual = red && !!m.red;
    const onSec = red && !m.red && d.net === 'sec';
    const ip = parseIp(d.ip);
    let pri = null;
    let sec = null;
    if (ip != null) {
      if (onSec) sec = ip;
      else {
        pri = ip;
        if (dual && info.secOffset != null && ip + info.secOffset <= MAX_IP) sec = ip + info.secOffset;
      }
    }
    return { m, dual, onSec, ip, pri, sec };
  }

  const SEV_RANK = { error: 3, warn: 2, info: 1 };
  function worst(list) {
    let w = null;
    for (const it of list || []) if (!w || SEV_RANK[it.sev] > SEV_RANK[w]) w = it.sev;
    return w;
  }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

  // ---------------------------------------------------------------- checks
  function analyze(v) {
    const info = netInfo(v);
    const issues = [];
    const byDev = new Map();
    const add = (sev, code, msg, devId) => {
      const it = { sev, code, msg, dev: devId || null };
      issues.push(it);
      if (devId) {
        if (!byDev.has(devId)) byDev.set(devId, []);
        byDev.get(devId).push(it);
      }
    };
    const P = info.prefix;
    const netLabel = info.ok ? ipToStr(info.network) + '/' + P : '';
    const devices = v.devices || [];
    const names = new Map(devices.map((d) => [d.id, d.name || modelOf(d.model).label]));

    // network level
    if (!info.ok) {
      add('error', 'net-invalid', 'The primary network isn’t a valid address. Enter something like 192.168.1.0.');
    } else {
      const r1 = laRange(info.network + 1);
      const r2 = laRange(info.broadcast - 1);
      if (!r1 || !r2 || r1 !== r2) add('error', 'net-range', netLabel + ' is outside the private ranges L-Acoustics units accept (10.x, 100.64–127.x, 172.16–31.x, 192.168.x).');
      else if (r1.notRecommended) add('warn', 'net-linklocal', 'L-Acoustics units accept 169.254.x.x, but L-Acoustics doesn’t recommend it.');
    }
    const compRaw = String(v.net.computer || '').trim();
    if (!compRaw) add('warn', 'pc-missing', 'No control computer address. L-Acoustics suggests ' + (info.blockStr || '192.168.1') + '.254 for the LA Network Manager computer.');
    else if (info.computer == null) add('error', 'pc-invalid', 'The control computer address “' + compRaw + '” isn’t valid.');
    else if (info.ok && !inNet(info.computer, info.network, P)) add('error', 'pc-subnet', 'The control computer (' + compRaw + ') is outside ' + netLabel + '. It needs the same subnet and mask as the units.');
    else if (info.ok && (info.computer === info.network || info.computer === info.broadcast)) add('error', 'pc-reserved', compRaw + ' is the network or broadcast address. Give the computer another one, such as ' + info.blockStr + '.254.');

    if (info.gatewayRaw && info.gatewayRaw !== '0.0.0.0') {
      if (info.gateway == null) add('error', 'gw-invalid', 'The gateway “' + info.gatewayRaw + '” isn’t a valid address. Leave it empty if you don’t need one.');
      else if (info.ok && (!inNet(info.gateway, info.network, P) || info.gateway === info.network || info.gateway === info.broadcast)) add('error', 'gw-subnet', 'The gateway must be a usable address inside ' + netLabel + ', or left empty.');
      else add('info', 'gw-info', 'Gateway set. It only applies to the primary network, for supervision systems on another subnet.');
    }

    const dRaw1 = String(v.net.dhcpFrom || '').trim();
    const dRaw2 = String(v.net.dhcpTo || '').trim();
    let dhcp = null;
    if (dRaw1 || dRaw2) {
      if (info.dhcpFrom == null || info.dhcpTo == null || info.dhcpFrom > info.dhcpTo) add('error', 'dhcp-invalid', 'The DHCP pool needs two valid addresses, lowest first.');
      else if (info.ok && (!inNet(info.dhcpFrom, info.network, P) || !inNet(info.dhcpTo, info.network, P))) add('error', 'dhcp-subnet', 'The DHCP pool must sit inside ' + netLabel + '.');
      else dhcp = { from: info.dhcpFrom, to: info.dhcpTo };
    }

    if (info.redundancy && info.ok) {
      if (info.secNetwork == null || !info.secOk) {
        add('error', 'sec-range', 'With redundancy on, the secondary network would be ' + (info.secNetwork != null ? ipToStr(info.secNetwork) + '/' + P : 'past 255.255.255.255') + ', which isn’t a private range. Pick a primary network with room above it, such as 192.168.1.0/24.');
      }
      if (!devices.some((d) => modelOf(d.model).group === 'net')) add('info', 'red-switch', 'Redundant mode needs a star layout through AVB switches such as LS10. No switches are in this plan yet.');
      const noRed = [...new Set(devices.filter((d) => modelOf(d.model).unit && !modelOf(d.model).red).map((d) => d.model))];
      if (noRed.length) add('info', 'red-unsupported', noRed.join(', ') + (noRed.length === 1 ? ' doesn’t' : ' don’t') + ' support redundancy, so ' + (noRed.length === 1 ? 'it stays' : 'they stay') + ' on the primary network only.');
    }

    const legacy = devices.filter((d) => modelOf(d.model).legacy);
    if (legacy.length && info.ok && info.blockStr !== '192.168.1') {
      add('error', 'legacy-net', 'LA4 and LA8 only work on 192.168.1.x, but this plan puts units on ' + info.blockStr + '.x.');
    }
    for (const g of v.speakers || []) {
      const need = ampsNeeded(g);
      const have = devices.filter((d) => d.drives === g.id).length;
      const zn = (v.zones.find((z) => z.id === g.zone) || {}).name || '';
      if (have !== need) {
        const it = { sev: 'warn', code: 'spk-amps', msg: g.qty + ' × ' + speakerLabel(g) + (zn ? ' in ' + zn : '') + ' need ' + plural(need, 'amp') + ' (' + g.amp + '), but ' + have + (have === 1 ? ' is' : ' are') + ' linked. Use Fix on the Speakers & amps tab.', dev: null, tab: 'speakers' };
        issues.push(it);
      }
    }
    const units = devices.filter((d) => modelOf(d.model).unit);
    if (units.length > 253) add('error', 'too-many', plural(units.length, 'unit') + ' in one plan. LA Network Manager handles up to 253 on one network.');

    // occupancy: address -> who uses it
    const occ = new Map();
    const occupy = (ip, o) => {
      if (ip == null) return;
      if (!occ.has(ip)) occ.set(ip, []);
      occ.get(ip).push(o);
    };
    if (info.computer != null) occupy(info.computer, { type: 'pc' });
    if (info.gateway != null) occupy(info.gateway, { type: 'gw' });

    const nets = new Map();
    for (const d of devices) {
      const dn = devNets(v, d, info);
      nets.set(d.id, dn);
      const m = dn.m;
      if (m.group === 'amp' && !d.drives && SPEAKER_MAP[d.preset] && DRIVE_AMPS.indexOf(d.model) >= 0 && !driveMax(d.preset, d.model)) {
        add('warn', 'preset-amp', d.model + ' isn’t listed by L-Acoustics for ' + d.preset + '. Use ' + driveOptions(d.preset).join(' or ') + '.', d.id);
      }
      const raw = String(d.ip || '').trim();
      if (!raw) {
        if (m.auto) add('warn', 'no-ip', 'No IP address yet.', d.id);
        continue;
      }
      if (dn.ip == null) {
        add('error', 'ip-invalid', '“' + raw + '” isn’t a valid IPv4 address. Use four numbers from 0 to 255, like ' + (info.blockStr || '192.168.1') + '.21.', d.id);
        continue;
      }
      const ipS = ipToStr(dn.ip);
      if (info.ok) {
        const homeNet = dn.onSec ? info.secNetwork : info.network;
        const homeLabel = dn.onSec ? 'secondary' : 'primary';
        if (homeNet == null) add('error', 'ip-subnet', 'There’s no secondary network to put this device on.', d.id);
        else if (!inNet(dn.ip, homeNet, P)) add('error', 'ip-subnet', 'Outside the ' + homeLabel + ' network ' + ipToStr(homeNet) + '/' + P + '.', d.id);
        else if (dn.ip === homeNet) add('error', 'ip-netaddr', ipS + ' is the network’s own address. Devices can’t use it.', d.id);
        else if (dn.ip === homeNet + size(P) - 1) add('error', 'ip-bcast', ipS + ' is the broadcast address. Devices can’t use it.', d.id);
      }
      if (m.la) {
        const r = laRange(dn.ip);
        if (!r) add('error', 'ip-private', 'L-Acoustics units only accept private addresses: 10.x, 100.64–127.x, 172.16–31.x, 192.168.x or 169.254.x.', d.id);
        else if (r.notRecommended) add('warn', 'ip-linklocal', '169.254.x.x works, but L-Acoustics doesn’t recommend it.', d.id);
      }
      if (m.legacy && !(blockLabel(blockOf(dn.ip)) === '192.168.1' && host(dn.ip) >= 1 && host(dn.ip) <= 253)) {
        add('error', 'legacy-ip', d.model + ' only accepts 192.168.1.1 to 192.168.1.253.', d.id);
      }
      if (m.unit && info.ok && info.block != null && blockOf(dn.ip) !== info.block && !dn.onSec) {
        add('warn', 'ip-block', 'Not on ' + info.blockStr + '.x like the other units. LA Network Manager needs every unit to share the first three numbers.', d.id);
      }
      if (dn.ip === FD_UNIT || dn.ip === FD_LS10) {
        add('info', 'ip-default', ipS + ' is the factory address of new ' + (dn.ip === FD_LS10 ? 'LS10 switches' : 'L-Acoustics units') + '. A fresh one plugged in later would clash with this device.', d.id);
      }
      if (dhcp && !dn.onSec && dn.ip >= dhcp.from && dn.ip <= dhcp.to) {
        add('warn', 'ip-dhcp', 'Inside the DHCP pool (' + ipToStr(dhcp.from) + ' to ' + ipToStr(dhcp.to) + '). The router could hand this address to a phone or laptop.', d.id);
      }
      if (dn.pri != null) occupy(dn.pri, { type: 'dev', id: d.id, role: 'pri' });
      if (dn.sec != null) occupy(dn.sec, { type: 'dev', id: d.id, role: dn.dual ? 'sec' : 'only' });
    }

    const who = (o) => (o.type === 'pc' ? 'the control computer' : o.type === 'gw' ? 'the gateway' : '“' + names.get(o.id) + '”' + (o.role === 'sec' ? ' (secondary)' : ''));
    for (const [ip, list] of occ) {
      if (list.length < 2) continue;
      if (list.some((o) => o.type === 'pc') && list.some((o) => o.type === 'gw')) add('error', 'pc-gw', 'The control computer and the gateway both use ' + ipToStr(ip) + '.');
      for (const o of list) {
        if (o.type !== 'dev') continue;
        let others = list.filter((x) => x !== o && !(x.type === 'dev' && x.id === o.id));
        // two redundant units clash on the secondary exactly when they clash on the primary: report it once
        if (o.role === 'sec') others = others.filter((x) => !(x.type === 'dev' && x.role === 'sec'));
        if (!others.length) continue;
        add('error', 'dup', ipToStr(ip) + (o.role === 'sec' ? ' (its secondary address)' : '') + ' is also used by ' + others.map(who).join(', ') + '.', o.id);
      }
    }

    // stats
    let channels = 0;
    let scanFrom = null;
    let scanTo = null;
    for (const d of devices) {
      const m = modelOf(d.model);
      channels += m.ch || 0;
      if (!m.unit) continue;
      const dn = nets.get(d.id);
      if (dn && dn.pri != null && info.block != null && blockOf(dn.pri) === info.block) {
        if (scanFrom == null || dn.pri < scanFrom) scanFrom = dn.pri;
        if (scanTo == null || dn.pri > scanTo) scanTo = dn.pri;
      }
    }
    let free = 0;
    if (info.ok) {
      for (let h = 1; h <= MAX_HOST; h++) {
        const ip = info.block + h;
        if (occ.has(ip)) continue;
        if (dhcp && ip >= dhcp.from && ip <= dhcp.to) continue;
        free++;
      }
    }
    const count = (s) => issues.filter((i) => i.sev === s).length;
    const stats = {
      devices: devices.length, units: units.length, channels, scanFrom, scanTo, free,
      errors: count('error'), warns: count('warn'), infos: count('info'),
    };
    return { info, issues, byDev, occ, nets, dhcp, stats };
  }

  // ---------------------------------------------------------------- auto-assign
  function zoneBlocks(v) {
    const a = v.net.assign;
    if (a.scheme !== 'zones') return null;
    return v.zones.map((z, k) => {
      const lo = a.start + k * a.size;
      return { zone: z.id, lo, hi: Math.min(lo + a.size - 1, MAX_HOST), full: lo > MAX_HOST };
    });
  }

  function planAutoAssign(v, opts) {
    opts = opts || {};
    const info = netInfo(v);
    if (!info.ok) return { changes: [], unplaced: [], error: 'Fix the primary network first.' };
    const scheme = opts.scheme === 'sequential' ? 'sequential' : 'zones';
    const start = clampInt(opts.start, 1, MAX_HOST, 11);
    const bsize = clampInt(opts.size, 2, 100, 10);
    const all = opts.scope === 'all';
    const only = opts.onlyIds ? new Set(opts.onlyIds) : null;
    const devices = v.devices;
    const zi = new Map(v.zones.map((z, i) => [z.id, i]));
    const zoneIdx = (d) => (zi.has(d.zone) ? zi.get(d.zone) : v.zones.length);
    const isTarget = (d) => {
      const m = modelOf(d.model);
      if (!m.auto) return false;
      if (only && !only.has(d.id)) return false;
      return all || parseIp(d.ip) == null;
    };
    const targets = devices.filter(isTarget);
    const tset = new Set(targets.map((d) => d.id));
    const occPri = new Set();
    const occSec = new Set();
    for (const d of devices) {
      if (tset.has(d.id)) continue;
      const dn = devNets(v, d, info);
      if (dn.pri != null) occPri.add(dn.pri);
      if (dn.sec != null) occSec.add(dn.sec);
    }
    if (info.computer != null) occPri.add(info.computer);
    if (info.gateway != null) occPri.add(info.gateway);
    if (info.dhcpFrom != null && info.dhcpTo != null && info.dhcpFrom <= info.dhcpTo) {
      for (let h = 1; h <= MAX_HOST; h++) {
        const ip = info.block + h;
        if (ip >= info.dhcpFrom && ip <= info.dhcpTo) occPri.add(ip);
      }
    }
    if (opts.avoidDefaults !== false && info.blockStr === '192.168.1') {
      occPri.add(FD_UNIT);
      occPri.add(FD_LS10);
    }
    const ordered = targets
      .map((d, i) => ({ d, i: devices.indexOf(d) }))
      .sort((a, b) => zoneIdx(a.d) - zoneIdx(b.d) || a.i - b.i)
      .map((x) => x.d);
    const changes = [];
    const unplaced = [];
    for (const d of ordered) {
      const dn = devNets(v, d, info);
      let lo = start;
      let hi = MAX_HOST;
      if (scheme === 'zones') {
        lo = start + zoneIdx(d) * bsize;
        hi = Math.min(lo + bsize - 1, MAX_HOST);
      }
      let found = null;
      for (let h = lo; h <= hi; h++) {
        const p = info.block + h;
        const s = info.secBlock != null ? info.secBlock + h : null;
        if (dn.onSec) {
          if (s == null || occSec.has(s)) continue;
          found = { ip: s, h };
          break;
        }
        if (occPri.has(p)) continue;
        if (dn.dual && (s == null || occSec.has(s))) continue;
        found = { ip: p, h };
        break;
      }
      if (!found) {
        unplaced.push({ id: d.id, reason: lo > MAX_HOST ? 'No room left for this zone’s block (it would start at .' + lo + ')' : 'No free address in .' + lo + '–.' + hi });
        continue;
      }
      if (dn.onSec) occSec.add(found.ip);
      else {
        occPri.add(found.ip);
        if (dn.dual) occSec.add(info.secBlock + found.h);
      }
      const to = ipToStr(found.ip);
      const from = String(d.ip || '').trim();
      if (from !== to) changes.push({ id: d.id, from, to });
    }
    return { changes, unplaced, scheme, start, size: bsize };
  }

  function applyChanges(v, changes) {
    const byId = new Map(v.devices.map((d) => [d.id, d]));
    for (const c of changes) { const d = byId.get(c.id); if (d) d.ip = c.to; }
  }

  // Move every address from one unit block to another, keeping the last number.
  function rebase(v, from, to) {
    let moved = 0;
    const map = (ip) => {
      if (ip == null) return null;
      if (from.block != null && to.block != null && blockOf(ip) === from.block) return to.block + host(ip);
      if (from.secBlock != null && to.secBlock != null && blockOf(ip) === from.secBlock) return to.secBlock + host(ip);
      return null;
    };
    for (const d of v.devices) {
      const ip = parseIp(d.ip);
      const n = map(ip);
      if (n != null && n !== ip) { d.ip = ipToStr(n); moved++; }
    }
    for (const k of ['computer', 'gateway', 'dhcpFrom', 'dhcpTo']) {
      const ip = parseIp(v.net[k]);
      const n = map(ip);
      if (n != null && n !== ip) v.net[k] = ipToStr(n);
    }
    return moved;
  }

  // ---------------------------------------------------------------- export
  function orderedDevices(v) {
    const zi = new Map(v.zones.map((z, i) => [z.id, i]));
    return v.devices
      .map((d, i) => ({ d, i, ip: parseIp(d.ip) }))
      .sort((a, b) => {
        const za = zi.has(a.d.zone) ? zi.get(a.d.zone) : 1e6;
        const zb = zi.has(b.d.zone) ? zi.get(b.d.zone) : 1e6;
        if (za !== zb) return za - zb;
        if (a.ip != null && b.ip != null && a.ip !== b.ip) return a.ip - b.ip;
        if ((a.ip == null) !== (b.ip == null)) return a.ip == null ? 1 : -1;
        return a.i - b.i;
      })
      .map((x) => x.d);
  }

  function rackLabel(v, d) {
    const r = rackById(v, d.rack);
    if (!r) return '';
    return r.name + (d.slot >= 0 ? ' · slot ' + (d.slot + 1) : '') + ' (' + SIDE_LABEL[r.side] + ')';
  }
  function exportRows(v) {
    const info = netInfo(v);
    const zname = new Map(v.zones.map((z) => [z.id, z.name]));
    const rows = [];
    if (info.computer != null) {
      rows.push({ zone: 'Network', name: 'Control computer (LA Network Manager)', model: 'Computer', preset: '', ip: ipToStr(info.computer), sec: '', network: 'Primary', mask: info.mask, location: '', rack: '', port: '', serial: '', status: '', notes: '' });
    }
    for (const d of orderedDevices(v)) {
      const dn = devNets(v, d, info);
      rows.push({
        zone: zname.get(d.zone) || '', name: d.name, model: modelOf(d.model).label, preset: presetOf(v, d),
        ip: dn.ip != null ? ipToStr(dn.ip) : String(d.ip || '').trim(),
        sec: dn.dual && dn.sec != null ? ipToStr(dn.sec) : '',
        network: dn.dual ? 'Primary + secondary' : dn.onSec ? 'Secondary' : 'Primary',
        mask: info.mask, location: d.location, rack: rackLabel(v, d), port: d.port, serial: d.serial, status: STATUS_LABEL[d.status] || '', notes: d.notes,
      });
    }
    return rows;
  }

  function exportColumns(v) {
    const cols = [['zone', 'Zone'], ['name', 'Name'], ['model', 'Model'], ['preset', 'Preset'], ['ip', 'IP address']];
    if (v.net.redundancy) cols.push(['sec', 'Secondary IP'], ['network', 'Network']);
    cols.push(['mask', 'Subnet mask'], ['location', 'Location'], ['rack', 'Rack'], ['port', 'Switch / port'], ['serial', 'Serial / asset'], ['status', 'Status'], ['notes', 'Notes']);
    return cols;
  }

  function toDelimited(v, sep) {
    sep = sep || ',';
    const cols = exportColumns(v);
    const cell = (x) => {
      let s = String(x == null ? '' : x);
      if (sep === '\t') return s.replace(/[\t\r\n]+/g, ' ');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from reading text as a formula
      return s.indexOf(sep) >= 0 || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map((c) => cell(c[1])).join(sep)];
    for (const r of exportRows(v)) lines.push(cols.map((c) => cell(r[c[0]])).join(sep));
    return lines.join('\r\n') + '\r\n';
  }

  const ZONE_HEX = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#8b979d'];

  function formatDate(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
    const [y, m, d] = iso.split('-').map(Number);
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] || '';
    return d + ' ' + mon + ' ' + y;
  }

  function patchSheet(v) {
    const a = analyze(v);
    const info = a.info;
    const e = escHtml;
    const red = !!v.net.redundancy;
    const facts = [
      ['Primary network', info.ok ? ipToStr(info.network) + '/' + info.prefix : v.net.network],
      ['Subnet mask', info.mask],
      ['Control computer', v.net.computer || '—'],
      ['Gateway', info.gateway != null ? ipToStr(info.gateway) : 'none'],
    ];
    if (red) facts.push(['Secondary network', info.secNetwork != null ? ipToStr(info.secNetwork) + '/' + info.prefix : '—']);
    if (a.dhcp) facts.push(['DHCP pool', ipToStr(a.dhcp.from) + ' – ' + ipToStr(a.dhcp.to)]);
    facts.push(['LA NWM scan range', a.stats.scanFrom != null ? ipToStr(a.stats.scanFrom) + ' – ' + ipToStr(a.stats.scanTo) : '—']);
    const ipHtml = (s) => {
      const n = parseIp(s);
      if (n == null) return e(s || '');
      const t = ipToStr(n);
      const k = t.lastIndexOf('.');
      return e(t.slice(0, k + 1)) + '<b>' + host(n) + '</b>';
    };
    const zcount = v.zones.length;
    let body = '';
    const ordered = orderedDevices(v);
    v.zones.concat([{ id: '__none', name: 'No zone', color: 8 }]).forEach((z) => {
      const list = ordered.filter((d) => (z.id === '__none' ? !v.zones.some((x) => x.id === d.zone) : d.zone === z.id));
      if (!list.length) return;
      body += '<tr class="zone"><td colspan="' + (red ? 9 : 8) + '"><span class="sw" style="background:' + ZONE_HEX[z.color] + '"></span>' + e(z.name) + ' <span class="n">' + list.length + '</span></td></tr>';
      for (const d of list) {
        const dn = a.nets.get(d.id);
        const iss = a.byDev.get(d.id) || [];
        const flag = worst(iss) === 'error' ? ' class="err"' : '';
        body += '<tr' + flag + '><td class="box"><span></span></td><td class="box"><span></span></td><td><b>' + e(d.name) + '</b></td><td>' + e(modelOf(d.model).label) + '</td>' +
          '<td class="ip">' + ipHtml(d.ip) + (dn && dn.onSec ? ' <small>sec</small>' : '') + '</td>' +
          (red ? '<td class="ip">' + (dn && dn.dual && dn.sec != null ? ipHtml(ipToStr(dn.sec)) : '') + '</td>' : '') +
          '<td>' + e([d.location, rackLabel(v, d)].filter(Boolean).join(' · ')) + '</td><td>' + e(d.port) + '</td><td>' + e([d.serial, d.notes].filter(Boolean).join(' · ')) + '</td></tr>';
      }
    });
    const problems = a.stats.errors ? '<p class="warn">This plan still has ' + plural(a.stats.errors, 'error') + '. Rows marked ✕ need attention.</p>' : '';
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>IP plan · ' + e(v.name) + '</title><style>' +
      '@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{margin:0;padding:16px;font:10pt/1.35 "IBM Plex Sans","Segoe UI",Arial,sans-serif;color:#111}' +
      'h1{font:700 20pt/1.05 "Barlow Condensed","Arial Narrow",Arial,sans-serif;margin:0 0 2mm;letter-spacing:.01em}' +
      '.meta{color:#555;margin:0 0 4mm}.facts{display:flex;flex-wrap:wrap;gap:2mm 8mm;padding:3mm 4mm;border:1px solid #c9c9c9;border-radius:2mm;margin:0 0 5mm}' +
      '.facts div{min-width:30mm}.facts b{display:block;font-size:7pt;text-transform:uppercase;letter-spacing:.06em;color:#666;font-weight:600}' +
      '.facts span{font-family:"IBM Plex Mono",Consolas,monospace}table{width:100%;border-collapse:collapse}' +
      'th,td{text-align:left;padding:1.4mm 2mm;border-bottom:1px solid #ddd;vertical-align:top}' +
      'th{font-size:7pt;text-transform:uppercase;letter-spacing:.06em;color:#555;border-bottom:1.5px solid #222}' +
      'tr.zone td{background:#f1f1f1;font-weight:700;border-top:3mm solid #fff}.sw{display:inline-block;width:3mm;height:3mm;border-radius:.6mm;margin-right:2mm;vertical-align:-.2mm}' +
      '.n{color:#777;font-weight:400}.ip{font-family:"IBM Plex Mono",Consolas,monospace;white-space:nowrap}.ip b{font-size:11.5pt}' +
      'td.box{width:8mm}td.box span{display:inline-block;width:4mm;height:4mm;border:1px solid #555;border-radius:.6mm}' +
      'tr.err td:nth-child(3)::before{content:"✕ ";color:#b02a2a}tr{page-break-inside:avoid}thead{display:table-header-group}' +
      '.eq{margin:-2mm 0 5mm}.eq b{font-size:7pt;text-transform:uppercase;letter-spacing:.06em;color:#666;margin-right:2mm}.warn{color:#b02a2a;font-weight:600}.foot{margin-top:4mm;color:#777;font-size:8pt}</style></head><body>' +
      '<h1>' + e(v.name) + '</h1><p class="meta">' + e([formatDate(v.date), v.city, plural(v.devices.length, 'device'), plural(zcount, 'zone')].filter(Boolean).join(' · ')) + '</p>' +
      '<div class="facts">' + facts.map((f) => '<div><b>' + e(f[0]) + '</b><span>' + e(f[1]) + '</span></div>').join('') + '</div>' +
      ((v.speakers || []).length ? '<p class="eq"><b>Speakers</b> ' + e(speakerPlan(v).types.map((t) => t.qty + ' × ' + t.label + ' → ' + t.amps + ' × ' + t.amp).join(' · ')) + '</p>' : '') +
      (v.devices.length ? '<p class="eq"><b>Equipment</b> ' + e(equipmentLine(v)) + '</p>' : '') + problems +
      '<table><thead><tr><th>Set</th><th>OK</th><th>Name</th><th>Model</th><th>IP address</th>' + (red ? '<th>Secondary</th>' : '') +
      '<th>Location</th><th>Switch / port</th><th>Serial · notes</th></tr></thead><tbody>' + body + '</tbody></table>' +
      '<p class="foot">Amp Plan · exported ' + e(new Date().toISOString().slice(0, 16).replace('T', ' ')) + ' UTC · the unit’s front panel shows the bold number.</p></body></html>';
  }

  function bundle(venues) {
    return JSON.stringify({ app: 'amp-ip-planner', schema: SCHEMA, exported: new Date().toISOString(), venues: venues.map((v) => Object.assign({ id: v.id }, serialize(v))) }, null, 2);
  }

  function parseBundle(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('That file isn’t valid JSON.'); }
    let list = null;
    if (data && Array.isArray(data.venues)) list = data.venues;
    else if (data && Array.isArray(data.devices)) list = [data];
    if (!list || !list.length) throw new Error('No venues found in that file. Use a backup exported from this planner.');
    return list.filter((x) => x && typeof x === 'object').slice(0, 200);
  }

  // ---------------------------------------------------------------- sample plan
  function makeExample() {
    const v = makeVenue({ name: 'Example: arena, K2 main system', city: 'Sample plan. Duplicate it for a real show.', zones: ['Main L', 'Main R', 'Subs', 'Front fill', 'Delays', 'Control'], colors: [0, 1, 3, 4, 6, 8] });
    v.net.redundancy = true;
    v.net.dhcpFrom = '192.168.1.150';
    v.net.dhcpTo = '192.168.1.199';
    const plan = [['z1', 'K2', 12, 'LA12X', 'SL wing'], ['z2', 'K2', 12, 'LA12X', 'SR wing'], ['z3', 'KS28', 16, 'LA12X', 'Under stage'], ['z4', 'X8', 6, 'LA4X', 'Stage lip'], ['z5', 'Kara II', 12, 'LA12X', 'Delay towers']];
    v.speakers = plan.map((p, i) => ({ id: 'g' + (i + 1), model: p[1], custom: '', qty: p[2], zone: p[0], amp: p[3], per: 0 }));
    v.speakers.forEach((g, i) => syncGroup(v, g).added.forEach((d) => { d.location = plan[i][4]; }));
    packRacks(v);
    v.devices.push(newDevice({ name: 'Spare', model: 'LA12X', zone: 'z5', location: 'Amp world', notes: 'Hot spare' }));
    v.devices.push(newDevice({ name: 'FOH P1', model: 'P1', zone: 'z6', location: 'FOH' }));
    v.devices.push(newDevice({ name: 'FOH LS10 PRI', model: 'LS10', zone: 'z6', location: 'FOH', net: 'pri' }));
    v.devices.push(newDevice({ name: 'FOH LS10 SEC', model: 'LS10', zone: 'z6', location: 'FOH', net: 'sec' }));
    v.devices.push(newDevice({ name: 'Show Wi-Fi', model: 'Wi-Fi', zone: 'z6', location: 'FOH', ip: '192.168.1.1', notes: 'DHCP .150–.199 for tablets' }));
    const auto = planAutoAssign(v, { scheme: 'zones', start: 11, size: 10, scope: 'all', avoidDefaults: true });
    applyChanges(v, auto.changes);
    for (const d of v.devices) {
      if (d.name === 'Spare') d.ip = '';
      if (d.zone === 'z1' || d.zone === 'z2' || d.zone === 'z3' || d.model === 'P1') d.status = 'ok';
      else if (d.zone === 'z4' || d.model === 'LS10' || d.model === 'Wi-Fi') d.status = 'set';
    }
    return v;
  }

  // ---------------------------------------------------------------- Soundvision report import
  // Reads the text of an L-Acoustics Soundvision report (the PDF's text, one line per row):
  // groups, sources, their X position and the enclosures in each source's table.
  const SV_KEY = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const SV_ALIAS = (() => {
    const m = {};
    for (const sp of SPEAKERS) {
      m[SV_KEY(sp.id)] = sp.id;
      const parts = sp.id.split(/\s+/);
      if (sp.id.indexOf('/') >= 0) { // "A10 Focus/Wide" -> A10FOCUS, A10WIDE, A10
        const base = parts[0];
        parts.slice(1).join(' ').split('/').forEach((w) => { m[SV_KEY(base + w)] = sp.id; });
        m[SV_KEY(base)] = m[SV_KEY(base)] || sp.id;
      }
    }
    m.X15 = 'X15 HiQ'; m.K1SB = 'K1-SB';
    return m;
  })();
  // "KS28_C" (cardioid, reversed) is a KS28; "KARA II" is "Kara II"; unknown names stay as written
  function svModel(type) {
    const t = String(type || '').trim().replace(/[_ ](C|CARDIO|REV|R)$/i, '');
    return SV_ALIAS[SV_KEY(t)] || SV_ALIAS[SV_KEY(type)] || '';
  }
  const SV_NUM = /^[-+]?\d+(?:[.,]\d+)?$/;
  function parseSoundvision(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.some((l) => /^Soundvision\b/i.test(l) || /\.xmlp\b/i.test(l)) || !lines.some((l) => /^\d+\.\s*Source:/i.test(l))) {
      throw new Error('This doesn’t look like a Soundvision report. Export the report from Soundvision as a PDF and try again.');
    }
    const rep = { file: '', author: '', groups: [] };
    let group = null;
    let src = null;
    for (const l of lines) {
      let m;
      if ((m = /^File name:\s*(.+)$/i.exec(l))) { rep.file = m[1].replace(/\.xmlp$/i, '').trim(); continue; }
      if ((m = /^Author:\s*(.+)$/i.exec(l))) { rep.author = m[1].trim(); continue; }
      if ((m = /^\d+\.\s*Group:\s*(.+)$/i.exec(l))) { group = { name: m[1].trim(), sources: [] }; rep.groups.push(group); src = null; continue; }
      if ((m = /^\d+\.\s*Source:\s*(.+)$/i.exec(l))) {
        if (!group) { group = { name: 'Main', sources: [] }; rep.groups.push(group); }
        src = { name: m[1].trim(), x: null, boxes: [] };
        group.sources.push(src);
        continue;
      }
      if (!src) continue;
      if ((m = /^Position \(X;[^)]*\):\s*([-+]?\d+(?:\.\d+)?)/i.exec(l))) { if (src.x == null) src.x = +m[1]; continue; }
      if ((m = /^#\d+\s+(.+)$/.exec(l))) {
        const words = [];
        for (const w of m[1].split(' ')) { if (SV_NUM.test(w) || /\d+\/\d+/.test(w) || w === '|') break; words.push(w); }
        if (words.length) src.boxes.push(words.join(' '));
      }
    }
    rep.groups = rep.groups.filter((g) => g.sources.some((s) => s.boxes.length));
    if (!rep.groups.length) throw new Error('No speakers found in this Soundvision report.');
    return rep;
  }
  // Which side a source is on: its name first ("L2 Left"), then the sign of X (Soundvision: +X is left).
  function svSide(s) { return inferSide(s.name) || ''; }
  // Build the zones and speaker groups for a report. Each Soundvision group becomes a zone, split into
  // L and R zones when its sources are named left and right. L2D bottom boxes count into their L2 hang.
  function soundvisionPlan(rep) {
    const zones = [];
    for (const g of rep.groups) {
      const srcs = g.sources.filter((s) => s.boxes.length);
      const sides = new Set(srcs.map(svSide));
      const split = sides.has('L') && sides.has('R');
      const parts = split ? ['L', 'R', ''].map((sd) => ({ sd, list: srcs.filter((s) => svSide(s) === sd) })).filter((p) => p.list.length) : [{ sd: svSide(srcs[0]) && sides.size === 1 ? svSide(srcs[0]) : '', list: srcs }];
      for (const p of parts) {
        const name = str(split && p.sd ? g.name + ' ' + p.sd : g.name, 60);
        const counts = new Map();
        for (const s of p.list) {
          const hasL2 = s.boxes.some((b) => svModel(b) === 'L2');
          for (const b of s.boxes) {
            let model = svModel(b);
            if (model === 'L2D' && hasL2) model = 'L2';
            const key = model || 'Custom:' + b.trim();
            const c = counts.get(key) || { model: model || 'Custom', custom: model ? '' : b.trim(), qty: 0, where: [] };
            c.qty++;
            if (c.where.indexOf(s.name) < 0) c.where.push(s.name);
            counts.set(key, c);
          }
        }
        zones.push({ name, side: p.sd, speakers: Array.from(counts.values()) });
      }
    }
    return zones;
  }
  function venueFromSoundvision(rep, o) {
    o = o || {};
    const plan = soundvisionPlan(rep);
    const v = makeVenue({ name: o.name || rep.file || 'Soundvision import', zones: plan.map((z) => z.name), colors: plan.map((z, i) => DEFAULT_ZONE_COLORS[i] != null ? DEFAULT_ZONE_COLORS[i] : i % 9) });
    v.city = o.city || '';
    v.date = o.date || '';
    let unnamed = 0;
    v.zones.forEach((z, i) => { z.side = plan[i].side || inferSide(z.name) || (unnamed++ % 2 ? 'R' : 'L'); });
    v.speakers = [];
    plan.forEach((pz, i) => {
      for (const sp of pz.speakers) {
        const g = { id: uid('s'), model: sp.model, custom: sp.custom, qty: sp.qty, zone: v.zones[i].id, amp: driveOptions(sp.model)[0], per: 0 };
        v.speakers.push(g);
        const where = str(sp.where.join(', '), 80);
        syncGroup(v, g).added.forEach((d) => { d.location = where; });
      }
    });
    packRacks(v);
    applyChanges(v, planAutoAssign(v, { scheme: 'zones', start: 11, size: 10, scope: 'all', avoidDefaults: true }).changes);
    return v;
  }

  // ---------------------------------------------------------------- amp plan picture (SVG)
  const ZONE_TEXT = ['#4ea1ff', '#ff7b4a', '#2ed3a0', '#ffc233', '#ff74c4', '#63d863', '#ad9dff', '#ff6b6b', '#b8c4c9'];
  // The amp plan as a picture, the way it looks on screen: same width, height, zoom and columns
  // (opts.width / opts.height / opts.zoom / opts.half from the page), racks and single amps where they
  // were put, left half blue, right half orange, STAGE / FOH, and every zone with its colour underneath.
  function planSvg(v, opts) {
    opts = opts || {};
    const info = netInfo(v);
    const e = escHtml;
    const zmap = new Map(v.zones.map((z) => [z.id, z]));
    const SANS = 'Arial, Helvetica, sans-serif';
    const MONO = 'Consolas, Menlo, monospace';
    const z = Math.max(0.3, Math.min(1.5, +opts.zoom || 1));
    const PAD = 14;
    const CW = 142 * z / GRID_SPAN; const CH = 30 * z; const BW = 128 * z;
    const half = Math.max(GRID_SPAN, Math.min(200, opts.half || 4 * GRID_SPAN));
    const lay = gridLayout(v, half);
    const need = Math.max(...lay.map((it) => it.r + it.h), 0) * CH + 2 * PAD;
    const W = Math.round(Math.max(opts.width || 0, 2 * (PAD + (half - GRID_SPAN) * CW + BW), 600));
    const HC = Math.round(Math.max(opts.height || 0, need, 400));
    // title
    let out = '';
    // small AMP PLAN mark, the venue name large, then where / when and the counts
    out += '<text x="' + W / 2 + '" y="22" text-anchor="middle" font-family="Barlow Condensed, Arial Narrow, ' + SANS + '" font-size="20" font-weight="700" font-style="italic"><tspan fill="#fca311">AMP</tspan><tspan fill="#14213d" dx="6">PLAN</tspan></text>';
    out += '<text x="' + W / 2 + '" y="60" text-anchor="middle" font-family="' + SANS + '" font-size="32" font-weight="700" fill="#14213d">' + e(String(v.name || 'Venue').slice(0, 80)) + '</text>';
    out += '<text x="' + W / 2 + '" y="86" text-anchor="middle" font-family="' + SANS + '" font-size="15" fill="#5b666c">' + e([v.city, formatDate(v.date), plural((v.racks || []).length, 'rack'), plural(v.devices.filter((d) => isAmpModel(d.model)).length, 'amp')].filter(Boolean).join(' · ')) + '</text>';
    const TAG = 102;
    const TOP = TAG + 28;
    out += '<rect x="0" y="' + TAG + '" width="70" height="24" fill="#14213d"/><text x="35" y="' + (TAG + 17) + '" text-anchor="middle" font-family="' + SANS + '" font-size="12" font-weight="700" letter-spacing="1.5" fill="#fff">LEFT</text>';
    out += '<rect x="' + (W - 70) + '" y="' + TAG + '" width="70" height="24" fill="#a0570f"/><text x="' + (W - 35) + '" y="' + (TAG + 17) + '" text-anchor="middle" font-family="' + SANS + '" font-size="12" font-weight="700" letter-spacing="1.5" fill="#fff">RIGHT</text>';
    // the plan: two halves, grid lines one amp apart counted from each outer edge
    let g = '<rect x="0" y="0" width="' + W / 2 + '" height="' + HC + '" fill="#d3dadd"/><rect x="' + W / 2 + '" y="0" width="' + W / 2 + '" height="' + HC + '" fill="#f1dcb8"/>';
    let lines = '';
    for (let x = PAD; x < W / 2; x += CW) lines += 'M' + x.toFixed(1) + ' 0V' + HC;
    for (let x = W - PAD; x > W / 2; x -= CW) lines += 'M' + x.toFixed(1) + ' 0V' + HC;
    for (let y = PAD; y < HC; y += CH) lines += 'M0 ' + y.toFixed(1) + 'H' + W;
    g += '<path d="' + lines + '" stroke="#1d1f1c" stroke-opacity="0.08" stroke-width="1" fill="none"/>';
    g += '<line x1="' + W / 2 + '" y1="0" x2="' + W / 2 + '" y2="' + HC + '" stroke="#1d1f1c" stroke-opacity="0.25" stroke-width="1.5"/>';
    g += '<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (HC - 1) + '" fill="none" stroke="#b9b3a6"/>';
    const deck = (label, y) => '<rect x="' + (W / 2 - 60) + '" y="' + y + '" width="120" height="34" fill="#f4efe4" fill-opacity="0.75" stroke="#a8a294" stroke-width="1.5"/><text x="' + W / 2 + '" y="' + (y + 23.5) + '" text-anchor="middle" font-family="' + SANS + '" font-size="20" font-weight="700" letter-spacing="7" fill="#9a958a">' + label + '</text>';
    g += deck('STAGE', 16) + deck('FOH', HC - 52);
    const chip = (d, x, y, w) => {
      const zz = zmap.get(d.zone);
      const c = zz ? zz.color : 8;
      return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="24" rx="2" fill="' + ZONE_HEX[c] + '"/>' +
        '<text x="' + (x + w / 2) + '" y="' + (y + 16.5) + '" text-anchor="middle" font-family="' + MONO + '" font-size="12.5" font-weight="700" fill="' + (c === 3 ? '#0b0b0b' : '#fff') + '">' + e(slotLabel(v, d, info).slice(0, 16)) + '</text>';
    };
    for (const it of lay) {
      const x = it.side === 'L' ? PAD + it.c * CW : W - PAD - it.c * CW - BW;
      const y = PAD + it.r * CH;
      const h = it.h * 30 - 8; // drawn at 100% inside, then scaled like the page does
      let r = '<rect x="0" y="0" width="128" height="' + h + '" rx="3" fill="#e7dfcc" stroke="#9c937f"/>';
      r += '<rect x="3" y="3" width="122" height="' + (h - 6) + '" rx="1.5" fill="#1d2722"/>';
      const name = it.rack ? it.rack.name : (it.dev.name || modelOf(it.dev.model).label);
      const sub = it.rack ? it.rack.type || (rackModel(v, it.rack) || '') : modelOf(it.dev.model).label;
      // racks show only their type (the rack's name is left out); single amps show name and model
      if (!it.rack) r += '<text x="64" y="22" text-anchor="middle" font-family="' + MONO + '" font-size="9.5" font-weight="700" letter-spacing="0.8" fill="#9fc29a">' + e(name.toUpperCase().slice(0, 18)) + '</text>';
      r += '<text x="64" y="' + (it.rack ? 26 : 32) + '" text-anchor="middle" font-family="' + MONO + '" font-size="8" fill="#6d8070">' + e(String(sub || 'Rack').slice(0, 22)) + '</text>';
      if (it.rack) {
        rackSlots(v, it.rack).forEach((d, k) => {
          const sy = 38 + k * 28;
          if (d) r += chip(d, 14, sy, 100);
          else r += '<rect x="14.5" y="' + (sy + 0.5) + '" width="99" height="23" fill="none" stroke="#56685a" stroke-dasharray="3 3"/><text x="64" y="' + (sy + 16) + '" text-anchor="middle" font-family="' + MONO + '" font-size="11" fill="#6d8070">free</text>';
        });
      } else r += chip(it.dev, 14, 38, 100);
      g += '<g transform="translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') scale(' + z + ')">' + r + '</g>';
    }
    out += '<g transform="translate(0 ' + TOP + ')">' + g + '</g>';
    // every zone with its colour, under the plan (as on the page)
    const amps = v.devices.filter((d) => isAmpModel(d.model));
    const items = v.zones.map((zz) => ({ name: zz.name, color: ZONE_HEX[zz.color] }));
    if (amps.some((d) => !zmap.has(d.zone))) items.push({ name: 'No zone', color: ZONE_HEX[8] });
    const legW = items.map((it) => 26 + Math.min(20, it.name.length) * 8.6 + 26);
    let lx = 0; const rowsL = [[]];
    legW.forEach((w, i) => { if (lx + w > W - 40 && rowsL[rowsL.length - 1].length) { rowsL.push([]); lx = 0; } rowsL[rowsL.length - 1].push(i); lx += w; });
    let ly = TOP + HC + 34;
    rowsL.forEach((ln) => {
      const tot = ln.reduce((n, i) => n + legW[i], 0);
      let x = (W - tot) / 2;
      ln.forEach((i) => {
        out += '<rect x="' + x + '" y="' + (ly - 13) + '" width="16" height="16" rx="2" fill="' + items[i].color + '"/>';
        out += '<text x="' + (x + 24) + '" y="' + ly + '" font-family="' + SANS + '" font-size="13" font-weight="700" letter-spacing="0.6" fill="#1d1f1c">' + e(items[i].name.toUpperCase().slice(0, 20)) + '</text>';
        x += legW[i];
      });
      ly += 26;
    });
    // a margin all round, so the plan doesn't touch the picture's edges
    const M = 32;
    const H = Math.ceil(ly) + 2 * M - 10;
    const WW = W + 2 * M;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WW + '" height="' + H + '" viewBox="0 0 ' + WW + ' ' + H + '"><rect width="' + WW + '" height="' + H + '" fill="#ece6d8"/><g transform="translate(' + M + ' ' + M + ')">' + out + '</g></svg>';
  }



  const api = {
    ARRAY_BOTTOM, arrayText, arrayBottomAmp, SCHEMA, MAX_HOST, MAX_DEVICES, SAFE_ID, STATUSES, STATUS_LABEL, GROUPS, MODELS, MODEL_MAP, RACKS, RACK_MAP, DEFAULT_ZONES, ZONE_HEX, LA_RANGES, FD_UNIT, FD_LS10,
    parseIp, ipToStr, size, netOf, maskStr, host, blockOf, blockLabel, inNet, laRange, clampInt,
    modelOf, uid, escHtml, stableStringify, newDevice, sanitizeVenue, serialize, makeVenue, cloneVenue, rackDevices,
    netInfo, devNets, worst, analyze, zoneBlocks, planAutoAssign, applyChanges, rebase,
    orderedDevices, exportRows, exportColumns, toDelimited, patchSheet, bundle, parseBundle, formatDate, makeExample, plural,
    DEFAULT_RACK_SIZE, RACK_FOR, rackSizeOf, rackEquivalent, rackText, countPlan, rackSummary, equipmentLine,
    SPEAKERS, SPEAKER_MAP, SPEAKER_SERIES, DRIVE_AMPS, AMP_IDS, driveOptions, driveMax, drivePerOutput, speakerLabel, perAmp, ampsNeeded,
    nextIndex, syncGroup, removeGroup, speakerPlan,
    SIDES, SIDE_LABEL, RACK_MODEL, DEFAULT_RACK_TYPE, ZONE_TEXT, inferSide, sideFor, isAmpModel, rackById, moveRack, moveItem, planItems, singleSide, GRID_COLS, GRID_SPAN, gridLayout, placeOnGrid, rackSlots, rackModel, nextRackName, addRack, addRackWithDevices,
    placeDevice, removeRack, resizeRack, packRacks, presetOf, slotLabel, rackLabel, planSvg,
    parseSoundvision, soundvisionPlan, venueFromSoundvision, svModel, placeGroup,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IPCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
