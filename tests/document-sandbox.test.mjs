import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import {spawn,spawnSync} from 'node:child_process';
import {documentToolCommand,executeDocumentTool} from '../src/documents.mjs';
const darwin=process.platform==='darwin';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// One probe for every live test: it tries each request, never raises, and writes what happened into the workspace (the tool's
// standard output is discarded). REFUSED covers both systems, because Linux answers ENOENT where macOS answers EPERM; no test
// asserts an errno. A failure that is not an OS error (a typo, a missing API) is ERROR, so it can never pass as a refusal.
const PROBE=`import sys, os, json, socket, subprocess, time
ws, spec = sys.argv[1], json.loads(sys.argv[2])
out = {}
def procargs(pid):
    if sys.platform == 'darwin':
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True); mib = (ctypes.c_int * 3)(1, 49, pid); size = ctypes.c_size_t(262144); buf = ctypes.create_string_buffer(262144)
        if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0: raise OSError(ctypes.get_errno(), 'sysctl')
        return buf.raw[:size.value]
    return open('/proc/%d/environ' % pid, 'rb').read()
def sleeper(seconds): return 'import os, time\\ntry: os.setsid()\\nexcept OSError: pass\\ntime.sleep(%s)' % seconds
def dump(name='results.json'): json.dump(out, open(os.path.join(ws, name), 'w'))
def rm_inside(f):
    p = os.path.join(ws, f)
    if os.path.isdir(p) and not os.path.islink(p): [rm_inside(os.path.join(f, g)) for g in os.listdir(p)]; os.rmdir(p)
    else: os.unlink(p)
for label, kind, *t in spec:
    try:
        if kind == 'read': out[label] = 'READ:' + open(t[0], 'rb').read(64).decode('utf-8', 'replace')
        elif kind == 'list': out[label] = 'LISTED:' + json.dumps(sorted(os.listdir(t[0])))
        elif kind == 'stat': os.stat(t[0]); out[label] = 'STAT'
        elif kind == 'write': open(t[0], 'w').write('written-by-probe'); out[label] = 'WROTE'
        elif kind == 'unlink': os.unlink(t[0]); out[label] = 'UNLINKED'
        elif kind == 'symlink-read':
            link = os.path.join(ws, 'own-link-' + str(len(out))); os.symlink(t[0], link); out[label] = 'READ:' + open(link, 'rb').read(64).decode('utf-8', 'replace')
        elif kind == 'hardlink-read':
            link = os.path.join(ws, 'own-hard-' + str(len(out))); os.link(t[0], link); out[label] = 'READ:' + open(link, 'rb').read(64).decode('utf-8', 'replace')
        elif kind == 'chflags': os.chflags(t[0], 2); out[label] = 'FLAGGED'
        elif kind == 'acl':
            # An "everyone deny delete" entry on a file, which no mode change can override. As with mach, a library that does not load
            # or an entry that cannot be built is a failure of the probe (ERROR); only the refusal of acl_set_file itself is REFUSED.
            try:
                import ctypes
                libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
                libc.acl_from_text.restype = ctypes.c_void_p; libc.acl_from_text.argtypes = [ctypes.c_char_p]; libc.acl_set_file.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p]
            except OSError as e: raise RuntimeError('cannot load the ACL library: ' + str(e))
            entry = libc.acl_from_text(b'!#acl 1\\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:deny:delete\\n')
            if not entry: raise RuntimeError('cannot build the entry')
            if libc.acl_set_file(t[0].encode(), 0x100, entry) != 0: raise OSError(ctypes.get_errno(), 'acl_set_file')
            out[label] = 'ACL_SET'
        elif kind == 'replace-root':
            for f in os.listdir(ws): rm_inside(f)
            os.chdir('/'); os.rmdir(ws); os.symlink(t[0], ws); out[label] = 'REPLACED'
        elif kind == 'rename-root': os.rename(ws, t[0]); out[label] = 'RENAMED'
        elif kind == 'tcp':
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.settimeout(3); s.connect((t[0], int(t[1]))); s.sendall(b'probe'); s.close(); out[label] = 'CONNECTED'
        elif kind == 'udp':
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.sendto(b'probe', (t[0], int(t[1]))); s.close(); out[label] = 'SENT'
        elif kind == 'unix':
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(3); s.connect(t[0]); s.sendall(b'probe'); s.close(); out[label] = 'CONNECTED'
        elif kind == 'procargs': out[label] = 'READ:' + ('marker' if t[1].encode() in procargs(int(t[0]) if t[0] != 'self' else os.getpid()) else 'no marker')
        elif kind == 'exec':
            # A successful exec replaces this process, so the result is written first and overwritten on refusal.
            out[label] = 'EXECUTED'; dump(); out.pop(label); os.execv(t[0], [t[0]] + t[1:])
        elif kind == 'spawn':
            # Fork, posix_spawn and subprocess, each leaving a sleeper that names the workspace and, if it can, its own session. A
            # tool that cannot be stopped by the group kill shows here. Linux may allow all three; the pid namespace ends them.
            seconds = float(t[0]); pids = []
            try:
                pid = os.fork()
                if pid == 0: time.sleep(seconds); os._exit(0)
                out['fork'] = 'FORKED'
            except OSError: out['fork'] = 'REFUSED:fork'
            try: os.posix_spawn(sys.executable, [sys.executable, '-c', sleeper(seconds), ws], os.environ); out['posix_spawn'] = 'FORKED'
            except OSError as e: out['posix_spawn'] = 'REFUSED:' + type(e).__name__
            try: subprocess.Popen([sys.executable, '-c', sleeper(seconds), ws], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); out['subprocess'] = 'FORKED'
            except OSError as e: out['subprocess'] = 'REFUSED:' + type(e).__name__
            dump('started.json'); time.sleep(seconds)
        elif kind == 'mach':
            # A Mach bootstrap lookup of a system service. Not being able to load the library is a failure of the probe (ERROR), never a
            # refusal: only the answer of the lookup itself is. Answered means the lookup returned success and a port.
            try:
                import ctypes
                lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib'); bootstrap = ctypes.c_uint.in_dll(lib, 'bootstrap_port'); lookup = lib.bootstrap_look_up
            except OSError as e: raise RuntimeError('cannot load the Mach library: ' + str(e))
            port = ctypes.c_uint(0); kr = lookup(bootstrap, t[0].encode(), ctypes.byref(port))
            out[label] = ('ANSWERED:' if kr == 0 and port.value else 'REFUSED:') + 'kr=%d' % kr
        else: raise ValueError(kind)
    except OSError as e: out[label] = 'REFUSED:' + type(e).__name__
    except Exception as e: out[label] = 'ERROR:' + type(e).__name__ + ':' + str(e)
# A swap of the workspace that succeeded leaves nowhere to write the results; they go to standard error, which the failed call reports.
try: dump()
except OSError: sys.stderr.write('LOST:' + json.dumps(out) + '\\n'); sys.exit(3)
`;
// A parent folder that stands for the temporary folder of the server: the workspace of this conversion, the workspace of another
// one and a stand-in for the data folder, side by side. Removal is registered before anything else is done with it.
function arena(t){
 const parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'dp-sbx-')),ws=path.join(parent,'analyst-document-A'),sibling=path.join(parent,'analyst-document-B'),data=path.join(parent,'data');
 t.after(()=>{if(darwin){spawnSync('/usr/bin/chflags',['-R','nouchg',parent]);spawnSync('/usr/bin/find',[parent,'!','-type','l','-exec','/bin/chmod','-N','{}','+']);}fs.rmSync(parent,{recursive:true,force:true});});
 for(const dir of [ws,sibling,data])fs.mkdirSync(dir);
 fs.writeFileSync(path.join(ws,'probe.py'),PROBE);fs.writeFileSync(path.join(data,'analyst.sqlite'),'DATA-SENTINEL');fs.writeFileSync(path.join(sibling,'document.pdf'),'SIBLING-SENTINEL');
 return {parent,ws,sibling,data};
}
const probeArgs=(ws,spec)=>[path.join(ws,'probe.py'),ws,JSON.stringify(spec)];
// Runs the probe in the sandbox and returns what it recorded. results.json is removed before the call, so one from an earlier run never
// counts, and a call that failed with LOST: is read only from the results its error carries, never from a results.json. A failed call
// is an error, unless tolerate is set or the probe lost its workspace and reported its results on standard error (it then fails by design).
async function probe(ws,spec,options,{tolerate=false}={}){
 const file=path.join(ws,'results.json');fs.rmSync(file,{force:true});let failure=null;
 try{await executeDocumentTool('python3',probeArgs(ws,spec),ws,options);}catch(error){if(!tolerate&&!/LOST:/.test(error.message))throw error;failure=error;}
 const lost=/LOST:(\{.*\})/.exec(failure?failure.message:'');if(lost)return JSON.parse(lost[1]);
 if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'));
 throw failure||Error('the probe left no results');
}
// The same probe outside any sandbox: the control that its requests work at all.
function unconfined(ws,spec){
 fs.rmSync(path.join(ws,'results.json'),{force:true});
 const run=spawnSync('python3',probeArgs(ws,spec),{encoding:'utf8',cwd:ws,stdio:['ignore','ignore','pipe']});assert.equal(run.status,0,run.stderr);
 return JSON.parse(fs.readFileSync(path.join(ws,'results.json'),'utf8'));
}
const refused=(results,labels)=>{for(const label of labels)assert.match(String(results[label]),/^REFUSED:/,label);};
const listCommands=()=>spawnSync('ps',['-A','-ww','-o','args='],{encoding:'utf8',maxBuffer:64*1024*1024}).stdout.split('\n');
// The expected macOS profile, copied from the specification (Addendum B, section B1). It is deliberately not imported from the code.
const RULES_HEAD=['(version 1)','(deny default)','(deny process-info*)','(allow process-info* (target same-sandbox))','(allow sysctl-read)',
 String.raw`(deny sysctl-read (sysctl-name-regex #"^kern\.proc"))`,
 '(allow file-read-data file-read-metadata (literal "/"))',
 '(allow file-read-metadata (literal "/var") (literal "/tmp") (literal "/Applications") (literal "/opt") (literal "/opt/homebrew"))',
 '(allow file-read* (literal "/dev/urandom"))',
 '(allow file-read* (literal "/private/var/select/developer_dir") (literal "/private/var/db/xcode_select_link"))',
 '(allow file-read* (subpath "/usr/lib") (subpath "/System/Library"))',
 '(allow file-read* (subpath "/usr/bin") (subpath "/bin"))',
 '(allow process-exec* (literal "/usr/bin/python3") (literal "/bin/bash"))',
 '(allow file-read* process-exec* (subpath "/opt/homebrew/bin") (subpath "/opt/homebrew/Cellar") (subpath "/opt/homebrew/opt") (subpath "/opt/homebrew/Caskroom/libreoffice"))',
 '(allow file-read* process-exec* (subpath "/Applications/LibreOffice.app"))'];
