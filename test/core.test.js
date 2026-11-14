const assert = require('assert');
const C = require('../src/core.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', n, name); };

t('parse / format', () => {
  assert.strictEqual(C.parseIp('192.168.1.11'), 3232235787);
  assert.strictEqual(C.ipToStr(3232235787), '192.168.1.11');
  assert.strictEqual(C.parseIp(' 10.0.0.1 '), 167772161);
  assert.strictEqual(C.parseIp('192.168.1.256'), null);
  assert.strictEqual(C.parseIp('192.168.1'), null);
  assert.strictEqual(C.parseIp('a.b.c.d'), null);
  assert.strictEqual(C.parseIp('192.168.001.010'), C.parseIp('192.168.1.10'));
  assert.strictEqual(C.ipToStr(C.parseIp('255.255.255.255')), '255.255.255.255');
  assert.strictEqual(C.maskStr(24), '255.255.255.0');
  assert.strictEqual(C.maskStr(16), '255.255.0.0');
  assert.strictEqual(C.maskStr(8), '255.0.0.0');
  assert.strictEqual(C.maskStr(20), '255.255.240.0');
});

t('netInfo /24 with redundancy', () => {
  const v = C.makeVenue();
  v.net.redundancy = true;
  const i = C.netInfo(v);
  assert.ok(i.ok);
  assert.strictEqual(C.ipToStr(i.network), '192.168.1.0');
  assert.strictEqual(C.ipToStr(i.broadcast), '192.168.1.255');
  assert.strictEqual(i.blockStr, '192.168.1');
  assert.strictEqual(C.ipToStr(i.secNetwork), '192.168.2.0');
  assert.strictEqual(i.secBlockStr, '192.168.2');
  assert.ok(i.secOk);
});

t('netInfo /16 matches manual example 172.16.1.100 -> 172.17.1.100', () => {
  const v = C.makeVenue();
  Object.assign(v.net, { network: '172.16.0.0', prefix: 16, block: '172.16.1', computer: '172.16.1.254', redundancy: true });
  const i = C.netInfo(v);
  assert.strictEqual(i.blockStr, '172.16.1');
  assert.strictEqual(C.ipToStr(i.secNetwork), '172.17.0.0');
  const d = C.newDevice({ model: 'LA12X', ip: '172.16.1.100', zone: 'z1' });
  v.devices.push(d);
  const dn = C.devNets(v, d, i);
  assert.strictEqual(C.ipToStr(dn.sec), '172.17.1.100');
});

t('secondary out of private range for 10.0.0.0/8', () => {
  const v = C.makeVenue();
  Object.assign(v.net, { network: '10.0.0.0', prefix: 8, block: '10.0.1', computer: '10.0.1.254', redundancy: true });
  const a = C.analyze(v);
  assert.ok(a.issues.some((x) => x.code === 'sec-range' && x.sev === 'error'));
});

t('duplicates incl. secondary collisions', () => {
  const v = C.makeVenue();
  v.net.redundancy = true;
  const a1 = C.newDevice({ name: 'A', model: 'LA12X', ip: '192.168.1.11', zone: 'z1' });
  const a2 = C.newDevice({ name: 'B', model: 'LA12X', ip: '192.168.1.11', zone: 'z1' });
  const sw = C.newDevice({ name: 'SW', model: 'LS10', ip: '192.168.2.12', net: 'sec', zone: 'z1' });
  const a3 = C.newDevice({ name: 'C', model: 'LA12X', ip: '192.168.1.12', zone: 'z1' });
  v.devices.push(a1, a2, sw, a3);
  const a = C.analyze(v);
  const dupA = a.byDev.get(a1.id).filter((x) => x.code === 'dup');
  assert.strictEqual(dupA.length, 1, 'A/B clash reported once (secondary mirrors primary)');
  assert.ok(a.byDev.get(sw.id).some((x) => x.code === 'dup' && /“C” \(secondary\)/.test(x.msg)));
  assert.ok(a.byDev.get(a3.id).some((x) => x.code === 'dup' && /secondary address/.test(x.msg)));
  assert.strictEqual(a.stats.errors, 4);
});

