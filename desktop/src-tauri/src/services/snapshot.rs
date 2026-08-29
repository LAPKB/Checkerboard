use std::io::{Read, Write};

use anyhow::Context;
use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};

const MAGIC: &[u8; 8] = b"CKMATE01";
const MAX_DECOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;

pub fn save(path: &str, snapshot_json: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!snapshot_json.is_empty(), "project snapshot is empty");
    let encoded = encode(snapshot_json.as_bytes())?;
    std::fs::write(path, encoded).with_context(|| format!("could not write project snapshot {path}"))
}

pub fn load(path: &str) -> anyhow::Result<String> {
    let encoded = std::fs::read(path).with_context(|| format!("could not read project snapshot {path}"))?;
    let decoded = decode(&encoded)?;
    String::from_utf8(decoded).context("project snapshot does not contain valid UTF-8 state")
}

fn encode(value: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut output = MAGIC.to_vec();
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    encoder.write_all(value)?;
    output.extend(encoder.finish()?);
    Ok(output)
}

fn decode(value: &[u8]) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(value.starts_with(MAGIC), "not a Checkmate project snapshot");
    let decoder = ZlibDecoder::new(&value[MAGIC.len()..]);
    let mut limited = decoder.take(MAX_DECOMPRESSED_BYTES + 1);
    let mut output = Vec::new();
    limited.read_to_end(&mut output)?;
    anyhow::ensure!(output.len() as u64 <= MAX_DECOMPRESSED_BYTES, "project snapshot exceeds the 512 MiB safety limit");
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_binary_snapshot_round_trips_and_rejects_other_files() {
        let json = format!(r#"{{"schemaVersion":1,"effects":[{}]}}"#, "0.123456,".repeat(10_000));
        let encoded = encode(json.as_bytes()).unwrap();
        assert!(encoded.starts_with(MAGIC));
        assert!(encoded.len() < json.len() / 10);
        assert_eq!(decode(&encoded).unwrap(), json.as_bytes());
        assert!(decode(b"ordinary json").unwrap_err().to_string().contains("not a Checkmate"));
    }
}