const RULE_LAUNCH_SERVICES='(allow mach-lookup (global-name "com.apple.coreservices.launchservicesd"))';
const RULES_TAIL=['(allow file-read* file-write* (subpath (param "WORKSPACE")))','(allow network-bind (subpath (param "WORKSPACE")))','(deny file-write-unlink (literal (param "WORKSPACE")))','(deny file-write-flags)','(deny file-write-acl)'];
const DEVELOPER_RULE='(allow file-read* process-exec* (subpath (param "DEVELOPER_DIR")))';
const expectedProfile=({launchServices,developer,ancestors})=>[...RULES_HEAD,...(launchServices?[RULE_LAUNCH_SERVICES]:[]),...RULES_TAIL,...(developer?[DEVELOPER_RULE]:[]),...ancestors.map((_,i)=>`(allow file-read-metadata (literal (param "ANCESTOR_${i}")))`)].join('\n')+'\n';
const parameters=(workspace,developerDir,ancestors)=>['-D','WORKSPACE='+workspace,...(developerDir?['-D','DEVELOPER_DIR='+developerDir]:[]),...ancestors.flatMap((dir,i)=>['-D',`ANCESTOR_${i}=${dir}`])];

test('the Linux converter command is unchanged: bwrap, the same arguments, options and environment',()=>{
 const input={platform:'linux',binary:'pdftotext',args:['-layout','a b.pdf'],workspace:'/tmp/analyst-document-x',env:{PATH:'/usr/bin:/bin',HOME:'/home/u',SECRET:'s'},exists:()=>true};
 const expected={command:'bwrap',args:['--unshare-all','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind','/etc/fonts','/etc/fonts','--ro-bind','/etc/ld.so.cache','/etc/ld.so.cache','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/run','--bind','/tmp/analyst-document-x','/tmp/analyst-document-x','--chdir','/tmp/analyst-document-x','--setenv','HOME','/tmp/analyst-document-x','--setenv','TMPDIR','/tmp/analyst-document-x','--','pdftotext','-layout','a b.pdf'],options:{stdio:['ignore','ignore','pipe'],detached:true,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}};
 assert.deepEqual(documentToolCommand(input),expected);
 // The macOS-only inputs change nothing off macOS: no Launch Services line, no developer folder, no extra option.
 assert.deepEqual(documentToolCommand({...input,launchServices:true,developerDir:'/Library/Developer/CommandLineTools'}),expected);
 const some=documentToolCommand({platform:'linux',binary:'python3',args:[],workspace:'/var/tmp/w',env:{PATH:'/p'},exists:entry=>['/usr','/etc/fonts'].includes(entry)});
 assert.deepEqual(some.args,['--unshare-all','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--ro-bind','/etc/fonts','/etc/fonts','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/run','--bind','/var/tmp/w','/var/tmp/w','--chdir','/var/tmp/w','--setenv','HOME','/var/tmp/w','--setenv','TMPDIR','/var/tmp/w','--','python3']);
 assert.deepEqual(some.options,{stdio:['ignore','ignore','pipe'],detached:true,env:{PATH:'/p',LANG:'C.UTF-8'}});
});

