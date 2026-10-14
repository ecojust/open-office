"""Independent pixel audit of native reopening of the actual UI exports."""
from pathlib import Path
from PIL import Image
from collections import Counter
import hashlib, json

root = Path(__file__).resolve().parents[3]
manifest = json.loads((Path(__file__).parent / 'manifest.json').read_text())['items'][0]
original_path = root / 'test-results/text-opacity-native-baseline/ordinary-text-alpha/original/editor.png'
original = Image.open(original_path).convert('RGB')
results = []
checks = []

def crop(image, item):
    x,y,w,h = item['boxMm']
    sw,sh = manifest['slideMm']
    bounds = [round(329+(x+3)/sw*780),round(164+(y+3)/sh*439),round(329+(x+w-3)/sw*780),round(164+(y+h-3)/sh*439)]
    return image.crop(bounds)

def has_color(image, rgb):
    count = sum(n for c,n in Counter(image.get_flattened_data()).items() if max(abs(a-b) for a,b in zip(c,rgb)) <= 1)
    assert count >= 12, (rgb,count)
    return count

for name in ['text-opacity-text','text-opacity-edited']:
    screenshot = root / f'test-results/text-opacity-native-exports/{name}/original/editor.png'
    image = Image.open(screenshot).convert('RGB')
    unchanged = []
    for index,item in enumerate(manifest['objects']):
        if index == 0 or index == 5 and name.endswith('edited'):
            continue
        assert crop(image,item).tobytes() == crop(original,item).tobytes(), (name,item['id'])
        unchanged.append(item['id'])
    first_rgb = [191,143,143] if name.endswith('edited') else [127,95,95]
    samples = [{'id':'direct-half','expectedRgb':first_rgb,'matchedPixels':has_color(crop(image,manifest['objects'][0]),first_rgb)}]
    if name.endswith('edited'):
        for rgb in [[0,136,0],[127,164,95],[64,150,48]]:
            samples.append({'id':'mixed-runs','expectedRgb':rgb,'matchedPixels':has_color(crop(image,manifest['objects'][5]),rgb)})
    results.append({'file':name+'.pptx','screenshot':str(screenshot.relative_to(root)),'screenshotSha256':hashlib.sha256(screenshot.read_bytes()).hexdigest(),'unchangedObjectPixels':unchanged,'editedGlyphSamples':samples})
report={'ok':True,'reader':'Pillow native-screenshot pixel audit','scope':'Compare unchanged object interiors to native original, and modified solid glyph colors to compositing math. Does not assert identical font metrics between products.','originalScreenshotSha256':hashlib.sha256(original_path.read_bytes()).hexdigest(),'cases':results}
out=root/'test-results/text-opacity-native-exports/pixel-observations.json'
out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'ok':True,'unchangedObjectRegions':sum(len(r['unchangedObjectPixels'])for r in results),'glyphSamples':sum(len(r['editedGlyphSamples'])for r in results)}))
