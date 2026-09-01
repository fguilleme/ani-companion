from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / 'static' / 'icons'
out.mkdir(parents=True, exist_ok=True)
for size in (192, 512):
    image = Image.new('RGB', (size, size), '#17131c')
    draw = ImageDraw.Draw(image)
    s = size / 512
    draw.ellipse((86*s, 58*s, 426*s, 468*s), fill='#f0c86f', outline='#70563a', width=max(2, int(10*s)))
    draw.ellipse((126*s, 92*s, 386*s, 434*s), fill='#f4d3c9')
    draw.pieslice((90*s, 44*s, 422*s, 360*s), 185, 355, fill='#f3ce78')
    draw.ellipse((177*s, 226*s, 237*s, 292*s), fill='#74c8ef')
    draw.ellipse((275*s, 226*s, 335*s, 292*s), fill='#74c8ef')
    draw.ellipse((198*s, 245*s, 218*s, 274*s), fill='#164e84')
    draw.ellipse((296*s, 245*s, 316*s, 274*s), fill='#164e84')
    draw.arc((214*s, 286*s, 300*s, 360*s), 20, 160, fill='#9f5362', width=max(2, int(8*s)))
    draw.polygon([(134*s,150*s),(55*s,90*s),(78*s,196*s),(25*s,232*s),(146*s,252*s)], fill='#1b1720')
    draw.polygon([(378*s,150*s),(457*s,90*s),(434*s,196*s),(487*s,232*s),(366*s,252*s)], fill='#1b1720')
    image.save(out / f'ani-{size}.png')