test('the macOS converter command is a fixed deny-by-default profile, and every host path is a parameter',()=>{
 const hostile='/private/tmp/w") (allow default) ("x',developerDir='/Library/Developer/CommandLineTools',env={PATH:'/opt/homebrew/bin:/usr/bin',SECRET:'s'};
 const build=extra=>documentToolCommand({platform:'darwin',binary:'soffice',args:['--headless'],workspace:hostile,env,exists:()=>{throw Error('not consulted on macOS');},...extra});
 const options={stdio:['ignore','ignore','pipe'],detached:true,cwd:hostile,env:{PATH:'/opt/homebrew/bin:/usr/bin',LANG:'C.UTF-8',HOME:hostile,TMPDIR:hostile,OSL_SOCKET_PATH:'.'}};
 const ancestors=['/private','/private/tmp','/Library','/Library/Developer'];
 // One equality on the whole profile string, with and without Launch Services; the option absent means without.
 for(const [label,extra,launchServices] of [['launchServices:true',{developerDir,launchServices:true},true],['launchServices absent',{developerDir},false],['launchServices:false',{developerDir,launchServices:false},false]]){
  const built=build(extra);
  assert.equal(built.command,'/usr/bin/sandbox-exec',label);assert.equal(built.args[0],'-p',label);
  assert.equal(built.args[1],expectedProfile({launchServices,developer:true,ancestors}),label);
  assert.ok(!built.args[1].includes('/private/tmp/w')&&!built.args[1].includes('CommandLineTools'),label+': no host path in the profile text');
  assert.deepEqual(built.args.slice(2),[...parameters(hostile,developerDir,ancestors),'soffice','--headless'],label);
  assert.deepEqual(built.options,options,label);
 }
 // No developer folder: no DEVELOPER_DIR line or parameter anywhere, and no ancestor of it.
 for(const launchServices of [true,undefined]){
  const bare=documentToolCommand({platform:'darwin',binary:'python3',args:[],workspace:'/private/tmp/w',env:{},developerDir:null,launchServices});
  assert.equal(bare.args[1],expectedProfile({launchServices:launchServices===true,developer:false,ancestors:['/private','/private/tmp']}));
  assert.ok(!bare.args.join('\n').includes('DEVELOPER_DIR'));assert.deepEqual(bare.args.slice(2),[...parameters('/private/tmp/w',null,['/private','/private/tmp']),'python3']);
 }
 // Folders above both the workspace and the developer folder are listed once, workspace first.
 const shared=documentToolCommand({platform:'darwin',binary:'python3',args:[],workspace:'/Library/Developer/w',env:{},developerDir});
 assert.equal(shared.args[1],expectedProfile({launchServices:false,developer:true,ancestors:['/Library','/Library/Developer']}));assert.deepEqual(shared.args.slice(2),[...parameters('/Library/Developer/w',developerDir,['/Library','/Library/Developer']),'python3']);
});