t('device-level checks', () => {
  const v = C.makeVenue();
  v.net.dhcpFrom = '192.168.1.150';
  v.net.dhcpTo = '192.168.1.199';
  const mk = (o) => { const d = C.newDevice(Object.assign({ zone: 'z1' }, o)); v.devices.push(d); return d; };
  const bad = mk({ model: 'LA12X', ip: '192.168.1.300' });
  const out = mk({ model: 'LA12X', ip: '192.168.5.10' });
  const bc = mk({ model: 'LA4X', ip: '192.168.1.255' });
  const fd = mk({ model: 'LA4X', ip: '192.168.1.100' });
  const dh = mk({ model: 'P1', ip: '192.168.1.160' });
  const pc = mk({ model: 'LA12X', ip: '192.168.1.254' });
  const none = mk({ model: 'LA12X', ip: '' });
  const sw = mk({ model: 'Switch', ip: '' });
  const leg = mk({ model: 'LA8', ip: '192.168.1.20' });
  const a = C.analyze(v);
  const codes = (d) => (a.byDev.get(d.id) || []).map((x) => x.code);
  assert.deepStrictEqual(codes(bad), ['ip-invalid']);
  assert.ok(codes(out).includes('ip-subnet'));
  assert.ok(codes(out).includes('ip-block'));
  assert.ok(codes(bc).includes('ip-bcast'));
  assert.ok(codes(fd).includes('ip-default'));
  assert.ok(codes(dh).includes('ip-dhcp'));
  assert.ok(codes(pc).includes('dup'));
  assert.deepStrictEqual(codes(none), ['no-ip']);
  assert.deepStrictEqual(codes(sw), []);
  assert.deepStrictEqual(codes(leg), []);
});

t('legacy LA8 on another subnet', () => {
  const v = C.makeVenue();
  Object.assign(v.net, { network: '10.10.1.0', computer: '10.10.1.254' });
  const d = C.newDevice({ model: 'LA8', ip: '10.10.1.20', zone: 'z1' });
  v.devices.push(d);
  const a = C.analyze(v);
  assert.ok(a.issues.some((x) => x.code === 'legacy-net'));
  assert.ok(a.byDev.get(d.id).some((x) => x.code === 'legacy-ip'));
});

t('network-level: public range, computer outside, gateway outside', () => {
  const v = C.makeVenue();
  Object.assign(v.net, { network: '8.8.8.0', computer: '192.168.1.254', gateway: '10.0.0.1' });
  const a = C.analyze(v);
  const codes = a.issues.filter((x) => !x.dev).map((x) => x.code);
  assert.ok(codes.includes('net-range'));
  assert.ok(codes.includes('pc-subnet'));
  assert.ok(codes.includes('gw-subnet'));
});

