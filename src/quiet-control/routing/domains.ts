/** Exact names reject a leading dot. Suffixes accept one as familiar notation.
 * Preserve the user's text in storage; use ASCII/IDNA for comparison and validation. */
export function normalizeDomain(raw:string,scope:'domain'|'domain_suffix'):string|null {
 const mapped=raw.trim().replace(/[\u3002\uff0e\uff61]/g,'.');
 const body=scope==='domain_suffix'&&mapped.startsWith('.')?mapped.slice(1):mapped;
 if(!body||body.startsWith('.')||body.endsWith('.')||/[\s\u0000-\u0020\u007f/:*?#@\\%\[\]]/.test(body))return null;
 try{
  // Prefix avoids WHATWG interpreting a numeric DNS name as an IPv4 literal.
  const host=new URL('http://qc-domain.'+body).hostname.toLowerCase();
  if(!host.startsWith('qc-domain.'))return null;
  const ascii=host.slice('qc-domain.'.length);
  if(ascii.length>253||ascii.split('.').some(l=>!l||l.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l)))return null;
  return ascii;
 }catch{return null}
}
export const validDomain=(raw:string,scope:'domain'|'domain_suffix'='domain')=>normalizeDomain(raw,scope)!==null;

export function domainAreasOverlap(a:string,scopeA:'domain'|'domain_suffix',b:string,scopeB:'domain'|'domain_suffix'):boolean {
 const left=normalizeDomain(a,scopeA),right=normalizeDomain(b,scopeB);
 if(!left||!right)return false;
 return left===right||(scopeA==='domain_suffix'&&right.endsWith('.'+left))||(scopeB==='domain_suffix'&&left.endsWith('.'+right));
}
