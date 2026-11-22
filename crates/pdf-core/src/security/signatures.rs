use pdfium_render::prelude::*;
use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureReport {
    pub signer: Option<String>,
    pub integrity: Integrity,
    pub trust: Trust,
    pub later_bytes: Option<bool>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Integrity {
    Matches,
    Mismatch,
    #[default]
    Unverified,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Trust {
    Trusted,
    Untrusted,
    Revoked,
    #[default]
    Unknown,
}

pub(crate) fn inspect(document: &PdfDocument, source: &[u8]) -> Vec<SignatureReport> {
    let count = document.signatures().len();
    if count == 0 {
        return Vec::new();
    }
    let Ok(parsed) = lopdf::Document::load_mem(source) else {
        return vec![SignatureReport::default()];
    };
    let dictionaries: Vec<_> = parsed
        .objects
        .values()
        .filter_map(|object| object.as_dict().ok())
        .filter(|dict| dict.has(b"ByteRange") && dict.has(b"Contents"))
        .collect();
    let mut reports = Vec::new();
    for index in 0..count.min(64) {
        let report = (|| {
            let contents = document.signatures().get(index).ok()?.bytes();
            let mut matching = dictionaries.iter().filter(|dict| {
                dict.get(b"Contents").and_then(|v| v.as_str()).ok() == Some(contents.as_slice())
            });
            let dict = matching.next()?;
            if matching.next().is_some()
                || !matches!(
                    dict.get(b"SubFilter").and_then(|v| v.as_name()).ok()?,
                    b"adbe.pkcs7.detached" | b"ETSI.CAdES.detached"
                )
            {
                return None;
            }
            let values = dict.get(b"ByteRange").and_then(|v| v.as_array()).ok()?;
            if values.len() != 4 {
                return None;
            }
            let mut range = [0; 4];
            for (dst, src) in range.iter_mut().zip(values) {
                *dst = i32::try_from(src.as_i64().ok()?).ok()?;
            }
            verify_range(source, range, &contents)
        })()
        .unwrap_or_default();
        reports.push(report);
    }
    if count > 64 {
        reports.push(SignatureReport::default());
    }
    reports
}

fn verify_range(source: &[u8], range: [i32; 4], contents: &[u8]) -> Option<SignatureReport> {
    let [0, first, second, length] = range else {
        return None;
    };
    let first = usize::try_from(first).ok()?;
    let second = usize::try_from(second).ok()?;
    let end = second.checked_add(usize::try_from(length).ok()?)?;
    let suffix = source.get(second..end)?;
    if suffix.is_empty()
        || !suffix.trim_ascii_end().ends_with(b"%%EOF")
        || contents.is_empty()
        || contents.len() > 2 * 1024 * 1024
    {
        return None;
    }
    // Only the signature's own hexadecimal Contents token may be omitted from the digest.
    if !source
        .get(..first)?
        .trim_ascii_end()
        .ends_with(b"/Contents")
    {
        return None;
    }
    let gap = source
        .get(first..second)?
        .strip_prefix(b"<")?
        .strip_suffix(b">")?;
    let mut digits = gap.iter().filter(|b| !b.is_ascii_whitespace());
    for &byte in contents {
        let hi = (*digits.next()? as char).to_digit(16)?;
        let lo = (*digits.next()? as char).to_digit(16)?;
        if hi * 16 + lo != byte as u32 {
            return None;
        }
    }
    if digits.next().is_some() {
        return None;
    }
    let der = der_sequence(contents)?;
    let mut report = cms(der, &source[..first], suffix);
    report.later_bytes = Some(end != source.len());
    Some(report)
}

fn take_der<'a>(input: &mut &'a [u8], tag: u8) -> Option<&'a [u8]> {
    let slot = *input;
    if *slot.first()? != tag {
        return None;
    }
    let n = *slot.get(1)? as usize;
    let (header, len) = if n < 128 {
        (2, n)
    } else {
        let count = n & 127;
        if !(1..=4).contains(&count) {
            return None;
        }
        (
            2 + count,
            slot.get(2..2 + count)?
                .iter()
                .fold(0usize, |v, b| (v << 8) | *b as usize),
        )
    };
    let end = header.checked_add(len)?;
    *input = slot.get(end..)?;
    slot.get(header..end)
}