t('auto-assign: zone blocks, computer, defaults, dhcp, redundancy', () => {
  const v = C.makeVenue();
  v.net.redundancy = true;
  v.devices.push(...C.rackDevices('LA-RAK II AVB', 'RAK 1', 'z1'));
  v.devices.push(...C.rackDevices('LA-RAK III', 'RAK 2', 'z2'));
  v.devices.push(C.newDevice({ name: 'Console', model: 'Console', zone: 'z8', ip: '192.168.1.81' }));
  v.devices.push(C.newDevice({ name: 'P1', model: 'P1', zone: 'z8' }));
  const plan = C.planAutoAssign(v, { scheme: 'zones', start: 11, size: 10, scope: 'empty', avoidDefaults: true });
  assert.strictEqual(plan.unplaced.length, 0);
  C.applyChanges(v, plan.changes);
  const by = Object.fromEntries(v.devices.map((d) => [d.name, d.ip]));
  assert.strictEqual(by['RAK 1 A'], '192.168.1.11');
  assert.strictEqual(by['RAK 1 C'], '192.168.1.13');
  assert.strictEqual(by['RAK 1 LS10 PRI'], '192.168.1.14');
  assert.strictEqual(by['RAK 1 LS10 SEC'], '192.168.2.14');
  assert.strictEqual(by['RAK 2 A'], '192.168.1.21');
  assert.strictEqual(by['P1'], '192.168.1.82', 'skips the console at .81');
  const a = C.analyze(v);
  assert.strictEqual(a.stats.errors, 0, JSON.stringify(a.issues.filter((x) => x.sev === 'error')));
  // sequential, renumber all, avoid .100
  const v2 = C.makeVenue();
  v2.net.dhcpFrom = '192.168.1.5';
  v2.net.dhcpTo = '192.168.1.9';
  for (let i = 0; i < 100; i++) v2.devices.push(C.newDevice({ name: 'A' + i, model: 'LA4X', zone: 'z1' }));
  const p2 = C.planAutoAssign(v2, { scheme: 'sequential', start: 1, scope: 'all', avoidDefaults: true });
  C.applyChanges(v2, p2.changes);
  const ips = v2.devices.map((d) => C.parseIp(d.ip) % 256);
  assert.ok(!ips.includes(100) && !ips.some((h) => h >= 5 && h <= 9));
  assert.strictEqual(ips[0], 1);
  assert.strictEqual(ips[4], 10);
  // block full
  const v3 = C.makeVenue();
  for (let i = 0; i < 12; i++) v3.devices.push(C.newDevice({ name: 'X' + i, model: 'LA12X', zone: 'z1' }));
  const p3 = C.planAutoAssign(v3, { scheme: 'zones', start: 11, size: 10, scope: 'empty' });
  assert.strictEqual(p3.changes.length, 10);
  assert.strictEqual(p3.unplaced.length, 2);
});

t('auto-assign leaves manual devices and onlyIds', () => {
  const v = C.makeVenue();
  const a = C.newDevice({ name: 'keep', model: 'LA12X', zone: 'z1', ip: '192.168.1.11' });
  const b = C.newDevice({ name: 'new', model: 'LA12X', zone: 'z1' });
  const c = C.newDevice({ name: 'other', model: 'LA12X', zone: 'z1' });
  v.devices.push(a, b, c);
  const p = C.planAutoAssign(v, { scheme: 'zones', start: 11, size: 10, scope: 'empty', onlyIds: [b.id] });
  assert.deepStrictEqual(p.changes.map((x) => [x.id, x.to]), [[b.id, '192.168.1.12']]);
});

t('example plan is clean except the spare', () => {
  const v = C.makeExample();
  const a = C.analyze(v);
  assert.strictEqual(a.stats.errors, 0, JSON.stringify(a.issues));
  assert.strictEqual(a.stats.warns, 1);
  assert.strictEqual(a.stats.devices, 20);
  assert.strictEqual(a.stats.units, 17);
  assert.strictEqual(a.stats.channels, 64);
  assert.strictEqual(C.ipToStr(a.stats.scanFrom), '192.168.1.11');
  assert.strictEqual(C.ipToStr(a.stats.scanTo), '192.168.1.61');
  const by = Object.fromEntries(v.devices.map((d) => [d.name, d.ip]));
  assert.strictEqual(by['FOH LS10 SEC'], '192.168.2.62');
  assert.strictEqual(by['Front fill X8 1'], '192.168.1.41');
  assert.strictEqual(by['Main R K2 4'], '192.168.1.24');
});

t('rebase keeps last numbers', () => {
  const v = C.makeExample();
  const before = C.netInfo(v);
  v.net.network = '10.10.1.0';
  const after = C.netInfo(v);
  const moved = C.rebase(v, before, after);
  assert.strictEqual(moved, 19);
  const by = Object.fromEntries(v.devices.map((d) => [d.name, d.ip]));
  assert.strictEqual(by['Main L K2 1'], '10.10.1.11');
  assert.strictEqual(by['FOH LS10 SEC'], '10.10.2.62');
  assert.strictEqual(v.net.computer, '10.10.1.254');
  assert.strictEqual(v.net.dhcpFrom, '10.10.1.150');
  assert.strictEqual(C.analyze(v).stats.errors, 0);
});

