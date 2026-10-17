"""Build a single-file preview of the Rain Alarm app with the sample data
currently in docs/data (run scripts/make_demo_nowcast.py first).

    python scripts/build_preview.py path/to/leaflet.css preview.html
"""
import base64, gzip, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "docs"
leaflet_css = Path(sys.argv[1]).read_text()
out = Path(sys.argv[2])

def rle(b):
    o, i, n = bytearray(), 0, len(b)
    while i < n:
        v, j = b[i], i
        while j < n and b[j] == v and j - i < 255: j += 1
        o += bytes((v, j - i)); i = j
    return base64.b64encode(bytes(o)).decode()

doc = json.loads((D / "data/nowcast.json").read_text())
g = doc["grid"]; n = g["nrows"] * g["ncols"]
raw = gzip.decompress((D / "data/nowcast_grid.bin.gz").read_bytes())
layers = [rle(raw[i * n:(i + 1) * n]) for i in range(len(g["layers"]))]
hist = json.loads((D / "data/history.json").read_text())["frames"]
history = [{"time_utc": f["time_utc"], "b64": rle(gzip.decompress((D / f"data/history/{f['version']}.bin.gz").read_bytes()))}
           for f in hist if f["version"] != doc["version"]]
inline = {"doc": doc, "layersB64": layers, "history": history, "rebase": True}
files = {"data/places.json": json.loads((D / "data/places.json").read_text()),
         "data/boundaries.json": json.loads((D / "data/boundaries.json").read_text())}
if (D / "data/radars.json").exists():
    files["data/radars.json"] = json.loads((D / "data/radars.json").read_text())
logo = "data:image/png;base64," + base64.b64encode((D / "icons/logo.png").read_bytes()).decode()

html = (D / "index.html").read_text()
mark = "data:image/png;base64," + base64.b64encode((D / "icons/mark.png").read_bytes()).decode()
body = html.split("<body>", 1)[1].split('<script src="https://cdnjs')[0].replace("icons/logo.png", logo).replace("icons/mark.png", mark)
page = f"""<title>MasRainman Rain Alarm</title>
<meta name="theme-color" content="#1b1446">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800&family=Noto+Sans+Tamil:wght@500;700&display=swap" rel="stylesheet">
<style>{leaflet_css}</style>
<style>{(D / 'app.css').read_text()}</style>
{body}
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>window.RA_INLINE_DATA = {json.dumps(inline)};
window.RA_SAMPLE_PLACES = [{{"id":"s1","en":"Chennai","ta":"சென்னை","lat":13.083,"lon":80.27}},{{"id":"s2","en":"Tambaram","ta":"தாம்பரம்","lat":12.925,"lon":80.127}},{{"id":"s3","en":"Madurai","ta":"மதுரை","lat":9.925,"lon":78.12}},{{"id":"s4","en":"Kochi","ta":"கொச்சி","lat":9.97,"lon":76.28}}];
window.RA_INLINE_FILES = {json.dumps(files, ensure_ascii=False)};</script>
<script>{(D / 'engine.js').read_text()}</script>
<script>{(D / 'app.js').read_text()}</script>
"""
out.write_text(page)
print(out, round(len(page) / 1e6, 2), "MB")
