from pathlib import Path
import sys
import pymupdf

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / 'test-results' / 'pdf-ui'
out.mkdir(exist_ok=True, parents=True)
doc = pymupdf.open()
for index in range(3):
    page = doc.new_page(width=595, height=842)
    page.draw_rect(pymupdf.Rect(32, 32, 563, 170), color=None, fill=(0.91, 0.95, 1))
    page.insert_text((50, 65), f'ORIGINAL PAGE {index + 1}', fontsize=18, color=(0.1, 0.2, 0.4))
    page.insert_text((50, 120), 'KEEP THIS NEIGHBOR', fontsize=12)
    page.insert_text((50, 220), f'Searchable reference unique-{index + 1}', fontsize=12)
doc.save(out/'fixture.pdf')
doc.save(out/'protected.pdf', encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner123', user_pw='test123', permissions=pymupdf.PDF_PERM_PRINT | pymupdf.PDF_PERM_COPY)
image = doc[0].get_pixmap(matrix=pymupdf.Matrix(.5, .5))
image.save(out/'image.png')
scan = pymupdf.open()
page = scan.new_page(width=595, height=842)
page.insert_image(page.rect, stream=image.tobytes('png'))
scan.save(out/'scanned.pdf')
scan.close()
cropped = pymupdf.open()
page = cropped.new_page(width=600, height=800)
page.insert_text((120, 170), 'CROPPED ORIGINAL', fontsize=14)
page.set_cropbox(pymupdf.Rect(70, 90, 570, 730))
page.set_rotation(90)
cropped.save(out/'cropped.pdf')
cropped.close()
doc.close()
print('Created PDF fixtures')