t('exports', () => {
  const v = C.makeExample();
  const csv = C.toDelimited(v, ';');
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines.length, 1 + 1 + 20);
  assert.ok(lines[0].startsWith('Zone;Name;Model;Preset;IP address;Secondary IP;Network'));
  assert.ok(lines[1].includes('Control computer'));
  assert.ok(csv.includes('Main L K2 1;LA12X;K2;192.168.1.11;192.168.2.11;Primary + secondary'));
  const tsv = C.toDelimited(v, '\t');
  assert.strictEqual(tsv.split('\r\n')[2].split('\t').length, 14);
  const html = C.patchSheet(v);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('192.168.1.<b>11</b>'));
  assert.ok(html.includes('24 × K2 → 8 × LA12X'));
  assert.ok(!/<script/i.test(html));
  const evil = C.makeVenue({ name: '<img src=x onerror=alert(1)>' });
  evil.devices.push(C.newDevice({ name: '<script>x</script>', model: 'LA12X', zone: 'z1', notes: '=HYPERLINK("x")' }));
  const h2 = C.patchSheet(evil);
  assert.ok(!h2.includes('<script>x') && !h2.includes('<img src=x'));
  assert.ok(C.toDelimited(evil, ',').includes("'=HYPERLINK"));
});

t('bundle round trip + sanitize junk', () => {
  const v = C.makeExample();
  const text = C.bundle([v]);
  const list = C.parseBundle(text);
  assert.strictEqual(list.length, 1);
  const back = C.sanitizeVenue('vX', list[0]);
  assert.strictEqual(C.stableStringify(C.serialize(back)), C.stableStringify(C.serialize(Object.assign({}, v, { id: 'vX' }))));
  const junk = C.sanitizeVenue('vJ', { name: 5, zones: 'x', devices: [null, { id: '../bad', model: 'nope', zone: 'zz', ip: 7 }], net: { prefix: 99 } });
  assert.strictEqual(junk.net.prefix, 24);
  assert.strictEqual(junk.devices.length, 1);
  assert.strictEqual(junk.devices[0].model, 'Other');
  assert.ok(C.SAFE_ID.test(junk.devices[0].id));
  assert.strictEqual(junk.devices[0].zone, junk.zones[0].id);
  assert.throws(() => C.parseBundle('nope'));
  assert.throws(() => C.parseBundle('{"a":1}'));
});

t('clone resets status', () => {
  const v = C.makeExample();
  const c = C.cloneVenue(v);
  assert.notStrictEqual(c.id, v.id);
  assert.ok(c.devices.every((d) => d.status === 'planned'));
  assert.strictEqual(c.devices.length, v.devices.length);
});

