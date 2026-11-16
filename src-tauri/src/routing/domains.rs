//! Domain conditions use IDNA at the adapter boundary; persisted user text stays intact.
use crate::error::{AppError,AppResult};
pub fn normalize(raw:&str,suffix:bool)->AppResult<String>{
 let fail=||AppError::Config("routing.invalid.domain".into());
 let mapped=raw.trim().replace(['\u{3002}','\u{ff0e}','\u{ff61}'],".");
 let body=if suffix{mapped.strip_prefix('.').unwrap_or(&mapped)}else{&mapped};
 if body.is_empty()||body.starts_with('.')||body.ends_with('.')||body.chars().any(|c|c.is_whitespace()||c.is_control()||"/:*?#@\\%[]".contains(c)){return Err(fail())}
 let ascii=idna::domain_to_ascii_strict(body).map_err(|_|fail())?.to_ascii_lowercase();
 if ascii.len()>253||ascii.split('.').any(|l|l.is_empty()||l.len()>63||l.starts_with('-')||l.ends_with('-')||!l.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-')){return Err(fail())}
 Ok(ascii)
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn suffix_notation_and_idna_are_canonical(){for(raw,want)in[(".ru","ru"),(".COM","com"),(".рф","xn--p1ai"),(".XN--P1AI","xn--p1ai"),(" .Пример.РФ ","xn--e1afmkfd.xn--p1ai"),("。рф","xn--p1ai")]{assert_eq!(normalize(raw,true).unwrap(),want)}}
 #[test]fn condition_adapters_emit_canonical_idna_for_each_core(){
  let v=serde_json::json!({"field":"domain_suffix","values":[".ru",".рф"]});
  for core in [crate::core::CoreKind::SingBox,crate::core::CoreKind::Mihomo,crate::core::CoreKind::Xray]{super::super::conditions::validate(&v,core,0).unwrap()}
  assert_eq!(super::super::conditions::singbox(&v)["domain_suffix"],serde_json::json!(["ru","xn--p1ai"]));
  assert_eq!(super::super::conditions::xray(&v)["domain"],serde_json::json!(["domain:ru","domain:xn--p1ai"]));
  let mh=super::super::conditions::mihomo(&v);assert!(mh.contains("DOMAIN-SUFFIX,ru"));assert!(mh.contains("DOMAIN-SUFFIX,xn--p1ai"));
 }
 #[test]fn exact_domains_and_suffixes_have_distinct_validation(){assert!(normalize(".ru",false).is_err());assert_eq!(normalize("пример.рф",false).unwrap(),"xn--e1afmkfd.xn--p1ai");for bad in [".","..ru","https://example.ru","example.ru/account","*.ru","ru:443","a..ru","xn--",".ru.","evil ru"]{assert!(normalize(bad,true).is_err(),"{bad}")}}
}
