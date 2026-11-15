# Offline ground truth for a cast-portal fixture (never reaches a model): a dry standing cell in the same cave as a lava pool,
# 16-28 walked blocks from it, so find has to look for and reach the pool.
# usage: python3 -I scripts/quality/cave-start.py WORLD_DIR X Y Z   (a pool centroid from lava-survey.py) -> JSON
#        python3 -I scripts/quality/cave-start.py WORLD_DIR x,y,z ...   -> one JSON line per pool
import json, sys, os, glob, importlib.util
from collections import deque
spec = importlib.util.spec_from_file_location('lava_survey', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lava-survey.py'))
lava_survey = importlib.util.module_from_spec(spec); spec.loader.exec_module(lava_survey)

AIR = {'minecraft:air', 'minecraft:cave_air'}
# Cells a body walks through, not on (name endings; grass_block and snow_block are ground).
SOFT = ('short_grass', 'tall_grass', 'fern', 'lichen', 'vine', 'vines', 'vines_plant', 'flower', 'mushroom', 'torch', 'rail', 'carpet', 'dripleaf',
        'dripleaf_stem', 'pointed_dripstone', 'sculk_vein', 'spore_blossom', 'button', 'sapling', 'bush', 'roots', 'cobweb', ':snow', 'tulip', 'poppy',
        'dandelion', 'orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'hanging_moss', 'pale_moss_carpet')

def load(world, pools):
    """Block names of the sections near the pools (a cast fixture reads a few chunks round each)."""
    want = {(cx, cz) for px, py, pz in pools for cx in range(px // 16 - 3, px // 16 + 4) for cz in range(pz // 16 - 3, pz // 16 + 4)}
    ys = {sy for px, py, pz in pools for sy in range((py - 30) // 16, (py + 40) // 16 + 1)}
    names = {}
    for path in glob.glob(os.path.join(world, 'dimensions/minecraft/overworld/region/*.mca')):
        rx, rz = map(int, os.path.basename(path).split('.')[1:3])
        if not any(rx * 32 <= cx < rx * 32 + 32 and rz * 32 <= cz < rz * 32 + 32 for cx, cz in want): continue
        for c in lava_survey.chunks(path):
            cx, cz = c['xPos'], c['zPos']
            if (cx, cz) not in want or c.get('Status', '').split(':')[-1] != 'full': continue
            for sec in c.get('sections', []):
                sy = sec['Y']
                if sy not in ys: continue
                pal, idx = lava_survey.blocks_of(sec)
                if not pal: continue
                for n in range(4096):
                    p = pal[0] if idx is None else pal[idx[n]]
                    names[(cx * 16 + (n & 15), sy * 16 + (n >> 8), cz * 16 + ((n >> 4) & 15))] = (p.get('Name'), (p.get('Properties') or {}).get('level', '0'))
    return names

def start_for(names, px, py, pz):
    name = lambda c: names.get(c, (None, None))[0]
    lava = lambda c: name(c) == 'minecraft:lava'
    water = lambda c: name(c) == 'minecraft:water'
    def solid(c):
        n = name(c)
        return n is not None and n not in AIR and n not in ('minecraft:water', 'minecraft:lava') and not n.endswith(SOFT)
    def stand(c):
        return name(c) in AIR and name((c[0], c[1] + 1, c[2])) in AIR and solid((c[0], c[1] - 1, c[2]))
    near_lava = lambda c, r: any(lava((c[0] + dx, c[1] + dy, c[2] + dz)) for dx in range(-r, r + 1) for dy in range(-1, 2) for dz in range(-r, r + 1))
    # The pool: still sources near the centroid.
    sources = [(x, y, z) for x in range(px - 12, px + 13) for z in range(pz - 12, pz + 13) for y in range(py - 4, py + 5) if names.get((x, y, z)) == ('minecraft:lava', '0')]
    if not sources: return {'pool': {'x': px, 'y': py, 'z': pz}, 'error': 'no pool here'}
    exposed = [c for c in sources if name((c[0], c[1] + 1, c[2])) in AIR]
    # The shore: dry standing cells beside an exposed source, at its level or a block or two up.
    shore = {(c[0] + dx, c[1] + dy, c[2] + dz) for c in exposed for dx in (-2, -1, 0, 1, 2) for dz in (-2, -1, 0, 1, 2) for dy in (0, 1, 2)}
    dist = {}
    q = deque()
    for s in shore:
        if stand(s): dist[s] = 0; q.append(s)
    while q:
        c = q.popleft()
        if dist[c] >= 40: continue
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            for dy in (0, 1, -1):
                n = (c[0] + dx, c[1] + dy, c[2] + dz)
                if n in dist or not stand(n): continue
                if dy == 1 and name((c[0], c[1] + 2, c[2])) not in AIR: continue
                dist[n] = dist[c] + 1; q.append(n)
    # 16-28 walked blocks out when the cave is that big, else the farthest dry cell at least 4 out.
    dry = [c for c, d in dist.items() if d >= 4 and not near_lava(c, 3) and not water(c) and not water((c[0], c[1] - 1, c[2]))]
    picks = [c for c in dry if 16 <= dist[c] <= 28] or sorted(dry, key=lambda c: -dist[c])[:1]
    picks.sort(key=lambda c: (abs(dist[c] - 20), c))
    out = {'pool': {'x': px, 'y': py, 'z': pz, 'sources': len(sources), 'exposed': len(exposed)}, 'shore': sum(1 for d in dist.values() if d == 0), 'reachable': len(dist)}
    if picks: out['start'] = {'x': picks[0][0], 'y': picks[0][1], 'z': picks[0][2], 'walk': dist[picks[0]]}
    return out

def main():
    world = sys.argv[1]
    args = sys.argv[2:]
    # One pool as X Y Z, or many as x,y,z strings: one JSON line each.
    pools = [tuple(map(int, args[:3]))] if len(args) == 3 and ',' not in args[0] else [tuple(map(int, a.split(','))) for a in args]
    names = load(world, pools)
    if len(pools) == 1 and ',' not in args[0]: print(json.dumps(start_for(names, *pools[0]))); return
    for pool in pools: print(json.dumps(start_for(names, *pool)))

main()