t('amp count and rack equivalents', () => {
  const v = C.makeExample();
  const cp = C.countPlan(v);
  assert.strictEqual(cp.ampTotal, 16);
  assert.strictEqual(cp.channels, 64);
  assert.strictEqual(cp.totals.LA12X, 15);
  assert.deepStrictEqual(cp.equiv.LA12X, { full: 5, rem: 0, needed: 5, freeSlots: 0 });
  assert.strictEqual(cp.equiv.LA4X, null);
  assert.strictEqual(C.rackSummary(cp), '7 racks + 1 not in a rack');
  assert.strictEqual(C.rackSummary(C.countPlan(Object.assign({}, v, { racks: [] }))), 'fills 5 racks + 1 without a rack size');
  assert.strictEqual(C.rackText(C.rackEquivalent(14, 3), 3), '4 full racks + 2 amps = 5 racks, 1 slot free');
  assert.strictEqual(C.rackText(C.rackEquivalent(2, 3), 3), '1 rack, 1 slot free');
  assert.strictEqual(C.rackText(C.rackEquivalent(6, 3), 3), '2 racks of 3');
  v.rackSize = { LA4X: 4, LA12X: 0 };
  const cp2 = C.countPlan(v);
  assert.strictEqual(cp2.equiv.LA12X, null);
  assert.deepStrictEqual(cp2.equiv.LA4X, { full: 0, rem: 1, needed: 1, freeSlots: 3 });
  const back = C.sanitizeVenue('vR', JSON.parse(JSON.stringify(C.serialize(v))));
  assert.deepStrictEqual(back.rackSize, { LA4X: 4, LA12X: 0 });
  // racks added by hand remember their rack
  const r = C.makeVenue();
  C.addRackWithDevices(r, 'LA-RAK III', 'RAK 1', 'z1');
  const rc = C.countPlan(r);
  assert.strictEqual(rc.racks.length, 1);
  assert.strictEqual(rc.racks[0].type, 'LA-RAK III');
  assert.strictEqual(rc.inRacks['LA7.16'], 3);
  assert.strictEqual(rc.inRacks.LS10, 2);
  const rs = C.sanitizeVenue('x', C.serialize(r));
  assert.strictEqual(rs.racks[0].name, 'RAK 1');
  assert.strictEqual(rs.racks[0].side, 'L');
  assert.deepStrictEqual(rs.devices.map((d) => d.slot), [0, 1, 2, -1, -1]);
});

t('speakers add the amps L-Acoustics specifies', () => {
  assert.strictEqual(C.driveMax('K2', 'LA12X'), 3);
  assert.strictEqual(C.driveMax('K2', 'LA7.16'), 4);
  assert.strictEqual(C.driveMax('K2', 'LA4X'), 1);
  assert.strictEqual(C.driveMax('KS28', 'LA12X'), 4);
  assert.deepStrictEqual(C.driveOptions('KS28'), ['LA12X']);
  assert.deepStrictEqual(C.driveOptions('L2'), ['LA7.16']);
  const v = C.makeExample();
  const sp = C.speakerPlan(v);
  assert.strictEqual(sp.enclosures, 58);
  const k2 = sp.types.find((x) => x.label === 'K2');
  assert.strictEqual(k2.qty, 24);
  assert.strictEqual(k2.amps, 8);
  assert.deepStrictEqual(k2.e, { full: 2, rem: 2, needed: 3, freeSlots: 1 });
  const la12 = sp.ampModels.find((m) => m.id === 'LA12X');
  assert.strictEqual(la12.racks.length, 5);
  assert.strictEqual(la12.other, 1);
  // more K2 in Main L: 13 -> 5 amps, the new amp is linked and placed after the others
  const g = v.speakers[0];
  g.qty = 13;
  let r = C.syncGroup(v, g);
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(r.added[0].name, 'Main L K2 5');
  assert.strictEqual(v.devices.indexOf(r.added[0]), 4);
  // fewer: 6 K2 -> 2 amps; the unaddressed new one goes first
  g.qty = 6;
  r = C.syncGroup(v, g);
  assert.strictEqual(r.removed.length, 3);
  assert.ok(r.removed.some((d) => d.name === 'Main L K2 5'));
  assert.strictEqual(v.devices.filter((d) => d.drives === g.id).length, 2);
  // switch to LA7.16: 4 K2 per amp
  g.amp = 'LA7.16'; g.qty = 12; g.per = 0;
  r = C.syncGroup(v, g);
  const linked = v.devices.filter((d) => d.drives === g.id);
  assert.strictEqual(linked.length, 3);
  assert.ok(linked.every((d) => d.model === 'LA7.16'));
  // a lower per-amp limit is honoured, a higher one is capped
  g.amp = 'LA12X'; g.per = 2; assert.strictEqual(C.ampsNeeded(g), 6);
  g.per = 9; assert.strictEqual(C.perAmp(g), 3);
  // custom speaker
  const cg = { id: 'gc', model: 'Custom', custom: 'Old sub', qty: 11, zone: 'z3', amp: 'LA8', per: 5 };
  assert.strictEqual(C.ampsNeeded(cg), 3);
  // out of step is reported
  const v2 = C.makeExample();
  v2.devices = v2.devices.filter((d) => d.name !== 'Subs KS28 4');
  const a2 = C.analyze(v2);
  assert.ok(a2.issues.some((x) => x.code === 'spk-amps' && x.tab === 'speakers'));
  // removing a group removes its amps
  const gone = C.removeGroup(v2, 'g3');
  assert.strictEqual(gone.length, 3);
  assert.ok(!v2.devices.some((d) => d.drives === 'g3'));
  // sanitize keeps links, drops dangling ones, turns unknown models into custom
  const raw = C.serialize(C.makeExample());
  raw.speakers.push({ id: 'gx', model: 'K9000', qty: 4, zone: 'z1', amp: 'LA12X' });
  raw.devices[0].drives = 'nope';
  const sv = C.sanitizeVenue('vS', raw);
  assert.strictEqual(sv.speakers[5].model, 'Custom');
  assert.strictEqual(sv.speakers[5].custom, 'K9000');
  assert.strictEqual(sv.devices[0].drives, '');
  assert.strictEqual(sv.devices[1].drives, 'g1');
});

