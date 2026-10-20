//! Frente 2 · guarda de segurança: ASSINATURA das dispensas ("dispensar" na Revisão).
//!
//! O agente escreve na worktree (inclusive `.cardume/guard-ignore.json`) e a fingerprint é dedutível pelo motivo do
//! portão — então uma dispensa só vale com `hmac = HMAC-SHA256(chave, fingerprint)`, onde a chave é local do usuário
//! (`~/.cardume/guard.key`, 32 bytes aleatórios em hex, permissão 600, criada aqui na 1ª dispensa). Só o APP assina
//! (comando Tauri `guard_dismiss`, que o agente não alcança); o motor confere (src/guard.ts: signFingerprint /
//! validIgnores — mesmo vetor de teste dos dois lados).
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const BLOCK: usize = 64;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// HMAC-SHA256 (RFC 2104) em hex.
pub fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    let mut k = if key.len() > BLOCK { Sha256::digest(key).to_vec() } else { key.to_vec() };
    k.resize(BLOCK, 0);
    let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(msg);
    let ih = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(ih);
    hex(&outer.finalize())
}

pub fn key_path(home: &Path) -> PathBuf {
    home.join(".cardume").join("guard.key")
}

/// Lê a chave local; não existe → cria (32 bytes do gerador do sistema, hex, permissão 600).
pub fn load_or_create_key(home: &Path) -> Result<String, String> {
    let p = key_path(home);
    if let Ok(s) = std::fs::read_to_string(&p) {
        let k = s.trim().to_string();
        if k.len() >= 32 {
            return Ok(k);
        }
    }
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).map_err(|e| format!("sem gerador aleatório do sistema: {e}"))?;
    let k = hex(&raw);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    use std::io::Write;
    let mut f = o.open(&p).map_err(|e| format!("não consegui criar {}: {e}", p.display()))?;
    f.write_all(k.as_bytes()).map_err(|e| e.to_string())?;
    Ok(k)
}

/// Grava (ou atualiza) a dispensa assinada em `<worktree>/.cardume/guard-ignore.json`. Devolve o caminho relativo.
pub fn dismiss(worktree: &Path, home: &Path, fingerprint: &str, motivo: &str, por: &str, em: &str) -> Result<&'static str, String> {
    let fp = fingerprint.trim();
    let motivo = motivo.trim();
    if fp.is_empty() || fp.len() > 600 {
        return Err("achado inválido".into());
    }
    if motivo.is_empty() {
        return Err("diga o motivo pra dispensar".into());
    }
    let key = load_or_create_key(home)?;
    let rel = ".cardume/guard-ignore.json";
    let path = worktree.join(".cardume").join("guard-ignore.json");
    let mut list: Vec<serde_json::Value> = match std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
        Some(serde_json::Value::Array(a)) => a,
        Some(serde_json::Value::Object(o)) => o.get("list").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
        _ => vec![],
    };
    list.retain(|x| x.get("fingerprint").and_then(|v| v.as_str()) != Some(fp));
    let por = if por.trim().is_empty() { "Você" } else { por.trim() };
    list.push(serde_json::json!({ "fingerprint": fp, "motivo": motivo, "por": por, "em": em.trim(), "hmac": hmac_sha256_hex(key.as_bytes(), fp.as_bytes()) }));
    std::fs::create_dir_all(worktree.join(".cardume")).map_err(|e| e.to_string())?;
    let txt = serde_json::to_string_pretty(&serde_json::Value::Array(list)).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&path, txt).map_err(|e| e.to_string())?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_rfc4231_caso2() {
        assert_eq!(hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    }

    #[test]
    fn hmac_igual_ao_motor() {
        // mesmo vetor de src/guard.test.ts (signFingerprint)
        assert_eq!(hmac_sha256_hex(b"chave-de-teste", b"src/s3.ts:aws-access-token:0123456789abcdef"), "e2aeb5bde8ba8a515f1f21ca7074caf51cbea414ab43098e2b55c5238fb4136f");
    }

    #[test]
    fn dismiss_cria_chave_600_e_assina() {
        let d = std::env::temp_dir().join(format!("sf-guard-sign-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let (home, wt) = (d.join("home"), d.join("wt"));
        std::fs::create_dir_all(&wt).unwrap();
        dismiss(&wt, &home, "a.ts:r:1", "exemplo", "", "2026-10-19T00:00:00.000Z").unwrap();
        dismiss(&wt, &home, "a.ts:r:1", "exemplo do README", "Ana", "2026-10-19T01:00:00.000Z").unwrap();
        let key = std::fs::read_to_string(key_path(&home)).unwrap();
        assert_eq!(key.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(key_path(&home)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(wt.join(".cardume/guard-ignore.json")).unwrap()).unwrap();
        let a = v.as_array().unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["motivo"], "exemplo do README");
        assert_eq!(a[0]["hmac"], hmac_sha256_hex(key.as_bytes(), b"a.ts:r:1"));
        assert!(dismiss(&wt, &home, "a.ts:r:1", "  ", "x", "y").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
