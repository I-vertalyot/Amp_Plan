"""Screenshot the rack view of the example plan (light and dark, desktop and narrow)."""
import pathlib, sys
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'dist/index.html').as_uri()
OUT = ROOT / 'shots'
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for scheme, w in (('light', 1440), ('dark', 1440), ('light', 1100)):
        ctx = b.new_context(viewport={'width': w, 'height': 1000}, color_scheme=scheme)
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL)
        pg.wait_for_selector('.empty, .vhead', timeout=15000)
        pg.wait_for_timeout(1700)
        pg.click('[data-act="load-example"]')
        pg.wait_for_selector('.stbl')
        pg.click('#tab-devices')
        pg.wait_for_selector('.plan')
        pg.add_style_tag(content='#toasts{display:none!important}')
        pg.wait_for_timeout(300)
        pg.locator('.plan').screenshot(path=str(OUT / f'plan-{scheme}-{w}.png'))
        if scheme == 'light' and w == 1440:
            pg.locator('.pside-L .pslot[data-dev]').first.click()
            pg.wait_for_selector('#ae-ip')
            pg.wait_for_timeout(150)
            pg.locator('.modal').screenshot(path=str(OUT / 'plan-editor-linked.png'))
            pg.keyboard.press('Escape')
            pg.locator('.ptray .pslot[data-dev]').first.click()
            pg.wait_for_selector('#ae-ip')
            pg.wait_for_timeout(150)
            pg.locator('.modal').screenshot(path=str(OUT / 'plan-editor-free.png'))
            pg.keyboard.press('Escape')
            pg.locator('.prack-name').first.click()
            pg.wait_for_selector('#re-name')
            pg.locator('.modal').screenshot(path=str(OUT / 'plan-rack-editor.png'))
            pg.keyboard.press('Escape')
        print(scheme, w, 'errors', errs)
        ctx.close()
    b.close()