t('racks: layout, swap, pack, resize, legacy names, labels', () => {
  const v = C.makeExample();
  const info = C.netInfo(v);
  assert.strictEqual(v.racks.length, 7);
  assert.deepStrictEqual(v.racks.map((r) => r.side).join(''), 'LLRRCCC');
  const r6 = v.racks[5];
  assert.deepStrictEqual(C.rackSlots(v, r6).map((d) => C.slotLabel(v, d, info)), ['KS28 - 34', 'Kara II - 51', 'Kara II - 52']);
  const spare = v.devices.find((d) => d.name === 'Spare');
  assert.strictEqual(spare.rack, '');
  assert.strictEqual(C.slotLabel(v, spare, info), 'LA12X');
  // swap two amps
  const a1 = C.rackSlots(v, v.racks[0])[0];
  const b1 = C.rackSlots(v, v.racks[2])[1];
  C.placeDevice(v, a1.id, v.racks[2].id, 1);
  assert.strictEqual(C.rackSlots(v, v.racks[2])[1], a1);
  assert.strictEqual(C.rackSlots(v, v.racks[0])[0], b1);
  // drop on an empty slot, then take it out of the rack
  C.placeDevice(v, a1.id, v.racks[1].id, 2);
  assert.strictEqual(C.rackSlots(v, v.racks[2])[1], null);
  C.placeDevice(v, a1.id, '', -1);
  assert.strictEqual(a1.rack, '');
  // pack puts the spare and a1 back on the right side: spare zone Delays (center), a1 zone Main L (left)
  const res = C.packRacks(v);
  assert.strictEqual(res.placed, 2);
  assert.strictEqual(res.created.length, 1, 'center LA12X racks are full and RAK 7 holds an LA4X, so the spare gets a new rack');
  assert.strictEqual(res.created[0].name, 'RAK 8');
  assert.strictEqual(C.rackById(v, a1.rack).side, 'L');
  assert.strictEqual(C.rackById(v, spare.rack).side, 'C');
  // resize pushes amps out, remove empties a rack
  const out = C.resizeRack(v, v.racks[0], 1);
  assert.ok(out.length >= 1);
  const gone = C.removeRack(v, v.racks[4].id);
  assert.strictEqual(gone.length, 3);
  assert.strictEqual(v.racks.length, 7);
  // a linked amp changing model leaves a rack that can't hold it
  const g = v.speakers[0];
  g.amp = 'LA7.16';
  C.syncGroup(v, g);
  assert.ok(v.devices.filter((d) => d.drives === g.id).every((d) => !d.rack));
  // presets: manual preset on an unlinked amp, warning when the amp can't drive it
  const amp = C.newDevice({ name: 'Extra', model: 'LA4X', zone: 'z3', preset: 'KS28', ip: '192.168.1.39' });
  v.devices.push(amp);
  assert.strictEqual(C.presetOf(v, amp), 'KS28');
  assert.strictEqual(C.slotLabel(v, amp, info), 'KS28 - 39');
  assert.ok((C.analyze(v).byDev.get(amp.id) || []).some((x) => x.code === 'preset-amp'));
  // side from zone names, English and Czech
  assert.deepStrictEqual(['Main L', 'Out R', 'Left hang', 'Levá strana', 'Subs', 'FF'].map(C.inferSide), ['L', 'R', 'L', 'L', 'C', 'C']);
  // older documents with a rack name per device become racks
  const legacyBody = C.serialize(C.makeVenue());
  legacyBody.devices = [
    { id: 'a', name: 'A', model: 'LA12X', zone: 'z2', rack: 'RAK 9', rackType: 'LA-RAK II AVB' },
    { id: 'b', name: 'B', model: 'LA12X', zone: 'z2', rack: 'RAK 9' },
    { id: 'c', name: 'C', model: 'LS10', zone: 'z2', rack: 'RAK 9' },
  ];
  delete legacyBody.racks;
  const lv = C.sanitizeVenue('vL', legacyBody);
  assert.strictEqual(lv.racks.length, 1);
  assert.strictEqual(lv.racks[0].name, 'RAK 9');
  assert.strictEqual(lv.racks[0].side, 'R');
  assert.strictEqual(lv.racks[0].type, 'LA-RAK II AVB');
  assert.deepStrictEqual(lv.devices.map((d) => [d.rack === lv.racks[0].id, d.slot]), [[true, 0], [true, 1], [true, -1]]);
  // the picture
  const svg = C.planSvg(C.makeExample());
  assert.ok(svg.startsWith('<svg') && svg.includes('K2 - 11') && svg.includes('Not in a rack') && svg.includes('MAIN L'));
  assert.ok(!/<script/i.test(svg));
  // CSV has preset and rack position
  assert.ok(C.toDelimited(C.makeExample(), ';').includes('Main L K2 1;LA12X;K2;192.168.1.11;192.168.2.11;Primary + secondary;255.255.255.0;SL wing;RAK 1 · slot 1 (Left)'));
});

