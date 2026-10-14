"""Independently compare unchanged regions of actual saved files in native app."""
from pathlib import Path
from PIL import Image
import hashlib, json

root=Path(__file__).resolve().parents[3]
manifest=json.loads((Path(__file__).parent/'manifest.json').read_text())['items'][0]
original_path=root/'test-results/decoration-native-baseline/ordinary-decorations/original/editor.png'
original=Image.open(original_path).convert('RGB')

def crop(image,item):
    x,y,w,h=item['boxMm']; sw,sh=manifest['slideMm']
    return image.crop((round(329+(x+3)/sw*780),round(164+(y+3)/sh*439),round(329+(x+w-3)/sw*780),round(164+(y+h-3)/sh*439)))

cases=[]
for name, changed in [('decorations-edited',{5}),('decorations-text',{5,10})]:
    path=root/f'test-results/decoration-native-exports/{name}/original/editor.png'
    image=Image.open(path).convert('RGB'); same=[]
    for i,item in enumerate(manifest['objects']):
        if i in changed: continue
        assert crop(image,item).tobytes()==crop(original,item).tobytes(), (name,item['id'])
        same.append(item['id'])
    cases.append({'file':name+'.pptx','screenshot':str(path.relative_to(root)),'screenshotSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'unchangedObjectRegions':same})
result={'ok':True,'scope':'Native untouched object interiors match native original; changed regions visually reviewed separately. No cross-product pixel-equality or native-resave claim.','originalScreenshotSha256':hashlib.sha256(original_path.read_bytes()).hexdigest(),'cases':cases}
(root/'test-results/decoration-native-exports/pixel-observations.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'ok':True,'unchangedObjectRegions':sum(len(c['unchangedObjectRegions']) for c in cases)}))
