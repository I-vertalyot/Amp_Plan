"""One headless pass over the built page: local mode and a mocked db/downloads runtime."""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'dist/index.html').as_uri()
SHOTS = ROOT / 'shots'
SHOTS.mkdir(exist_ok=True)

MOCK = r"""
(() => {
  const store = new Map();
  const listeners = new Set();
  window.__writes = [];
  window.__saved = [];
  const snap = () => ({
    docs: [...store.entries()].map(([id, data]) => ({ id, exists: true, data: () => JSON.parse(JSON.stringify(data)), metadata: { fromCache: false, hasPendingWrites: false } })),
    size: store.size, empty: !store.size, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [],
  });
  const notify = () => setTimeout(() => listeners.forEach((l) => l(snap())), 30);
  const db = {
    collection(path) {
      return {
        path,
        onSnapshot(next, err) { listeners.add(next); setTimeout(() => next(snap()), 50); return () => listeners.delete(next); },
        doc(id) {
          return {
            id,
            async set(data) {
              if (JSON.stringify(data).length > 256 * 1024) throw { code: 'invalid_argument' };
              window.__writes.push(id); await new Promise((r) => setTimeout(r, 40)); store.set(id, JSON.parse(JSON.stringify(data))); notify();
            },
            async delete() { store.delete(id); notify(); },
          };
        },
      };
    },
  };
  const user = { can: async () => true, isOwner: async () => true, canEdit: async () => true };
  const downloads = { save: async ({ filename, data }) => { window.__saved.push([filename, typeof data === 'string' ? data.length : -1]); return { status: 'saved' }; } };
  window.claude = { use: (name) => new Promise((r) => setTimeout(() => r({ db, user, downloads }[name] || null), 20)) };
})();
"""