t('amps can have no zone', () => {
  const v = C.makeExample();
  const spare = v.devices.find((d) => d.name === 'Spare');
  spare.zone = '';
  const back = C.sanitizeVenue(v.id, JSON.parse(JSON.stringify(C.serialize(v))));
  assert.strictEqual(back.devices.find((d) => d.name === 'Spare').zone, '');
  const cp = C.countPlan(back);
  assert.strictEqual(cp.rows[cp.rows.length - 1].zone.name, 'No zone');
  assert.strictEqual(cp.rows[cp.rows.length - 1].amps, 1);
  assert.ok(C.planSvg(back).indexOf('<svg') === 0);
});

t('L2 hang ends with one L2D', () => {
  const v = C.makeExample();
  const g = { id: 'gl2', model: 'L2', custom: '', qty: 4, zone: v.zones[0].id, amp: 'LA7.16', per: 0 };
  v.speakers.push(g);
  C.syncGroup(v, g);
  const amps = () => v.devices.filter((d) => d.drives === 'gl2').map((d) => C.presetOf(v, d));
  assert.deepStrictEqual(amps(), ['L2', 'L2', 'L2', 'L2D']);
  assert.strictEqual(C.arrayText(g), '3 × L2 + 1 × L2D');
  g.qty = 7; C.syncGroup(v, g);
  assert.deepStrictEqual(amps().filter((x) => x === 'L2D').length, 1);
  assert.strictEqual(amps()[6], 'L2D');
  assert.strictEqual(C.arrayText({ model: 'K2', qty: 12, custom: '' }), '12 × K2');
});

console.log('\nall', n, 'tests passed');