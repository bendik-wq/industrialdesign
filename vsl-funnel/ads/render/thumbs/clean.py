import cv2, numpy as np, sys
for t in sys.argv[1:]:
    im = cv2.imread(f'base_{t}.png')
    b, g, r = [im[..., i].astype(int) for i in range(3)]
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    white = (mn > 232) & (mx - mn < 22)
    yellow = (r > 215) & (g > 160) & (b < 110) & (r - b > 120)
    m = np.zeros(im.shape[:2], np.uint8)
    reg = np.zeros_like(m); reg[:1400, :1350] = 1; reg[1800:, 600:] = 1
    m[(white | yellow) & (reg > 0)] = 255
    bot = np.zeros_like(m); bot[1950:, 600:] = 1
    m[(mn > 175) & (mx - mn < 30) & (bot > 0)] = 255
    tx = (np.abs(cv2.Laplacian(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), cv2.CV_32F)) > 25) & (mn > 120) & (mx - mn < 45)
    m[tx & (bot > 0)] = 255
    import os
    if os.path.exists(f'mask_{t}.png'):
        pm = cv2.imread(f'mask_{t}.png', 0) > 100
        pm = cv2.dilate(pm.astype(np.uint8), np.ones((25, 25), np.uint8)) > 0
        side = np.zeros_like(m); side[700:1450, :1750] = 1
        txt2 = (np.abs(cv2.Laplacian(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), cv2.CV_32F)) > 30) & (mn > 150) & (mx - mn < 40)
        m[txt2 & (side > 0) & (~pm)] = 255
        m = cv2.dilate(m, np.ones((9, 9), np.uint8))
    m = cv2.dilate(m, np.ones((15, 15), np.uint8))
    for (x0, y0, x1, y1) in {'296': [(0, 940, 1320, 1190)]}.get(t, []):
        m[y0:y1, x0:x1] = 255
    small = cv2.resize(im, None, fx=0.5, fy=0.5); sm = cv2.resize(m, None, fx=0.5, fy=0.5)
    fix = cv2.inpaint(small, sm, 12, cv2.INPAINT_TELEA)
    fix = cv2.resize(fix, (im.shape[1], im.shape[0]), interpolation=cv2.INTER_CUBIC)
    mm = cv2.GaussianBlur(m, (0, 0), 3)[..., None] / 255.0
    out = (im * (1 - mm) + fix * mm).astype(np.uint8)
    cv2.imwrite(f'clean_{t}.png', out)
    cv2.imwrite(f'clean_{t}_v.jpg', cv2.resize(out, (960, 540)))
    print(t, int(m.sum() / 255))
