//! Session-local measured payload accounting. Never infer a route from its rule.
use crate::api::ConnectionsSnapshot;
use serde::Serialize;
use std::{collections::{HashMap, VecDeque}, time::{Duration, Instant}};

#[derive(Clone, Debug, Default, Serialize)]
pub struct Bucket {
    pub upload_total: u64,
    pub download_total: u64,
    pub upload_speed: u64,
    pub download_speed: u64,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct View {
    pub available: bool,
    pub source: String,
    pub vpn: Bucket,
    pub direct: Bucket,
    pub unknown: Bucket,
    pub epoch: u64,
    pub partial: bool,
}
#[derive(Default)]
pub struct Accounting {
    view: View,
    previous: HashMap<String, (u64, u64)>,
    global: (u64, u64),
    at: Option<Instant>,
    speed_samples: VecDeque<(Instant, [(u64, u64); 3])>,
}
fn kind(tags: &[String]) -> usize {
    if tags
        .iter()
        .any(|s| s.starts_with("node-") || s.starts_with("chain-"))
    {
        0
    } else if tags.iter().any(|s| s.eq_ignore_ascii_case("direct")) {
        1
    } else {
        2
    }
}
impl Accounting {
    pub fn reset(&mut self) {
        let epoch = self.view.epoch + 1;
        *self = Self::default();
        self.view.epoch = epoch;
        self.speed_samples.push_back((Instant::now(), [(0, 0); 3]));
    }
    pub fn finish(&mut self) {
        for b in [
            &mut self.view.vpn,
            &mut self.view.direct,
            &mut self.view.unknown,
        ] {
            b.upload_speed = 0;
            b.download_speed = 0;
        }
        self.at = None;
        self.speed_samples.clear();
    }
    pub fn view(&self) -> View {
        let mut v = self.view.clone();
        if self.at.is_some_and(|t| t.elapsed().as_secs() > 4) {
            v.available = false;
        }
        v
    }
    pub fn unavailable(&mut self, source: &str) {
        self.view.available = false;
        self.view.source = source.into();
    }
    fn add(&mut self, delta: [(u64, u64); 3], source: &str) {
        self.add_at(delta, source, Instant::now());
    }
    fn add_at(&mut self, delta: [(u64, u64); 3], source: &str, now: Instant) {
        if self.speed_samples.is_empty() {
            self.speed_samples.push_back((now, [
                (self.view.vpn.upload_total, self.view.vpn.download_total),
                (self.view.direct.upload_total, self.view.direct.download_total),
                (self.view.unknown.upload_total, self.view.unknown.download_total),
            ]));
        }
        for (b, (up, down)) in [
            &mut self.view.vpn,
            &mut self.view.direct,
            &mut self.view.unknown,
        ]
        .into_iter()
        .zip(delta)
        {
            b.upload_total = b.upload_total.saturating_add(up);
            b.download_total = b.download_total.saturating_add(down);
        }
        // A single 100ms journal frame can contain the whole burst. A 1Hz UI
        // otherwise samples the following zero frame and never shows its speed.
        self.speed_samples.push_back((now, [
            (self.view.vpn.upload_total, self.view.vpn.download_total),
            (self.view.direct.upload_total, self.view.direct.download_total),
            (self.view.unknown.upload_total, self.view.unknown.download_total),
        ]));
        while self.speed_samples.len() > 2 &&
            (now.duration_since(self.speed_samples[1].0) >= Duration::from_secs(1)
                || self.speed_samples.len() > 128) {
            self.speed_samples.pop_front();
        }
        let (start, previous) = self.speed_samples.front().unwrap();
        let dt = now.duration_since(*start).as_secs_f64();
        for (b, (up, down)) in [&mut self.view.vpn, &mut self.view.direct, &mut self.view.unknown]
            .into_iter().zip(previous) {
            b.upload_speed = if dt > 0.05 { (b.upload_total.saturating_sub(*up) as f64 / dt) as u64 } else { 0 };
            b.download_speed = if dt > 0.05 { (b.download_total.saturating_sub(*down) as f64 / dt) as u64 } else { 0 };
        }
        self.view.available = true;
        self.view.source = source.into();
        self.view.partial =
            self.view.unknown.upload_total > 0 || self.view.unknown.download_total > 0;
        self.at = Some(now);
    }
    pub fn connections(&mut self, s: &ConnectionsSnapshot) {
        if s.upload_total < self.global.0 || s.download_total < self.global.1 {
            self.reset();
        }
        let budget = (
            s.upload_total - self.global.0,
            s.download_total - self.global.1,
        );
        let mut delta = [(0u64, 0u64); 3];
        let mut next = HashMap::with_capacity(s.connections.len().min(20000));
        if s.connections.len() <= 20000 {
            for c in &s.connections {
                // An ID reused after disappearance is conservatively charged to unknown
                // if its full counters exceed this frame's aggregate delta.
                let id = format!("{}:{}", c.id, c.start);
                let prev = self.previous.get(&id).copied().unwrap_or_default();
                let d = (
                    c.upload.saturating_sub(prev.0),
                    c.download.saturating_sub(prev.1),
                );
                let k = kind(&c.chains);
                delta[k].0 = delta[k].0.saturating_add(d.0);
                delta[k].1 = delta[k].1.saturating_add(d.1);
                next.insert(id, (c.upload, c.download));
            }
        }
        let known = (
            delta[0].0.saturating_add(delta[1].0),
            delta[0].1.saturating_add(delta[1].1),
        );
        // Independent counters can be sampled at slightly different instants.
        // An upload mismatch must not discard valid download attribution.
        if known.0 > budget.0 {
            delta[0].0 = 0; delta[1].0 = 0; delta[2].0 = budget.0;
        } else {
            delta[2].0 = budget.0 - known.0;
        }
        if known.1 > budget.1 {
            delta[0].1 = 0; delta[1].1 = 0; delta[2].1 = budget.1;
        } else {
            delta[2].1 = budget.1 - known.1;
        }
        self.previous = next;
        self.global = (s.upload_total, s.download_total);
        self.add(delta, "clash_connections");
    }
    pub fn outbounds(&mut self, counters: &HashMap<String, (u64, u64)>) {
        if !counters.keys().any(|tag|tag=="direct"||tag.starts_with("node-")){self.unavailable("xray_waiting_counters");return;}
        let mut sums = [(0u64, 0u64); 3];
        for (tag, (u, d)) in counters {
            // Fragment/DNS relay outputs can duplicate payload already counted at
            // a node. Only generated terminal node/direct outputs are counted.
            let k = if tag.starts_with("node-") {
                0
            } else if tag == "direct" {
                1
            } else {
                continue;
            };
            sums[k].0 = sums[k].0.saturating_add(*u);
            sums[k].1 = sums[k].1.saturating_add(*d);
        }
        let totals = [
            (self.view.vpn.upload_total, self.view.vpn.download_total),
            (
                self.view.direct.upload_total,
                self.view.direct.download_total,
            ),
        ];
        if (0..2).any(|i| sums[i].0 < totals[i].0 || sums[i].1 < totals[i].1) {
            self.reset();
        }
        let previous = [
            (self.view.vpn.upload_total, self.view.vpn.download_total),
            (
                self.view.direct.upload_total,
                self.view.direct.download_total,
            ),
        ];
        for i in 0..2 {
            sums[i] = (sums[i].0 - previous[i].0, sums[i].1 - previous[i].1);
        }
        self.add(sums, "xray_outbounds");
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::parse_connections_json;
    #[test]
    fn one_second_ui_observes_bursts_between_short_journal_frames() {
        let mut a=Accounting::default();let start=Instant::now();
        a.speed_samples.push_back((start,[(0,0);3]));
        let mib=1024*1024;
        for tick in 1..=40 {
            let burst=if tick%10==1 {if tick<31 {12*mib} else {10*mib}} else {0};
            a.add_at([(0,burst),(0,0),(0,0)],"clash_connections",start+Duration::from_millis(tick*100));
            if tick%10==0 {
                let expected=if tick<=30 {12*mib}else{10*mib};
                assert_eq!(a.view.vpn.download_speed,expected,"a 1Hz reader must not see the zero 100ms frame");
            }
        }
        assert_eq!(a.view.vpn.download_total,46*mib);
        a.add_at([(0,0);3],"clash_connections",start+Duration::from_secs(5));
        assert_eq!(a.view.vpn.download_speed,0);
        a.finish();assert!(a.speed_samples.is_empty());
    }

    #[test]
    fn upload_sampling_skew_does_not_discard_measured_download_route() {
        let mut a=Accounting::default();
        let s=parse_connections_json(r#"{"uploadTotal":10,"downloadTotal":46000000,"connections":[{"id":"a","upload":11,"download":46000000,"chains":["node-a","proxy"],"metadata":{}}]}"#).unwrap();
        a.connections(&s);let v=a.view();
        assert_eq!(v.vpn.download_total,46_000_000);assert_eq!(v.unknown.download_total,0);
        assert_eq!(v.unknown.upload_total,10);assert_eq!(v.vpn.upload_total,0);
    }

    #[test]
    fn rolling_rates_reconcile_vpn_direct_and_unattributed_bytes() {
        let mut a=Accounting::default();let start=Instant::now();
        a.speed_samples.push_back((start,[(0,0);3]));
        for tick in 1..=10 {a.add_at([(100,100000),(200,200000),(50,50000)],"clash_connections",start+Duration::from_millis(tick*100));}
        let v=a.view();assert_eq!(v.vpn.download_speed+v.direct.download_speed+v.unknown.download_speed,3_500_000);
        assert_eq!(v.vpn.upload_speed+v.direct.upload_speed+v.unknown.upload_speed,3500);
    }
    #[test]
    fn measured_routes_unknown_and_closed() {
        let mut a = Accounting::default();
        let s=parse_connections_json(r#"{"uploadTotal":100,"downloadTotal":200,"connections":[{"id":"a","upload":30,"download":60,"chains":["node-a","proxy"],"metadata":{}},{"id":"b","upload":20,"download":40,"chains":["DIRECT"],"metadata":{}}]}"#).unwrap();
        a.connections(&s);
        let v = a.view();
        assert_eq!(v.vpn.upload_total, 30);
        assert_eq!(v.direct.download_total, 40);
        assert_eq!(v.unknown.download_total, 100);
        let empty = ConnectionsSnapshot {
            upload_total: 100,
            download_total: 200,
            connections: vec![],
        };
        a.connections(&empty);
        assert_eq!(a.view().vpn.upload_total, 30);
        assert_eq!(a.view().vpn.upload_speed, 0);
        a.connections(&s);
        assert_eq!(
            a.view().vpn.upload_total,
            30,
            "reappearing counters cannot count twice"
        );
    }
    #[test]
    fn outbound_internal_not_doubled_and_reset() {
        let mut a = Accounting::default();
        let m = HashMap::from([
            ("node-a".into(), (10, 20)),
            ("direct".into(), (5, 6)),
            ("fragment-dialer".into(), (10, 20)),
        ]);
        a.outbounds(&m);
        assert_eq!(a.view().vpn.upload_total, 10);
        a.outbounds(&m);
        assert_eq!(a.view().vpn.upload_total, 10);
        a.outbounds(&HashMap::from([("direct".into(), (1, 2))]));
        assert_eq!(a.view().direct.upload_total, 1);
        assert_eq!(a.view().vpn.upload_total, 0);
    }
    #[test] fn unavailable_and_stop_do_not_invent_measurements(){
        let mut a=Accounting::default();assert!(!a.view().available);
        a.outbounds(&HashMap::new());assert!(!a.view().available);
        a.outbounds(&HashMap::from([("node-a".into(),(100,200))]));
        a.finish();assert_eq!(a.view().vpn.download_total,200);assert_eq!(a.view().vpn.download_speed,0);
        a.unavailable("custom_or_multicore");assert!(!a.view().available);
    }
    #[test] fn counters_reset_and_relay_chain_is_one_connection(){
        let mut a=Accounting::default();let s=parse_connections_json(r#"{"uploadTotal":80,"downloadTotal":120,"connections":[{"id":"chain","upload":80,"download":120,"chains":["chain-one","node-a","node-b"],"metadata":{}}]}"#).unwrap();
        a.connections(&s);assert_eq!(a.view().vpn.download_total,120);
        let epoch=a.view().epoch;a.connections(&ConnectionsSnapshot{upload_total:0,download_total:0,connections:vec![]});assert!(a.view().epoch>epoch);assert_eq!(a.view().vpn.download_total,0);
    }

}
