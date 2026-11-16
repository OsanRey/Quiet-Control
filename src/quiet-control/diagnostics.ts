import {diagnosticCopy} from '../i18n/diagnostic-copy';
import {q, type MessageKey} from '../i18n';
/** Apply only to upstream diagnostic fields, never user-authored configuration. */
export function diagnosticText(value: string, aliases: ReadonlyMap<string,string> = new Map()): string {
 const protectedText: string[]=[];
 const protect=(part:string)=>{protectedText.push(part);return `\u0001${protectedText.length-1}\u0001`;};
 let text=value.replace(/「([^」]*)」|https?:\/\/[^\s（）]+/g,(part,name)=>protect(name && aliases.has(name) ? `「${aliases.get(name)}」` : part));
 // Cache membership notes contain unquoted user-set names.
 text=text.replace(/^规则集 (.*) 的成员按本地缓存近似判定，内核以自身数据为准$/,(_,names)=>`${q('diag.25' as MessageKey)} ${protect(names.split("、").map((name:string)=>aliases.get(name)??name).join(", "))} ${q('diag.30' as MessageKey)}`);
 for(const [i,[source]] of diagnosticCopy.entries())text=text.split(source).join(q(('diag.'+i) as MessageKey));
 return text.split('（').join(' (').split('）').join(')').replace(/\u0001(\d+)\u0001/g,(_,index)=>protectedText[Number(index)]);
}
