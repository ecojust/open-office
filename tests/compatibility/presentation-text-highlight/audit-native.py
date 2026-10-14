"""Compare untouched object interiors in actual UI exports reopened natively."""
from pathlib import Path
from PIL import Image
import hashlib
import json

root = Path(__file__).resolve().parents[3]
fixture = json.loads((Path(__file__).parent / 'manifest.json').read_text())['items'][0]
baseline_path = root / 'test-results/highlight-native-baseline/ordinary-highlight/original/editor.png'
baseline = Image.open(baseline_path).convert('RGB')


def crop(image, item):
    x, y, w, h = item['boxMm']
    sw, sh = fixture['slideMm']
    return image.crop((round(329 + (x + 3) / sw * 780), round(164 + (y + 3) / sh * 439),
                       round(329 + (x + w - 3) / sw * 780), round(164 + (y + h - 3) / sh * 439)))


cases = []
for name, changed in [('highlight-text', {1}), ('highlight-edited', {1, 4, 5})]:
    screenshot = root / f'test-results/highlight-native-exports/{name}/original/editor.png'
    image = Image.open(screenshot).convert('RGB')
    same = []
    for index, item in enumerate(fixture['objects']):
        if index in changed:
            continue
        assert crop(image, item).tobytes() == crop(baseline, item).tobytes(), (name, item['id'])
        same.append(item['id'])
    cases.append({'file': name + '.pptx', 'screenshot': str(screenshot.relative_to(root)),
                  'screenshotSha256': hashlib.sha256(screenshot.read_bytes()).hexdigest(),
                  'unchangedObjectRegions': same})

result = {
    'ok': True,
    'scope': 'Untouched native object interiors match the native baseline. No cross-product pixel equality or native-resave claim.',
    'originalScreenshotSha256': hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
    'cases': cases,
}
(root / 'test-results/highlight-native-exports/pixel-observations.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'ok': True, 'unchangedObjectRegions': sum(len(c['unchangedObjectRegions']) for c in cases)}))
