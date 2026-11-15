import pathlib
root = pathlib.Path(__file__).parent
t = (root / 'src/index.template.html').read_text()
for key, f in (('/*__CSS__*/', 'src/style.css'), ('/*__CORE__*/', 'src/core.js'), ('/*__APP__*/', 'src/app.js')):
    body = (root / f).read_text()
    assert '</script' not in body.lower() or f.endswith('.css'), f
    t = t.replace(key, body)
out = root / 'dist/index.html'
out.write_text(t)
print(out, len(t.encode()), 'bytes')

# website extras for installing as an app: manifest, offline worker, icons (copied next to index.html)
import shutil
for f in ('manifest.webmanifest', 'sw.js'):
    shutil.copy(root / 'pwa' / f, root / 'dist' / f)
shutil.copytree(root / 'pwa/icons', root / 'dist/icons', dirs_exist_ok=True)
shutil.copytree(root / 'pwa/screenshots', root / 'dist/screenshots', dirs_exist_ok=True)