def run(p, label, mock, dark=False):
    errors = []
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, color_scheme='dark' if dark else 'light')
    if mock:
        ctx.add_init_script(MOCK)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.' + m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
    page.goto(URL)
    page.wait_for_selector('#rail .brand, .vhead', timeout=15000)
    page.wait_for_timeout(1700 if not mock else 200)
    page.screenshot(path=str(SHOTS / f'{label}-1-empty.png'))
    page.click('[data-act="load-example"]')
    page.wait_for_selector('.stbl')
    page.wait_for_timeout(400)
    page.screenshot(path=str(SHOTS / f'{label}-2-speakers.png'), full_page=True)
    print(label, 'pill:', page.inner_text('.pill').replace('\n', ' | '))
    print(label, 'need:', page.inner_text('.need-model').split('\n')[:3])
    # one more K2 in Main L: 13 K2 -> 5 amps
    page.locator('tr[data-spk]').first.locator('[data-step="1"]').click()
    page.wait_for_timeout(250)
    print(label, 'after +1 K2:', page.locator('tr[data-spk]').first.locator('.num').inner_text(), '| summary amps:', page.locator('.fact-btn').nth(1).inner_text().replace('\n', ' '))
    # add L2 on LA7.16 through the dialog
    page.click('[data-act="add-speakers"]')
    page.wait_for_selector('#sp-model')
    page.select_option('#sp-model', 'L2')
    page.fill('#sp-qty', '8')
    page.select_option('#sp-zone', label='Front fill')
    page.wait_for_timeout(100)
    print(label, 'L2 amps options:', page.locator('#sp-amp option').all_inner_texts(), '| calc:', page.inner_text('#sp-calc').replace('\n', ' '))
    page.screenshot(path=str(SHOTS / f'{label}-2b-addspeakers.png'))
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(300)
    print(label, 'after L2 pill:', page.inner_text('.pill').replace('\n', ' | '))
    # change amp of the KS28 row is impossible (LA12X only); switch Kara II delays to LA7.16
    kara = page.locator('tr[data-spk]').filter(has_text='Kara II')
    kara.locator('[data-sf="amp"]').select_option('LA7.16')
    page.wait_for_timeout(300)
    print(label, 'Kara II on LA7.16 ->', page.locator('tr[data-spk]').filter(has_text='Kara II').locator('.num').inner_text())
    page.screenshot(path=str(SHOTS / f'{label}-2c-speakers-after.png'), full_page=True)

    # devices tab opens on the rack view (the amp plan)
    page.click('#tab-devices')
    page.wait_for_selector('.plan')
    print(label, 'grid cells:', page.locator('.pcell').count(), '| layout picker gone:', page.locator('[data-act="plan-layout"]').count() == 0)
    rack = lambda name: page.locator('.pcell', has=page.locator('.prack[data-name="' + name + '"]')).first
    page.screenshot(path=str(SHOTS / f'{label}-3a-racks.png'), full_page=True)
    racks_txt = lambda: [' | '.join(page.locator('.prack:not(.psingle)').nth(k).inner_text().split('\n')) for k in range(page.locator('.prack:not(.psingle)').count())]
    print(label, 'racks:', racks_txt())
    print(label, 'singles:', page.locator('.psingle .pslot[data-dev]').all_inner_texts())
    # a linked K2 amp: preset is locked, .21 is taken by Main R, pick .19
    rack('RAK 1').locator('.pslot[data-dev]').first.click()
    page.wait_for_selector('#ae-ip')
    print(label, 'editor title:', page.inner_text('#m-title'), '| locked:', page.locator('#ae-locked').is_visible(), '| preset select hidden:', page.locator('#ae-preset').is_hidden())
    opt21 = page.locator('#ae-ip option[value="21"]')
    print(label, 'option 21:', opt21.inner_text(), '| disabled:', opt21.is_disabled(), '| prefix:', page.inner_text('#ae-prefix'))
    assert 'swap' in opt21.inner_text(), 'taken number not marked swap'
    page.select_option('#ae-ip', '19')
    page.wait_for_timeout(50)
    print(label, 'ip hint:', page.inner_text('#ae-ip-hint'))
    page.screenshot(path=str(SHOTS / f'{label}-3b-amp-editor.png'))
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(200)
    first = rack('RAK 1').locator('.pslot[data-dev]').first.inner_text()
    print(label, 'after .19:', first)
    assert first == 'K2 - 19', 'ip change not shown'
    # the spare amp in the tray: choose a preset and a number, then pack it
    page.locator('.psingle .pslot[data-dev]').first.click()
    page.wait_for_selector('#ae-preset')
    page.select_option('#ae-preset', 'KS28')
    page.select_option('#ae-ip', '60')
    page.wait_for_timeout(50)
    print(label, 'spare preset hint:', page.inner_text('#ae-preset-hint'))
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(200)
    print(label, 'tray after spare:', page.locator('.psingle .pslot[data-dev]').all_inner_texts())
    page.click('[data-act="rack-pack"]')
    page.wait_for_timeout(200)
    print(label, 'after pack:', racks_txt()[-2:], '| tray:', page.locator('.psingle .pslot[data-dev]').count())
    # unlink one Main R amp to Kara II on its own
    rack('RAK 3').locator('.pslot[data-dev]').nth(1).click()
    page.wait_for_selector('#ae-unlock')
    page.click('#ae-unlock')
    page.select_option('#ae-preset', 'Kara II')
    page.wait_for_timeout(50)
    print(label, 'unlink hint:', page.inner_text('#ae-preset-hint'))
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(200)
    print(label, 'toast:', page.locator('.toast').last.inner_text().replace('\n', ' '))
    right_txt = lambda: rack('RAK 3').inner_text().replace('\n', ' | ')
    print(label, 'right rack:', right_txt(), '| pill:', page.inner_text('.pill').replace('\n', ' | '))
    page.locator('.toast').last.locator('button').click()
    page.wait_for_timeout(200)
    print(label, 'after undo right rack:', right_txt())
    # drag the second Left K2 rack's amp into an empty slot of rack 1? rack 1 is full: drag into rack 2's empty slot
    src = rack('RAK 1').locator('.pslot[data-dev]').nth(2)
    dst = page.locator('.pcell .prack:not(.psingle) .pslot.p-empty').first
    vp = page.viewport_size
    page.set_viewport_size({'width': vp['width'], 'height': 1600})  # both racks on screen for the drag
    src.drag_to(dst)
    page.wait_for_timeout(200)
    page.set_viewport_size(vp)
    print(label, 'after drag left:', racks_txt()[:2])
    # empty slot -> new amp
    rack('RAK 1').locator('.pslot.p-empty').first.click()
    page.wait_for_selector('#ae-preset')
    page.select_option('#ae-preset', 'K1')
    page.wait_for_timeout(50)
    print(label, 'new amp ip:', page.locator('#ae-ip').input_value(), '| model:', page.locator('#ae-model').input_value(), '| zone:', page.locator('#ae-zone option:checked').inner_text())
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(200)
    print(label, 'after new amp:', racks_txt()[0], '| pill:', page.inner_text('.pill').replace('\n', ' | '))
    # rack editor
    rack('RAK 1').locator('.prack-name').click()
    page.wait_for_selector('#re-name')
    page.fill('#re-name', 'SL A')
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(150)
    print(label, 'renamed:', page.locator('.prack-name').first.inner_text().replace('\n', ' '))
    page.add_style_tag(content='#toasts{display:none!important}')
    page.locator('.plan').screenshot(path=str(SHOTS / f'{label}-3c-racks-after.png'))
    page.add_style_tag(content='#toasts{display:block!important}')
    if mock:
        page.click('.more-menu > summary'); page.click('[data-act="export"]')
        page.wait_for_selector('.export-list')
        page.click('[data-x="png"]')
        page.wait_for_timeout(600)
        page.click('[data-x="svg"]')
        page.wait_for_timeout(200)
        print(label, 'plan downloads:', page.evaluate('window.__saved'))
        page.keyboard.press('Escape')
    # then the list view for the table steps
    page.click('[data-act="dev-view"][data-view="list"]')

    # devices tab: type a conflicting address on a delay amp using the shorthand
    page.wait_for_selector('#dev-table')
    row = page.locator('tr.dev').filter(has=page.locator('input[value="Delays Kara II 1"]'))
    ipin = row.locator('input[data-f="ip"]')
    ipin.fill('21')
    ipin.press('Enter')
    page.wait_for_timeout(200)
    print(label, 'delay ip ->', ipin.input_value(), '| pill:', page.inner_text('.pill').replace('\n', ' | '))
    assert ipin.input_value() == '192.168.1.21', 'shorthand expansion failed'
    assert 'error' in page.inner_text('.pill').lower(), 'duplicate not flagged'
    page.screenshot(path=str(SHOTS / f'{label}-3-conflict.png'))
    page.click('#tab-checks')
    page.wait_for_selector('.checks, .all-clear')
    page.screenshot(path=str(SHOTS / f'{label}-4-checks.png'))
    page.click('#tab-devices')
    ipin = page.locator('tr.dev').filter(has=page.locator('input[value="Delays Kara II 1"]')).locator('input[data-f="ip"]')
    ipin.fill('192.168.1.51')
    ipin.press('Tab')
    page.wait_for_timeout(150)

    # map tab
    page.click('#tab-checks')
    print(label, 'tabs:', page.locator('#tabs .tab').count())
    page.click('details[data-sec="map"] > summary')
    page.wait_for_selector('.ipgrid')
    page.hover('.ipc[data-h="11"]')
    page.wait_for_timeout(100)
    tip = page.inner_text('#tip')
    print(label, 'tip .11:', tip.replace('\n', ' | '))
    page.screenshot(path=str(SHOTS / f'{label}-5-map.png'))
    # click a free cell and assign the spare
    page.click('.ipc[data-h="57"]')
    page.wait_for_selector('#as-dev')
    page.select_option('#as-dev', label=page.locator('#as-dev option').first.inner_text())
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(200)
    print(label, 'after assign pill:', page.inner_text('.pill').replace('\n', ' | '))

    # auto-assign dialog: add 5 x LA4X to Front fill without assigning, then preview
    page.click('#tab-devices')
    page.wait_for_selector('#dev-table')
    page.click('[data-act="add-devices"]')
    page.wait_for_selector('#ad-model')
    page.select_option('#ad-model', 'LA4X')
    page.fill('#ad-qty', '5')
    page.uncheck('#ad-assign')
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(200)
    page.click('[data-act="auto-assign"]')
    page.wait_for_selector('#aa-prev')
    page.wait_for_timeout(150)
    print(label, 'auto-assign preview:', page.inner_text('#aa-prev').split('\n')[0])
    page.screenshot(path=str(SHOTS / f'{label}-6-autoassign.png'))
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(200)

    # add a rack, redundancy toggle off and on
    page.click('[data-act="add-rack"]')
    page.wait_for_selector('#ar-type')
    page.select_option('#ar-type', 'LA-RAK III')
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(200)
    print(label, 'network card hidden:', page.locator('#net-card').count() == 0)
    page.click('.more-menu summary')
    page.click('.more-menu [data-act="net-toggle"]')
    page.wait_for_selector('#n-network')
    page.click('label.switch')
    page.wait_for_timeout(200)
    off_pill = page.inner_text('.pill').replace('\n', ' | ')
    page.click('label.switch')
    page.wait_for_timeout(200)
    print(label, 'redundancy off pill:', off_pill, '|| back on:', page.inner_text('.pill').replace('\n', ' | '))

    # network change with rebase
    page.fill('#n-network', '10.20.1.0')
    page.press('#n-network', 'Enter')
    page.wait_for_selector('.modal')
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(250)
    first_ip = page.locator('tr.dev input[data-f="ip"]').first.input_value()
    print(label, 'after rebase first ip:', first_ip, '| pill:', page.inner_text('.pill').replace('\n', ' | '))

    # export modal
    page.click('.more-menu > summary'); page.click('[data-act="export"]')
    page.wait_for_selector('.export-list')
    page.screenshot(path=str(SHOTS / f'{label}-7-export.png'))
    if mock:
        page.click('[data-x="csv"]')
        page.wait_for_timeout(150)
        page.click('[data-x="sheet"]')
        page.wait_for_timeout(150)
        print(label, 'downloads:', page.evaluate('window.__saved'))
    page.keyboard.press('Escape')

    # zones dialog + rules tab
    page.click('#tab-devices')
    page.wait_for_selector('#dev-table')
    page.click('[data-act="zones"]')
    page.wait_for_selector('#ze-list')
    page.click('#ze-add')
    page.click('.modal-f .btn-primary')
    page.wait_for_timeout(150)
    page.click('#tab-checks')
    if not page.locator('details[data-sec="rules"]').get_attribute('open') is not None:
        page.click('details[data-sec="rules"] > summary')
    page.wait_for_selector('.rules')
    page.screenshot(path=str(SHOTS / f'{label}-8-rules.png'))

    # undo keyboard
    page.click('#tab-devices')
    page.locator('body').click(position={'x': 5, 'y': 890})
    page.keyboard.press('Control+z')
    page.wait_for_timeout(200)

    # wait for saves
    page.wait_for_timeout(1200)
    status = page.inner_text('#store-status')
    print(label, 'status:', status)
    if mock:
        print(label, 'writes:', len(page.evaluate('window.__writes')))
        # reload: data must come back from the mock? (mock store is per page; reload clears it) -> check local mode persistence instead
    else:
        page.reload()
        page.wait_for_selector('.vhead', timeout=10000)
        print(label, 'after reload venue:', page.input_value('#v-name'), '| tabs:', page.inner_text('#tabs').replace('\n', ' '))

    # mobile layout
    page.set_viewport_size({'width': 390, 'height': 844})
    page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / f'{label}-9-mobile.png'))
    page.click('#tab-devices')
    page.click('[data-act="dev-view"][data-view="racks"]')
    page.wait_for_selector('.plan')
    page.wait_for_timeout(150)
    page.screenshot(path=str(SHOTS / f'{label}-9b-mobile-racks.png'), full_page=True)
    print(label, 'mobile racks scrollWidth:', page.evaluate('document.documentElement.scrollWidth'))
    page.click('[data-act="dev-view"][data-view="list"]')
    page.click('#tab-devices')
    page.wait_for_selector('#dev-table')
    page.locator('#dev-table tr.dev').nth(5).scroll_into_view_if_needed()
    page.wait_for_timeout(150)
    page.screenshot(path=str(SHOTS / f'{label}-10-mobile-cards.png'))
    sw = page.evaluate('document.documentElement.scrollWidth')
    print(label, 'mobile scrollWidth:', sw)
    b.close()
    return errors


with sync_playwright() as p:
    allerr = []
    import subprocess
    subprocess.run(['node', '-e', "const C=require('./src/core.js');require('fs').writeFileSync('shots/patch.html', C.patchSheet(C.makeExample()))"], cwd=ROOT, check=True)
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(viewport={'width': 1200, 'height': 800})
    pg.goto((ROOT / 'shots/patch.html').as_uri())
    pg.screenshot(path=str(SHOTS / 'patch.png'))
    b.close()
    for label, mock, dark in (('local', False, False), ('db', True, True)):
        errs = run(p, label, mock, dark)
        fonts = [e for e in errs if 'fonts.g' in e or 'ERR_' in e or 'net::' in e]
        other = [e for e in errs if e not in fonts]
        print(label, 'errors:', len(other), other[:10])
        allerr += other
    sys.exit(1 if allerr else 0)
