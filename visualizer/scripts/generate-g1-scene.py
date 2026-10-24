"""Generate small, self-contained GLB props and the static G1 demo scene.

All authoring values below are ROS Z-up meters. Prop dimensions/poses are
illustrative estimates from episode 0, not measured dataset annotations.
"""
import base64
import json
import pathlib
import struct

ROOT = pathlib.Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'public/examples/models'
ASSETS.mkdir(parents=True, exist_ok=True)

# Each face has independent vertices/normals so box faces stay flat.
FACES = [
    ([1,0,0], [(1,-1,-1),(1,1,-1),(1,1,1),(1,-1,1)]),
    ([-1,0,0], [(-1,-1,1),(-1,1,1),(-1,1,-1),(-1,-1,-1)]),
    ([0,1,0], [(-1,1,-1),(-1,1,1),(1,1,1),(1,1,-1)]),
    ([0,-1,0], [(-1,-1,1),(-1,-1,-1),(1,-1,-1),(1,-1,1)]),
    ([0,0,1], [(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]),
    ([0,0,-1], [(1,-1,-1),(-1,-1,-1),(-1,1,-1),(1,1,-1)]),
]

def model(name, parts):
    positions = [list(v) for _, vertices in FACES for v in vertices]
    normals = [n for n, vertices in FACES for _ in vertices]
    indices = [x for i in range(6) for x in [4*i,4*i+1,4*i+2,4*i,4*i+2,4*i+3]]
    binary = b''.join(struct.pack('<3f', *v) for v in positions + normals) + struct.pack('<36H', *indices)
    gltf = {
        'asset': {'version':'2.0', 'generator':'Custom LeRobot scene generator'},
        'scene':0, 'scenes':[{'name':name,'nodes':list(range(len(parts)))}],
        'nodes':[], 'meshes':[], 'materials':[],
        'buffers':[{'byteLength':len(binary)}],
        'bufferViews':[{'buffer':0,'byteOffset':0,'byteLength':288,'target':34962}, {'buffer':0,'byteOffset':288,'byteLength':288,'target':34962}, {'buffer':0,'byteOffset':576,'byteLength':72,'target':34963}],
        'accessors':[{'bufferView':0,'componentType':5126,'count':24,'type':'VEC3','min':[-1,-1,-1],'max':[1,1,1]}, {'bufferView':1,'componentType':5126,'count':24,'type':'VEC3'}, {'bufferView':2,'componentType':5123,'count':36,'type':'SCALAR'}],
    }
    for i,(part, center, size, color) in enumerate(parts):
        # ROS (x,y,z) -> glTF (x,z,-y); importer reverses this up-axis conversion.
        gltf['nodes'].append({'name':part, 'mesh':i, 'translation':[center[0],center[2],-center[1]], 'scale':[size[0]/2,size[2]/2,size[1]/2]})
        rgb=[int(color[j:j+2],16)/255 for j in [1,3,5]]
        # glTF baseColorFactor is linear, unlike CSS/sRGB hex colors.
        linear=[c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in rgb]
        gltf['materials'].append({'name':part, 'pbrMetallicRoughness':{'baseColorFactor':linear+[1], 'metallicFactor':0, 'roughnessFactor':.65}})
        gltf['meshes'].append({'primitives':[{'attributes':{'POSITION':0,'NORMAL':1}, 'indices':2, 'material':i}]})
    encoded=json.dumps(gltf,separators=(',',':')).encode(); encoded+=b' '*((-len(encoded))%4)
    binary+=b'\0'*((-len(binary))%4)
    glb=struct.pack('<III',0x46546c67,2,28+len(encoded)+len(binary))+struct.pack('<II',len(encoded),0x4e4f534a)+encoded+struct.pack('<II',len(binary),0x004e4942)+binary
    (ASSETS / f'{name}.glb').write_bytes(glb)
    return 'data:model/gltf-binary;base64,'+base64.b64encode(glb).decode()

height=.94
parts=[('white tabletop',[0,0,-.0125],[.7,1.0,.025],'#eeeeea')]
for x in [-.3,.3]:
    for y in [-.45,.45]:
        parts.append(('table leg',[x,y,-(height+.025)/2],[.04,.04,height-.025],'#d8d8d4'))
table=model('white-table',parts)
assets={color:model(f'{color}-block',[(f'{color} cube',[0,0,0],[.045,.045,.045],hex)]) for color,hex in [('red','#d95840'),('yellow','#e6b63e'),('mint','#9cc7b2')]}
tape=model('black-marker',[('target tape',[0,0,0],[.075,.025,.001],'#202124')])

def obj(id,name,position,asset,frame='world'):
    return {'id':id,'name':name,'frame':frame,'translation':position,'rotation':[0,0,0,1],'scale':[1,1,1],'geometry':{'type':'glb','dataUrl':asset}}
scene={
    'schemaVersion':1,'convention':'ros-rep-103','units':'meters',
    'preset':'g1-blockstacking-floor-v1',
    'originDescription':'Floor between the feet in the G1 reference stance.',
    'note':'Reconstructed static props. Sizes and positions are approximate.',
    # Zero-pose ankle z = -0.7568637524 m. Foot collision sphere bottoms
    # are another 0.035 m below it in g1_body29_hand14.urdf.
    'frames':[{'id':'base_link','parent':'world','translation':[0,0,.7918637524222113],'rotation':[0,0,0,1]}, {'id':'tabletop','parent':'world','translation':[.48,0,height],'rotation':[0,0,0,1]}],
    'objects':[
        obj('white-table','White table',[0,0,0],table,'tabletop'),
        obj('red-block','Red block',[.41,-.14,height+.0225],assets['red']),
        obj('yellow-block','Yellow block',[.29,.20,height+.0225],assets['yellow']),
        obj('mint-block','Blue-green block',[.53,.03,height+.0225],assets['mint']),
        obj('target-marker','Black tape marker',[.39,.04,height+.0005],tape),
    ],
}
(ROOT/'public/examples/g1-blockstacking.scene.json').write_text(json.dumps(scene,indent=2)+'\n')
print('Generated 5 GLB models and the reconstructed G1 scene.')