// Accept detached CMS SignedData with one SHA-2 signer. CryptoAPI verifies its
// signature and signed attributes. Reject embedded content and legacy digests.
fn der_sequence(slot: &[u8]) -> Option<&[u8]> {
    let mut padding = slot;
    let mut message = take_der(&mut padding, 0x30)?;
    if padding.iter().any(|b| *b != 0) {
        return None;
    }
    if take_der(&mut message, 0x06)? != b"\x2a\x86\x48\x86\xf7\x0d\x01\x07\x02" {
        return None;
    }
    let mut wrapper = take_der(&mut message, 0xa0)?;
    let mut signed_data = take_der(&mut wrapper, 0x30)?;
    if !message.is_empty() || !wrapper.is_empty() {
        return None;
    }
    take_der(&mut signed_data, 0x02)?; // version
    take_der(&mut signed_data, 0x31)?; // digest algorithms
    let mut content = take_der(&mut signed_data, 0x30)?;
    if take_der(&mut content, 0x06)? != b"\x2a\x86\x48\x86\xf7\x0d\x01\x07\x01"
        || !content.is_empty()
    {
        return None;
    }
    for tag in [0xa0, 0xa1] {
        // optional certificates and revocation information
        if signed_data.first() == Some(&tag) {
            take_der(&mut signed_data, tag)?;
        }
    }
    let mut signers = take_der(&mut signed_data, 0x31)?;
    let mut signer = take_der(&mut signers, 0x30)?;
    if !signed_data.is_empty() || !signers.is_empty() {
        return None;
    }
    take_der(&mut signer, 0x02)?;
    let id_tag = *signer.first()?;
    if !matches!(id_tag, 0x30 | 0x80) {
        return None;
    }
    take_der(&mut signer, id_tag)?;
    let mut algorithm = take_der(&mut signer, 0x30)?;
    let oid = take_der(&mut algorithm, 0x06)?;
    if !matches!(
        oid.strip_prefix(b"\x60\x86\x48\x01\x65\x03\x04\x02")?,
        [1..=3]
    ) {
        return None;
    }
    slot.get(..slot.len() - padding.len())
}

#[cfg(not(windows))]
fn cms(_: &[u8], _: &[u8], _: &[u8]) -> SignatureReport {
    SignatureReport::default()
}

#[cfg(windows)]
fn cms(der: &[u8], before: &[u8], after: &[u8]) -> SignatureReport {
    use std::{
        mem::size_of,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{GetLastError, CRYPT_E_HASH_VALUE, NTE_BAD_SIGNATURE},
        Security::Cryptography::*,
    };
    let mut report = SignatureReport::default();
    let encoding = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;
    let settings = CRYPT_VERIFY_MESSAGE_PARA {
        cbSize: size_of::<CRYPT_VERIFY_MESSAGE_PARA>() as u32,
        dwMsgAndCertEncodingType: encoding,
        ..Default::default()
    };
    let buffers = [before.as_ptr(), after.as_ptr()];
    let lengths = [before.len() as u32, after.len() as u32];
    // Buffers and returned certificate remain live until all CryptoAPI calls finish.
    unsafe {
        if CryptGetMessageSignerCount(encoding, der.as_ptr(), der.len() as u32) != 1 {
            return report;
        }
        let mut cert = null_mut();
        if CryptVerifyDetachedMessageSignature(
            &settings,
            0,
            der.as_ptr(),
            der.len() as u32,
            2,
            buffers.as_ptr(),
            lengths.as_ptr(),
            &mut cert,
        ) == 0
        {
            if matches!(
                GetLastError() as i32,
                CRYPT_E_HASH_VALUE | NTE_BAD_SIGNATURE
            ) {
                report.integrity = Integrity::Mismatch;
            }
            return report;
        }
        if cert.is_null() {
            return report;
        }
        report.integrity = Integrity::Matches;
        let len = CertGetNameStringW(
            cert,
            CERT_NAME_SIMPLE_DISPLAY_TYPE,
            0,
            null(),
            null_mut(),
            0,
        );
        if (2..=4096).contains(&len) {
            let mut name = vec![0u16; len as usize];
            if CertGetNameStringW(
                cert,
                CERT_NAME_SIMPLE_DISPLAY_TYPE,
                0,
                null(),
                name.as_mut_ptr(),
                len,
            ) == len
            {
                report.signer = Some(String::from_utf16_lossy(&name[..name.len() - 1]));
            }
        }
        let store = CryptGetMessageCertificates(encoding, 0, 0, der.as_ptr(), der.len() as u32);
        let params = CERT_CHAIN_PARA {
            cbSize: size_of::<CERT_CHAIN_PARA>() as u32,
            ..Default::default()
        };
        let flags = CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL
            | CERT_CHAIN_DISABLE_AUTH_ROOT_AUTO_UPDATE
            | CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY
            | CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT;
        let mut chain = null_mut();
        if CertGetCertificateChain(
            null_mut(),
            cert,
            null(),
            store,
            &params,
            flags,
            null(),
            &mut chain,
        ) != 0
        {
            let errors = (*chain).TrustStatus.dwErrorStatus;
            report.trust = if errors == 0 {
                Trust::Trusted
            } else if errors & CERT_TRUST_IS_REVOKED != 0 {
                Trust::Revoked
            } else if errors
                & !(CERT_TRUST_REVOCATION_STATUS_UNKNOWN
                    | CERT_TRUST_IS_OFFLINE_REVOCATION
                    | CERT_TRUST_IS_PARTIAL_CHAIN)
                == 0
            {
                Trust::Unknown
            } else {
                Trust::Untrusted
            };
            CertFreeCertificateChain(chain);
        }
        if !store.is_null() {
            CertCloseStore(store, 0);
        }
        CertFreeCertificateContext(cert);
    }
    report
}
