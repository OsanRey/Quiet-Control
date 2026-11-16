// Guest-only real native CLI validation of host-generated synthetic configurations.
import fs from 'node:fs';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
if(!fs.existsSync('C:/Fixtures/singbox.json'))throw Error('Guest fixtures mount required');
const root='C:/RoutingStage4',bin=root+'/resources/bin/windows-amd64',checks=[];
const dest='C:/CoreChecks';fs.mkdirSync(dest+'/config',{recursive:true});fs.mkdirSync(dest+'/mihomo',{recursive:true});
for(const [core,file,args] of [['singbox','sing-box.exe',['check','-c']],['xray','xray.exe',['run','-test','-c']],['mihomo','mihomo.exe',['-t','-f']]]){
 const config=dest+'/config/'+core+(core==='mihomo'?'.yaml':'.json');fs.copyFileSync('C:/Fixtures/'+core+(core==='mihomo'?'.yaml':'.json'),config);
 const item={core,sha256:createHash('sha256').update(fs.readFileSync(bin+'/'+file)).digest('hex')};
 try{item.output=execFileSync(bin+'/'+file,[...args,config,...(core==='mihomo'?['-d',dest+'/mihomo']:[])],{env:{...process.env,XRAY_LOCATION_ASSET:bin},cwd:bin,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});item.passed=true}catch(e){item.passed=false;item.error=String(e);item.stdout=e.stdout?.toString();item.stderr=e.stderr?.toString()}
 checks.push(item);fs.writeFileSync('C:/Results/native-core-checks.json',JSON.stringify({checks},null,2));
}
