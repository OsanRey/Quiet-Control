import {useConnectionRuleName,observedGroup} from './routing/ConnectionRules';
import {openRoutingGroup} from './routing/navigation';
import {useRoutingText} from './routing/messages';
import {useState,useEffect} from 'react';
import {routingWorkspace} from '../api';
import {ruleSetName} from './ruleNames';
import {ErrorModal} from '../components/ErrorModal';
import type {ConnectionView} from '../types';
import {q} from '../i18n';
import {redactSecrets} from './privacy';

/** Observed engine evidence only; never substitute a static routing prediction. */
export function ConnectionRule({row:r,onInspect}:{row:ConnectionView;onInspect:(r:ConnectionView)=>void}) {
 const label=useConnectionRuleName(r);
 return <button className="connection-rule-button" title={redactSecrets(r.rule||q('routeEvidence.title'))} onClick={()=>onInspect(r)}>{label}</button>;
}
export function ConnectionRouteDetails({row:r,onClose}:{row:ConnectionView;onClose:()=>void}) {
 const t=useRoutingText();const [group,setGroup]=useState('');const [groupId,setGroupId]=useState('');
 useEffect(()=>{let live=true;void routingWorkspace().then(w=>{const found=observedGroup(w.active,r);if(live){setGroup(found?ruleSetName(found):'');setGroupId(found?.id||'')}}).catch(()=>{});return()=>{live=false}},[r.rule,r.rule_payload]);
 const raw=[r.rule,r.rule_payload&&!r.rule.includes(r.rule_payload)?r.rule_payload:''].filter(Boolean).join('\n');
 const chain=r.chains.length?r.chains.join(' → '):r.chains_display||r.node_tag||r.node_name;
 const message=[`${q('routeEvidence.rule')}:\n${raw||q('routeEvidence.unreported')}`,`${q('routeEvidence.group')}:\n${group||'—'}`,`${q('routeEvidence.exit')}:\n${r.node_name||r.node_tag||''}\n${chain||q('routeEvidence.unreported')}`,`${q('routeEvidence.process')}:\n${r.process||q('routeEvidence.noProcess')}`,`${q('routeEvidence.destination')}:\n${r.destination}`,raw?q('routeEvidence.reason'):q('routeEvidence.unreported'),q('routeEvidence.oldConnections')].join('\n\n');
 return <ErrorModal action={groupId?{label:t('openMatchedGroup'),onClick:()=>{onClose();openRoutingGroup(groupId)}}:undefined} title={q('routeEvidence.title')} help={q('routeEvidence.help')} message={message} onClose={onClose}/>;
}
