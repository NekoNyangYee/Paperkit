//! Bounded byte caches. Native handles never escape the worker and revisions
//! never reuse layers/fonts from a different document state.
use pdfium_render::prelude::PdfFontToken;
use std::{
    collections::{HashMap, VecDeque},
    hash::Hash,
};

pub(super) type LayerKey = (u64, i32, i32, bool, Vec<usize>);
#[derive(Default)]
pub(super) struct SessionCache {
    pub fonts: ByteCache<(u64, PdfFontToken)>,
    pub layers: ByteCache<LayerKey>,
}
pub(super) struct ByteCache<K> {
    entries: HashMap<K, Vec<u8>>,
    order: VecDeque<K>,
    bytes: usize,
}
impl<K> Default for ByteCache<K> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
        }
    }
}
impl<K: Clone + Eq + Hash> ByteCache<K> {
    const MAX_BYTES: usize = 24 * 1024 * 1024;
    pub fn get(&self, key: &K) -> Option<&Vec<u8>> {
        self.entries.get(key)
    }
    pub fn insert(&mut self, key: K, value: Vec<u8>) {
        if value.len() > Self::MAX_BYTES || self.entries.contains_key(&key) {
            return;
        }
        while self.bytes + value.len() > Self::MAX_BYTES || self.entries.len() >= 12 {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            if let Some(bytes) = self.entries.remove(&old) {
                self.bytes -= bytes.len();
            }
        }
        self.bytes += value.len();
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evicts_by_bytes_and_count_and_never_crosses_revision() {
        let mut cache = ByteCache::default();
        cache.insert((0, 1), vec![1; 16 * 1024 * 1024]);
        cache.insert((0, 2), vec![2; 16 * 1024 * 1024]);
        assert!(cache.get(&(0, 1)).is_none());
        assert!(cache.get(&(1, 2)).is_none());
        for id in 3..16 {
            cache.insert((0, id), vec![3]);
        }
        assert!(cache.get(&(0, 2)).is_none());
        assert!(cache.entries.len() <= 12);
    }
}
