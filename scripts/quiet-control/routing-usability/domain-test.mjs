import fs from 'node:fs';import ts from 'typescript';import assert from 'node:assert/strict';
const source=fs.readFileSync('src/quiet-control/routing/domains.ts','utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText;
const {normalizeDomain,validDomain,domainAreasOverlap}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
let checks=0;for(const [raw,want]of [['.ru','ru'],['.COM','com'],['.рф','xn--p1ai'],['.xn--p1ai','xn--p1ai'],[' .Пример.РФ ','xn--e1afmkfd.xn--p1ai'],['。рф','xn--p1ai'],['example.com','example.com']]){assert.equal(normalizeDomain(raw,'domain_suffix'),want);checks++}
for(const raw of ['.ru','.com','.рф']){assert.equal(validDomain(raw,'domain'),false);checks++}
for(const raw of ['.','..ru','*.ru','https://example.ru','example.ru/account','ru:443','a..ru','xn--','.ru.','evil ru']){assert.equal(validDomain(raw,'domain_suffix'),false,raw);checks++}
assert.equal(normalizeDomain('пример.рф','domain'),'xn--e1afmkfd.xn--p1ai');checks++;
for(const [a,sa,b,sb,want]of [['.ru','domain_suffix','example.ru','domain',true],['.рф','domain_suffix','xn--p1ai','domain_suffix',true],['.ru','domain_suffix','guru.com','domain',false],['.com','domain_suffix','guru.com','domain',true],['example.com','domain','sub.example.com','domain',false],['example.com','domain_suffix','sub.example.com','domain',true]]){assert.equal(domainAreasOverlap(a,sa,b,sb),want);checks++}
console.log('Domain validation and IDNA:',checks,'checks passed');