test('an isolated tool runs in its workspace, also when the path to it goes through a system link',async t=>{
 const {ws}=arena(t);
 // os.tmpdir() on macOS is /var/folders/… behind the link /var -> /private/var; the tests' preload resolves it, production did not.
 const given=darwin?ws.replace(/^\/private\/(var|tmp)\//,'/$1/'):ws;
 if(darwin){assert.notEqual(given,ws,'this test needs a temporary folder below /private/var or /private/tmp');assert.notEqual(given,fs.realpathSync(given));}
 fs.writeFileSync(path.join(ws,'input.txt'),'INPUT');
 const results=await probe(given,[['read input','read',path.join(given,'input.txt')],['write output','write',path.join(given,'output.txt')],['cwd','list','.']]);
 assert.equal(results['read input'],'READ:INPUT');assert.equal(results['write output'],'WROTE');assert.equal(fs.readFileSync(path.join(ws,'output.txt'),'utf8'),'written-by-probe');
 assert.ok(results.cwd.startsWith('LISTED:')&&JSON.parse(results.cwd.slice(7)).includes('probe.py'),'the working folder is the workspace: '+results.cwd);
});

test('nothing outside the workspace can be read: the home folder, the data folder and another document, directly or through a link',async t=>{
 // The sentinel lives in the real home, which other tests re-point through HOME, so os.userInfo() names it. Removal comes first.
 let homeFolder=null;t.after(()=>{if(homeFolder)fs.rmSync(homeFolder,{recursive:true,force:true});});
 homeFolder=fs.mkdtempSync(path.join(os.userInfo().homedir,'.deep-proof-sandbox-probe-'));
 const homeFile=path.join(homeFolder,'sentinel.txt');fs.writeFileSync(homeFile,'HOME-SENTINEL');
 const {parent,ws,sibling,data}=arena(t),dataFile=path.join(data,'analyst.sqlite'),other=path.join(sibling,'document.pdf');
 for(const file of [homeFile,dataFile,other])assert.match(fs.readFileSync(file,'utf8'),/SENTINEL/,'control: the server itself can read '+file);
 fs.symlinkSync(homeFile,path.join(ws,'link-home'));fs.symlinkSync(dataFile,path.join(ws,'link-data'));fs.symlinkSync(data,path.join(ws,'link-data-folder'));
 const results=await probe(ws,[['inside','read',path.join(ws,'probe.py')],['inside through its own link','symlink-read',path.join(ws,'probe.py')],['inside through a hard link','hardlink-read',path.join(ws,'probe.py')],
  ['home','read',homeFile],['home through a link','read',path.join(ws,'link-home')],['home through its own link','symlink-read',homeFile],['home through a hard link','hardlink-read',homeFile],['home metadata','stat',homeFile],['home listing','list',homeFolder],
  ['data','read',dataFile],['data through a link','read',path.join(ws,'link-data')],['data through a folder link','read',path.join(ws,'link-data-folder','analyst.sqlite')],['data through its own link','symlink-read',dataFile],['data through a hard link','hardlink-read',dataFile],['data listing','list',data],
  ['other document','read',other],['other document listing','list',sibling],['temporary folder listing','list',parent]]);
 // Controls: the probe ran and can read inside; its own links and hard links work where the target is inside.
 for(const label of ['inside','inside through its own link','inside through a hard link'])assert.match(results[label],/^READ:import sys/,'control: '+label);
 refused(results,['home','home through a link','home through its own link','home through a hard link','home metadata','home listing','data','data through a link','data through a folder link','data through its own link','data through a hard link','data listing','other document','other document listing']);
 // Linux shows a private /tmp around the workspace and macOS refuses the listing. Neither may name the neighbours.
 const around=results['temporary folder listing'];assert.match(around,/^(REFUSED:|LISTED:)/,around);
 if(around.startsWith('LISTED:')){const names=JSON.parse(around.slice(7));assert.ok(!names.includes('analyst-document-B')&&!names.includes('data'),around);}
 assert.ok(!JSON.stringify(results).includes('SENTINEL'),'no result holds a sentinel');
});

test('nothing outside the workspace can be written, removed or replaced',async t=>{
 const {parent,ws,sibling,data}=arena(t);fs.symlinkSync(data,path.join(ws,'link-data-folder'));fs.writeFileSync(path.join(ws,'scratch.txt'),'scratch');
 const targets=[path.join(sibling,'w.txt'),path.join(parent,'w.txt'),path.join(data,'w.txt'),path.join(data,'w-through-link.txt')];
 const results=await probe(ws,[['inside','write',path.join(ws,'inside.txt')],['remove inside','unlink',path.join(ws,'scratch.txt')],['other document','write',targets[0]],['temporary folder','write',targets[1]],['data','write',targets[2]],['data through a link','write',path.join(ws,'link-data-folder','w-through-link.txt')],['overwrite data','write',path.join(data,'analyst.sqlite')],['remove data','unlink',path.join(data,'analyst.sqlite')]]);
 assert.equal(results.inside,'WROTE');assert.equal(fs.readFileSync(path.join(ws,'inside.txt'),'utf8'),'written-by-probe','control: the probe ran and writes inside its workspace');
 assert.equal(results['remove inside'],'UNLINKED');assert.equal(fs.existsSync(path.join(ws,'scratch.txt')),false,'control: the probe removes inside its workspace');
 // Judged on the server's side: on Linux a write to the private /tmp "succeeds" inside and never reaches the host.
 for(const target of targets)assert.equal(fs.existsSync(target),false,target);
 assert.equal(fs.readFileSync(path.join(data,'analyst.sqlite'),'utf8'),'DATA-SENTINEL');
 assert.deepEqual(fs.readdirSync(parent).sort(),['analyst-document-A','analyst-document-B','data']);
 assert.deepEqual(fs.readdirSync(sibling),['document.pdf']);assert.deepEqual(fs.readdirSync(data),['analyst.sqlite']);
 refused(results,['other document','data','data through a link','overwrite data','remove data']);
});

test('the network is unreachable from inside: TCP, UDP and a Unix socket outside the workspace',async t=>{
 const {ws,data}=arena(t),seen={tcp:0,udp:0,unix:0};
 const tcp=net.createServer(s=>{seen.tcp++;s.destroy();}),udp=dgram.createSocket('udp4'),unix=net.createServer(s=>{seen.unix++;s.destroy();});
 // Registered before any assertion: an open listener would keep the test process alive after a failure.
 t.after(()=>{for(const listener of [tcp,udp,unix]){try{listener.close();}catch{}}});
 await new Promise(r=>tcp.listen(0,'127.0.0.1',r));udp.on('message',()=>seen.udp++);await new Promise(r=>udp.bind(0,'127.0.0.1',r));
 // A Unix socket address holds about 100 bytes, less than many temporary folder paths. The listener therefore binds a relative
 // name from inside the data folder, and the probe, whose working folder is the workspace, connects to ../data/s.
 const socketPath='../data/s',cwd=process.cwd();try{process.chdir(data);unix.listen('s');}finally{process.chdir(cwd);}await new Promise(r=>unix.once('listening',r));
 // No inside connect as control: the profile grants network-bind below the workspace but no outbound connection, so a connect to a
 // socket inside is refused too. That the relative name is resolved from the workspace is guarded by tests 2 and 3 (the working folder).
 const requests=[['tcp','tcp','127.0.0.1',tcp.address().port],['udp','udp','127.0.0.1',udp.address().port],['unix','unix',socketPath]];
 // Control: the same requests from outside the sandbox arrive.
 assert.deepEqual(unconfined(ws,requests),{tcp:'CONNECTED',udp:'SENT',unix:'CONNECTED'});await sleep(300);assert.deepEqual(seen,{tcp:1,udp:1,unix:1},'control: the listeners work');
 const results=await probe(ws,[['inside','write',path.join(ws,'ran.txt')],...requests]);await sleep(300);
 assert.equal(results.inside,'WROTE','control: the probe ran');assert.equal(fs.existsSync(path.join(ws,'ran.txt')),true);assert.deepEqual(seen,{tcp:1,udp:1,unix:1},'nothing more arrived');
 refused(results,['tcp','unix']);assert.doesNotMatch(String(results.udp),/^ERROR:/,results.udp);
});

test('arguments and environment of other processes stay hidden',async t=>{
 const {ws}=arena(t),marker='DP_PROBE_SECRET_'+process.pid;
 // A process of the server's user with a secret in its environment, as the server itself has. Node itself, not a system
 // program, because macOS hides the environment of its own programs from everyone.
 const other=spawn(process.execPath,['-e','process.stdout.write("up");setTimeout(()=>{},30000)'],{env:{[marker]:'1'},stdio:['ignore','pipe','ignore']});t.after(()=>other.kill('SIGKILL'));
 await new Promise((resolve,reject)=>{other.stdout.once('data',resolve);other.once('error',reject);other.once('exit',()=>reject(Error('the helper process ended')));});
 const spec=[['own','procargs','self','PATH='],['other','procargs',String(other.pid),marker]];
 assert.deepEqual(unconfined(ws,spec),{own:'READ:marker',other:'READ:marker'},'control: outside the sandbox the secret is readable');
 const results=await probe(ws,spec);
 // Linux has its own process numbers inside, so the number may name another process there: what matters is the secret.
 assert.match(results.own,/^READ:/,'control: the probe ran and can read its own');assert.notEqual(results.other,'READ:marker');
 if(darwin)refused(results,['other']);
});

test('the time limit stops everything the tool started',async t=>{
 const {ws}=arena(t),name=path.basename(path.dirname(ws)),listed=()=>listCommands().filter(line=>line.includes(name)).length;
 // Whatever a failed assertion leaves running would also hold the test process open through its pipes.
 t.after(()=>{spawnSync('pkill',['-9','-f',name]);});
 // Control: outside the sandbox the same request starts all three, and they end by themselves.
 const control=unconfined(ws,[['hang','spawn',1]]);assert.deepEqual([control.fork,control.posix_spawn,control.subprocess],['FORKED','FORKED','FORKED'],'control: the requests work unconfined');
 for(let i=0;i<60&&listed();i++)await sleep(100);
 assert.equal(listed(),0,'control: the unconfined sleepers ended');fs.rmSync(path.join(ws,'started.json'));fs.rmSync(path.join(ws,'results.json'));
 const started=Date.now(),run=executeDocumentTool('python3',probeArgs(ws,[['hang','spawn',120]]),ws,{timeoutMs:2500});run.catch(()=>{});
 while(!fs.existsSync(path.join(ws,'started.json'))&&Date.now()-started<2400)await sleep(50);
 assert.ok(fs.existsSync(path.join(ws,'started.json')),'the probe reached its start marker');
 const state=JSON.parse(fs.readFileSync(path.join(ws,'started.json'),'utf8')),running=listed();
 assert.ok(running>=1,'control: the running tool is found by its command line');
 // macOS refuses fork, posix_spawn and subprocess, so a tool is one process and cannot leave its group; Linux allows them and the
 // end of the pid namespace takes the tool along. Either way nothing may be left after the limit.
 if(darwin){assert.equal(state.fork,'REFUSED:fork');refused(state,['posix_spawn','subprocess']);}
 else{assert.equal(state.fork,'FORKED');assert.ok(running>=2,'the forked child is running too');}
 const outcome=await Promise.race([run.then(()=>'resolved',error=>error),sleep(6000).then(()=>'late')]);
 assert.ok(outcome instanceof Error&&/Document processing timed out/.test(outcome.message),'the call rejects with the time limit message, not '+(outcome instanceof Error?outcome.message:outcome));assert.ok(Date.now()-started<6000);
 let left=listed();for(let i=0;i<40&&left;i++){await sleep(50);left=listed();}
 assert.equal(left,0,'no process of the tool is left');
});

test('a workspace that does not exist is refused before any tool starts',async t=>{
 const {parent}=arena(t),missing=path.join(parent,'missing'),marker=path.join(missing,'ran.txt');
 // The marker is inside the missing workspace, the one place a confined tool may write, and the tool creates the folder first.
 await assert.rejects(executeDocumentTool('python3',['-c',`import os;os.makedirs(${JSON.stringify(missing)},exist_ok=True);open(${JSON.stringify(marker)},'w').write('ran')`],missing),darwin?/Document processing could not start its isolated converter/:/Document processing could not start its isolated converter|Could not read this document/);
 assert.equal(fs.existsSync(marker),false,'the tool did not run');assert.equal(fs.existsSync(missing),false,'the workspace was not created');
});

test('system programs that talk to system services cannot be started by a confined tool (macOS)',{skip:!darwin&&'macOS only: the Linux sandbox has no Launch Services or system programs to reach'},async t=>{
 const {parent,ws}=arena(t),marker=path.join(parent,'launched.txt'),app=path.join(ws,'Probe.app'),script=path.join(ws,'probe.command');
 // Each program replaces the probe when it can be started, so each gets its own run and writes its result first. The arguments
 // are inert: under a wide execution rule these programs would really run.
 const programs=[['open','/usr/bin/open','--help'],['lsappinfo','/usr/bin/lsappinfo','help'],['launchctl','/bin/launchctl','help'],['osascript','/usr/bin/osascript','-e','return 1']];
 // Control: the programs exist and can be executed by the server's user, so a refusal is not just a missing path.
 for(const [label,program] of programs)assert.doesNotThrow(()=>fs.accessSync(program,fs.constants.X_OK),label+' exists on this system');
 for(const launchServices of [false,true]){
  for(const [label,...command] of programs){
   const results=await probe(ws,[[label,'exec',...command]],{launchServices},{tolerate:true});
   assert.match(String(results[label]),/^REFUSED:/,`${label} with launchServices:${launchServices}`);
  }
  // Control: a program the profile admits can be started, so the refusals above are not a broken probe.
  const control=await probe(ws,[['bash','exec','/bin/bash','-c','exit 0']],{launchServices});assert.equal(control.bash,'EXECUTED','control: bash starts with launchServices:'+launchServices);
 }
 // The earlier assertion, kept as a second one: nothing is opened for the tool, whatever Launch Services is asked.
 fs.mkdirSync(path.join(app,'Contents','MacOS'),{recursive:true});
 fs.writeFileSync(path.join(app,'Contents','Info.plist'),'<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>local.deep-proof.sandbox-probe</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>\n');
 for(const file of [path.join(app,'Contents','MacOS','probe'),script])fs.writeFileSync(file,`#!/bin/sh\necho launched > '${marker}'\n`,{mode:0o755});
 for(const launchServices of [false,true])for(const target of [app,script])await assert.rejects(executeDocumentTool('/usr/bin/open',['-g','-j',target],ws,{launchServices}),/Could not read this document/,`open ${path.basename(target)} with launchServices:${launchServices}`);
 await sleep(2000);assert.equal(fs.existsSync(marker),false,'nothing was launched');
});

test('the workspace folder itself cannot be removed, renamed or replaced by a link',async t=>{
 const {parent,ws,data}=arena(t);fs.writeFileSync(path.join(ws,'flag-target.txt'),'flag');
 // An access-control entry "everyone deny delete" would keep the server from removing the workspace, as an immutable flag would. The
 // control sets it unconfined on a file of the arena and removes it again, in the test and, registered first, in a clean-up.
 const entry=path.join(parent,'acl-control.txt'),entries=file=>spawnSync('/bin/ls',['-le',file],{encoding:'utf8'}).stdout;
 if(darwin){
  t.after(()=>{spawnSync('/bin/chmod',['-N',entry]);});fs.writeFileSync(path.join(ws,'acl-target.txt'),'acl');fs.writeFileSync(entry,'acl');
  assert.equal(unconfined(ws,[['acl','acl',entry]]).acl,'ACL_SET','control: outside the sandbox the entry is set');
  assert.match(entries(entry),/deny delete/,'control: the file holds the entry');
  spawnSync('/bin/chmod',['-N',entry]);assert.doesNotMatch(entries(entry),/deny delete/,'control: the entry is removed again');fs.rmSync(entry);
 }
 // After such a swap the next tool of the same conversion would be confined to whatever the link names. Flags first: a file
 // the tool made immutable would also keep the server from removing the workspace.
 const spec=[...(darwin?[['flags','chflags',path.join(ws,'flag-target.txt')],['acl','acl',path.join(ws,'acl-target.txt')]]:[]),['rename','rename-root',path.join(parent,'moved')],['replace','replace-root',data]];
 // A swap that succeeds takes the probe's own workspace away; its results then come back through the failed call, so each request
 // is still reported at its own assertion below.
 const results=await probe(ws,spec);
 refused(results,[...(darwin?['flags','acl']:[]),'rename','replace']);
 // Control: the probe emptied the workspace before it tried to replace it. With a workspace it could not write to, every request would
 // be refused for that reason alone and the folder would still hold its files.
 assert.deepEqual(fs.readdirSync(ws),['results.json'],'control: the probe removed every file of the workspace but its results');
 assert.equal(fs.lstatSync(ws).isDirectory(),true);assert.equal(fs.lstatSync(ws).isSymbolicLink(),false);
 assert.deepEqual(fs.readdirSync(parent).sort(),['analyst-document-A','analyst-document-B','data']);assert.deepEqual(fs.readdirSync(data),['analyst.sqlite']);
 assert.doesNotThrow(()=>fs.rmSync(parent,{recursive:true}),'the arena is removed without error');
});

test('executeDocumentTool hands launchServices to the sandbox: the Launch Services daemon is refused without it and answered with it (macOS)',{skip:!darwin&&'macOS only: Mach services and Launch Services exist only there'},async t=>{
 const {ws}=arena(t),lookup=[['launchservicesd','mach','com.apple.coreservices.launchservicesd']],others=[['preferences','mach','com.apple.cfprefsd.daemon']];
 // Control: outside any sandbox the same lookups are answered, so a refusal below is not a missing service or a broken probe.
 const control=unconfined(ws,[...lookup,...others]);for(const label of ['launchservicesd','preferences'])assert.match(control[label],/^ANSWERED:/,'control: outside the sandbox the lookup is answered: '+label);
 // Both ways of not asking: the option absent and false.
 for(const [label,options] of [['no options',undefined],['launchServices absent',{}],['launchServices:false',{launchServices:false}]]){
  const results=await probe(ws,lookup,options);assert.match(results.launchservicesd,/^REFUSED:/,`lookup with ${label}`);
 }
 const results=await probe(ws,[...lookup,...others],{launchServices:true});
 assert.match(results.launchservicesd,/^ANSWERED:/,'lookup with launchServices:true');
 // The option opens that one service only: another service that exists (answered unconfined above) stays refused.
 assert.match(results.preferences,/^REFUSED:/,'another system service, with launchServices:true');
});
