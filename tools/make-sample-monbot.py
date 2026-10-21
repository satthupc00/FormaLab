"""Generates the MonBot sample: a small rigged robot as ASCII FBX 7.4 + PBR textures.

Outputs (in samples/MonBot):
  MonBot.fbx               mesh + skeleton + "Idle" animation, BaseColor/Normal/Emissive linked
  animations/MonBot_Anim_Walk.fbx  skeleton + "Walk" animation only (same bone names)
  animations/MonBot_Anim_Wave.fbx  skeleton + "Wave" animation only
  textures/MonBot_BaseColor.png, _Normal.png (OpenGL), _ORM.png (R=AO G=Roughness B=Metallic), _Emissive.png

Run:  python3 tools/make-sample-monbot.py
Units are centimetres (like Maya), Y up, character faces +Z, left side is +X.
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'samples', 'MonBot')
TEX = 1024
FPS = 30
KTIME = 46186158000  # FBX ticks per second

# ---------------------------------------------------------------------------
# skeleton (global rest positions, no rest rotations)
# ---------------------------------------------------------------------------
BONES = [  # name, parent, global position
    ('Hips', None, (0, 92, 0)),
    ('Spine', 'Hips', (0, 104, 0)),
    ('Chest', 'Spine', (0, 120, 0)),
    ('Neck', 'Chest', (0, 146, 0)),
    ('Head', 'Neck', (0, 152, 0)),
    ('L_UpperArm', 'Chest', (24, 141, 0)),
    ('L_Forearm', 'L_UpperArm', (26, 117, 0)),
    ('L_Hand', 'L_Forearm', (27, 95, 0)),
    ('R_UpperArm', 'Chest', (-24, 141, 0)),
    ('R_Forearm', 'R_UpperArm', (-26, 117, 0)),
    ('R_Hand', 'R_Forearm', (-27, 95, 0)),
    ('L_UpLeg', 'Hips', (10, 86, 0)),
    ('L_Leg', 'L_UpLeg', (10, 50, 0)),
    ('L_Foot', 'L_Leg', (10, 12, 0)),
    ('R_UpLeg', 'Hips', (-10, 86, 0)),
    ('R_Leg', 'R_UpLeg', (-10, 50, 0)),
    ('R_Foot', 'R_Leg', (-10, 12, 0)),
]
BONE_POS = {n: np.array(p, float) for n, _, p in BONES}
BONE_PARENT = {n: par for n, par, _ in BONES}

# ---------------------------------------------------------------------------
# atlas layout: name -> (u0, v0, u1, v1) in 0..1 (v up, like FBX)
# ---------------------------------------------------------------------------
def px(x0, y0, x1, y1):  # pixel rect (y down) -> uv rect (v up)
    return (x0 / TEX, 1 - y1 / TEX, x1 / TEX, 1 - y0 / TEX)

ATLAS = {
    'head': px(0, 0, 512, 256),
    'torso': px(512, 0, 1024, 256),
    'pelvis': px(512, 256, 768, 384),
    'limb': px(0, 256, 512, 384),
    'forearm': px(0, 384, 512, 512),
    'joint': px(768, 256, 1024, 384),
    'hand': px(768, 384, 1024, 512),
    'foot': px(512, 384, 768, 512),
    'antenna': px(0, 512, 256, 640),
    'ball': px(256, 512, 512, 640),
    'core': px(512, 512, 768, 768),
}


class Mesh:
    def __init__(self):
        self.pos = []      # unique positions
        self.weight = []   # bone name per position
        self.polys = []    # list of lists of (pos index, normal, uv)

    def add_vertex(self, p, bone):
        self.pos.append(np.array(p, float))
        self.weight.append(bone)
        return len(self.pos) - 1


def lerp_uv(rect, u, v):
    u0, v0, u1, v1 = rect
    m = 0.004  # keep away from region borders
    return (u0 + m + (u1 - u0 - 2 * m) * u, v0 + m + (v1 - v0 - 2 * m) * v)


def add_box(mesh, center, size, bone, rect):
    c, s = np.array(center, float), np.array(size, float) / 2
    corners = {}
    for ix in (-1, 1):
        for iy in (-1, 1):
            for iz in (-1, 1):
                corners[(ix, iy, iz)] = mesh.add_vertex(c + s * (ix, iy, iz), bone)
    # faces: normal, 4 corners (ccw seen from outside), cell in a 3x2 grid of the uv rect
    faces = [
        ((0, 0, 1), [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)], (1, 0)),
        ((0, 0, -1), [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)], (1, 1)),
        ((1, 0, 0), [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)], (2, 0)),
        ((-1, 0, 0), [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)], (0, 0)),
        ((0, 1, 0), [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)], (0, 1)),
        ((0, -1, 0), [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)], (2, 1)),
    ]
    quad_uv = [(0, 0), (1, 0), (1, 1), (0, 1)]
    for n, cs, (cx, cy) in faces:
        poly = []
        for k, key in enumerate(cs):
            qu, qv = quad_uv[k]
            poly.append((corners[key], n, lerp_uv(rect, (cx + qu) / 3, (cy + qv) / 2)))
        mesh.polys.append(poly)


def add_capsule(mesh, a, b, radius, bone, rect, seg=16, rings=4):
    """Cylinder from a to b with hemispherical caps. Smooth normals, cylindrical uv."""
    a, b = np.array(a, float), np.array(b, float)
    axis = b - a
    length = np.linalg.norm(axis)
    w = axis / length
    tmp = np.array([0, 0, 1.0]) if abs(w[2]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(w, tmp); u /= np.linalg.norm(u)
    v = np.cross(w, u)
    # profile rows: (offset along axis, radius scale, normal axial component)
    rows = []
    for i in range(rings, 0, -1):
        t = (math.pi / 2) * i / rings
        rows.append((-math.sin(t) * radius, math.cos(t), -math.sin(t)))
    rows.append((0, 1, 0))
    rows.append((length, 1, 0))
    for i in range(1, rings + 1):
        t = (math.pi / 2) * i / rings
        rows.append((length + math.sin(t) * radius, math.cos(t), math.sin(t)))
    total = len(rows) - 1
    grid = []
    for r, (off, sc, na) in enumerate(rows):
        line = []
        for j in range(seg + 1):
            ang = 2 * math.pi * j / seg
            radial = math.cos(ang) * u + math.sin(ang) * v
            p = a + w * off + radial * radius * sc
            nrm = radial * math.sqrt(max(0, 1 - na * na)) + w * na
            idx = mesh.add_vertex(p, bone) if j < seg else line[0][0]
            line.append((idx, tuple(nrm / np.linalg.norm(nrm)), (j / seg, r / total)))
        grid.append(line)
    for r in range(total):
        for j in range(seg):
            q = [grid[r][j], grid[r][j + 1], grid[r + 1][j + 1], grid[r + 1][j]]
            if q[0][0] == q[3][0] or q[1][0] == q[2][0]:
                pass
            mesh.polys.append([(i, n, lerp_uv(rect, uu, vv)) for i, n, (uu, vv) in q])


def add_sphere(mesh, center, radii, bone, rect, seg=24, rings=14):
    c, rr = np.array(center, float), np.array(radii, float)
    grid = []
    for r in range(rings + 1):
        phi = math.pi * r / rings  # 0 = bottom
        line = []
        for j in range(seg + 1):
            th = 2 * math.pi * j / seg  # j=0 at back (-Z), j=seg/2 at front (+Z)
            d = np.array([-math.sin(th) * math.sin(phi), -math.cos(phi), -math.cos(th) * math.sin(phi)])
            p = c + d * rr
            nrm = d / rr
            nrm /= np.linalg.norm(nrm)
            idx = mesh.add_vertex(p, bone) if j < seg else line[0][0]
            line.append((idx, tuple(nrm), (j / seg, r / rings)))
        grid.append(line)
    for r in range(rings):
        for j in range(seg):
            q = [grid[r][j], grid[r][j + 1], grid[r + 1][j + 1], grid[r + 1][j]]
            mesh.polys.append([(i, n, lerp_uv(rect, uu, vv)) for i, n, (uu, vv) in q])


def build_mesh():
    m = Mesh()
    P = BONE_POS
    add_sphere(m, (0, 168, 0), (17, 16, 16), 'Head', ATLAS['head'])
    add_capsule(m, (0, 145, 0), (0, 152, 0), 5, 'Neck', ATLAS['joint'], seg=12, rings=2)
    add_box(m, (0, 128, 0), (40, 30, 24), 'Chest', ATLAS['torso'])
    add_box(m, (0, 128, 12.4), (12, 12, 1.2), 'Chest', ATLAS['core'])
    add_capsule(m, (0, 104, 0), (0, 113, 0), 9, 'Spine', ATLAS['joint'], seg=14, rings=2)
    add_box(m, (0, 93, 0), (30, 12, 20), 'Hips', ATLAS['pelvis'])
    add_capsule(m, (0, 184, 0), (0, 194, 0), 1.2, 'Head', ATLAS['antenna'], seg=8, rings=1)
    add_sphere(m, (0, 197, 0), (3.2, 3.2, 3.2), 'Head', ATLAS['ball'], seg=12, rings=8)
    for side, sx in (('L', 1), ('R', -1)):
        add_sphere(m, P[f'{side}_UpperArm'], (7, 7, 7), f'{side}_UpperArm', ATLAS['joint'], seg=14, rings=8)
        add_capsule(m, P[f'{side}_UpperArm'] + (0, -6, 0), P[f'{side}_Forearm'] + (0, 3, 0), 5, f'{side}_UpperArm', ATLAS['limb'])
        add_sphere(m, P[f'{side}_Forearm'], (5, 5, 5), f'{side}_Forearm', ATLAS['joint'], seg=12, rings=8)
        add_capsule(m, P[f'{side}_Forearm'] + (0, -4, 0), P[f'{side}_Hand'] + (0, 4, 0), 5.6, f'{side}_Forearm', ATLAS['forearm'])
        add_box(m, P[f'{side}_Hand'] + (0, -5, 0), (8, 11, 6), f'{side}_Hand', ATLAS['hand'])
        add_sphere(m, P[f'{side}_UpLeg'] + (0, -2, 0), (6.5, 6.5, 6.5), f'{side}_UpLeg', ATLAS['joint'], seg=12, rings=8)
        add_capsule(m, P[f'{side}_UpLeg'] + (0, -8, 0), P[f'{side}_Leg'] + (0, 4, 0), 6.5, f'{side}_UpLeg', ATLAS['limb'])
        add_sphere(m, P[f'{side}_Leg'], (6, 6, 6), f'{side}_Leg', ATLAS['joint'], seg=12, rings=8)
        add_capsule(m, P[f'{side}_Leg'] + (0, -5, 0), P[f'{side}_Foot'] + (0, 5, 0), 6.8, f'{side}_Leg', ATLAS['forearm'])
        add_box(m, P[f'{side}_Foot'] + (0, -6, 4), (14, 10, 24), f'{side}_Foot', ATLAS['foot'])
    return m


# ---------------------------------------------------------------------------
# textures
# ---------------------------------------------------------------------------
def rect_px(name):
    u0, v0, u1, v1 = ATLAS[name]
    return int(u0 * TEX), int((1 - v1) * TEX), int(u1 * TEX), int((1 - v0) * TEX)


def make_textures():
    os.makedirs(os.path.join(OUT, 'textures'), exist_ok=True)
    WHITE, RED, GUN, VISOR, CYAN = (226, 224, 218), (229, 56, 59), (58, 61, 68), (22, 24, 30), (80, 230, 255)
    base = Image.new('RGB', (TEX, TEX), WHITE)
    rough = Image.new('L', (TEX, TEX), 115)   # 0.45 painted plastic
    metal = Image.new('L', (TEX, TEX), 0)
    ao = Image.new('L', (TEX, TEX), 255)
    height = Image.new('L', (TEX, TEX), 128)
    emis = Image.new('RGB', (TEX, TEX), (0, 0, 0))
    db, dr, dm, da, dh, de = (ImageDraw.Draw(i) for i in (base, rough, metal, ao, height, emis))

    def fill(name, color, r, m):
        b = rect_px(name)
        db.rectangle(b, fill=color); dr.rectangle(b, fill=r); dm.rectangle(b, fill=m)

    def panel_lines(name, cols, rows, inset=10):
        x0, y0, x1, y1 = rect_px(name)
        cw, ch = (x1 - x0) / cols, (y1 - y0) / rows
        for i in range(cols):
            for j in range(rows):
                r = (x0 + i * cw + inset, y0 + j * ch + inset, x0 + (i + 1) * cw - inset, y0 + (j + 1) * ch - inset)
                dh.rectangle(r, outline=40, width=4)
                da.rectangle(r, outline=150, width=4)
                db.rectangle(r, outline=(150, 148, 144), width=2)

    fill('joint', GUN, 90, 255)
    fill('antenna', GUN, 90, 255)
    fill('ball', RED, 70, 0)
    fill('core', (40, 10, 12), 40, 0)
    for name in ('torso', 'pelvis', 'limb', 'forearm', 'hand', 'foot'):
        fill(name, WHITE, 115, 0)
    panel_lines('torso', 3, 2)
    panel_lines('pelvis', 3, 2)
    panel_lines('hand', 3, 2, 6)
    panel_lines('foot', 3, 2, 6)
    # red accent stripes on forearms / shins and the chest
    x0, y0, x1, y1 = rect_px('forearm')
    for yy in (y0 + 24, y1 - 40):
        db.rectangle((x0, yy, x1, yy + 16), fill=RED); dr.rectangle((x0, yy, x1, yy + 16), fill=80)
    x0, y0, x1, y1 = rect_px('torso')
    cw = (x1 - x0) / 3
    db.rectangle((x0 + cw + 30, y0 + 20, x0 + 2 * cw - 30, y0 + 44), fill=RED)  # front face top stripe
    # rings on limbs
    for name in ('limb', 'forearm'):
        x0, y0, x1, y1 = rect_px(name)
        for k in (0.22, 0.78):
            yy = int(y0 + (y1 - y0) * k)
            dh.rectangle((x0, yy - 3, x1, yy + 3), fill=50); da.rectangle((x0, yy - 3, x1, yy + 3), fill=160)
    # joints: knurled grooves
    x0, y0, x1, y1 = rect_px('joint')
    for yy in range(y0, y1, 12):
        dh.line((x0, yy, x1, yy), fill=90, width=3)
    # head: white helmet with a dark glossy visor band on the front and two cyan eyes
    x0, y0, x1, y1 = rect_px('head')
    W, H = x1 - x0, y1 - y0
    vx0, vx1 = x0 + int(W * 0.30), x0 + int(W * 0.70)
    vy0, vy1 = y0 + int(H * 0.30), y0 + int(H * 0.52)
    db.rounded_rectangle((vx0, vy0, vx1, vy1), 30, fill=VISOR)
    dr.rounded_rectangle((vx0, vy0, vx1, vy1), 30, fill=18)
    dh.rounded_rectangle((vx0, vy0, vx1, vy1), 30, outline=40, width=6)
    da.rounded_rectangle((vx0 - 4, vy0 - 4, vx1 + 4, vy1 + 4), 30, outline=170, width=6)
    for ex in (0.43, 0.57):
        cx, cy = x0 + int(W * ex), (vy0 + vy1) // 2
        db.ellipse((cx - 14, cy - 10, cx + 14, cy + 10), fill=CYAN)
        de.ellipse((cx - 14, cy - 10, cx + 14, cy + 10), fill=CYAN)
    # ear discs (red) at the sides of the helmet
    for ex in (0.25, 0.75):
        cx, cy = x0 + int(W * ex), y0 + int(H * 0.45)
        db.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), fill=RED)
        dh.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), outline=60, width=5)
    # chest core: glowing ring
    x0, y0, x1, y1 = rect_px('core')
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    for d in (db, de):
        d.ellipse((cx - 70, cy - 70, cx + 70, cy + 70), outline=(255, 80, 70), width=26)
    de_core = emis.crop((x0, y0, x1, y1)).filter(ImageFilter.GaussianBlur(4))
    emis.paste(de_core, (x0, y0))

    # normal map (OpenGL / Y+) from the height map
    h = np.asarray(height.filter(ImageFilter.GaussianBlur(1.5)), float) / 255.0
    strength = 6.0
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    n = np.dstack([-dx, dy, np.ones_like(h)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    normal = Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8), 'RGB')

    ao = ao.filter(ImageFilter.GaussianBlur(3))
    orm = Image.merge('RGB', (ao, rough, metal))
    base = base.filter(ImageFilter.GaussianBlur(0.6))
    base.save(os.path.join(OUT, 'textures', 'MonBot_BaseColor.png'))
    normal.save(os.path.join(OUT, 'textures', 'MonBot_Normal.png'))
    orm.save(os.path.join(OUT, 'textures', 'MonBot_ORM.png'))
    emis.save(os.path.join(OUT, 'textures', 'MonBot_Emissive.png'))


# ---------------------------------------------------------------------------
# animation curves: {bone: {'R': fn(t)->(x,y,z) degrees, 'T': fn(t)->(x,y,z) local offset}}
# ---------------------------------------------------------------------------
def idle(t):
    p = 2 * math.pi * t / 2.0
    return {
        'Chest': {'R': lambda t: (2.5 * math.sin(2 * math.pi * t / 2.0), 0, 0)},
        'Head': {'R': lambda t: (3 * math.sin(2 * math.pi * t / 2.0 + 1), 12 * math.sin(2 * math.pi * t / 4.0 * 2), 0)},
        'L_UpperArm': {'R': lambda t: (0, 0, 6 + 3 * math.sin(2 * math.pi * t / 2.0))},
        'R_UpperArm': {'R': lambda t: (0, 0, -6 - 3 * math.sin(2 * math.pi * t / 2.0))},
        'L_Forearm': {'R': lambda t: (-8 - 3 * math.sin(2 * math.pi * t / 2.0), 0, 0)},
        'R_Forearm': {'R': lambda t: (-8 - 3 * math.sin(2 * math.pi * t / 2.0), 0, 0)},
        'Hips': {'T': lambda t: (0, -0.6 + 0.6 * math.cos(2 * math.pi * t / 2.0 * 2), 0)},
    }


def walk():
    T = 1.0
    s = lambda t, ph=0: math.sin(2 * math.pi * t / T + ph)
    return {
        'Hips': {'T': lambda t: (0, 1.6 * abs(s(t)) - 1.2, 0), 'R': lambda t: (0, 6 * s(t), 0)},
        'Chest': {'R': lambda t: (4, -9 * s(t), 0)},
        'Head': {'R': lambda t: (-3, 4 * s(t), 0)},
        'L_UpLeg': {'R': lambda t: (-28 * s(t), 0, 0)},
        'R_UpLeg': {'R': lambda t: (28 * s(t), 0, 0)},
        'L_Leg': {'R': lambda t: (30 * max(0, s(t, -math.pi / 2)), 0, 0)},
        'R_Leg': {'R': lambda t: (30 * max(0, s(t, math.pi / 2)), 0, 0)},
        'L_Foot': {'R': lambda t: (-10 * s(t, 0.6), 0, 0)},
        'R_Foot': {'R': lambda t: (10 * s(t, 0.6), 0, 0)},
        'L_UpperArm': {'R': lambda t: (24 * s(t), 0, 8)},
        'R_UpperArm': {'R': lambda t: (-24 * s(t), 0, -8)},
        'L_Forearm': {'R': lambda t: (-20 - 10 * s(t), 0, 0)},
        'R_Forearm': {'R': lambda t: (-20 + 10 * s(t), 0, 0)},
    }, T


def wave():
    T = 2.0
    def raise_amt(t):  # 0 -> 1 in the first 0.35 s, back to 0 in the last 0.35 s
        a = min(1, t / 0.35, (T - t) / 0.35)
        return 0.5 - 0.5 * math.cos(math.pi * max(0, a))
    return {
        'R_UpperArm': {'R': lambda t: (0, 0, -150 * raise_amt(t))},
        'R_Forearm': {'R': lambda t: (0, 0, (-25 + 25 * math.sin(2 * math.pi * t * 1.6)) * raise_amt(t))},
        'R_Hand': {'R': lambda t: (0, 0, 10 * math.sin(2 * math.pi * t * 1.6 + 0.8) * raise_amt(t))},
        'Head': {'R': lambda t: (-4 * raise_amt(t), -14 * raise_amt(t), -6 * raise_amt(t))},
        'Chest': {'R': lambda t: (0, -6 * raise_amt(t), 4 * raise_amt(t))},
        'L_UpperArm': {'R': lambda t: (0, 0, 5 + 2 * math.sin(2 * math.pi * t / T))},
        'Hips': {'T': lambda t: (0, -0.5 + 0.5 * math.cos(2 * math.pi * t), 0)},
    }, T


# ---------------------------------------------------------------------------
# FBX ASCII writer
# ---------------------------------------------------------------------------
def fmt(v):
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    s = f'{float(v):.6f}'.rstrip('0').rstrip('.')
    return s if s not in ('-0', '') else '0'


def arr(name, values, ind):
    vals = ','.join(fmt(v) for v in values)
    return f'{ind}{name}: *{len(values)} {{\n{ind}\ta: {vals}\n{ind}}}\n'


class Ids:
    def __init__(self):
        self.n = 1000000

    def __call__(self):
        self.n += 1
        return self.n


def local_pos(name):
    par = BONE_PARENT[name]
    return BONE_POS[name] - (BONE_POS[par] if par else 0)


def translation_matrix(p):
    m = np.eye(4)
    m[3, :3] = p  # FBX stores matrices with translation in elements 12..14
    return m


def write_fbx(path, mesh=None, anim=None, anim_name='Take 001', duration=1.0, textures=None):
    ids = Ids()
    objs, conns = [], []
    bone_ids = {}
    for name, par, _ in BONES:
        mid, aid = ids(), ids()
        bone_ids[name] = mid
        lp = local_pos(name)
        objs.append(f'\tNodeAttribute: {aid}, "NodeAttribute::{name}", "LimbNode" {{\n\t\tTypeFlags: "Skeleton"\n\t}}\n')
        objs.append(
            f'\tModel: {mid}, "Model::{name}", "LimbNode" {{\n\t\tVersion: 232\n\t\tProperties70:  {{\n'
            f'\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",{fmt(lp[0])},{fmt(lp[1])},{fmt(lp[2])}\n'
            f'\t\t\tP: "Size", "double", "Number", "",6\n'
            f'\t\t}}\n\t\tShading: T\n\t\tCulling: "CullingOff"\n\t}}\n')
        conns.append((aid, mid, None))
        conns.append((mid, bone_ids[par] if par else 0, None))

    if mesh is not None:
        gid, mid, matid, skin = ids(), ids(), ids(), ids()
        verts = [c for p in mesh.pos for c in p]
        pvi, normals, uvs, uvi = [], [], [], []
        for poly in mesh.polys:
            for k, (vi, n, uv) in enumerate(poly):
                pvi.append(vi if k < len(poly) - 1 else -vi - 1)
                normals.extend(n)
                uvi.append(len(uvs) // 2)
                uvs.extend(uv)
        g = f'\tGeometry: {gid}, "Geometry::MonBot_Body", "Mesh" {{\n'
        g += arr('Vertices', verts, '\t\t') + arr('PolygonVertexIndex', pvi, '\t\t')
        g += '\t\tGeometryVersion: 124\n'
        g += ('\t\tLayerElementNormal: 0 {\n\t\t\tVersion: 101\n\t\t\tName: ""\n'
              '\t\t\tMappingInformationType: "ByPolygonVertex"\n\t\t\tReferenceInformationType: "Direct"\n')
        g += arr('Normals', normals, '\t\t\t') + '\t\t}\n'
        g += ('\t\tLayerElementUV: 0 {\n\t\t\tVersion: 101\n\t\t\tName: "map1"\n'
              '\t\t\tMappingInformationType: "ByPolygonVertex"\n\t\t\tReferenceInformationType: "IndexToDirect"\n')
        g += arr('UV', uvs, '\t\t\t') + arr('UVIndex', uvi, '\t\t\t') + '\t\t}\n'
        g += ('\t\tLayerElementMaterial: 0 {\n\t\t\tVersion: 101\n\t\t\tName: ""\n'
              '\t\t\tMappingInformationType: "AllSame"\n\t\t\tReferenceInformationType: "IndexToDirect"\n')
        g += arr('Materials', [0], '\t\t\t') + '\t\t}\n'
        g += ('\t\tLayer: 0 {\n\t\t\tVersion: 100\n'
              '\t\t\tLayerElement:  {\n\t\t\t\tType: "LayerElementNormal"\n\t\t\t\tTypedIndex: 0\n\t\t\t}\n'
              '\t\t\tLayerElement:  {\n\t\t\t\tType: "LayerElementMaterial"\n\t\t\t\tTypedIndex: 0\n\t\t\t}\n'
              '\t\t\tLayerElement:  {\n\t\t\t\tType: "LayerElementUV"\n\t\t\t\tTypedIndex: 0\n\t\t\t}\n\t\t}\n\t}\n')
        objs.append(g)
        objs.append(f'\tModel: {mid}, "Model::MonBot_Body", "Mesh" {{\n\t\tVersion: 232\n\t\tProperties70:  {{\n\t\t}}\n'
                    '\t\tShading: T\n\t\tCulling: "CullingOff"\n\t}\n')
        objs.append(f'\tMaterial: {matid}, "Material::MonBot_MAT", "" {{\n\t\tVersion: 102\n\t\tShadingModel: "phong"\n'
                    '\t\tMultiLayer: 0\n\t\tProperties70:  {\n'
                    '\t\t\tP: "DiffuseColor", "Color", "", "A",1,1,1\n'
                    '\t\t\tP: "EmissiveColor", "Color", "", "A",1,1,1\n'
                    '\t\t\tP: "EmissiveFactor", "Number", "", "A",1\n'
                    '\t\t\tP: "Shininess", "double", "Number", "",20\n\t\t}\n\t}\n')
        conns += [(mid, 0, None), (gid, mid, None), (matid, mid, None), (skin, gid, None)]
        for slot, fname in (textures or {}).items():
            tid, vid = ids(), ids()
            rel = 'textures/' + fname
            objs.append(f'\tTexture: {tid}, "Texture::{fname}", "" {{\n\t\tType: "TextureVideoClip"\n\t\tVersion: 202\n'
                        f'\t\tTextureName: "Texture::{fname}"\n\t\tMedia: "Video::{fname}"\n'
                        f'\t\tFileName: "{rel}"\n\t\tRelativeFilename: "{rel}"\n\t}}\n')
            objs.append(f'\tVideo: {vid}, "Video::{fname}", "Clip" {{\n\t\tType: "Clip"\n'
                        f'\t\tFileName: "{rel}"\n\t\tRelativeFilename: "{rel}"\n\t}}\n')
            conns += [(tid, matid, slot), (vid, tid, None)]
        objs.append(f'\tDeformer: {skin}, "Deformer::MonBot_Skin", "Skin" {{\n\t\tVersion: 101\n\t\tLink_DeformAcuracy: 50\n\t}}\n')
        pose_nodes = [(mid, np.eye(4))]
        for name, _, _ in BONES:
            idx = [i for i, b in enumerate(mesh.weight) if b == name]
            link = translation_matrix(BONE_POS[name])
            pose_nodes.append((bone_ids[name], link))
            if not idx:
                continue
            cid = ids()
            objs.append(f'\tDeformer: {cid}, "SubDeformer::{name}", "Cluster" {{\n\t\tVersion: 100\n\t\tUserData: "", ""\n'
                        + arr('Indexes', idx, '\t\t') + arr('Weights', [1.0] * len(idx), '\t\t')
                        + arr('Transform', np.linalg.inv(link).flatten(), '\t\t')
                        + arr('TransformLink', link.flatten(), '\t\t') + '\t}\n')
            conns += [(cid, skin, None), (bone_ids[name], cid, None)]
        pid = ids()
        p = (f'\tPose: {pid}, "Pose::BIND_POSES", "BindPose" {{\n\t\tType: "BindPose"\n\t\tVersion: 100\n'
             f'\t\tNbPoseNodes: {len(pose_nodes)}\n')
        for nid, mtx in pose_nodes:
            p += f'\t\tPoseNode:  {{\n\t\t\tNode: {nid}\n' + arr('Matrix', mtx.flatten(), '\t\t\t') + '\t\t}\n'
        objs.append(p + '\t}\n')

    if anim:
        sid, lid = ids(), ids()
        stop = int(round(duration * KTIME))
        objs.append(f'\tAnimationStack: {sid}, "AnimStack::{anim_name}", "" {{\n\t\tProperties70:  {{\n'
                    f'\t\t\tP: "LocalStop", "KTime", "Time", "",{stop}\n\t\t\tP: "ReferenceStop", "KTime", "Time", "",{stop}\n'
                    '\t\t}\n\t}\n')
        objs.append(f'\tAnimationLayer: {lid}, "AnimLayer::BaseLayer", "" {{\n\t}}\n')
        conns.append((lid, sid, None))
        frames = int(round(duration * FPS))
        times = [int(round(f / FPS * KTIME)) for f in range(frames + 1)]
        for bone, chans in anim.items():
            for ch, fn in chans.items():
                cnid = ids()
                prop = 'Lcl Rotation' if ch == 'R' else 'Lcl Translation'
                vals = [np.array(fn(f / FPS), float) for f in range(frames + 1)]
                if ch == 'T':
                    vals = [v + local_pos(bone) for v in vals]
                objs.append(f'\tAnimationCurveNode: {cnid}, "AnimCurveNode::{ch}", "" {{\n\t\tProperties70:  {{\n'
                            f'\t\t\tP: "d|X", "Number", "", "A",{fmt(vals[0][0])}\n'
                            f'\t\t\tP: "d|Y", "Number", "", "A",{fmt(vals[0][1])}\n'
                            f'\t\t\tP: "d|Z", "Number", "", "A",{fmt(vals[0][2])}\n\t\t}}\n\t}}\n')
                conns += [(cnid, lid, None), (cnid, bone_ids[bone], prop)]
                for axis, comp in (('X', 0), ('Y', 1), ('Z', 2)):
                    cid = ids()
                    objs.append(f'\tAnimationCurve: {cid}, "AnimCurve::", "" {{\n\t\tDefault: 0\n\t\tKeyVer: 4009\n'
                                + arr('KeyTime', times, '\t\t') + arr('KeyValueFloat', [v[comp] for v in vals], '\t\t')
                                + arr('KeyAttrFlags', [24840], '\t\t') + arr('KeyAttrDataFloat', [0, 0, 255790911, 0], '\t\t')
                                + arr('KeyAttrRefCount', [len(times)], '\t\t') + '\t}\n')
                    conns.append((cid, cnid, f'd|{axis}'))

    # Keep this header short: FBXLoader's ASCII check samples a few characters of the file start.
    out = ['; FBX 7.4.0 project file\n; MonBot sample - Mondiro FormaLab\n\n',
           'FBXHeaderExtension:  {\n\tFBXHeaderVersion: 1003\n\tFBXVersion: 7400\n\tCreator: "Mondiro FormaLab"\n}\n',
           'GlobalSettings:  {\n\tVersion: 1000\n\tProperties70:  {\n'
           '\t\tP: "UpAxis", "int", "Integer", "",1\n\t\tP: "UpAxisSign", "int", "Integer", "",1\n'
           '\t\tP: "FrontAxis", "int", "Integer", "",2\n\t\tP: "FrontAxisSign", "int", "Integer", "",1\n'
           '\t\tP: "CoordAxis", "int", "Integer", "",0\n\t\tP: "CoordAxisSign", "int", "Integer", "",1\n'
           '\t\tP: "UnitScaleFactor", "double", "Number", "",1\n\t\tP: "TimeMode", "enum", "", "",6\n\t}\n}\n',
           'Objects:  {\n', *objs, '}\n',
           'Connections:  {\n']
    for a, b, prop in conns:
        out.append(f'\tC: "OP",{a},{b}, "{prop}"\n' if prop else f'\tC: "OO",{a},{b}\n')
    out.append('}\n')
    with open(path, 'w', newline='\n') as f:
        f.write(''.join(out))


def main():
    os.makedirs(os.path.join(OUT, 'animations'), exist_ok=True)
    make_textures()
    mesh = build_mesh()
    tex = {'DiffuseColor': 'MonBot_BaseColor.png', 'NormalMap': 'MonBot_Normal.png', 'EmissiveColor': 'MonBot_Emissive.png'}
    write_fbx(os.path.join(OUT, 'MonBot.fbx'), mesh, idle(0), 'Idle', 2.0, tex)
    w, tw = walk()
    write_fbx(os.path.join(OUT, 'animations', 'MonBot_Anim_Walk.fbx'), None, w, 'Walk', tw)
    v, tv = wave()
    write_fbx(os.path.join(OUT, 'animations', 'MonBot_Anim_Wave.fbx'), None, v, 'Wave', tv)
    print('verts', len(mesh.pos), 'polys', len(mesh.polys))


if __name__ == '__main__':
    main()
