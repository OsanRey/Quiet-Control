let pending:{group:string}|undefined;
export function openRoutingGroup(group:string){pending={group};window.dispatchEvent(new Event('qc-routing-open'));}
export function takeRoutingFocus(){const next=pending;pending=undefined;return next;}
