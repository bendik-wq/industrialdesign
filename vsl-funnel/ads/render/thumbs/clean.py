import cv2, numpy as np, sys
for t in sys.argv[1:]:
    im = cv2.imread(f'base_{t}.png')
    b, g, r = [im[..., i].astype(int) for i in range(3)]
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    white = (mn > 232) & (mx - mn < 22)
    yellow = (r > 215) & (g > 160) & (b < 110) & (r - b > 120)
    m = np.zeros(im.shape[:2], np.uint8)
    reg = np.zeros_like(m); reg[:1400, :1350] = 1
    m[(white | yellow) & (reg > 0)] = 255
    m = cv2.dilate(m, np.ones((15, 15), np.uint8))
    small = cv2.resize(im, None, fx=0.5, fy=0.5); sm = cv2.resize(m, None, fx=0.5, fy=0.5)
    fix = cv2.inpaint(small, sm, 12, cv2.INPAINT_TELEA)
    fix = cv2.resize(fix, (im.shape[1], im.shape[0]), interpolation=cv2.INTER_CUBIC)
    mm = cv2.GaussianBlur(m, (0, 0), 3)[..., None] / 255.0
    out = (im * (1 - mm) + fix * mm).astype(np.uint8)
    cv2.imwrite(f'clean_{t}.png', out)
    cv2.imwrite(f'clean_{t}_v.jpg', cv2.resize(out, (960, 540)))
    print(t, int(m.sum() / 255))
